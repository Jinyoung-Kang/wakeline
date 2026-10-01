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
from datetime import UTC, datetime, timedelta

import orjson
import pytest
from acl_rules import service_acl_rules
from redis.asyncio import Redis
from redis.exceptions import NoPermissionError

from wakeline_collector.budget import Budget, day_key
from wakeline_collector.chain_store import ChainStateStore
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
    keys += ("wakeline:demand:portcalls", "wakeline:portcalls:230025", day_key("portmis"), "wakeline:provider:portmis")
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


async def test_a_flushed_budget_script_is_loaded_again_under_the_collector_acl(admin, collector):
    """F4: _eval 은 NoScriptError 에만 스크립트를 다시 올린다 — 실제 Redis 의 NOSCRIPT 응답이 redis-py 에서 그 예외로 오고, 다시 올리기(SCRIPT LOAD)가
    수집기 ACL 안에서 된다."""
    b = Budget(collector, {"itest": 5})
    assert await b.reserve("itest") == (True, 1)
    await admin.script_flush()
    assert await b.reserve("itest") == (True, 2)


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


async def test_port_call_index_runs_under_the_collector_acl_and_cannot_touch_the_retired_keys(admin, collector):
    """ADR-022 개정: 색인 작업은 Redis 에 예산(하루 · 해양수산부 시간 창 Lua) · 공급자 상태 · heartbeat 만 쓴다 — 수집기 규칙으로 모두 되고,
    선택마다 쓰던 예전 임대 · 캐시 이름은 읽지도 쓰지도 못한다(규칙을 없앴다). 외부 호출 없음(가짜 응답기 — 확인한 동작 그대로)."""
    from fakes import make_ctx
    from portcall_index_fakes import DirectSource, FakeIndexDb
    from portmis_observed import ObservedPortMis, real_item

    from wakeline_collector.budget import hour_key
    from wakeline_collector.jobs.portcalls_index import PortCallIndexJob
    from wakeline_collector.portcalls import kst_date

    now = datetime.now(UTC)
    mof_hours = {hour_key("mof", now), hour_key("mof", now + timedelta(hours=1))}
    ctx = make_ctx(collector, limits={"portmis": 3000})
    ctx.budget = Budget(collector, {"portmis": 3000})
    ctx.status = ProviderStatus(collector)
    db = ctx.db = FakeIndexDb()
    db.cov = {}  # 처음
    job = PortCallIndexJob(DirectSource(ObservedPortMis([real_item()])), ctx, now=lambda: now)
    try:
        for _ in range(3):  # 범위 읽기 + 꼬리 첫 날들
            await job.step()
        today = kst_date(now)
        assert db.applied == [("020", today - timedelta(days=n)) for n in (2, 1, 0)]  # 꼬리 — 오래된 날부터
        assert (await Budget(admin, {}).usage("portmis"))[0] == len(db.applied)
        used = [int((await admin.hgetall(k)).get("used", 0)) for k in mof_hours]
        assert sum(used) == len(db.applied)
        hb = await admin.hgetall("wakeline:collector")
        assert hb["portcalls_index_state"] == "active" and hb["portcalls_index_at"]
        assert (await admin.hgetall("wakeline:provider:portmis"))["budget_limit"] == "3000"
    finally:
        await admin.delete(*mof_hours)
    for call in (
        collector.zrangebyscore("wakeline:demand:portcalls", 0, "+inf"),
        collector.zadd("wakeline:demand:portcalls", {"FORGED1": 1}),
        collector.set("wakeline:portcalls:230025", "x", ex=60),
        collector.exists("wakeline:portcalls:230025"),
    ):
        with pytest.raises(NoPermissionError):
            await call


