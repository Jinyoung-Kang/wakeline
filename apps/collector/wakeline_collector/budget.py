"""외부 호출 예산 — Redis 한 곳에서(ADR-005). 키 budget:{provider}:{yyyymmdd}, Lua 로 원자적 예약.

Redis 장애 시 예약은 예외를 올리지 않는다(실시간 경로 보호). 한도가 엄격한 공급자(strict: OpenSky 크레딧 등)는
예약할 수 없으면 호출하지 않고(fail closed), 나머지는 호출을 계속한다(fail open, 사용량은 기록되지 않음).
headroom: 우선순위가 낮은 호출(focus·hot)은 한도에서 이만큼을 남겨 두고 멈춘다 — 저장되는 limit 은 그대로다.
시간 창(reserve_hour): 키 budget:{창}:h:{yyyymmddHH}(UTC 시 — KST 와 시 경계가 같다), 같은 Lua 로 예약한다. 프로세스 메모리가 아니라 Redis 에
세므로 재기동 · 두 번째 수집기도 같은 창을 센다. 창은 공급자 하나(교통 폴링 budget:komsa_traffic:h:*)이거나 여러 공급자가 나눠 세는 이름
(해양수산부 두 서비스 budget:mof:h:* — ADR-022 · ADR-023)이다. 어떤 24시간이든 UTC 시 창을 많아야 25개 걸치므로, 창 상한 × 25 가 포털 하루
한도 안이면 포털이 하루를 어느 경계(KST 자정 · UTC 자정 · 지난 24시간)로 세어도 넘지 않는다 — UTC 날 예산(day_key)만으로는 KST 하루가 두 UTC 날의
몫을 쓸 수 있다.
"""

from __future__ import annotations

import logging
import time
from collections.abc import Iterable
from contextvars import ContextVar
from datetime import UTC, datetime, timedelta
from typing import Any

from redis.asyncio import Redis
from redis.exceptions import NoScriptError

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

# 돌려주기(F3): 그 키가 있고 사용량이 cost 이상일 때만 뺀다 — 키를 만들지 않고(TTL 없는 키가 noeviction 에 남지 않게) 음수로 내리지 않는다
RELEASE_LUA = """
local used = tonumber(redis.call('HGET', KEYS[1], 'used'))
local cost = tonumber(ARGV[1])
if not used or used < cost then
  return 0
end
redis.call('HINCRBY', KEYS[1], 'used', -cost)
return 1
"""

UNKNOWN = -1  # 예약 결과의 사용량을 알 수 없음(Redis 장애)
# 공공데이터포털 세 서비스: 포털 하루 한도(ADR-023) · 입출항 색인(ADR-022 개정 — 기다리는 사람이 없는 배경 작업이라 셀 수 없으면 부르지 않는다)
DEFAULT_STRICT = frozenset({"opensky", "kma_radar", "komsa_traffic", "mof_grid4", "portmis"})


# 이 태스크가 공급자마다 마지막으로 예약한 하루 키(F3) — release 가 그 키에 돌려준다. 예약과 돌려주기는 같은 태스크에서 짝을 이룬다(보내지 않은
# 호출 · 다시 부르기 — 예약 바로 뒤). asyncio 태스크는 저마다 문맥을 가지므로 다른 작업의 예약과 섞이지 않는다(자정을 사이에 둔 두 작업도 제 날에).
# 값은 바꾸지 않고 새 dict 로만 갈아 끼운다(태스크가 만든 자식 태스크와 dict 를 함께 쓰지 않게)
_RESERVED: ContextVar[dict[str, str] | None] = ContextVar("wakeline_budget_reserved", default=None)


def day_key(provider: str, now: datetime | None = None) -> str:
    d = (now or datetime.now(UTC)).strftime("%Y%m%d")
    return f"budget:{provider}:{d}"


HOUR_TTL_S = 2 * 3600  # 시간 창 키는 그 시가 끝난 뒤 한 시간 더 남긴다(운영 확인용)


