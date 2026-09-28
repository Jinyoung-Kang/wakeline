from wakeline_collector.config import Settings
from wakeline_collector.main import build_limits, make_redis


def test_redis_acl_username_passed_through():
    r = make_redis(Settings(redis_username="wakeline_collector", redis_password="pw", redis_host="h", redis_port=1))
    kw = r.connection_pool.connection_kwargs
    assert kw["username"] == "wakeline_collector" and kw["password"] == "pw"


def test_redis_without_username_uses_default_user():
    kw = make_redis(Settings(redis_username="", redis_password="")).connection_pool.connection_kwargs
    assert kw.get("username") is None and kw.get("password") is None


async def test_r43_redis_clients_use_a_short_explicit_retry():
    """리뷰 R-43: redis-py 8 기본 재시도(지터 백오프 최대 1 s × 10회)로 닫힌 포트에 XADD 1회가 3.2 s 걸렸다."""
    import time

    from redis.exceptions import ConnectionError as RedisConnectionError

    from wakeline_collector.ais.config import AisSettings
    from wakeline_collector.ais.main import make_redis as make_ais_redis

    clients = [
        make_redis(Settings(redis_host="127.0.0.1", redis_port=1)),
        make_ais_redis(AisSettings(redis_host="127.0.0.1", redis_port=1)),  # type: ignore[call-arg]
    ]
    for r in clients:
        assert r.get_retry()._retries <= 2
        t0 = time.monotonic()
        try:
            await r.xadd("wakeline:aircraft", {"a": "1"})
        except RedisConnectionError:
            pass
        finally:
            await r.aclose()
        assert time.monotonic() - t0 < 1.5  # 연결 거부(로컬 닫힌 포트)는 1 s 안팎에 포기한다


