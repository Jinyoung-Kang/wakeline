"""끊김 로그 수준(ADR-014 부록 C) — 공백 기록은 바꾸지 않는다. 로그 수준과 문구만 정한다.

로그 화면(wakeline:logs)은 WARN·ERROR 만 싣는다. 받던 연결이 끊겼다가 곧 다시 받는 일(공급자 쪽 적체가 keepalive 20 s 를 넘을 때 — 부록 A 결정 3)
까지 매번 WARN 이면 로그 화면이 되풀이되는 정상 복구로 덮인다. 그래서:
- INFO: 데이터를 받던 연결이 끊김(문구에 최근 30 분 끊김 수와 진단 맥락) · 회복 창 안에 다시 받음(회복까지 걸린 시간 · 기록한 공백 길이 ·
  프로세스 시작 이후 빠른 회복 누적 수 — 상태 해시 reconnects_quick_total).
- WARN: 같은 연결이 REPEAT_WINDOW_S 안에 REPEAT_WARN_COUNT 번째 이상 끊김(되풀이) · 데이터 없이 끝난 연결(재연결 실패·핸드셰이크 거절·
  오류 프레임만 받음 — 기동 때 첫 연결 실패 포함) · 끊긴 뒤 RECOVER_WINDOW_S 안에 다시 받지 못함(끊김 하나에 한 번) · 그 뒤의 늦은 회복.
공백(AIS 수신 공백 목록 · ais_gap · 상태 해시)은 수준과 상관없이 FeedState 가 그대로 기록한다 — 숨기지 않는다.

고른 값(잰 값이 아니다):
- RECOVER_WINDOW_S 30 s: '곧 다시 받음' 의 창(끊긴 순간부터). 한 번의 정상 재연결은 close_timeout 3 s + 백오프 1 s(±20 %) + 연결 제한 open_timeout
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
        self._gap_since: float | None = None  # 그때 열린 공백의 시작(wall — 받은 적이 없으면 None)
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
        """연결이 끝났다(reason 은 비밀값을 가린 문구). had_data = 이 연결이 데이터 메시지를 받았다."""
        if had_data:
            n = self.note_disconnect()
            minutes = self.repeat_window_s / 60
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
        else:
            log.warning("%s connection ended without data: %s — retrying in %.1f s (%s)", self.name, reason, delay_s, context)
        if self._outage_since is None and had_data:
            self._start_outage(reason)

    def _start_outage(self, reason: str) -> None:
        self._outage_since, self._outage_reason, self._warned = self._mono(), reason, False
        self._gap_since = self.feed.gaps.open_since
        self._cancel()
        self._timer = asyncio.get_running_loop().call_later(self.recover_window_s, self._deadline)

    def _deadline(self) -> None:
        self._timer = None
        if self._outage_since is None or self._warned:
            return
        self._warned = True
        log.warning(
            "%s not receiving %g s after the disconnect (%s) — still reconnecting, state %s",
            self.name,
            self.recover_window_s,
            self._outage_reason,
            self.feed.state,
        )

    def first_data(self) -> None:
        """연결의 첫 데이터 메시지(공백은 FeedState 가 이미 닫았다). 끊긴 뒤라면 회복을 남긴다."""
        if self._outage_since is None:
            return
        took = self._mono() - self._outage_since
        gap = "" if self._gap_since is None else f"gap {max(0.0, self._wall() - self._gap_since):.1f} s recorded"
        self._cancel()
        if not self._warned and took <= self.recover_window_s:
            self.feed.reconnects_quick += 1
            log.info(
                "%s recovered %.1f s after the disconnect — %s (%d quick reconnect(s) since start)",
                self.name,
                took,
                gap or "no gap (no data before)",
                self.feed.reconnects_quick,
            )
        else:
            log.warning(
                "%s recovered %.1f s after the disconnect (not within %g s) — %s",
                self.name,
                took,
                self.recover_window_s,
                gap or "no gap (no data before)",
            )
        self._outage_since, self._gap_since, self._warned = None, None, False

    def _cancel(self) -> None:
        if self._timer is not None:
            self._timer.cancel()
            self._timer = None

    def close(self) -> None:
        """수신을 멈춘다(종료·구역 제거) — 회복 감시 타이머를 거둔다."""
        self._cancel()
