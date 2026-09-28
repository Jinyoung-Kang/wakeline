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


def _start_sh_value(name: str) -> str:
    """infra/redis/start.sh 의 규칙 변수 값(손으로 옮긴 목록이 어긋나지 않게). `X="$X …"` 로 이어 붙인 줄도 순서대로 합친다."""
    import re
    from pathlib import Path

    text = (Path(__file__).resolve().parents[3] / "infra" / "redis" / "start.sh").read_text()
    value: str | None = None
    for m in re.finditer(rf"^{name}=(['\"])(.*)\1\s*$", text, re.M):
        value = m.group(2).replace(f"${name}", value or "")
    assert value is not None, name
    return value


def _start_sh_rules(*names: str) -> list[str]:
    """단어로 나누는 규칙 변수(start.sh 가 따옴표 없이 펼치는 것)."""
    import shlex

    return [w for name in names for w in shlex.split(_start_sh_value(name))]


async def test_r14_publisher_time_trim_on_real_redis_under_collector_acl(admin):
    """R-14: 수집기 ACL 사용자로 XADD MINID ~ 가 허용되고, 보존 창보다 오래된 노드는 지워지며 창 안 항목은 남는다."""
    from wakeline_collector.publisher import STREAM_AIRCRAFT, STREAM_RETENTION_S, Publisher

    user, pw = f"itest_col_{uuid.uuid4().hex[:8]}", uuid.uuid4().hex
    # start.sh 의 wakeline_collector 와 같은 규칙: 키 + 명령 허용 목록(R-86) + 선택자(따옴표로 한 인자씩)
    await admin.execute_command(
        "ACL",
        "SETUSER",
        user,
        "reset",
        "on",
        f">{pw}",
        *_start_sh_rules("COLLECTOR_KEYS", "PRODUCER_BASE", "COLLECTOR_CMDS"),
        *(_start_sh_value(v) for v in ("COLLECTOR_SEL_SET", "COLLECTOR_SEL_DEL", "COLLECTOR_SEL_EXPIRE")),
    )
    kw = admin.connection_pool.connection_kwargs
    col = Redis(host=kw["host"], port=kw["port"], username=user, password=pw, decode_responses=True)
    await admin.delete(STREAM_AIRCRAFT)
    try:
        now_ms = int(time.time() * 1000)
        old_ms = now_ms - int((STREAM_RETENTION_S + 1800) * 1000)
        recent_ms = now_ms - 3600 * 1000
        for i in range(250):  # 노드(기본 100항목) 둘 이상을 채우는 오래된 항목
            await admin.xadd(STREAM_AIRCRAFT, {"old": str(i)}, id=f"{old_ms}-{i + 1}")
        for i in range(5):  # api 가 1 h 멈춘 동안의 항목
            await admin.xadd(STREAM_AIRCRAFT, {"recent": str(i)}, id=f"{recent_ms}-{i + 1}")
        assert await Publisher(col).publish(STREAM_AIRCRAFT, {"new": "1"})  # type: ignore[arg-type]
        rows = [f for _sid, f in await admin.xrange(STREAM_AIRCRAFT)]
        assert sum("recent" in f for f in rows) == 5 and sum("new" in f for f in rows) == 1  # 창 안은 모두 남는다
        assert sum("old" in f for f in rows) <= 100  # ~(근사): 통째로 오래된 노드만 지운다 — 남은 오래된 항목은 한 노드 이하
    finally:
        await admin.delete(STREAM_AIRCRAFT)
        await col.aclose()
        await admin.execute_command("ACL", "DELUSER", user)


# ---- 계약 v5 §C2: 로그 싱크의 파이프라인 XADD(MAXLEN ~) · 권한 거부 때의 백오프 ------------------------------------------------
async def test_v5_log_sink_pipeline_xadd_on_real_redis(admin):
    """실 redis.asyncio 파이프라인으로 XADD wakeline:logs MAXLEN ~ 3000 * e <json> — 가짜 Redis 가 흉내 내지 못하는 명령 모양 확인."""
    import logging

    from wakeline_collector.logsink import STREAM_LOGS, LogSink

    await admin.delete(STREAM_LOGS)
    sink = LogSink("collector", admin)
    lg = logging.getLogger("itest.logsink")
    lg.handlers[:], lg.propagate = [sink], False
    try:
        for i in range(120):
            lg.warning("itest %s", chr(0x4E00 + i))  # 지문이 모두 달라 억제되지 않는다
        assert await sink.send_pending() == 120
        rows = await admin.xrange(STREAM_LOGS)
        assert len(rows) == 120 and all(list(f) == ["e"] for _id, f in rows)
        assert [orjson.loads(f["e"])["message"] for _id, f in rows][:2] == ["itest 一", "itest 丁"]
    finally:
        lg.handlers.clear()
        await admin.delete(STREAM_LOGS)


async def test_v5_log_sink_backs_off_on_noperm_and_keeps_entries(admin):
    """스트림 키 권한이 없는 사용자(계약 v5 §C3 의 ACL 이 아직 없을 때와 같은 상황): NOPERM 이면 항목을 버리지 않고 백오프한다.
    권한이 생기면(C3) 다음 시도에 보낸다."""
    import asyncio
    import logging

    from wakeline_collector.logsink import STREAM_LOGS, LogSink

    user, pw = f"itest_logs_{uuid.uuid4().hex[:8]}", uuid.uuid4().hex
    await admin.execute_command("ACL", "SETUSER", user, "reset", "on", f">{pw}", "~itest:*", "+xadd", "+ping")
    kw = admin.connection_pool.connection_kwargs
    r = Redis(host=kw["host"], port=kw["port"], username=user, password=pw, decode_responses=True)
    await admin.delete(STREAM_LOGS)
    sink = LogSink("ais", r, flush_every_s=0.02, backoff=(0.05, 0.05))
    lg = logging.getLogger("itest.logsink.noperm")
    lg.handlers[:], lg.propagate = [sink], False
    sink.start(attach=False)
    try:
        lg.error("cannot reach upstream")
        for _ in range(200):
            if sink.failures >= 2:
                break
            await asyncio.sleep(0.01)
        assert sink.failures >= 2 and len(sink.pending()) == 1 and sink.dropped == 0 and sink.sent == 0
        await admin.execute_command("ACL", "SETUSER", user, f"~{STREAM_LOGS}")  # C3: ~wakeline:logs 를 더한다
        for _ in range(200):
            if sink.sent == 1:
                break
            await asyncio.sleep(0.01)
        assert sink.sent == 1 and len(await admin.xrange(STREAM_LOGS)) == 1
    finally:
        lg.handlers.clear()
        await sink.aclose(drain_s=0.2)
        await r.aclose()
        await admin.execute_command("ACL", "DELUSER", user)
        await admin.delete(STREAM_LOGS)
