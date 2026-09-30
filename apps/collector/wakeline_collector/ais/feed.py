"""수신 연결 상태와 데이터 공백(gap) 기록(계약 v2 §B1 · v3 §A).

공백 = 받던 데이터가 끊긴 구간. aisstream 은 재전송이 없으므로 메울 수 없고, 기록해서 화면에 보여 줄 뿐이다.
시각은 모두 **우리 수신 시각**(프레임을 읽은 순간의 wall clock)이다 — 메시지의 MetaData.time_utc(aisstream 수신 시각)가 아니다.
'메시지' 는 데이터 메시지만 뜻한다: 공급자 오류 프레임({"error": ...})은 on_message 를 부르지 않는다(client._read).
- 시작: 연결이 끊긴 순간이 아니라 **마지막으로 데이터 메시지를 받은 시각**(ping 시간 초과로 끊김을 알아채기까지 최대 40 s 가
  걸려도 그 사이 데이터가 없었다는 사실이 그대로 남는다). 이 프로세스가 한 번도 데이터를 받지 못했고 이전 실행 기록도 없으면
  공백을 만들지 않는다(처음부터 없던 것은 '끊김' 이 아니다 — 상태 해시의 state·last_error 로 보인다).
- 끝: 다시 구독한 연결에서 **첫 데이터 메시지를 받은 시각**. aisstream 은 구독 성공을 따로 알려 주지 않으므로 첫 데이터가 그
  증거다(잘못된 키로 오류 한 줄만 받고 끊기는 반복이 '회복' 으로 기록되지 않는다).
- 데이터 시각 기준의 구멍은 이보다 길 수 있다: 공급자 쪽 지연(상태 lag_p50_s = 처리 시각 - time_utc)이 끊기기 전에 컸다면
  그만큼 앞선 구간도 받지 못했다. 그 차이는 추정해 넓히지 않는다(계약 v3 §A).
- 프로세스 재시작: 종료할 때 마지막 메시지 시각으로 공백을 열어 상태 해시에 남기고, 다음 기동이 그것(같은 공급자일 때만)을 이어받는다.
- 진단(diag.py · ADR-014 부록 C): 연결마다 keepalive 왕복(ping_rtt)·websockets 수신 버퍼 깊이(ws_buffer)의 최근 최댓값, 발행 태스크가
  창마다 넣어 주는 공급자 지연 중앙값(lag_p50_s) — 끊김 로그의 맥락과 상태 해시에 쓴다.
- 구역(계약 v4 §D): 연결마다 FeedState 하나. 공백에는 그 구역의 정규화한 상자 문자열(scope)을 **공백이 열린 순간** 값으로 붙인다 —
  데이터가 끊긴 곳이 그 영역이다(열린 사이 설정이 바뀌어도 바꾸지 않는다). fixture 재생은 구독 영역이 없어 scope 를 붙이지 않는다.
"""

from __future__ import annotations

import asyncio
import time
from collections import deque
from collections.abc import Callable
from datetime import datetime

from wakeline_collector.ais.diag import WindowMax
from wakeline_collector.ais.parse import iso_ms

REASON_MAX = 200
PENDING_MAX = 1000
FUTURE_SKEW_S = 60.0
REMOVED_SUFFIX = " · 구역 제거"  # 구역을 없앤 순간 닫은 공백의 원인 끝(계약 v4 G D-3)


def parse_iso(v: str | None) -> float | None:
    """상태 해시의 ISO 시각 → epoch. 비었거나 문자열이 아니거나 시간대가 없으면 None."""
    if not v or not isinstance(v, str):
        return None
    try:
        dt = datetime.fromisoformat(v.replace("Z", "+00:00"))
    except ValueError:
        return None
    return dt.timestamp() if dt.tzinfo is not None else None


