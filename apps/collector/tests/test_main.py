from wakeline_collector.config import Settings
from wakeline_collector.main import build_limits, make_redis


def test_redis_acl_username_passed_through():
    r = make_redis(Settings(redis_username="wakeline_collector", redis_password="pw", redis_host="h", redis_port=1))
    kw = r.connection_pool.connection_kwargs
    assert kw["username"] == "wakeline_collector" and kw["password"] == "pw"


def test_redis_without_username_uses_default_user():
    kw = make_redis(Settings(redis_username="", redis_password="")).connection_pool.connection_kwargs
    assert kw.get("username") is None and kw.get("password") is None


def test_every_budgeted_provider_is_snapshotted():
    limits = build_limits(Settings())
    assert {"adsb_lol", "adsb_fi", "opensky", "awc", "rainviewer", "kma_radar"} <= set(limits)


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
    from wakeline_collector.demand import FOCUS_KEY
    from wakeline_collector.publisher import STREAM_AIRCRAFT

    monkeypatch.setattr(mainmod.settings, "wakeline_fixture_mode", 1)
    r = FakeRedis()
    base = orjson.loads((Path(mainmod.settings.fixtures_dir) / "adsb_lol_region.json").read_bytes())
    hex_ = next(a["hex"] for a in base["ac"] if a.get("lat") is not None)
    await r.zadd(FOCUS_KEY, {hex_: time.time() * 1000 + 60_000})  # api 가 쓴 것처럼 집중 추적 임대 1건

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
    for _ in range(300):
        scopes = {f["scope"] for _sid, f in r.streams.get(STREAM_AIRCRAFT, [])}
        if {"region", "focus"} <= scopes:
            break
        await asyncio.sleep(0.01)
    assert {"region", "focus"} <= scopes
    stop.set()
    await asyncio.wait_for(task, 5)
    assert closed == [mainmod.DB_DRAIN_S]
    hb = r.kv["wakeline:collector"]
    assert hb["fixture"] == "1" and hb["region_poll_s"] == "10" and "adsb_fi_rps_1m" in hb and hb["demand_focus"] == "1"
    assert mainmod.SHUTDOWN_GRACE_S + 2 * mainmod.DB_DRAIN_S < 30  # compose stop_grace_period 30 s 안
