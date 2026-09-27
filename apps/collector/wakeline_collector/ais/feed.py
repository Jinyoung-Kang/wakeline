"""수신 연결 상태와 데이터 공백(gap) 기록(계약 v2 §B1).

공백 = 받던 데이터가 끊긴 구간. aisstream 은 재전송이 없으므로 메울 수 없고, 기록해서 화면에 보여 줄 뿐이다.
- 시작: 연결이 끊긴 순간이 아니라 **마지막으로 메시지를 받은 시각**(ping 시간 초과로 끊김을 알아채기까지 최대 40 s 가 걸려도
  그 사이 데이터가 없었다는 사실이 그대로 남는다). 이 프로세스가 한 번도 데이터를 받지 못했고 이전 실행 기록도 없으면 공백을
  만들지 않는다(처음부터 없던 것은 '끊김' 이 아니다 — 상태 해시의 state·last_error 로 보인다).
- 끝: 다시 구독한 연결에서 **첫 메시지를 받은 시각**. aisstream 은 구독 성공을 따로 알려 주지 않으므로 첫 메시지가 그 증거다
  (잘못된 키로 붙자마자 끊기는 반복이 '회복' 으로 기록되지 않는다).
- 프로세스 재시작: 종료할 때 마지막 메시지 시각으로 공백을 열어 상태 해시에 남기고, 다음 기동이 그것(같은 공급자일 때만)을 이어받는다.
"""

from __future__ import annotations

import asyncio
import time
from collections import deque
from collections.abc import Callable
from datetime import datetime

from wakeline_collector.ais.parse import iso_ms

REASON_MAX = 200
PENDING_MAX = 1000
FUTURE_SKEW_S = 60.0


def parse_iso(v: str | None) -> float | None:
    """상태 해시의 ISO 시각 → epoch. 비었거나 시간대가 없으면 None."""
    if not v:
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
        self.pending: deque[dict[str, str]] = deque(maxlen=pending_max)  # 아직 발행하지 못한 닫힌 공백(순서대로)
        self.pending_dropped = 0
        self.last: dict[str, str] | None = None

    def open(self, at: float, reason: str) -> bool:
        if self.open_since is not None:
            return False  # 이미 열린 공백의 시작·원인을 덮어쓰지 않는다
        self.open_since, self.reason = at, reason[:REASON_MAX]
        return True

    def close(self, at: float) -> dict[str, str] | None:
        if self.open_since is None:
            return None
        ev = None
        if at > self.open_since:
            ev = {"started_at": iso_ms(self.open_since), "ended_at": iso_ms(at), "reason": self.reason or "unknown"}
            if len(self.pending) == self.pending.maxlen:
                self.pending_dropped += 1
            self.pending.append(ev)
            self.last = ev
        self.open_since, self.reason = None, ""
        return ev

    def restore(self, prev: dict[str, str], provider: str, now: float) -> None:
        """이전 실행의 상태 해시에서 열린 공백(또는 마지막 메시지 시각)을 이어받는다. 공급자가 다르면(fixture ↔ 실시간) 잇지 않는다."""
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
            self.open(since, prev.get("gap_reason") or "ais process restart")
            return
        last = parse_iso(prev.get("last_msg_at"))
        if last is not None and last <= now + FUTURE_SKEW_S:
            self.open(last, "ais process restart")


class FeedState:
    """수신원(실시간 연결 또는 fixture 재생)의 상태. 수신 태스크만 바꾸고, 발행 태스크(sink)가 읽어 상태 해시에 쓴다.

    changed 이벤트는 상태가 바뀔 때(연결·구독·첫 메시지·끊김)만 켠다 — 메시지마다 켜지 않는다.
    """

    def __init__(self, provider: str, *, wall: Callable[[], float] = time.time, mono: Callable[[], float] = time.monotonic):
        self.provider = provider
        self._wall, self._mono = wall, mono
        self.state = "starting"  # starting · connecting · subscribed · receiving · backoff · replaying · disabled · stopped
        self.connected = False
        self.connected_since: float | None = None
        self.last_msg_at: float | None = None
        self.msgs_total = 0
        self.sessions_ended = 0
        self.last_error = ""  # 마지막 연결 오류(끊김 원인)
        self.provider_error = ""  # 공급자가 보낸 마지막 오류 메시지({"error": ...})
        self.deflate: bool | None = None
        self.bbox = ""
        self.backoff_s: float | None = None
        self.subscribe_updates = 0
        self.gaps = GapTracker()
        self.changed = asyncio.Event()
        self._session_first: float | None = None

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
        self.deflate = deflate
        self._session_first = None
        self._mark()

    def on_resubscribed(self, bbox: str) -> None:
        self.bbox = bbox
        self.subscribe_updates += 1
        self._mark()

    def on_message(self, now: float) -> None:
        self.msgs_total += 1
        self.last_msg_at = now
        if self._session_first is None:
            self._session_first = self._mono()
            if self.state == "subscribed":
                self.state = "receiving"
            self.gaps.close(now)
            self._mark()

    def on_disconnected(self, reason: str) -> float | None:
        """연결이 끝났다. 반환: 이 연결이 메시지를 받은 시간(초, 받지 못했으면 None) — 백오프 초기화 판단용."""
        healthy = None if self._session_first is None else self._mono() - self._session_first
        self.connected = False
        self.connected_since = None
        self._session_first = None
        self.sessions_ended += 1
        self.last_error = reason
        if self.last_msg_at is not None:
            self.gaps.open(self.last_msg_at, reason)
        self._mark()
        return healthy

    def on_backoff(self, delay_s: float) -> None:
        self.state = "backoff"
        self.backoff_s = delay_s
        self._mark()

    def on_error(self, text: str) -> None:
        """공급자가 보낸 오류 메시지. 호출자가 비밀값을 가린 뒤 넘긴다(끊김 원인 last_error 와 따로 둔다)."""
        self.provider_error = text
        self._mark()

    def on_disabled(self, reason: str) -> None:
        self.state = "disabled"
        self.last_error = reason
        self._mark()

    def on_stopped(self) -> None:
        self.state = "stopped"
        self.connected = False
        self.connected_since = None
        if self.last_msg_at is not None:
            self.gaps.open(self.last_msg_at, "ais process stopped")
        self._mark()