class GapTracker:
    def __init__(self, pending_max: int = PENDING_MAX) -> None:
        self.open_since: float | None = None
        self.reason = ""
        self.scope: str | None = None  # 열린 공백의 구역(연 순간의 구독 문자열). None = 구역 없음
        self.pending: deque[dict[str, str]] = deque(maxlen=pending_max)  # 아직 발행하지 못한 닫힌 공백(순서대로)
        self.pending_dropped = 0
        self.last: dict[str, str] | None = None

    def open(self, at: float, reason: str, scope: str | None = None) -> bool:
        if self.open_since is not None:
            return False  # 이미 열린 공백의 시작·원인·구역을 덮어쓰지 않는다
        self.open_since, self.reason, self.scope = at, reason[:REASON_MAX], scope or None
        return True

    def close(self, at: float) -> dict[str, str] | None:
        if self.open_since is None:
            return None
        ev = None
        if at > self.open_since:
            ev = {"started_at": iso_ms(self.open_since), "ended_at": iso_ms(at), "reason": self.reason or "unknown"}
            if self.scope:
                ev["scope"] = self.scope
            if len(self.pending) == self.pending.maxlen:
                self.pending_dropped += 1
            self.pending.append(ev)
            self.last = ev
        self.open_since, self.reason, self.scope = None, "", None
        return ev

    def close_removed(self, at: float) -> dict[str, str] | None:
        """구역을 없앤 순간(at) 열린 공백을 닫는다 — 그때까지 받지 못했다는 사실만 남는다(그 뒤로 그 영역은 구독 범위 밖).
        원인 끝에 ' · 구역 제거' 를 붙인다(원인 상한 안에서). at 이 시작보다 늦지 않으면 기록하지 않는다."""
        if self.open_since is None:
            return None
        base = self.reason or "unknown"
        if not base.endswith(REMOVED_SUFFIX):
            self.reason = base[: REASON_MAX - len(REMOVED_SUFFIX)] + REMOVED_SUFFIX
        return self.close(at)

    def widen(self, since: float, reason: str) -> None:
        """열린 공백을 구역 없는(모든 선박에 적용) 공백으로 넓힌다. since 가 더 이르면 그 시작·원인으로(재시작 이어받기, G D-3)."""
        if self.open_since is None or since < self.open_since:
            self.open_since, self.reason = since, reason[:REASON_MAX]
        self.scope = None

    def restore(self, prev: dict[str, str], provider: str, now: float, scope: str | None = None) -> None:
        """이전 실행의 상태 해시에서 열린 공백(또는 마지막 메시지 시각)을 이어받는다. 공급자가 다르면(fixture ↔ 실시간) 잇지 않는다.
        scope = 이어받는 구역(호출자가 같은 구역의 기록만 넘긴다)."""
        if not prev or prev.get("provider") != provider:
            return
        if (a := parse_iso(prev.get("last_gap_started_at"))) and (b := parse_iso(prev.get("last_gap_ended_at"))):
            self.last = {
                "started_at": iso_ms(a),
                "ended_at": iso_ms(b),
                "reason": (prev.get("last_gap_reason") or "unknown")[:REASON_MAX],
            }
        since = parse_iso(prev.get("gap_open_since"))
        if since is not None and since <= now + FUTURE_SKEW_S:
            self.open(since, prev.get("gap_reason") or "ais process restart", scope)
            return
        last = parse_iso(prev.get("last_msg_at"))
        if last is not None and last <= now + FUTURE_SKEW_S:
            self.open(last, "ais process restart", scope)


