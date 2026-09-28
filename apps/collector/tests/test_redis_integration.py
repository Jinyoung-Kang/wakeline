"""실 Redis 대조(선택 실행): WAKELINE_TEST_REDIS_URL(관리자 접속, 예: redis://:pw@127.0.0.1:56379/0)이 있을 때만.

가짜 Redis 로는 확인할 수 없는 것 — 예산 Lua(여유분 인자) · 임대 읽기(ZRANGEBYSCORE LIMIT WITHSCORES · HMGET 파이프라인) ·
수요 상태 HSET/HKEYS/HDEL · 노선 캐시 SET EX/EXISTS(계약 v4 §A) · ACL(infra/redis/start.sh 의 수집기 규칙: 임대는 읽기 전용).
실행: docker run --rm -d -p 127.0.0.1:56379:6379 redis:8-alpine --requirepass pw
      WAKELINE_TEST_REDIS_URL=redis://:pw@127.0.0.1:56379/0 uv run pytest tests/test_redis_integration.py
"""

from __future__ import annotations

import os
import time
import uuid
from datetime import UTC, datetime

import orjson
import pytest
from acl_rules import service_acl_rules
from redis.asyncio import Redis
from redis.exceptions import NoPermissionError

from wakeline_collector.budget import Budget, day_key
from wakeline_collector.demand import FOCUS_KEY, FOCUS_META_KEY, HOT_KEY, HOT_META_KEY, STATUS_KEY, DemandPoller, DemandStatus
from wakeline_collector.jobs.route import RouteLookup
from wakeline_collector.providers.adsbdb import RouteFetch
from wakeline_collector.route import not_found, route_key
from wakeline_collector.status import ProviderStatus

URL = os.environ.get("WAKELINE_TEST_REDIS_URL", "")
pytestmark = pytest.mark.skipif(not URL, reason="WAKELINE_TEST_REDIS_URL not set (opt-in real Redis check)")

# infra/redis/start.sh 가 wakeline_collector 에게 주는 규칙 그대로(복사하지 않는다 — R-41)
COLLECTOR_RULES = ["on", *service_acl_rules("wakeline_collector")]


@pytest.fixture
async def admin():
    r = Redis.from_url(URL, decode_responses=True)
    keys = (HOT_KEY, HOT_META_KEY, FOCUS_KEY, FOCUS_META_KEY, STATUS_KEY, day_key("itest"), day_key("adsbdb"))
    keys += (route_key("ZZX123"), route_key("ZZX124"), "wakeline:provider:adsbdb")
    await r.delete(*keys)
    yield r
    await r.delete(*keys)
    await r.aclose()


@pytest.fixture
async def collector(admin):
    user, pw = f"itest_{uuid.uuid4().hex[:8]}", uuid.uuid4().hex
    await admin.execute_command("ACL", "SETUSER", user, "reset", f">{pw}", *COLLECTOR_RULES)
    host = admin.connection_pool.connection_kwargs["host"]
    port = admin.connection_pool.connection_kwargs["port"]
    r = Redis(host=host, port=port, username=user, password=pw, decode_responses=True)
    yield r
    await r.aclose()
    await admin.execute_command("ACL", "DELUSER", user)


async def test_budget_lua_headroom_on_real_redis(admin, collector):
    b = Budget(collector, {"itest": 5})
    got = [await b.reserve("itest", headroom=3) for _ in range(3)]
    assert got == [(True, 1), (True, 2), (False, 2)]
    assert await b.reserve("itest") == (True, 3)
    assert await b.usage("itest") == (3, 5)
    # Lua 가 수집기 권한으로 EXPIRE 를 걸었는지(TTL 조회는 수집기가 쓰지 않는 명령이라 관리자로 본다)
    assert 0 < await admin.ttl(day_key("itest")) <= 48 * 3600


async def test_poller_reads_leases_and_collector_cannot_write_them(admin, collector):
    now = time.time() * 1000
    await admin.zadd(HOT_KEY, {"35.5:139.5:150": now + 60_000, "22.0:114.0:100": now - 1})
    await admin.hset(HOT_META_KEY, "35.5:139.5:150", orjson.dumps({"sessions": 2, "first_at": int(now)}).decode())
    await admin.zadd(FOCUS_KEY, {"abcdef": now + 60_000})
    d = await DemandPoller(collector).poll()
    assert [c.key for c in d.hot] == ["35.5:139.5:150"] and d.hot[0].sessions == 2 and d.focus_hexes == ["abcdef"]
    with pytest.raises(NoPermissionError):
        await collector.zadd(FOCUS_KEY, {"ffffff": now + 60_000})  # 임대는 api 만 쓴다
    with pytest.raises(NoPermissionError):
        await collector.zremrangebyscore(HOT_KEY, "-inf", now)
    st = DemandStatus(collector)
    await st.put({"focus:abcdef": {"state": "active"}, "focus:dead00": {"state": "active"}})
    await st.prune({"focus:abcdef"})
    assert set(await admin.hkeys(STATUS_KEY)) == {"focus:abcdef"} and st.errors == 0


class _NotFoundProvider:
    name, cost, host = "adsbdb", 1, "api.adsbdb.com"

    def __init__(self) -> None:
        self.calls: list[str] = []

    async def lookup(self, callsign: str, *, wait_s: float, before_send=None) -> RouteFetch:
        self.calls.append(callsign)
        return RouteFetch(not_found(callsign, datetime.now(UTC)), 404, 10)


async def test_route_cache_set_ex_and_exists_with_collector_acl(admin, collector):
    """계약 v4 §A: 수집기 규칙(~wakeline:route:*)으로 SET EX · EXISTS 가 된다. 캐시가 있으면 다시 묻지 않는다."""
    prov = _NotFoundProvider()
    rl = RouteLookup(collector, prov, Budget(collector, {"adsbdb": 2000}), ProviderStatus(collector))  # type: ignore[arg-type]
    rl.request(["ZZX123"])
    for t in list(rl._tasks.values()):
        await t
    raw = await admin.get(route_key("ZZX123"))
    assert raw is not None and orjson.loads(raw)["status"] == "not_found"
    assert 1790 < await admin.ttl(route_key("ZZX123")) <= 1800
    rl.request(["ZZX123"])
    for t in list(rl._tasks.values()):
        await t
    assert prov.calls == ["ZZX123"] and (await Budget(admin, {}).usage("adsbdb"))[0] == 1
