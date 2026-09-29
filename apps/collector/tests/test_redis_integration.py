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
from wakeline_collector.chain_store import ChainStateStore
from wakeline_collector.demand import FOCUS_KEY, FOCUS_META_KEY, HOT_KEY, HOT_META_KEY, STATUS_KEY, DemandPoller, DemandStatus
from wakeline_collector.jobs.portcalls import PortCallJob, PortCallLookup
from wakeline_collector.jobs.route import RouteLookup
from wakeline_collector.portcalls import DEMAND_KEY as PORTCALL_DEMAND_KEY
from wakeline_collector.portcalls import parse_page, portcalls_key
from wakeline_collector.providers.adsbdb import RouteFetch
from wakeline_collector.providers.portmis import PageFetch
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
    keys += (PORTCALL_DEMAND_KEY, portcalls_key("230025"), day_key("portmis"), "wakeline:provider:portmis")
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


class _FixtureProvider:
    """PORT-MIS 대신 저장소 fixture(부산 · 230025)를 돌려준다 — 외부 호출 없음."""

    name, cost, host = "portmis", 1, "apis.data.go.kr"

    def __init__(self) -> None:
        self.calls: list[tuple[str, str]] = []

    async def fetch_page(self, *, port_authority: str, call_sign: str, sde, ede, page_no: int, wait_s=15.0, before_send=None):
        from portmis_synthetic import empty_page, fixture_bytes

        self.calls.append((port_authority, call_sign))
        if before_send is not None:
            assert await before_send()
        body = fixture_bytes() if port_authority == "020" else empty_page()
        return PageFetch(parse_page(body, call_sign), 5, datetime.now(UTC))


async def test_port_call_leases_are_read_only_and_cache_is_set_ex_under_collector_acl(admin, collector):
    """ADR-022: 수집기 규칙으로 임대(ZRANGEBYSCORE LIMIT)를 읽고 캐시를 SET EX · EXISTS 로 쓴다. 임대는 쓰지 못한다."""
    now = time.time() * 1000
    await admin.zadd(PORTCALL_DEMAND_KEY, {"230025": now + 60_000, "DEAD01": now - 1})
    prov = _FixtureProvider()
    lk = PortCallLookup(collector, prov, Budget(collector, {"portmis": 3000}), ProviderStatus(collector))  # type: ignore[arg-type]
    job = PortCallJob(collector, lk)
    assert await job.wanted() == ["230025"]
    assert await job.tick() == 1
    for t in list(lk._tasks.values()):
        await t
    raw = await admin.get(portcalls_key("230025"))
    assert raw is not None and orjson.loads(raw)["status"] == "ok"
    assert 6 * 3600 - 10 < await admin.ttl(portcalls_key("230025")) <= 6 * 3600
    assert len(prov.calls) == 10 and (await Budget(admin, {}).usage("portmis"))[0] == 10
    lk.request(["230025"])  # 캐시가 있으면 묻지 않는다(EXISTS)
    for t in list(lk._tasks.values()):
        await t
    assert len(prov.calls) == 10
    with pytest.raises(NoPermissionError):
        await collector.zadd(PORTCALL_DEMAND_KEY, {"FORGED1": now + 60_000})  # 임대는 api 만 쓴다
    with pytest.raises(NoPermissionError):
        await collector.expire(portcalls_key("230025"), 1)  # 캐시는 SET EX 만


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


