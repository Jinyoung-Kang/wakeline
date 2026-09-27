"""외부 호출 예산 — Redis 한 곳에서(ADR-005). 키 budget:{provider}:{yyyymmdd}, Lua 로 원자적 예약."""

from __future__ import annotations

from datetime import UTC, datetime

from redis.asyncio import Redis

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


def day_key(provider: str, now: datetime | None = None) -> str:
    d = (now or datetime.now(UTC)).strftime("%Y%m%d")
    return f"budget:{provider}:{d}"


class Budget:
    def __init__(self, redis: Redis, limits: dict[str, int]):
        self._r = redis
        self._limits = limits
        self._sha: str | None = None

    async def reserve(self, provider: str, cost: int = 1) -> tuple[bool, int]:
        """(허용 여부, 예약 후 사용량). 한도 초과면 사용량은 그대로."""
        key = day_key(provider)
        limit = self._limits.get(provider, 0)
        if self._sha is None:
            self._sha = await self._r.script_load(RESERVE_LUA)
        try:
            ok, used = await self._r.evalsha(self._sha, 1, key, cost, limit, 48 * 3600)
        except Exception:  # NOSCRIPT 등 — 재로드 후 1회 재시도
            self._sha = await self._r.script_load(RESERVE_LUA)
            ok, used = await self._r.evalsha(self._sha, 1, key, cost, limit, 48 * 3600)
        return bool(int(ok)), int(used)

    async def release(self, provider: str, cost: int = 1) -> None:
        """예약했지만 호출하지 못한 몫을 되돌린다."""
        await self._r.hincrby(day_key(provider), "used", -cost)

    async def usage(self, provider: str) -> tuple[int, int]:
        h = await self._r.hgetall(day_key(provider))
        return int(h.get("used", 0) or 0), int(h.get("limit", self._limits.get(provider, 0)) or 0)