def hour_key(provider: str, now: datetime | None = None) -> str:
    """시간 창 예산 키(UTC 시). 하루 키 budget:{provider}:{yyyymmdd} 와 겹치지 않는다(':h:')."""
    return f"budget:{provider}:h:{(now or datetime.now(UTC)).astimezone(UTC).strftime('%Y%m%d%H')}"


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
        self._shas: dict[str, str] = {}  # 스크립트 → SCRIPT LOAD 한 sha
        self._last_log = 0.0

    def limit(self, provider: str) -> int:
        return self._limits.get(provider, 0)

    def _warn(self, what: str, e: Exception) -> None:
        now = time.monotonic()
        if now - self._last_log > 60:
            self._last_log = now
            log.warning("budget %s failed (%s) — redis unavailable?", what, type(e).__name__)

    async def _script(self, script: str, key: str, *args: int) -> Any:
        sha = self._shas.get(script)
        if sha is None:
            sha = self._shas[script] = await self._r.script_load(script)
        try:
            return await self._r.evalsha(sha, 1, key, *args)
        except NoScriptError:
            # 서버가 스크립트를 모른다(재시작 · SCRIPT FLUSH) — 다시 올리고 한 번만 더. 그 밖의 오류(시간 초과 · 연결 끊김)에는 다시 부르지 않는다:
            # 스크립트가 이미 돌고 응답만 잃었을 수 있어 두 번 예약한다(F4 — OpenSky 는 4크레딧씩). 호출자가 사용량 UNKNOWN 으로 받는다(reserve)
            sha = self._shas[script] = await self._r.script_load(script)
            return await self._r.evalsha(sha, 1, key, *args)

    async def _eval(self, key: str, cost: int, limit: int, headroom: int, ttl_s: int = 48 * 3600) -> tuple[int, int]:
        ok, used = await self._script(RESERVE_LUA, key, cost, limit, ttl_s, headroom)
        return int(ok), int(used)

    async def reserve(self, provider: str, cost: int = 1, *, headroom: int = 0) -> tuple[bool, int]:
        """(허용 여부, 예약 후 사용량). 한도 초과면 사용량은 그대로. Redis 장애면 사용량 UNKNOWN(-1).
        headroom > 0 이면 한도 - headroom 을 넘는 예약을 거절한다(한도가 0 = 무제한이면 무시)."""
        key = day_key(provider)
        try:
            ok, used = await self._eval(key, cost, self.limit(provider), max(0, headroom))
        except Exception as e:  # noqa: BLE001
            self._shas.clear()
            self._warn("reserve", e)
            return provider not in self._strict, UNKNOWN
        if ok:
            _RESERVED.set({**(_RESERVED.get() or {}), provider: key})  # 돌려줄 때 이 날 키에(release)
        return bool(ok), used

    async def reserve_hour(
        self,
        provider: str,
        limit: int,
        cost: int = 1,
        *,
        now: datetime | None = None,
        window: str | None = None,
        headroom: int = 0,
    ) -> tuple[bool, int, str]:
        """시간 창 예약: (허용 여부, 예약 후 사용량, 키). 되돌릴 때는 이 키를 release_key 에 준다(시 경계를 넘겨도 예약한 창에서 뺀다).
        window: 여러 공급자가 나눠 세는 창 이름(키 budget:{window}:h:…) — 없으면 공급자 이름. headroom > 0 이면 limit − headroom 을 넘는 예약을
        거절한다(우선순위가 낮은 공급자가 높은 쪽 몫을 남긴다 — reserve 와 같은 규칙). 저장되는 limit 은 그대로다.
        Redis 장애면 사용량 UNKNOWN — 엄격함은 창이 아니라 부른 공급자로 정한다(reserve 와 같은 규칙)."""
        key = hour_key(window or provider, now)
        try:
            ok, used = await self._eval(key, cost, limit, max(0, headroom), HOUR_TTL_S)
            return bool(ok), used, key
        except Exception as e:  # noqa: BLE001
            self._shas.clear()
            self._warn("reserve", e)
            return provider not in self._strict, UNKNOWN, key

    async def release_key(self, key: str, cost: int = 1) -> None:
        """reserve_hour 로 예약했지만 호출하지 못한 몫을 그 키에서 되돌린다."""
        try:
            await self._r.hincrby(key, "used", -cost)
        except Exception as e:  # noqa: BLE001
            self._warn("release", e)

    async def release(self, provider: str, cost: int = 1) -> None:
        """예약했지만 호출하지 못한 몫을 그 예약의 하루 키에 되돌린다 — 00:00Z 를 넘겨도 예약한 날에서 뺀다(F3: 전에는 돌려줄 때의 날 키에서 빼
        새 날이 used=-1 · TTL 없는 키가 됐다). 이 태스크가 그 공급자를 예약한 적이 없으면 오늘 키. 키가 없거나 사용량이 cost 보다 적으면 아무것도
        하지 않는다(RELEASE_LUA)."""
        key = (_RESERVED.get() or {}).get(provider) or day_key(provider)
        try:
            await self._script(RELEASE_LUA, key, cost)
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