async def test_restart_seeds_the_byte_budget_from_the_stream_on_real_redis_under_collector_acl(admin, monkeypatch):
    """ADR-011 Redis 여유: 재시작한 Publisher 가 첫 XADD 전에 기존 항목을 되읽어(XREVRANGE 배타 경계 '(' 로 여러 쪽) 예산에 넣는다 —
    수집기 ACL(+xrevrange)로 읽을 수 있고, 첫 발행 뒤 스트림 필드 길이 합이 예산 이하로 줄어든다."""
    from wakeline_collector import publisher as pubmod
    from wakeline_collector.publisher import SEED_PAGE, STREAM_AIRCRAFT, Publisher

    budget = 200_000
    monkeypatch.setitem(pubmod.STREAM_BUDGET_BYTES, STREAM_AIRCRAFT, budget)
    user, pw = f"itest_col_{uuid.uuid4().hex[:8]}", uuid.uuid4().hex
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
        n_before = 3 * SEED_PAGE + 5  # 되읽기가 여러 쪽을 넘긴다
        for _ in range(n_before):  # 재시작 전 발행자가 남긴 창 안 항목 — 합계가 예산의 두 배 남짓
            await admin.xadd(STREAM_AIRCRAFT, {"payload": "x" * 8_000})
        before = sum(len(k) + len(v) for _sid, f in await admin.xrange(STREAM_AIRCRAFT) for k, v in f.items())
        assert before > 2 * budget
        p = Publisher(col)  # type: ignore[arg-type]
        assert await p.publish(STREAM_AIRCRAFT, {"payload": "y" * 8_000})
        rows = await admin.xrange(STREAM_AIRCRAFT)
        after = sum(len(k) + len(v) for _sid, f in rows for k, v in f.items())
        assert after <= budget + 8_007, after  # MAXLEN ~ 은 노드(8 KB 항목은 거의 한 노드 한 항목) 단위라 한 항목 남짓 여유
        assert p.budget_trims[STREAM_AIRCRAFT] == 1 and rows[-1][1]["payload"][0] == "y"
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
    """수집기 사용자를 infra/redis/start.sh 의 규칙 그대로(acl_rules 가 읽은 것 — 손으로 권한을 적지 않는다, R-41) 만든다.
    먼저 로그 스트림 규칙(%W~wakeline:logs — 계약 v5 §C3 · §G1)만 뺀 규칙: NOPERM 이면 항목을 버리지 않고 백오프한다.
    그다음 start.sh 규칙 전체로 바꾸면 다음 시도에 보낸다 — 실제 수집기 규칙이 싱크의 파이프라인 XADD MAXLEN ~ 을 허용하는지까지.
    쓰기 전용이라 같은 사용자로 스트림을 읽지는 못한다(§G1)."""
    import asyncio
    import logging

    from redis.exceptions import NoPermissionError

    from wakeline_collector.logsink import STREAM_LOGS, LogSink

    log_rules = [rule for rule in COLLECTOR_RULES if "wakeline:logs" in rule]
    assert log_rules == [f"%W~{STREAM_LOGS}"], "start.sh 의 수집기 로그 스트림 규칙은 쓰기 전용 하나(계약 v5 §G1)"
    before_c3 = [rule for rule in COLLECTOR_RULES if rule not in log_rules]
    user, pw = f"itest_logs_{uuid.uuid4().hex[:8]}", uuid.uuid4().hex
    await admin.execute_command("ACL", "SETUSER", user, "reset", f">{pw}", *before_c3)
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
        # start.sh 의 수집기 규칙 그대로(비밀번호는 시험의 것) — 이미 붙은 연결에도 곧바로 적용된다
        await admin.execute_command("ACL", "SETUSER", user, "reset", f">{pw}", *COLLECTOR_RULES)
        for _ in range(200):
            if sink.sent == 1:
                break
            await asyncio.sleep(0.01)
        assert sink.sent == 1 and len(await admin.xrange(STREAM_LOGS)) == 1
        with pytest.raises(NoPermissionError):
            await r.xrevrange(STREAM_LOGS, count=1)  # 쓰기 전용(%W~) — 다른 서비스의 로그를 읽지 못한다
    finally:
        lg.handlers.clear()
        await sink.aclose(drain_s=0.2)
        await r.aclose()
        await admin.execute_command("ACL", "DELUSER", user)
        await admin.delete(STREAM_LOGS)


async def test_chain_429_history_store_under_collector_acl(admin, collector, caplog):
    """R-17 보존: 429 이력 키(wakeline:provider:{name}:ratelimit:{job})는 수집기 규칙으로 HSET + EXPIRE(파이프라인) · HGETALL · HDEL 이
    된다. EXPIRE 는 start.sh 의 셀렉터가 이 키에만 준다 — 같은 접두어의 공급자 상태 해시는 만료시킬 수 없다."""
    import logging

    caplog.set_level(logging.WARNING, logger="chain_store")
    store = ChainStateStore(collector)
    key = store.key("itest", "adsb_lol")
    try:
        fields = {"v": "1", "stage": "2", "hold_until": "", "expires_at": "1790001500.000"}
        assert await store.save("itest", "adsb_lol", fields, ttl_s=1500)
        assert 1490 <= await admin.ttl(key) <= 1500  # TTL 조회는 수집기가 쓰지 않는 명령이라 관리자로 본다
        assert await store.load("itest", ["adsb_lol", "adsb_fi"]) == {"adsb_lol": fields}
        await store.drop("itest", "adsb_lol")
        assert await admin.exists(key) == 0
        assert store.errors == 0 and not [r for r in caplog.records if r.name == "chain_store"]
        await admin.hset("wakeline:provider:itest", "ok", "1")
        with pytest.raises(NoPermissionError):
            await collector.expire("wakeline:provider:itest", 1)
    finally:
        await admin.delete(key, "wakeline:provider:itest")
