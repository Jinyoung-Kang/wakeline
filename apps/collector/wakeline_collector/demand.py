"""수요 임대(lease) 읽기 · 수요 상태 쓰기 (ADR-013, 계약 v2 §A1·§A2).

임대는 api 만 쓴다. 수집기는 읽기만 한다(Redis ACL %R~wakeline:demand:{hot,focus}[:meta]).
- ZSET wakeline:demand:hot    member = cellKey "{lat:.1f}:{lon:.1f}:{radius}"   score = 만료 epoch ms
- HASH wakeline:demand:hot:meta    field = cellKey → JSON {lat, lon, radius_nm, sessions, first_at}
- ZSET wakeline:demand:focus  member = hex(6자리 소문자)                        score = 만료 epoch ms
- HASH wakeline:demand:focus:meta  field = hex → JSON {sessions, first_at, callsign?}
임대 값은 믿지 않는다: 형식·범위를 다시 검증하고 상한(hot 6셀 · focus 50대)도 수집기에서 다시 건다. 셀 좌표·반경은
meta 가 아니라 검증한 cellKey 에서 읽는다(meta 는 순위용 sessions·first_at 과 focus 의 callsign 만 쓴다).
focus meta 의 callsign(계약 v4 G A-1) = api 가 화면에 보이는 콜사인을 정규화한 값 — 노선 조회에 쓴다. 같은 규칙
(route.normalize_callsign)으로 다시 검사하고, 틀리면 없는 것으로 본다.
Redis 를 못 읽으면 마지막으로 읽은 임대를 각자의 만료 시각까지만 쓴다(임대는 60 s 로 짧다 → 창을 닫으면 최대 60 s 안에 멈춘다).

수요 상태(수집기만 씀): HASH wakeline:demand:status, field focus:{hex} / hot:{cellKey} →
JSON {state, interval_s, last_success_at, last_error, provider}. 임대가 사라진 필드는 지운다(TTL 없음).
"""

from __future__ import annotations

import asyncio
import logging
import math
import re
import time
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

import orjson
from redis.asyncio import Redis

from wakeline_collector.masking import mask
from wakeline_collector.route import normalize_callsign
from wakeline_collector.status import AUX_TIMEOUT_S

log = logging.getLogger("demand")

HOT_KEY = "wakeline:demand:hot"
HOT_META_KEY = "wakeline:demand:hot:meta"
FOCUS_KEY = "wakeline:demand:focus"
FOCUS_META_KEY = "wakeline:demand:focus:meta"
STATUS_KEY = "wakeline:demand:status"

MAX_HOT_CELLS = 6  # 계약 v2 §A1 상한(api 가 쓸 때 걸고, 수집기가 다시 건다)
MAX_FOCUS_HEXES = 50
HOT_READ_MAX = 64  # ZRANGEBYSCORE LIMIT — 임대가 비정상적으로 많아도 읽는 양은 고정
FOCUS_READ_MAX = 256
META_MAX_BYTES = 1024
STATUS_ERROR_MAX = 200

HEX_RE = re.compile(r"^[0-9a-f]{6}$")
# schemas/stream_envelope.v1.json aircraft_payload.cell 과 같은 패턴(0.5° 격자, 반경 50 NM 단위 50–250)
CELL_RE = re.compile(r"^(-?[0-9]{1,2}\.[05]):(-?[0-9]{1,3}\.[05]):(50|100|150|200|250)$")

# wakeline:demand:status 의 state 값 — api CollectorDemandStatus.STATES 와 같은 집합(다른 값은 api 가 버린다, R-22)
STATES = frozenset({"active", "throttled", "not_found", "error", "disabled"})


def parse_cell_key(key: str) -> tuple[float, float, int] | None:
    """'35.5:139.5:150' → (35.5, 139.5, 150). 형식·범위(lat ±85, lon ±180)가 맞지 않으면 None."""
    if not isinstance(key, str):
        return None
    m = CELL_RE.fullmatch(key)
    if m is None:
        return None
    lat, lon, radius = float(m.group(1)), float(m.group(2)), int(m.group(3))
    if not (-85.0 <= lat <= 85.0 and -180.0 <= lon <= 180.0):
        return None
    return lat, lon, radius


def _epoch_ms(v: Any) -> float:
    """first_at → epoch ms. 숫자는 1e11 이상이면 ms, 아니면 초로 읽는다(현재 시각 기준 두 단위가 겹치지 않는다).
    ISO-8601 문자열도 받는다. 읽을 수 없으면 +inf(순위 맨 뒤)."""
    if isinstance(v, bool):
        return math.inf
    if isinstance(v, int | float) and math.isfinite(v) and v > 0:
        return float(v) if v >= 1e11 else float(v) * 1000.0
    if isinstance(v, str) and 0 < len(v) <= 40:
        try:
            dt = datetime.fromisoformat(v.replace("Z", "+00:00"))
        except ValueError:
            return math.inf
        if dt.tzinfo is not None:
            return dt.timestamp() * 1000.0
    return math.inf


