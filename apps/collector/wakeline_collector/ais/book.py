"""MMSI 별 최신 상태·정적 정보와 '바뀐 선박' 표시(dirty). 발행(sink)은 10 s 마다 바뀐 것만 꺼낸다(drain).

위치 품질 게이트(계약 v2 §B1 + 항공기 게이트와 같은 규칙 이름):
- position_jump: 직전에 받아들인 위치에서 60 s 안에 50 NM 넘게 움직였다 → 격리(발행하지 않음, 집계). 격리한 위치는 기준점이 되지
  않으므로, 잘못된 기준점 하나가 60 s 넘게 정상 위치를 막지 못한다.
- seen_in_future: 수신 시각이 지금보다 30 s 넘게 앞선다 → 격리.
- stale_position: 수신 시각이 600 s 넘게 지났다(대기열 적체 상한 ≈ 220 s 보다 넉넉함) → 격리.
- out_of_order(이미 받은 것보다 오래된 위치) · duplicate(같은 값) 는 격리가 아니라 대체된 것으로 센다.

메모리 상한: 선박 수 max_ships(LRU 제거) + 마지막 갱신 뒤 ttl_s 가 지난 선박 제거. 레코드는 튜플로 둔다(선박당 ≈ 1 KiB).

정적 정보의 받은 필드(계약 v5 §G19): 레코드는 재시작 · 제거 뒤 빈 것(14칸 None)에서 시작해 받은 조각만 채운다 — 메시지 5 는 14칸 모두, 24A 는 name,
24B 는 call_sign · ship_type · dim_*(보조 선박 98MIDxxxx 는 크기 없음), 19 는 name · ship_type · dim_*. 레코드가 시작된 뒤 실제로 받은 필드를 비트로 들고
있다가 발행 때 함께 꺼낸다(drain_received) — None 이 '받지 않음' 인지 '빈 값으로 받음'(선박이 비워 보냄)인지 api 가 가릴 수 있게. 받은 필드가 늘기만 해도
(값은 같은 None) '바뀜' 이다 — 빈 값으로 받은 칸이 저장값을 비우도록.
"""

from __future__ import annotations

import time
from collections import OrderedDict
from collections.abc import Callable, Iterable
from typing import Any

from wakeline_collector.ais.parse import STATIC_FIELDS, Position, StaticPart
from wakeline_collector.geo import haversine_nm

STATE_FIELDS = (
    "mmsi",
    "lat",
    "lon",
    "sog_kn",
    "cog_deg",
    "heading_deg",
    "nav_status",
    "rot",
    "position_source",
    "seen_at",
    "provider",
    "msg_type",
    "class",
)
QUARANTINE_RULES = ("position_jump", "seen_in_future", "stale_position")
_EMPTY_STATIC: tuple[Any, ...] = (None,) * len(STATIC_FIELDS)
_STATIC_INDEX = {f: i for i, f in enumerate(STATIC_FIELDS)}


def received_fields(mask: int) -> list[str]:
    """받은 필드 비트 → 필드 이름(STATIC_FIELDS 순서)."""
    return [f for i, f in enumerate(STATIC_FIELDS) if mask >> i & 1]


class _Ship:
    __slots__ = ("state", "t", "static", "static_recv", "static_at", "static_pub", "touched")

    def __init__(self, touched: float) -> None:
        self.state: tuple[Any, ...] | None = None
        self.t = 0.0  # 받아들인 마지막 위치의 수신 시각(epoch)
        self.static: tuple[Any, ...] | None = None
        self.static_recv = 0  # 이 레코드가 시작된 뒤 실제로 받은 정적 필드(STATIC_FIELDS 순서의 비트)
        self.static_at = ""  # 정적 정보(내용 또는 받은 필드)가 마지막으로 바뀐 메시지의 수신 시각(ISO)
        self.static_pub = float("-inf")  # 정적 정보를 마지막으로 꺼낸(발행한) 단조 시각
        self.touched = touched