async def test_traffic_grid_publish_and_negative_cache_under_collector_acl(admin, collector):
    """ADR-023: 수집기 규칙으로 스냅샷 SET EX 1200 · 부정 캐시 HSET/HGETALL · 예산 Lua(하루 · 시간 창) · 상태 해시가 되고,
    지우기(DEL · HDEL) · 모양 바꾸기(XADD)는 거부된다(두 이름은 셀렉터로만 닿는다)."""
    from test_traffic_grid_job import CELLS, T0, Clock, FakeKomsa, FakeWfs, TGDb, komsa_body

    from wakeline_collector.budget import hour_key
    from wakeline_collector.jobs.context import JobContext
    from wakeline_collector.jobs.traffic_grid import NEGATIVE_KEY, SNAPSHOT_KEY, TrafficGridJob
    from wakeline_collector.marine_grid import WfsResult
    from wakeline_collector.publisher import Publisher
    from wakeline_collector.runtime_settings import RuntimeSettings

    keys = (
        SNAPSHOT_KEY,
        NEGATIVE_KEY,
        day_key("komsa_traffic"),
        day_key("mof_grid4"),
        hour_key("komsa_traffic", T0),
        hour_key("mof", T0),
        "wakeline:provider:komsa_traffic",
        "wakeline:provider:mof_grid4",
    )
    await admin.delete(*keys)
    try:
        answers = {g: WfsResult("found", cell=c) for g, c in CELLS.items()}
        answers["GR4_F2K41_C4"] = WfsResult("not_found")
        ctx = JobContext(
            budget=Budget(collector, {"komsa_traffic": 400, "mof_grid4": 6000}),
            db=TGDb([]),
            publisher=Publisher(collector),
            raw=__import__("fakes").FakeRaw(),
            status=ProviderStatus(collector),
            rt=RuntimeSettings(collector),
            fixture=False,
        )
        clock = Clock()
        job = TrafficGridJob(FakeKomsa(clock, komsa_body()), FakeWfs(answers), ctx, now=clock)  # type: ignore[arg-type]
        await job.run_once()
        raw = await admin.get(SNAPSHOT_KEY)
        assert raw is not None and orjson.loads(raw)["resolved"] == 2 and orjson.loads(raw)["not_found"] == 1
        assert 1190 < await admin.ttl(SNAPSHOT_KEY) <= 1200
        assert orjson.loads((await admin.hgetall(NEGATIVE_KEY))["GR4_F2K41_C4"])["reason"] == "not_found"
        assert (await admin.hgetall("wakeline:collector"))["traffic_grid_state"] == "active"
        with pytest.raises(NoPermissionError):
            await collector.delete(SNAPSHOT_KEY)
        with pytest.raises(NoPermissionError):
            await collector.set(NEGATIVE_KEY, "x")
        with pytest.raises(NoPermissionError):
            await collector.hdel(NEGATIVE_KEY, "GR4_F2K41_C4")
        with pytest.raises(NoPermissionError):
            await collector.xadd(SNAPSHOT_KEY, {"x": "y"})
        assert (await admin.hgetall(hour_key("komsa_traffic", T0)))["used"] == "1"
        assert 0 < await admin.ttl(hour_key("komsa_traffic", T0)) <= 7200
        # 격자 WFS 세 번 — 해양수산부 시간 창(입출항 조회와 함께 센다)
        assert (await admin.hgetall(hour_key("mof", T0)))["used"] == "3"
        assert 0 < await admin.ttl(hour_key("mof", T0)) <= 7200
    finally:
        await admin.delete(*keys)


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


async def test_kma_missing_streak_reads_and_writes_under_the_collector_acl(admin, collector, monkeypatch):
    """계약 v5 §G22(리뷰 2026-09-30 — 통합 뒤 실 Redis · ACL 로 돌리지 않았다): 기상청 '파일 없음' 연속은 첫 주기의 HGETALL wakeline:radar_kr:meta
    (이어받기) · meta 와 공급자 해시 wakeline:provider:kma_radar 의 HSET missing_* · 닫은 뒤 알린 공백 missing_gap_* 를 쓴다 — 수집기 규칙(start.sh)으로
    모두 되는지 실제 Redis 에서 본다. 외부 호출 없음(가짜 공급자 — test_kma_missing 의 OutageKma)."""
    from fakes import make_ctx
    from test_kma_missing import KST, OutageKma, _fake_decode

    from wakeline_collector.jobs import kma_radar as mod

    clock = {"now": "202609271215"}
    wall = lambda: datetime.strptime(clock["now"], "%Y%m%d%H%M")  # noqa: E731
    monkeypatch.setattr(mod, "_decode", _fake_decode)
    monkeypatch.setattr(mod, "kst_now", wall)
    monkeypatch.setattr(mod, "_now", lambda: (wall() - KST).replace(tzinfo=UTC))
    keys = (mod.KEY_META, mod.KEY_FRAMES, "wakeline:provider:kma_radar", day_key("kma_radar"), "wakeline:collector")
    await admin.delete(*keys)

    def ctx_for():
        ctx = make_ctx(collector, limits={"kma_radar": 1000})
        ctx.budget = Budget(collector, {"kma_radar": 1000})
        ctx.status = ProviderStatus(collector)
        return ctx

    prov = OutageKma(clock, down_from="202609270000", up_from="202609271240")
    try:
        job = mod.KmaRadarJob(prov, ctx_for())
        for t in ("202609271215", "202609271220", "202609271225"):
            clock["now"] = t
            await job.run_once()
        assert job.missing is not None
        meta, prov_h = await admin.hgetall(mod.KEY_META), await admin.hgetall("wakeline:provider:kma_radar")
        assert meta["missing_since_tm"] == prov_h["missing_since_tm"] == job.missing.since_tm
        assert meta["missing_tms"] == str(job.missing.tms) and meta["missing_listed"] == "EXT"
        again = mod.KmaRadarJob(prov, ctx_for())  # 다시 띄운 수집기 — HGETALL 로 이어받는다
        clock["now"] = "202609271230"
        await again.run_once()
        assert again.missing is not None and again.missing.since_tm == job.missing.since_tm
        for t in ("202609271235", "202609271240"):
            clock["now"] = t
            await again.run_once()
        assert again.missing is None  # 12:40 의 파일 — 닫았다
        meta, prov_h = await admin.hgetall(mod.KEY_META), await admin.hgetall("wakeline:provider:kma_radar")
        assert all(meta[k] == "" for k in mod.MISSING_KEYS) and all(prov_h[k] == "" for k in mod.MISSING_KEYS)
        assert (meta["missing_gap_from"], meta["missing_gap_to"]) == (job.missing.since_tm, "202609271240")
        assert meta["latest_tm"] == "202609271240" and await admin.exists(mod.KEY_FRAME.format(tm="202609271240")) == 1
    finally:
        await admin.delete(*keys, mod.KEY_FRAME.format(tm="202609271240"))