def _meta_doc(raw: Any) -> dict[str, Any] | None:
    if not isinstance(raw, str) or not raw or len(raw) > META_MAX_BYTES:
        return None
    try:
        d = orjson.loads(raw)
    except orjson.JSONDecodeError:
        return None
    return d if isinstance(d, dict) else None


def _rank_fields(d: dict[str, Any] | None) -> tuple[int, float]:
    if d is None:
        return 0, math.inf
    s = d.get("sessions")
    sessions = s if isinstance(s, int) and not isinstance(s, bool) and 0 <= s <= 1_000_000 else 0
    return sessions, _epoch_ms(d.get("first_at"))


def parse_meta(raw: Any) -> tuple[int, float]:
    """meta JSON → (sessions, first_at epoch ms). 이상하면 (0, +inf) — 순위에만 쓰므로 버리지 않는다."""
    return _rank_fields(_meta_doc(raw))


def parse_focus_meta(raw: Any) -> tuple[int, float, str | None]:
    """focus meta JSON → (sessions, first_at epoch ms, callsign | None). callsign 은 api 와 같은 규칙으로 다시 검사한다."""
    d = _meta_doc(raw)
    sessions, first_at = _rank_fields(d)
    return sessions, first_at, normalize_callsign(d.get("callsign")) if d is not None else None


@dataclass(frozen=True)
class HotCell:
    key: str
    lat: float
    lon: float
    radius_nm: int
    expires_ms: float
    sessions: int = 0
    first_at_ms: float = math.inf

    @property
    def field(self) -> str:
        return f"hot:{self.key}"


@dataclass(frozen=True)
class FocusLease:
    hex: str
    expires_ms: float
    sessions: int = 0
    first_at_ms: float = math.inf
    callsign: str | None = None  # api 가 meta 에 적은 콜사인(정규화·재검사한 값, 노선 조회용)

    @property
    def field(self) -> str:
        return f"focus:{self.hex}"


def _rank(items: Iterable[Any], key_attr: str) -> list[Any]:
    """세션 수 많은 순 → 먼저 요청된 순 → 키 순(결정적)."""
    return sorted(items, key=lambda x: (-x.sessions, x.first_at_ms, getattr(x, key_attr)))


@dataclass(frozen=True)
class Demand:
    hot: tuple[HotCell, ...] = ()
    focus: tuple[FocusLease, ...] = ()
    ignored_hot: int = 0  # 형식 오류 + 상한 초과로 쓰지 않은 임대 수(지표)
    ignored_focus: int = 0

    def alive(self, now_ms: float) -> Demand:
        return Demand(
            hot=tuple(c for c in self.hot if c.expires_ms > now_ms),
            focus=tuple(f for f in self.focus if f.expires_ms > now_ms),
            ignored_hot=self.ignored_hot,
            ignored_focus=self.ignored_focus,
        )

    @property
    def focus_hexes(self) -> list[str]:
        return [f.hex for f in self.focus]

    @property
    def fields(self) -> set[str]:
        return {c.field for c in self.hot} | {f.field for f in self.focus}


