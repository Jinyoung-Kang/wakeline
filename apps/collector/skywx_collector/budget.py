"""외부 호출 예산 — Redis 한 곳에서(ADR-005). 키 budget:{provider}:{yyyymmdd}, Lua 로 원자적 예약.

Redis 장애 시 예약은 예외를 올리지 않는다(실시간 경로 보호). 한도가 엄격한 공급자(strict: OpenSky 크레딧 등)는
예약할 수 없으면 호출하지 않고(fail closed), 나머지는 호출을 계속한다(fail open, 사용량은 기록되지 않음).
"""

from __future__ import annotations

import logging
import time
from collections.abc import Iterable
from datetime import UTC, datetime

from redis.asyncio import Redis

log = logging.getLogger("budget")

RESERVE_LUA = """
local used = tonumber(redis.call('HGET', KEYS[1], 'used') or '0')
local cost = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
if limit > 0 and used + cost > limit then
  return {0, used}
end
used = redis.call('HINCRBY', KEYS[1], 'used', cost)
redis.call('HSET', KEYS[1], 'limit', ARGV[2])
redis.call('EXPIRE', KEYS[1], ARGV[3])
return {1, used}
"""

UNKNOWN = -1  # 예약 결과의 사용량을 알 수 없음(Redis 장애)
DEFAULT_STRICT = frozenset({"opensky", "kma_radar"})


def day_key(provider: str, now: datetime | None = None) -> str:
    d = (now or datetime.now(UTC)).strftime("%Y%m%d")
    return f"budget:{provider}:{d}"


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

    async def _eval(self, key: str, cost: int, limit: int) -> tuple[int, int]:
        if self._sha is None:
            self._sha = await self._r.script_load(RESERVE_LUA)
        try:
            ok, used = await self._r.evalsha(self._sha, 1, key, cost, limit, 48 * 3600)
        except Exception:  # noqa: BLE001 — NOSCRIPT 등: 재로드 후 1회 재시도
            self._sha = await self._r.script_load(RESERVE_LUA)
            ok, used = await self._r.evalsha(self._sha, 1, key, cost, limit, 48 * 3600)
        return int(ok), int(used)

    async def reserve(self, provider: str, cost: int = 1) -> tuple[bool, int]:
        """(허용 여부, 예약 후 사용량). 한도 초과면 사용량은 그대로. Redis 장애면 사용량 UNKNOWN(-1)."""
        try:
            ok, used = await self._eval(day_key(provider), cost, self.limit(provider))
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

    async def usage(self, provider: str) -> tuple[int | None, int]:
        """(사용량 | None=알 수 없음, 한도)."""
        try:
            h = await self._r.hgetall(day_key(provider))
        except Exception as e:  # noqa: BLE001
            self._warn("usage", e)
            return None, self.limit(provider)
        return int(h.get("used", 0) or 0), int(h.get("limit", self.limit(provider)) or 0)