async def _silent_redis():
    """연결은 받지만 한 바이트도 답하지 않는 서버(멈춘 Redis). 반환: (server, port)."""
    import asyncio

    async def handle(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        try:
            while await reader.read(65536):
                pass
        except (ConnectionError, asyncio.CancelledError):
            pass
        finally:
            writer.close()

    server = await asyncio.start_server(handle, "127.0.0.1", 0)
    return server, server.sockets[0].getsockname()[1]


async def test_r43_calls_give_up_within_seconds_when_redis_accepts_but_never_answers():
    """리뷰 R-43 후속: 연결은 받지만 답하지 않는 Redis 에 발행 1회가 46 s 걸렸다 — redis-py 가 재시도를 두 겹(연결 핸드셰이크 3회 ×
    명령 3회)으로 걸고 매번 socket_timeout 5 s 를 기다렸다. 발행은 그동안 락을 쥐어 모든 작업이 뒤에 줄을 섰다.
    발행(로컬 큐로)·임대 읽기(마지막 임대로)·예산 예약(fail open, 사용량 모름)·ais 발행과 상태 쓰기가 몇 초 안에 포기해야 한다."""
    import asyncio
    import time

    from redis.exceptions import RedisError

    from wakeline_collector.ais.book import ShipBook
    from wakeline_collector.ais.config import AisSettings
    from wakeline_collector.ais.main import make_redis as make_ais_redis
    from wakeline_collector.ais.queue import RawQueue
    from wakeline_collector.ais.shards import ShardSet
    from wakeline_collector.ais.sink import AisSink
    from wakeline_collector.ais.worker import Worker
    from wakeline_collector.budget import UNKNOWN, Budget
    from wakeline_collector.demand import Demand, DemandPoller
    from wakeline_collector.publisher import STREAM_AIRCRAFT, Publisher

    server, port = await _silent_redis()
    r = make_redis(Settings(redis_host="127.0.0.1", redis_port=port))
    ais_r = make_ais_redis(AisSettings(redis_host="127.0.0.1", redis_port=port))  # type: ignore[call-arg]
    q, book, shards = RawQueue(10), ShipBook("aisstream"), ShardSet("aisstream")
    shards.add(None)
    sink = AisSink(ais_r, book=book, shards=shards, worker=Worker(q, book), queue=q, provider="aisstream", raw_ref="-")
    publisher = Publisher(r)

    async def timed(coro):
        t0 = time.monotonic()
        try:
            res = await asyncio.wait_for(coro, 15)
        except Exception as e:  # noqa: BLE001
            res = e
        return res, time.monotonic() - t0

    try:
        results = await asyncio.gather(
            timed(publisher.publish(STREAM_AIRCRAFT, {"a": "1"})),
            timed(DemandPoller(r).poll()),
            timed(Budget(r, {"adsb_lol": 0}).reserve("adsb_lol")),
            timed(sink.write_status()),
            timed(sink._xadd({"a": "1"})),
        )
    finally:
        await r.aclose()
        await ais_r.aclose()
        server.close()
    took = {
        name: round(t, 1)
        for name, (_res, t) in zip(["publish", "poll", "reserve", "ais_status", "ais_xadd"], results, strict=True)
    }
    (sid, _), (demand, _), (reserved, _), (status_ok, _), (xadd_err, _) = results
    assert max(took.values()) < 5, took
    assert sid is None and publisher.queued == 1  # 로컬 큐에 보관
    assert demand == Demand()  # 마지막 임대(없음)
    assert reserved == (True, UNKNOWN)  # fail open, 사용량 모름
    assert status_ok is False and sink.status_errors == 1
    assert isinstance(xadd_err, RedisError)  # flush 가 발행 실패로 처리하는 오류


def test_every_budgeted_provider_is_snapshotted():
    limits = build_limits(Settings())
    assert {"adsb_lol", "adsb_fi", "opensky", "awc", "rainviewer", "kma_radar", "adsbdb"} <= set(limits)
    assert limits["adsbdb"] == 2000  # 계약 v4 §A: 노선 조회 하루 2,000회


def test_adsbdb_settings_defaults_and_validation():
    import pytest
    from pydantic import ValidationError

    s = Settings()
    assert (s.adsbdb_base_url, s.adsbdb_rps, s.budget_adsbdb) == ("https://api.adsbdb.com", 0.5, 2000)
    assert Settings(adsbdb_base_url="https://api.adsbdb.com/").adsbdb_base_url == "https://api.adsbdb.com/"
    for bad in (
        {"adsbdb_base_url": "http://api.adsbdb.com"},
        {"adsbdb_base_url": "https://x/y?z"},
        # 리뷰 v4: HttpClient 허용 목록 밖 호스트는 보내지도 못하면서 예산만 쓴다 — 설정에서 거절
        {"adsbdb_base_url": "https://mirror.example.org"},
        {"adsbdb_base_url": "https://api.adsbdb.com.example.org"},
        {"adsbdb_base_url": "https://api.adsbdb.com:8443"},
        {"adsbdb_rps": 0},
        {"adsbdb_rps": 2},
    ):
        with pytest.raises(ValidationError):
            Settings(**bad)


# ---- COL-4: 종료 시 진행 중 작업은 grace 동안 끝내게 두고, 남은 것은 취소 ------------------------------------------------------
async def test_run_until_stopped_lets_short_jobs_finish_and_cancels_stuck_ones():
    import asyncio

    from wakeline_collector.main import run_until_stopped

    stop = asyncio.Event()
    finished: list[str] = []

    async def quick():
        await stop.wait()
        await asyncio.sleep(0.02)  # 종료 신호 뒤에도 잠깐 일한다
        finished.append("quick")

    async def stuck():
        await asyncio.Event().wait()

    tasks = [asyncio.create_task(quick()), asyncio.create_task(stuck())]
    runner = asyncio.create_task(run_until_stopped(tasks, stop, grace_s=0.2))
    await asyncio.sleep(0.01)
    stop.set()
    await asyncio.wait_for(runner, 1)
    assert finished == ["quick"] and tasks[1].cancelled()


async def test_run_until_stopped_when_a_job_ends_unexpectedly():
    import asyncio

    from wakeline_collector.main import run_until_stopped

    stop = asyncio.Event()

    async def ends():
        return None

    async def loops():
        await stop.wait()

    tasks = [asyncio.create_task(ends()), asyncio.create_task(loops())]
    await asyncio.wait_for(run_until_stopped(tasks, stop, grace_s=1), 1)
    assert stop.is_set() and all(t.done() for t in tasks)


async def test_main_fixture_mode_smoke(monkeypatch):
    """fixture 모드 전체 기동 → 관심 지역·focus 발행 → 종료 신호 → DB close 까지(외부 호출·실 Redis·실 DB 없음)."""
    import asyncio
    import time
    from pathlib import Path

    import orjson
    from fakes import FakeRedis

    from wakeline_collector import main as mainmod
    from wakeline_collector.db import Db
    from wakeline_collector.demand import FOCUS_KEY, FOCUS_META_KEY
    from wakeline_collector.publisher import STREAM_AIRCRAFT
    from wakeline_collector.route import normalize_callsign

    monkeypatch.setattr(mainmod.settings, "wakeline_fixture_mode", 1)
    r = FakeRedis()
    base = orjson.loads((Path(mainmod.settings.fixtures_dir) / "adsb_lol_region.json").read_bytes())
    ac = next(a for a in base["ac"] if a.get("lat") is not None and normalize_callsign(a.get("flight")))
    hex_, callsign = ac["hex"], normalize_callsign(ac["flight"])
    await r.zadd(FOCUS_KEY, {hex_: time.time() * 1000 + 60_000})  # api 가 쓴 것처럼 집중 추적 임대 2건
    await r.zadd(FOCUS_KEY, {"abcdef": time.time() * 1000 + 60_000})
    await r.hset(FOCUS_META_KEY, "abcdef", '{"sessions": 1, "callsign": "ZZY999"}')  # 메타 콜사인(계약 v4 G A-1)

    async def no_db():
        raise OSError("no db in tests")

    db = Db(no_db)
    closed: list[float] = []
    real_close = db.close

    async def close(drain_s: float = 5.0) -> None:
        closed.append(drain_s)
        await real_close(drain_s=0.1)

    monkeypatch.setattr(db, "close", close)
    stop = asyncio.Event()
    task = asyncio.create_task(mainmod.main(stop=stop, redis=r, db=db))
    routes = [f"wakeline:route:{callsign}", "wakeline:route:ZZY999"]
    for _ in range(300):
        scopes = {f["scope"] for _sid, f in r.streams.get(STREAM_AIRCRAFT, [])}
        if {"region", "focus"} <= scopes and all(k in r.kv for k in routes):
            break
        await asyncio.sleep(0.01)
    assert {"region", "focus"} <= scopes
    stop.set()
    await asyncio.wait_for(task, 5)
    assert closed == [mainmod.DB_DRAIN_S]
    hb = r.kv["wakeline:collector"]
    assert hb["fixture"] == "1" and hb["region_poll_s"] == "10" and "adsb_fi_rps_1m" in hb and hb["demand_focus"] == "2"
    assert hb["stream_budget_trims"] == "0"  # R-14: 바이트 예산 때문에 보존 창보다 일찍 자른 적 없음
    # R-18: 손실 신호가 api 가 읽는 heartbeat 해시(wakeline:collector)에 있다 — 발행 큐 버림·DB 쓰기 버림/대기/실패·속도 상한
    loss = ("publish_dropped", "publish_queued", "db_dropped", "db_pending", "db_failures", "db_ok", "http_throttled")
    assert all(hb.get(k, "").isdigit() for k in loss), {k: hb.get(k) for k in loss}
    assert hb["db_ok"] == "0"  # 시험의 DB 는 연결되지 않는다 — 그대로 드러난다(실패 횟수는 heartbeat 시점에 따라 0 일 수 있다)
    # 계약 v4 G A-2: fixture 모드는 외부 호출이 없다 — 노선을 묻지 않고, 선택한 항공기의 콜사인(응답의 콜사인 · 메타 콜사인)에
    # disabled(120 s)를 써서 api 가 "노선 조회 중"(pending)으로 남기지 않게 한다
    assert hb["adsbdb_rps_1m"] == "0.000" and hb["route_lookups"] == "0"
    for key in routes:
        v = orjson.loads(r.kv[key])
        assert v["status"] == "disabled" and v["origin"] is None and v["destination"] is None and r.ttl[key] - time.time() <= 120
    assert sorted(k for k in r.kv if k.startswith("wakeline:route:")) == sorted(routes)
    assert mainmod.SHUTDOWN_GRACE_S + 2 * mainmod.DB_DRAIN_S < 30  # compose stop_grace_period 30 s 안