class DemandPoller:
    """임대를 읽는다(초당 1회). 쓰기 명령은 하나도 쓰지 않는다."""

    def __init__(self, redis: Redis, *, now_ms: Callable[[], float] | None = None):
        self._r = redis
        self._now_ms = now_ms or (lambda: time.time() * 1000.0)
        self._current = Demand()
        self._last_log = 0.0
        self.errors = 0

    @property
    def current(self) -> Demand:
        return self._current.alive(self._now_ms())

    def _warn(self, e: Exception) -> None:
        self.errors += 1
        now = time.monotonic()
        if now - self._last_log > 60:
            self._last_log = now
            log.warning("demand lease read failed (%s) — using last leases until they expire", type(e).__name__)

    async def poll(self) -> Demand:
        now_ms = self._now_ms()
        try:
            pipe = self._r.pipeline(transaction=False)
            pipe.zrangebyscore(HOT_KEY, now_ms, "+inf", start=0, num=HOT_READ_MAX, withscores=True)
            pipe.zrangebyscore(FOCUS_KEY, now_ms, "+inf", start=0, num=FOCUS_READ_MAX, withscores=True)
            hot_raw, focus_raw = await pipe.execute()
            hot_ok = [(m, float(s)) for m, s in hot_raw or [] if parse_cell_key(m) is not None]
            focus_ok = [(m, float(s)) for m, s in focus_raw or [] if isinstance(m, str) and HEX_RE.fullmatch(m)]
            pipe = self._r.pipeline(transaction=False)
            if hot_ok:
                pipe.hmget(HOT_META_KEY, [m for m, _ in hot_ok])
            if focus_ok:
                pipe.hmget(FOCUS_META_KEY, [m for m, _ in focus_ok])
            metas = await pipe.execute() if (hot_ok or focus_ok) else []
        except Exception as e:  # noqa: BLE001 — 임대를 못 읽어도 수집기는 계속(마지막 임대를 만료까지)
            self._warn(e)
            self._current = self._current.alive(now_ms)
            return self._current
        hot_meta = metas.pop(0) if hot_ok else []
        focus_meta = metas.pop(0) if focus_ok else []
        cells: list[HotCell] = []
        for (key, score), raw in zip(hot_ok, hot_meta, strict=True):
            lat, lon, radius = parse_cell_key(key)  # type: ignore[misc]  # 위에서 검증
            sessions, first_at = parse_meta(raw)
            cells.append(HotCell(key, lat, lon, radius, score, sessions, first_at))
        leases: list[FocusLease] = []
        for (hex_, score), raw in zip(focus_ok, focus_meta, strict=True):
            sessions, first_at, callsign = parse_focus_meta(raw)
            leases.append(FocusLease(hex_, score, sessions, first_at, callsign))
        cells, leases = _rank(cells, "key"), _rank(leases, "hex")
        self._current = Demand(
            hot=tuple(cells[:MAX_HOT_CELLS]),
            focus=tuple(leases[:MAX_FOCUS_HEXES]),
            ignored_hot=len(hot_raw or []) - len(cells[:MAX_HOT_CELLS]),
            ignored_focus=len(focus_raw or []) - len(leases[:MAX_FOCUS_HEXES]),
        )
        return self._current


def _iso(dt: datetime | None) -> str | None:
    return dt.astimezone(UTC).isoformat().replace("+00:00", "Z") if dt else None


def status_value(
    state: str, interval_s: int | None, last_success_at: datetime | None, last_error: str | None, provider: str
) -> dict[str, Any]:
    """interval_s None = 조회가 돌지 않아 주기가 없다(예: 운영자가 공급자를 끔). state 는 STATES 중 하나."""
    if state not in STATES:
        raise ValueError(f"unknown demand state {state!r}")
    return {
        "state": state,
        "interval_s": interval_s,
        "last_success_at": _iso(last_success_at),
        "last_error": (mask(last_error) or "")[:STATUS_ERROR_MAX] or None,
        "provider": provider,
    }


class DemandStatus:
    """wakeline:demand:status 쓰기. 부가 기능이라 Redis 오류는 삼킨다(분당 1회 경고)."""

    def __init__(self, redis: Redis):
        self._r = redis
        self._fields: set[str] = set()
        self._synced = False
        self._last_log = 0.0
        self.errors = 0

    def _warn(self, what: str, e: Exception) -> None:
        self.errors += 1
        now = time.monotonic()
        if now - self._last_log > 60:
            self._last_log = now
            log.warning("demand status %s failed (%s)", what, type(e).__name__)

    async def put(self, values: dict[str, dict[str, Any]]) -> None:
        if not values:
            return
        try:
            async with asyncio.timeout(AUX_TIMEOUT_S):
                await self._r.hset(STATUS_KEY, mapping={k: orjson.dumps(v).decode() for k, v in values.items()})
            self._fields.update(values)
        except Exception as e:  # noqa: BLE001
            self._warn("hset", e)

    async def delete(self, fields: list[str]) -> None:
        if not fields:
            return
        try:
            async with asyncio.timeout(AUX_TIMEOUT_S):
                await self._r.hdel(STATUS_KEY, *fields)
            self._fields.difference_update(fields)
        except Exception as e:  # noqa: BLE001
            self._warn("hdel", e)

    async def prune(self, active: set[str]) -> None:
        """임대가 사라진 필드를 지운다. 처음 한 번은 이전 프로세스가 남긴 필드까지(HKEYS)."""
        try:
            async with asyncio.timeout(AUX_TIMEOUT_S):
                if not self._synced:
                    keys = await self._r.hkeys(STATUS_KEY)
                    self._fields.update(k if isinstance(k, str) else k.decode() for k in keys)
                    self._synced = True
                stale = self._fields - active
                if stale:
                    await self._r.hdel(STATUS_KEY, *sorted(stale))
                    self._fields -= stale
        except Exception as e:  # noqa: BLE001
            self._warn("prune", e)
