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

발행이 실패하는 동안의 위치(ADR-033 · 계약 v5 §G46 — QA 2026-10 신뢰성 개선 제안 2): 발행(sink)이 실패를 알리면(hold) 그때부터 MMSI 별로 60 s 창
(에포크 정렬 — api ShipRepository.WINDOW_S 와 같은 창)마다 처음 받아들인 위치 하나를 받은 순서대로 모은다. api 는 창마다 첫 보고 하나만 저장하므로
이것이 장애가 없었다면 DB 에 들어갔을 행과 같다(첫 줄은 보내지 못한 그 발행의 최신값 — 그 창에서 받은 마지막 위치일 수 있다). 예전에는 '바뀜' 표시만
되돌려 복구 뒤 최신값 하나만 실렸다 — redis 150 s pause 에서 분당 선박 행이 244–284 → 116 · 137 로 줄고 그 빈 곳을 설명하는 기록도 없었다.
모으는 수 상한 BACKFILL_MAX(위치 튜플 참조 — 하나 ≈ 350 B, 상한에서 ≈ 35 MB · 운영 2026-10-03 의 분당 표본 ≈ 2,700 으로 ≈ 37분). 넘으면 더 모으지
않고 (MMSI, 창) 수와 처음 모으지 못한 위치의 시각을 센다 — sink 가 복구 뒤 그 시각부터 공백(ais_gap, 구역 없음)으로 남긴다. 다 보낸 뒤(release) 모으기를 끝낸다.
"""

from __future__ import annotations

import time
from collections import OrderedDict, deque
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
BACKFILL_WINDOW_S = 60  # api ShipRepository.WINDOW_S — MMSI 별 창마다 첫 보고 하나(DB 의 줄이기와 같은 창)
BACKFILL_MAX = 100_000  # 발행이 실패하는 동안 모으는 분당 위치 상한(tools/contract_check.py 의 영수증 표식 상한 계산이 읽는다)
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
        backfill_max: int = BACKFILL_MAX,
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
        # 발행 실패 동안의 분당 위치(hold → release)
        self.backfill_max = backfill_max
        self.holding = False
        self._backlog: deque[tuple[Any, ...]] = deque()
        self._sampled: dict[str, int] = {}  # 모으는 동안 MMSI → 표본을 고른(또는 상한으로 버린) 마지막 창
        self.backfill_dropped = 0  # 이번 장애에서 상한 때문에 모으지 못한 (MMSI, 창) 수
        self.backfill_dropped_since: float | None = None  # 처음 모으지 못한 위치의 수신 시각(epoch)
        self.backfill_dropped_total = 0  # 누계(상태 해시)

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
        if self.holding:
            self._sample(p.mmsi, state, p.t)
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

    # ── 발행 실패 동안의 분당 위치 ──────────────────────────────

    @property
    def backlog(self) -> int:
        """모아 두고 아직 보내지 못한 위치 수."""
        return len(self._backlog)

    def hold(self, state_mmsis: Iterable[str]) -> None:
        """발행이 실패했다 — 이때부터 분당 첫 위치를 모은다. state_mmsis: 보내지 못한 선박(그 최신 위치가 표본의 첫 줄)."""
        self.holding = True
        for m in state_mmsis:
            ship = self._ships.get(m)
            if ship is not None and ship.state is not None:
                self._sample(m, ship.state, ship.t)

    def _sample(self, mmsi: str, state: tuple[Any, ...], t: float) -> None:
        w = int(t // BACKFILL_WINDOW_S)
        last = self._sampled.get(mmsi)
        if last is not None and w <= last:
            return  # 이 창은 이미 골랐다(또는 버렸다)
        self._sampled[mmsi] = w
        if len(self._backlog) >= self.backfill_max:
            self.backfill_dropped += 1
            self.backfill_dropped_total += 1
            if self.backfill_dropped_since is None or t < self.backfill_dropped_since:
                self.backfill_dropped_since = t
            return
        self._backlog.append(state)

    def take_backfill(self) -> list[dict[str, Any]]:
        """모은 위치를 받은 순서대로 모두 꺼낸다(모으기는 계속 — 그 사이 받은 위치는 새로 쌓인다)."""
        out = [dict(zip(STATE_FIELDS, s, strict=True)) for s in self._backlog]
        self._backlog.clear()
        return out

    def return_backfill(self, unsent: list[dict[str, Any]]) -> None:
        """보내지 못한 위치를 맨 앞으로 되돌린다(순서 그대로 — 그 뒤에 새로 쌓인 것보다 먼저 보낸다)."""
        self._backlog.extendleft(tuple(d[f] for f in STATE_FIELDS) for d in reversed(unsent))

    def release(self) -> tuple[int, float | None]:
        """모으기를 끝낸다(모은 것을 다 보냈고 최신값 발행도 됐다). 반환: (상한 때문에 모으지 못한 수, 처음 그런 위치의 시각)."""
        dropped, since = self.backfill_dropped, self.backfill_dropped_since
        self.holding = False
        self._backlog.clear()
        self._sampled.clear()
        self.backfill_dropped, self.backfill_dropped_since = 0, None
        return dropped, since

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