class FeedState:
    """수신원(실시간 연결 또는 fixture 재생)의 상태. 수신 태스크만 바꾸고, 발행 태스크(sink)가 읽어 상태 해시에 쓴다.

    changed 이벤트는 상태가 바뀔 때(연결·구독·첫 메시지·끊김)만 켠다 — 메시지마다 켜지 않는다. 구역이 여럿이면 한 이벤트를 함께 쓴다.
    scope: 구역 연결이면 설정의 정규화 문자열로 시작해 구독할 때마다 실제로 보낸 문자열로 맞춘다. None = 구역 없음(fixture 재생).
    """

    def __init__(
        self,
        provider: str,
        *,
        scope: str | None = None,
        changed: asyncio.Event | None = None,
        wall: Callable[[], float] = time.time,
        mono: Callable[[], float] = time.monotonic,
    ):
        self.provider = provider
        self.scope = scope
        self._wall, self._mono = wall, mono
        self.state = "starting"  # starting · connecting · subscribed · receiving · backoff · replaying · disabled · stopped
        self.connected = False
        self.connected_since: float | None = None
        self.last_msg_at: float | None = None
        self.msgs_total = 0
        self.sessions_ended = 0
        self.last_error = ""  # 마지막 연결 오류(끊김 원인)
        self.last_error_at: float | None = None
        self.provider_error = ""  # 공급자가 보낸 마지막 오류 메시지({"error": ...})
        self.provider_error_at: float | None = None
        self.deflate: bool | None = None
        self.bbox = ""
        self.on_first_data: Callable[[float], None] | None = None  # 연결마다 첫 데이터 메시지(ShardSet 이 건다)
        self.backoff_s: float | None = None
        self.subscribe_updates = 0
        self.gaps = GapTracker()
        self.changed = changed if changed is not None else asyncio.Event()
        self._session_first: float | None = None
        # 진단(값을 바꿔도 changed 를 켜지 않는다 — 상태 해시는 5 s 마다 싣는다)
        self.ping_rtt = WindowMax(mono=mono)  # keepalive ping → pong 왕복(초, websockets latency)
        self.ws_buffer = WindowMax(mono=mono)  # 메시지를 꺼낸 뒤 websockets 수신 버퍼에 남은 프레임 수
        self.lag_p50_s: float | None = None  # 직전 발행 창의 공급자 지연 중앙값(처리 시각 − time_utc) — sink 가 넣는다

    def _mark(self) -> None:
        self.changed.set()

    def on_connecting(self) -> None:
        self.state = "connecting"
        self.backoff_s = None
        self._mark()

    def on_subscribed(self, bbox: str, *, deflate: bool | None, state: str = "subscribed") -> None:
        self.connected = True
        self.connected_since = self._wall()
        self.state = state
        self.bbox = bbox
        if self.scope is not None:
            self.scope = bbox
        self.deflate = deflate
        self._session_first = None
        self._mark()

    def on_resubscribed(self, bbox: str) -> None:
        self.bbox = bbox
        if self.scope is not None:
            self.scope = bbox
        self.subscribe_updates += 1
        self._mark()

    def on_message(self, now: float) -> None:
        """데이터 메시지 하나를 받았다(now = 우리 수신 시각). 공급자 오류 프레임에는 부르지 않는다."""
        self.msgs_total += 1
        self.last_msg_at = now
        if self._session_first is None:
            self._session_first = self._mono()
            if self.state == "subscribed":
                self.state = "receiving"
            self.gaps.close(now)
            if self.on_first_data is not None:
                self.on_first_data(now)  # 구역 모음이 재시작 때 이어받은 구역 없는 공백을 닫는다(ShardSet)
            self._mark()

    def on_disconnected(self, reason: str) -> float | None:
        """연결이 끝났다. 반환: 이 연결이 메시지를 받은 시간(초, 받지 못했으면 None) — 백오프 초기화 판단용."""
        healthy = None if self._session_first is None else self._mono() - self._session_first
        self.connected = False
        self.connected_since = None
        self._session_first = None
        self.sessions_ended += 1
        self.last_error, self.last_error_at = reason, self._wall()
        if self.last_msg_at is not None:
            self.gaps.open(self.last_msg_at, reason, self.scope)
        self._mark()
        return healthy

    def on_backoff(self, delay_s: float) -> None:
        self.state = "backoff"
        self.backoff_s = delay_s
        self._mark()

    def on_error(self, text: str) -> None:
        """공급자가 보낸 오류 메시지. 호출자가 비밀값을 가린 뒤 넘긴다(끊김 원인 last_error 와 따로 둔다)."""
        self.provider_error, self.provider_error_at = text, self._wall()
        self._mark()

    def on_disabled(self, reason: str) -> None:
        self.state = "disabled"
        self.last_error, self.last_error_at = reason, self._wall()
        self._mark()

    def on_stopped(self) -> None:
        self.state = "stopped"
        self.connected = False
        self.connected_since = None
        if self.last_msg_at is not None:
            self.gaps.open(self.last_msg_at, "ais process stopped", self.scope)
        self._mark()
