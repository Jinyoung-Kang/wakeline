"""구역(연결)별 수신 상태 모음과 상태 해시 합계(계약 v4 §D, ADR-014 부록 B).

구역 = aisstream WebSocket 연결 하나(fixture 재생은 구역 하나, 구독 영역이 없어 scope 없음). 구역마다 FeedState(연결 상태·공백)를 두고,
대기열·정리·ShipBook·발행은 모두가 함께 쓴다. 발행 태스크(sink)가 이 모음을 읽어 상태 해시를 쓴다.

상태 해시 합계의 의미(계약 v4 §D):
- connected = 모든 구역이 연결됨, last_msg_at = 최댓값, msgs_per_s = 구역 합, gap_open_since = 열린 공백 중 가장 이른 것(gap_reason 은 그 공백의 것),
  lag_p50_s = 구역 최댓값.
- 계약이 정하지 않은 합계는 한 구역일 때 v4 이전과 같게 두고, 여럿이면 좋게 말하지 않는 쪽으로 정한다:
  state = 가장 나쁜 구역의 상태(STATE_RANK) · connected_since = 모두 연결된 뒤로(연결 시각 최댓값) · deflate = 하나라도 아니면 0 ·
  last_error·provider_error = 가장 최근 것 · 누적 수(msgs_total·sessions_ended 등) = 구역 합(없앤 구역 포함 — 줄어들지 않게).
- shards = JSON 배열(≤ 3) [{scope, state, connected, last_msg_at, msgs_per_s, lag_p50_s, gap_open_since, gap_reason, sessions_ended}].
  모르는 값은 null(추정하지 않는다).

구역을 없애면(설정에서 빠짐) 연결을 닫고, 아직 발행하지 못한 닫힌 공백은 그대로 보낸다. 그 구역에 **열린** 공백은 기록하지 않는다 —
끝(다시 받은 첫 메시지)이 오지 않고, 그 뒤로 그 영역은 구독 범위 밖이지 끊김이 아니다(로그로만 남긴다).
재시작 이어받기: 이전 실행의 shards 배열에서 **같은 scope** 의 구역만 잇는다. v4 이전 해시(shards 없음)는 bbox 가 같은 구역(또는 fixture)에 한 번.
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections import deque
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

import orjson

from wakeline_collector.ais.bbox import MAX_SHARDS, BboxState
from wakeline_collector.ais.feed import PENDING_MAX, FeedState, parse_iso
from wakeline_collector.ais.parse import iso_ms

log = logging.getLogger("ais.shards")

# 상태 이름의 나쁜 정도(클수록 나쁨). 합계 state 는 가장 나쁜 구역의 것 — 한 구역이라도 끊겼으면 '수신 중' 이라고 말하지 않는다.
STATE_RANK = {
    "receiving": 0,
    "replaying": 0,
    "subscribed": 1,
    "starting": 2,
    "connecting": 3,
    "backoff": 4,
    "disabled": 5,
    "stopped": 6,
}
SHARD_FIELDS = (
    "scope",
    "state",
    "connected",
    "last_msg_at",
    "msgs_per_s",
    "lag_p50_s",
    "gap_open_since",
    "gap_reason",
    "sessions_ended",
)


def _iso(epoch: float | None) -> str | None:
    return iso_ms(epoch) if epoch is not None else None


def _text(v: Any) -> str:
    return v if isinstance(v, str) else ""


def _later(a: dict[str, str] | None, b: dict[str, str] | None) -> dict[str, str] | None:
    """끝난 시각이 늦은 공백(ISO 문자열은 같은 모양이라 문자열 비교로 순서가 맞다)."""
    if a is None:
        return b
    if b is None:
        return a
    return b if b["ended_at"] > a["ended_at"] else a


def previous_shards(raw: Any) -> list[dict[str, Any]] | None:
    """이전 상태 해시의 shards 필드 → 항목 목록. 필드가 없으면 None(v4 이전 해시), 형식이 틀리면 빈 목록(잇지 않는다)."""
    if raw is None or raw == "":
        return None
    try:
        doc = orjson.loads(raw)
    except (orjson.JSONDecodeError, TypeError):
        return []
    if not isinstance(doc, list):
        return []
    ok = [e for e in doc if isinstance(e, dict) and (e.get("scope") is None or isinstance(e.get("scope"), str))]
    return ok[:MAX_SHARDS]


@dataclass(eq=False)
class Shard:
    """구역 하나. id 는 대기열 tag(프로세스 안에서 다시 쓰지 않는다), position 은 설정 안 순번(0부터, 로그용)."""

    id: int
    position: int
    feed: FeedState
    window: tuple[float, int] = (0.0, 0)  # 직전 발행 창 끝 (mono, msgs_total)
    msgs_per_s: float | None = None
    lag_p50_s: float | None = None
    # 실시간 연결(AisStreamPool)만 쓴다
    bboxes: BboxState | None = None
    stop: asyncio.Event = field(default_factory=asyncio.Event)
    task: asyncio.Task[None] | None = None

    @property
    def label(self) -> str:
        return f"shard {self.position + 1}"


class ShardSet:
    def __init__(
        self, provider: str, *, wall: Callable[[], float] = time.time, mono: Callable[[], float] = time.monotonic
    ) -> None:
        self.provider = provider
        self._wall, self._mono = wall, mono
        self.changed = asyncio.Event()  # 모든 구역의 FeedState 가 함께 쓴다(발행 태스크가 기다린다)
        self.active: list[Shard] = []
        self.closing: list[Shard] = []  # 설정에서 빠져 연결을 닫는 중(누적 수·보낼 공백은 아직 여기)
        self._next_id = 0
        self.retired_pending: deque[dict[str, str]] = deque(maxlen=PENDING_MAX)  # 없앤 구역의 보내지 못한 닫힌 공백
        self.retired_msgs_total = 0
        self.retired_sessions_ended = 0
        self.retired_subscribe_updates = 0
        self.retired_last_gap: dict[str, str] | None = None
        self.restored_last_gap: dict[str, str] | None = None  # 이전 실행의 '마지막 닫힌 공백'(합계)
        self._prev: dict[str, str] = {}
        self._prev_shards: list[dict[str, Any]] | None = None

    # ── 구역 만들기·없애기 ─────────────────────────────────────

    def load_previous(self, prev: dict[str, str]) -> None:
        """기동 때 한 번: 이전 실행의 상태 해시. 공급자가 다르면(fixture ↔ 실시간) 아무것도 잇지 않는다."""
        if not prev or prev.get("provider") != self.provider:
            return
        self._prev = prev
        self._prev_shards = previous_shards(prev.get("shards"))
        a, b = parse_iso(prev.get("last_gap_started_at")), parse_iso(prev.get("last_gap_ended_at"))
        if a is not None and b is not None:
            reason = (prev.get("last_gap_reason") or "unknown")[:200]
            self.restored_last_gap = {"started_at": iso_ms(a), "ended_at": iso_ms(b), "reason": reason}

    def add(self, scope: str | None, *, restore: bool = True) -> Shard:
        """구역 하나를 만든다. restore = 이전 실행의 같은 구역 기록을 잇는다(기동 때 만든 구역만)."""
        feed = FeedState(self.provider, scope=scope, changed=self.changed, wall=self._wall, mono=self._mono)
        shard = Shard(self._next_id, len(self.active), feed, window=(self._mono(), 0))
        self._next_id += 1
        if restore:
            self._restore(shard)
        self.active.append(shard)
        self.changed.set()
        return shard

    def _restore(self, shard: Shard) -> None:
        prev, feed, now = self._prev, shard.feed, self._wall()
        if not prev:
            return
        if self._prev_shards is not None:
            match = next((e for e in self._prev_shards if e.get("scope") == feed.scope), None)
            if match is None:
                return
            self._prev_shards.remove(match)
            src = {k: _text(match.get(k)) for k in ("gap_open_since", "gap_reason", "last_msg_at")}
        elif feed.scope is None or feed.scope == prev.get("bbox"):
            src = {k: prev.get(k, "") for k in ("gap_open_since", "gap_reason", "last_msg_at")}
            self._prev = {}  # v4 이전 해시는 구역 하나에만 잇는다
        else:
            return
        feed.gaps.restore({"provider": self.provider, **src}, self.provider, now, feed.scope)
        if feed.gaps.open_since is not None:
            log.info("carrying over an open AIS gap from the previous run (%s, %s)", feed.gaps.reason, shard.label)

    def begin_closing(self, shard: Shard) -> None:
        """설정에서 빠진 구역: 상태·합계에서 빼고, 연결을 닫는 동안 누적 수·보낼 공백만 남긴다."""
        self.active.remove(shard)
        self.closing.append(shard)
        self.changed.set()

    def retire(self, shard: Shard) -> None:
        """연결을 닫은 구역을 없앤다. 누적 수를 합계에 더하고, 보내지 못한 닫힌 공백은 계속 보낸다."""
        if shard in self.closing:
            self.closing.remove(shard)
        f = shard.feed
        self.retired_msgs_total += f.msgs_total
        self.retired_sessions_ended += f.sessions_ended
        self.retired_subscribe_updates += f.subscribe_updates
        self.retired_last_gap = _later(self.retired_last_gap, f.gaps.last)
        self.retired_pending.extend(f.gaps.pending)
        f.gaps.pending.clear()
        if f.gaps.open_since is not None:
            log.info(
                "ais %s removed with a gap open since %s — not recorded (no longer subscribed)",
                shard.label,
                iso_ms(f.gaps.open_since),
            )
        self.changed.set()

    def find(self, shard_id: int) -> Shard | None:
        return next((s for s in (*self.active, *self.closing) if s.id == shard_id), None)

    def on_provider_error(self, shard_id: int, text: str) -> None:
        """정리 태스크가 넘긴 공급자 오류(비밀값을 가린 문구)를 그 원문을 받은 구역에 남긴다. 이미 없앤 구역이면 버린다."""
        s = self.find(shard_id)
        if s is not None:
            s.feed.on_error(text)

    def on_stopped(self) -> None:
        for s in self.active:
            s.feed.on_stopped()

    # ── 합계 ─────────────────────────────────────────────────

    def feeds(self) -> list[FeedState]:
        return [s.feed for s in self.active]

    def _all(self) -> list[Shard]:
        return [*self.active, *self.closing]

    @property
    def msgs_total(self) -> int:
        return self.retired_msgs_total + sum(s.feed.msgs_total for s in self._all())

    @property
    def sessions_ended(self) -> int:
        return self.retired_sessions_ended + sum(s.feed.sessions_ended for s in self._all())

    @property
    def subscribe_updates(self) -> int:
        return self.retired_subscribe_updates + sum(s.feed.subscribe_updates for s in self._all())

    def pending_queues(self) -> list[deque[dict[str, str]]]:
        """보낼 닫힌 공백 대기열들(구역마다 순서대로). 없앤 구역 것이 먼저(더 오래됐다)."""
        return [self.retired_pending, *(s.feed.gaps.pending for s in self._all())]

    @property
    def gaps_pending(self) -> int:
        return sum(len(q) for q in self.pending_queues())

    @property
    def state(self) -> str:
        if not self.active:
            return "starting"
        return max((f.state for f in self.feeds()), key=lambda st: STATE_RANK.get(st, 0))

    @property
    def connected(self) -> bool:
        return bool(self.active) and all(f.connected for f in self.feeds())

    @property
    def connected_since(self) -> float | None:
        if not self.connected:
            return None
        times = [f.connected_since for f in self.feeds()]
        return None if any(t is None for t in times) else max(t for t in times if t is not None)

    @property
    def last_msg_at(self) -> float | None:
        return max((f.last_msg_at for f in self.feeds() if f.last_msg_at is not None), default=None)

    def gap_open(self) -> tuple[float, str] | None:
        """열린 공백 중 가장 이른 것 (시작, 원인)."""
        best: tuple[float, str] | None = None
        for f in self.feeds():
            t = f.gaps.open_since
            if t is not None and (best is None or t < best[0]):
                best = (t, f.gaps.reason)
        return best

    def last_gap(self) -> dict[str, str] | None:
        out = _later(self.restored_last_gap, self.retired_last_gap)
        for s in self._all():
            out = _later(out, s.feed.gaps.last)
        return out

    @property
    def bbox(self) -> str:
        """구독한 영역 전체(구역마다 마지막으로 보낸 문자열을 '|' 로). fixture 는 'fixture:<파일명>', 구독 전·비활성은 빈 값."""
        return "|".join(f.bbox for f in self.feeds() if f.bbox)

    @property
    def deflate(self) -> bool | None:
        known = [f.deflate for f in self.feeds() if f.deflate is not None]
        return all(known) if known else None

    @property
    def backoff_s(self) -> float | None:
        waits = [f.backoff_s for f in self.feeds() if f.backoff_s is not None]
        return max(waits) if waits else None

    def _latest(self, attr: str) -> str:
        """구역들 중 가장 최근에 남은 문구(시각을 모르는 값은 가장 오래된 것으로 친다)."""
        found = [(getattr(f, attr + "_at") or float("-inf"), getattr(f, attr)) for f in self.feeds() if getattr(f, attr)]
        return max(found, key=lambda x: x[0])[1] if found else ""

    @property
    def last_error(self) -> str:
        return self._latest("last_error")

    @property
    def provider_error(self) -> str:
        return self._latest("provider_error")

    @property
    def msgs_per_s(self) -> float | None:
        rates = [s.msgs_per_s for s in self.active if s.msgs_per_s is not None]
        return sum(rates) if rates else None

    @property
    def lag_p50_s(self) -> float | None:
        lags = [s.lag_p50_s for s in self.active if s.lag_p50_s is not None]
        return max(lags) if lags else None

    def shards_view(self) -> list[dict[str, Any]]:
        out = []
        for s in self.active:
            f, g = s.feed, s.feed.gaps
            out.append(
                {
                    "scope": f.scope,
                    "state": f.state,
                    "connected": f.connected,
                    "last_msg_at": _iso(f.last_msg_at),
                    "msgs_per_s": None if s.msgs_per_s is None else round(s.msgs_per_s, 2),
                    "lag_p50_s": None if s.lag_p50_s is None else round(s.lag_p50_s, 1),
                    "gap_open_since": _iso(g.open_since),
                    "gap_reason": (g.reason or None) if g.open_since is not None else None,
                    "sessions_ended": f.sessions_ended,
                }
            )
        return out
