"""외부 호출 예산 — Redis 한 곳에서(ADR-005). 키 budget:{provider}:{yyyymmdd}, Lua 로 원자적 예약.

Redis 장애 시 예약은 예외를 올리지 않는다(실시간 경로 보호). 한도가 엄격한 공급자(strict: OpenSky 크레딧 등)는
예약할 수 없으면 호출하지 않고(fail closed), 나머지는 호출을 계속한다(fail open, 사용량은 기록되지 않음).
headroom: 우선순위가 낮은 호출(focus·hot)은 한도에서 이만큼을 남겨 두고 멈춘다 — 저장되는 limit 은 그대로다.
"""

from __future__ import annotations

import logging
import time
from collections.abc import Iterable
from datetime import UTC, datetime, timedelta

from redis.asyncio import Redis

log = logging.getLogger("budget")

RESERVE_LUA = """
local used = tonumber(redis.call('HGET', KEYS[1], 'used') or '0')
local cost = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
local headroom = tonumber(ARGV[4] or '0')
if limit > 0 and used + cost > limit - headroom then
  return {0, used}
end
used = redis.call('HINCRBY', KEYS[1], 'used', cost)
redis.call('HSET', KEYS[1], 'limit', ARGV[2])
redis.call('EXPIRE', KEYS[1], ARGV[3])
return {1, used}
"""

UNKNOWN = -1  # 예약 결과의 사용량을 알 수 없음(Redis 장애)
DEFAULT_STRICT = frozenset(
    {"opensky", "kma_radar", "komsa_traffic", "mof_grid4"}
)  # 공공데이터포털 두 서비스: 포털 하루 한도(ADR-023)


def day_key(provider: str, now: datetime | None = None) -> str:
    d = (now or datetime.now(UTC)).strftime("%Y%m%d")
    return f"budget:{provider}:{d}"


def regular_headroom(schedule: Iterable[tuple[float, int]], now: datetime) -> int:
    """정규 주기가 예산 날(UTC — day_key)이 끝날 때까지 더 쓸 수 있는 최대 호출 수: Σ (남은 초 // 주기 + 1) × 주기당 호출 수.
    schedule = (주기 초, 주기당 호출 수) 목록 — 지금 주기 설정으로 계산한 상한이다(잰 값이 아니다). run_periodic 은 주기가 끝난 뒤
    주기만큼 쉬므로 남은 주기는 남은 초 // 주기 + 1(지금 돌거나 곧 시작할 주기 하나) 이하다. 우선순위가 낮은 추가 호출(기상 작업의 다시
    부르기 · KMA 부분 합성 다시 받기)은 이 값을 headroom 으로 예약한다 — 사용량 + 1 ≤ 한도 − 이 값일 때만 부르므로 정규 주기가 예산 소진으로
    막히지 않는다."""
    now = now.astimezone(UTC)
    left = ((now + timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0) - now).total_seconds()
    return sum((int(left // period) + 1) * calls for period, calls in schedule)


class Budget:
    def __init__(self, redis: Redis, limits: dict[str, int], strict: Iterable[str] = DEFAULT_STRICT):
        self._r = redis
        self._limits = limits
        self._strict = frozenset(strict)
        self._sha: str | None = None
        self._last_log = 0.0

    def limit(self, provider: str) -> int:
        return self._limits.get(provider, 0)

    def _warn(self, what: str, e: Exception) -> None:
        now = time.monotonic()
        if now - self._last_log > 60:
            self._last_log = now
            log.warning("budget %s failed (%s) — redis unavailable?", what, type(e).__name__)

    async def _eval(self, key: str, cost: int, limit: int, headroom: int) -> tuple[int, int]:
        if self._sha is None:
            self._sha = await self._r.script_load(RESERVE_LUA)
        try:
            ok, used = await self._r.evalsha(self._sha, 1, key, cost, limit, 48 * 3600, headroom)
        except Exception:  # noqa: BLE001 — NOSCRIPT 등: 재로드 후 1회 재시도
            self._sha = await self._r.script_load(RESERVE_LUA)
            ok, used = await self._r.evalsha(self._sha, 1, key, cost, limit, 48 * 3600, headroom)
        return int(ok), int(used)

    async def reserve(self, provider: str, cost: int = 1, *, headroom: int = 0) -> tuple[bool, int]:
        """(허용 여부, 예약 후 사용량). 한도 초과면 사용량은 그대로. Redis 장애면 사용량 UNKNOWN(-1).
        headroom > 0 이면 한도 - headroom 을 넘는 예약을 거절한다(한도가 0 = 무제한이면 무시)."""
        try:
            ok, used = await self._eval(day_key(provider), cost, self.limit(provider), max(0, headroom))
            return bool(ok), used
        except Exception as e:  # noqa: BLE001
            self._sha = None
            self._warn("reserve", e)
            return provider not in self._strict, UNKNOWN

    async def release(self, provider: str, cost: int = 1) -> None:
        """예약했지만 호출하지 못한 몫을 되돌린다."""
        try:
            await self._r.hincrby(day_key(provider), "used", -cost)
        except Exception as e:  # noqa: BLE001
            self._warn("release", e)

    async def usage(self, provider: str, day: datetime | None = None) -> tuple[int | None, int]:
        """(사용량 | None=알 수 없음, 한도). day: 그 UTC 날짜의 키(기본 오늘)."""
        try:
            h = await self._r.hgetall(day_key(provider, day))
        except Exception as e:  # noqa: BLE001
            self._warn("usage", e)
            return None, self.limit(provider)
        return int(h.get("used", 0) or 0), int(h.get("limit", self.limit(provider)) or 0)

    async def recorded_usage(self, provider: str, day: datetime) -> tuple[int, int] | None:
        """그 날짜 키가 남아 있으면(TTL 48 h) (사용량, 한도). 키가 없거나 Redis 장애면 None — 모르는 값을 0 으로 만들지 않는다."""
        try:
            h = await self._r.hgetall(day_key(provider, day))
        except Exception as e:  # noqa: BLE001
            self._warn("usage", e)
            return None
        if not h:
            return None
        return int(h.get("used", 0) or 0), int(h.get("limit", self.limit(provider)) or 0)
