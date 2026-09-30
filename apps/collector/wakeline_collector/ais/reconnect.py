"""끊김 로그 수준(ADR-014 부록 C) — 공백 기록은 바꾸지 않는다. 로그 수준과 문구만 정한다.

로그 화면(wakeline:logs)은 WARN·ERROR 만 싣는다. 받던 연결이 끊겼다가 곧 다시 받는 일(공급자 쪽 적체가 keepalive 시간 초과 — 40 s, ADR-014 부록 C 개정 — 를 넘을 때 · 부록 A 결정 3)
까지 매번 WARN 이면 로그 화면이 되풀이되는 정상 복구로 덮인다. '곧' 은 **기록되는 공백의 길이**(마지막 데이터 → 다시 받은 데이터, AIS 수신 공백과 같은 구간)로
잰다 — 끊긴 순간부터가 아니다. idle 끊김 · 조용한 서버처럼 끊기기 전부터 데이터가 없던 시간도 공백이므로, 재연결이 빨라도 긴 공백은 WARN 이다. 그래서:
- INFO: 데이터를 받던 연결이 끊겼고 그때 공백이 아직 RECOVER_WINDOW_S 안(문구에 최근 30 분 끊김 수와 진단 맥락) · 공백이 창 안에 닫힘(끊긴 뒤 회복까지
  걸린 시간 · 기록한 공백 길이 · 프로세스 시작 이후 빠른 회복 누적 수 — 상태 해시 reconnects_quick_total).
- WARN: 같은 연결이 REPEAT_WINDOW_S 안에 REPEAT_WARN_COUNT 번째 이상 끊김(되풀이) · 끊길 때 공백이 이미 창을 넘음(idle 끊김 등) · 데이터 없이 끝난
  연결(재연결 실패·핸드셰이크 거절·오류 프레임만 받음 — 기동 때 첫 연결 실패 포함) · 공백이 창을 넘도록 다시 받지 못함(끊김 하나에 한 번, 창이 차는 순간) ·
  그 뒤의 늦은 회복.
공백(AIS 수신 공백 목록 · ais_gap · 상태 해시)은 수준과 상관없이 FeedState 가 그대로 기록한다 — 숨기지 않는다.
빠른 회복 수(reconnects_quick)도 로그 수준이 아니라 공백 길이로 센다: 되풀이 끊김(끊김 줄 WARN) · 그 사이 데이터 없이 끝난 재연결 시도(WARN)가
있었어도 공백이 창 안에 닫히면 센다(회복 줄은 INFO). 끊길 때 이미 창을 넘었거나 창이 차도록 받지 못한 끊김만 세지 않는다.

고른 값(잰 값이 아니다):
- RECOVER_WINDOW_S 30 s: '곧 다시 받음' 으로 볼 공백 길이의 상한. 한 번의 정상 재연결은 close_timeout 3 s + 백오프 1 s(±20 %) + 연결 제한 open_timeout
  10 s + 첫 메시지 몇 초 ≈ 20 s 안이다 — 여유를 둔 값. 실측 keepalive 재연결의 공백은 2–13 s(ADR-014 부록 A · VERIFICATION #17 · 2026-09-30 11 s).
- REPEAT_WINDOW_S 30 분 · REPEAT_WARN_COUNT 3: 지금 두 구역 운영에서 본 빈도는 구역 1 에 2시간 2번(시간당 1번)이다 — 30 분에 3번이면 그 6배,
  한 연결로 받던 때(6시간 51번 ≈ 30 분 4번, 부록 B)처럼 공급자 쪽 적체가 되풀이되는 상태다.
- RECENT_MAX 256: 기억하는 끊김 시각 수(메모리 상한). 백오프(60 s 정상 연결 뒤에만 초기화) 때문에 30 분에 이만큼 끊길 수 없다 — 수는 정확하다.
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections import deque
from collections.abc import Callable

from wakeline_collector.ais.feed import FeedState

log = logging.getLogger("ais.client")  # 끊김 로그와 같은 로거(로그 화면에서 한 줄기)

RECOVER_WINDOW_S = 30.0
REPEAT_WINDOW_S = 1800.0
REPEAT_WARN_COUNT = 3
RECENT_MAX = 256


class ReconnectLog:
    """연결(구역) 하나의 끊김·회복 로그. 수신 태스크(client.run · client._read)에서만 부른다."""

    def __init__(
        self,
        name: str,
        feed: FeedState,
        *,
        recover_window_s: float = RECOVER_WINDOW_S,
        repeat_window_s: float = REPEAT_WINDOW_S,
        repeat_warn_count: int = REPEAT_WARN_COUNT,
        mono: Callable[[], float] = time.monotonic,
        wall: Callable[[], float] = time.time,
    ) -> None:
        self.name, self.feed = name, feed
        self.recover_window_s, self.repeat_window_s, self.repeat_warn_count = recover_window_s, repeat_window_s, repeat_warn_count
        self._mono, self._wall = mono, wall
        self._recent: deque[float] = deque(maxlen=RECENT_MAX)  # 데이터를 받던 연결이 끊긴 단조 시각
        self._outage_since: float | None = None  # 끊긴 뒤 아직 다시 받지 못함(단조 시각)
        self._gap_since: float | None = None  # 그때 열린 공백의 시작(wall, 마지막 데이터 — 받은 적이 없으면 None)
        self._outage_reason = ""
        self._warned = False
        self._timer: asyncio.TimerHandle | None = None

    def note_disconnect(self) -> int:
        """데이터를 받던 연결의 끊김을 센다. 반환: 최근 repeat_window_s 안의 끊김 수(이번 것 포함)."""
        now = self._mono()
        self._recent.append(now)
        while self._recent and self._recent[0] < now - self.repeat_window_s:
            self._recent.popleft()
        return len(self._recent)

    def disconnected(self, reason: str, delay_s: float, *, had_data: bool, context: str) -> None:
        """연결이 끝났다(reason 은 비밀값을 가린 문구). had_data = 이 연결이 데이터 메시지를 받았다. FeedState.on_disconnected 뒤에 부른다
        (열린 공백의 시작 = 마지막 데이터 시각을 읽는다)."""
        if not had_data:
            log.warning("%s connection ended without data: %s — retrying in %.1f s (%s)", self.name, reason, delay_s, context)
            return
        n = self.note_disconnect()
        minutes = self.repeat_window_s / 60
        gap_since = self.feed.gaps.open_since  # 이번 끊김으로 열린 공백의 시작(wall) = 마지막 데이터
        silent = None if gap_since is None else max(0.0, self._wall() - gap_since)
        over = silent is not None and silent > self.recover_window_s
        if n >= self.repeat_warn_count:
            log.warning(
                "%s disconnected %d times in the last %.0f min (WARN threshold %d): %s — reconnecting in %.1f s (%s)",
                self.name,
                n,
                minutes,
                self.repeat_warn_count,
                reason,
                delay_s,
                context,
            )
        elif over:
            log.warning(
                "%s disconnected: %s — no data for %.1f s, over the %g s quick-recovery window — reconnecting in %.1f s "
                "(%d disconnect(s) in the last %.0f min; %s)",
                self.name,
                reason,
                silent,
                self.recover_window_s,
                delay_s,
                n,
                minutes,
                context,
            )
        else:
            log.info(
                "%s disconnected: %s — reconnecting in %.1f s (%d disconnect(s) in the last %.0f min; %s)",
                self.name,
                reason,
                delay_s,
                n,
                minutes,
                context,
            )
        if self._outage_since is None:
            self._start_outage(reason, gap_since, silent or 0.0, warned=over)

    def _start_outage(self, reason: str, gap_since: float | None, silent: float, *, warned: bool) -> None:
        self._outage_since, self._outage_reason, self._warned = self._mono(), reason, warned
        self._gap_since = gap_since
        self._cancel()
        if not warned:  # 공백이 창을 넘는 순간(마지막 데이터 + 창)에 한 번 — 이미 넘었으면 끊김 줄이 WARN 이었다
            self._timer = asyncio.get_running_loop().call_later(max(0.0, self.recover_window_s - silent), self._deadline)

    def _deadline(self) -> None:
        self._timer = None
        if self._outage_since is None or self._warned:
            return
        self._warned = True
        log.warning(
            "%s not receiving %g s after the last message (disconnected: %s) — still reconnecting, state %s",
            self.name,
            self.recover_window_s,
            self._outage_reason,
            self.feed.state,
        )

    def first_data(self) -> None:
        """연결의 첫 데이터 메시지(공백은 FeedState 가 이미 닫았다). 끊긴 뒤라면 회복을 남긴다 — 빠른 회복인지는 기록한 공백 길이로 가른다."""
        if self._outage_since is None:
            return
        took = self._mono() - self._outage_since
        gap_s = None if self._gap_since is None else max(0.0, self._wall() - self._gap_since)
        gap = "no gap (no data before)" if gap_s is None else f"gap {gap_s:.1f} s recorded"
        length = took if gap_s is None else gap_s  # 공백을 모르면(받은 적 없음) 끊긴 뒤 시간으로
        self._cancel()
        if not self._warned and length <= self.recover_window_s:
            self.feed.reconnects_quick += 1
            log.info(
                "%s recovered %.1f s after the disconnect — %s (%d quick reconnect(s) since start)",
                self.name,
                took,
                gap,
                self.feed.reconnects_quick,
            )
        else:
            log.warning(
                "%s recovered %.1f s after the disconnect — %s, over the %g s quick-recovery window",
                self.name,
                took,
                gap,
                self.recover_window_s,
            )
        self._outage_since, self._gap_since, self._warned = None, None, False

    def _cancel(self) -> None:
        if self._timer is not None:
            self._timer.cancel()
            self._timer = None

    def close(self) -> None:
        """수신을 멈춘다(종료·구역 제거) — 회복 감시 타이머를 거둔다."""
        self._cancel()