async def test_traffic_grid_tile_states_under_collector_acl(admin, collector):
    """ADR-023 2026-10-01 bbox 개정: 수집기 규칙으로 bbox 타일 상태 해시(wakeline:traffic_grid:tiles)를 HSET · HGETALL 하고(재기동 뒤 다시 묻지
    않는다), 지우기(DEL · HDEL) · 덮어쓰기(SET)는 거부된다. 합성 서버(tests/wfs_tiles — 가정)로 타일 하나를 받는다."""
    from test_traffic_grid_job import Clock, FakeKomsa, komsa_body
    from test_traffic_grid_tile_job import A, CallDb, GridWfs, home
    from wfs_tiles import FakeGrid

    from wakeline_collector.budget import hour_key
    from wakeline_collector.jobs.context import JobContext
    from wakeline_collector.jobs.traffic_grid import NEGATIVE_KEY, SNAPSHOT_KEY, TILES_KEY, TrafficGridJob
    from wakeline_collector.publisher import Publisher
    from wakeline_collector.runtime_settings import RuntimeSettings

    clock = Clock()
    keys = (
        SNAPSHOT_KEY,
        NEGATIVE_KEY,
        TILES_KEY,
        day_key("komsa_traffic"),
        day_key("mof_grid4"),
        hour_key("komsa_traffic", clock()),
        hour_key("mof", clock()),
        "wakeline:provider:komsa_traffic",
        "wakeline:provider:mof_grid4",
    )
    await admin.delete(*keys)
    try:
        grid = FakeGrid()
        ids = home(grid, A)
        store = {ids[0]: grid.cell(ids[0])}  # marine_grid4 흉내 — 두 프로세스가 나눠 쓴다

        def make() -> tuple[TrafficGridJob, GridWfs]:
            ctx = JobContext(
                budget=Budget(collector, {"komsa_traffic": 400, "mof_grid4": 6000}),
                db=CallDb(store),
                publisher=Publisher(collector),
                raw=__import__("fakes").FakeRaw(),
                status=ProviderStatus(collector),
                rt=RuntimeSettings(collector),
                fixture=False,
            )
            wfs = GridWfs(grid)
            body = komsa_body(items=[(g, 5, 1.0) for g in ids[1:4]])
            return TrafficGridJob(FakeKomsa(clock, body), wfs, ctx, tiles=wfs, now=clock), wfs  # type: ignore[arg-type]

        job, wfs = make()
        await job.run_once()
        assert wfs.boxes == [A.box]
        assert orjson.loads((await admin.hgetall(TILES_KEY))[A.key])["status"] == "done"
        assert (await admin.hgetall(hour_key("mof", clock())))["used"] == "1"
        again, wfs2 = make()  # 다시 시작 — 끝난 타일도, 그 타일이 준 칸도 다시 묻지 않는다
        await again.run_once()
        assert wfs2.boxes == [] and wfs2.asked == []
        for call in (
            collector.delete(TILES_KEY),
            collector.hdel(TILES_KEY, A.key),
            collector.set(TILES_KEY, "x"),
            collector.expire(TILES_KEY, 1),
        ):
            with pytest.raises(NoPermissionError):
                await call
    finally:
        await admin.delete(*keys)