class ShipBook:
    def __init__(
        self,
        provider: str,
        *,
        max_ships: int = 50_000,
        ttl_s: float = 1800.0,
        jump_nm: float = 50.0,
        jump_window_s: float = 60.0,
        future_s: float = 30.0,
        stale_s: float = 600.0,
        static_refresh_s: float = 1800.0,
        mono: Callable[[], float] = time.monotonic,
    ) -> None:
        self.provider = provider
        self.max_ships = max_ships
        self.ttl_s = ttl_s
        self.jump_nm = jump_nm
        self.jump_window_s = jump_window_s
        self.future_s = future_s
        self.stale_s = stale_s
        self.static_refresh_s = static_refresh_s  # 내용이 같아도 이 간격마다 한 번은 다시 싣는다(소비자 재시작 복구)
        self._mono = mono
        self._ships: OrderedDict[str, _Ship] = OrderedDict()
        self._dirty_state: set[str] = set()
        self._dirty_static: set[str] = set()
        self.evicted = 0

    def __len__(self) -> int:
        return len(self._ships)

    @property
    def dirty(self) -> tuple[int, int]:
        return len(self._dirty_state), len(self._dirty_static)

    def _touch(self, mmsi: str) -> _Ship:
        now = self._mono()
        ship = self._ships.get(mmsi)
        if ship is None:
            while len(self._ships) >= self.max_ships:
                self._pop_oldest()
            ship = self._ships[mmsi] = _Ship(now)
        else:
            self._ships.move_to_end(mmsi)
            ship.touched = now
        return ship

    def _pop_oldest(self) -> None:
        mmsi, _ = self._ships.popitem(last=False)
        self._dirty_state.discard(mmsi)
        self._dirty_static.discard(mmsi)
        self.evicted += 1

    def _time_gate(self, t: float, now: float) -> str | None:
        if t > now + self.future_s:
            return "seen_in_future"
        if t < now - self.stale_s:
            return "stale_position"
        return None

    def apply_position(self, p: Position, now: float) -> str:
        """결과: accepted · position_jump · seen_in_future · stale_position · out_of_order · duplicate."""
        rule = self._time_gate(p.t, now)
        if rule:
            return rule
        prev = self._ships.get(p.mmsi)
        if prev is not None and prev.state is not None:
            dt = p.t - prev.t
            if dt < 0:
                return "out_of_order"
            if dt <= self.jump_window_s and haversine_nm(prev.state[1], prev.state[2], p.lat, p.lon) > self.jump_nm:
                return "position_jump"
        state = (
            p.mmsi,
            p.lat,
            p.lon,
            p.sog_kn,
            p.cog_deg,
            p.heading_deg,
            p.nav_status,
            p.rot,
            p.position_source,
            p.seen_at,
            self.provider,
            p.msg_type,
            p.cls,
        )
        ship = self._touch(p.mmsi)
        if ship.state == state:
            return "duplicate"
        ship.state, ship.t = state, p.t
        self._dirty_state.add(p.mmsi)
        return "accepted"

    def apply_static(self, part: StaticPart, now: float) -> str:
        """결과: changed · refresh(내용 같음, 재발행 주기 도달) · unchanged · seen_in_future · stale_position."""
        rule = self._time_gate(part.t, now)
        if rule:
            return rule
        ship = self._touch(part.mmsi)
        old = ship.static or _EMPTY_STATIC
        new = list(old)
        recv = ship.static_recv
        for k, v in part.fields.items():
            i = _STATIC_INDEX.get(k)
            if i is not None:
                new[i] = v
                recv |= 1 << i
        merged = tuple(new)
        if ship.static is None or merged != ship.static or recv != ship.static_recv:
            ship.static, ship.static_recv, ship.static_at = merged, recv, part.seen_at
            self._dirty_static.add(part.mmsi)
            return "changed"
        if self._mono() - ship.static_pub >= self.static_refresh_s:
            self._dirty_static.add(part.mmsi)
            return "refresh"
        return "unchanged"

    def drain(self) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
        """바뀐 선박의 최신 상태·정적 정보를 꺼내고 표시를 지운다."""
        states, statics, _ = self.drain_received()
        return states, statics

    def drain_received(self) -> tuple[list[dict[str, Any]], list[dict[str, Any]], dict[str, list[str]]]:
        """drain + 꺼낸 정적 정보마다 이 레코드가 시작된 뒤 받은 필드(MMSI → 필드 이름, STATIC_FIELDS 순서 — 계약 v5 §G19)."""
        now = self._mono()
        states: list[dict[str, Any]] = []
        statics: list[dict[str, Any]] = []
        received: dict[str, list[str]] = {}
        for mmsi in self._dirty_state:
            ship = self._ships.get(mmsi)
            if ship is not None and ship.state is not None:
                states.append(dict(zip(STATE_FIELDS, ship.state, strict=True)))
        for mmsi in self._dirty_static:
            ship = self._ships.get(mmsi)
            if ship is not None and ship.static is not None:
                d: dict[str, Any] = {"mmsi": mmsi, **dict(zip(STATIC_FIELDS, ship.static, strict=True))}
                d["updated_at"], d["provider"] = ship.static_at, self.provider
                statics.append(d)
                received[mmsi] = received_fields(ship.static_recv)
                ship.static_pub = now
        self._dirty_state.clear()
        self._dirty_static.clear()
        return states, statics, received

    def mark_dirty(self, state_mmsis: Iterable[str], static_mmsis: Iterable[str]) -> None:
        """발행 실패분을 다시 표시한다 — 다음 발행이 그때의 최신값을 싣는다(낡은 변경분을 쌓아 두지 않는다)."""
        for m in state_mmsis:
            if m in self._ships:
                self._dirty_state.add(m)
        for m in static_mmsis:
            if m in self._ships:
                self._dirty_static.add(m)

    def evict(self) -> int:
        """마지막 갱신 뒤 ttl_s 가 지난 선박을 지운다(LRU 앞쪽부터)."""
        cutoff = self._mono() - self.ttl_s
        n = 0
        while self._ships:
            ship = next(iter(self._ships.values()))
            if ship.touched >= cutoff:
                break
            self._pop_oldest()
            n += 1
        return n
