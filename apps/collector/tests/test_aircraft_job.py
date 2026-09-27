"""항공기 작업: OpenSky 크레딧 상한(GAP-5/REL-14), 실시간 경로의 DB·Redis 비의존(REL-3)."""

from __future__ import annotations

import asyncio
import base64
import gzip
from datetime import UTC, datetime, timedelta

import orjson
from fakes import FakeRedis, make_ctx

from wakeline_collector.config import Settings
from wakeline_collector.fallback import ProviderChain
from wakeline_collector.jobs.aircraft import AircraftJob, next_utc_midnight
from wakeline_collector.main import build_limits
from wakeline_collector.models import BudgetInfo, ProviderResult
from wakeline_collector.providers.opensky import OpenSkyProvider
from wakeline_collector.publisher import STREAM_AIRCRAFT


class FakeReadsb:
    supports_region, supports_global, region_cost, global_cost, configured = True, False, 1, 0, True

    def __init__(self, name: str, fail: bool = False):
        self.name, self.fail, self.calls = name, fail, 0

    async def fetch_region(self, lat, lon, radius):
        self.calls += 1
        if self.fail:
            raise RuntimeError(f"{self.name} down")
        now = datetime.now(UTC)
        data = {"ac": [{"hex": "71c0a1", "lat": 37.0, "lon": 127.0, "alt_baro": 30000, "gs": 400, "track": 90, "seen_pos": 1}]}
        return ProviderResult(self.name, orjson.dumps(data), now, 200, 12, data=data)


class FakeOpenSky(OpenSkyProvider):
    def __init__(self, remaining: int | None = 3000):
        super().__init__(http=None, client_id="id", client_secret="secret")  # type: ignore[arg-type]
        self.remaining = remaining
        self.calls = 0

    async def _states(self, params):
        self.calls += 1
        data = {"time": 0, "states": []}
        budget = BudgetInfo(remaining=self.remaining) if self.remaining is not None else None
        return ProviderResult(self.name, orjson.dumps(data), datetime.now(UTC), 200, 30, data=data, budget=budget)


def _decode(fields):
    return orjson.loads(gzip.decompress(base64.b64decode(fields["payload"])))


# ---- GAP-5 / REL-14 ------------------------------------------------------------------------------------------------
def test_opensky_daily_cap_is_72_percent_and_region_ineligible():
    assert Settings().budget_opensky == 2880 <= 4000 * 0.72
    assert build_limits(Settings())["opensky"] == 2880
    assert OpenSkyProvider.supports_region is False and OpenSkyProvider.supports_global is True


async def test_region_never_falls_back_to_opensky_even_when_adsb_down():
    r = FakeRedis()
    ctx = make_ctx(r)
    osky = FakeOpenSky()
    providers = {"adsb_lol": FakeReadsb("adsb_lol", fail=True), "adsb_fi": FakeReadsb("adsb_fi", fail=True), "opensky": osky}
    job = AircraftJob("region", ProviderChain("region", providers, ctx.status), ctx)
    for _ in range(12):  # 두 ADS-B 공급자 모두 3회 실패 → 쿨다운 → 공급자 없음
        await job.run_once()
    assert osky.calls == 0
    assert (await ctx.budget.usage("opensky"))[0] == 0


async def test_simulated_day_all_adsb_down_stays_within_cap():
    """ADS-B 가 하루 종일 죽고 전세계를 기본 120 s 보다 빠르게(60 s) 돌려도 OpenSky 예약 총량 ≤ 2,880."""
    r = FakeRedis()
    ctx = make_ctx(r, limits=build_limits(Settings()))
    osky = FakeOpenSky(remaining=None)
    providers = {"adsb_lol": FakeReadsb("adsb_lol", fail=True), "adsb_fi": FakeReadsb("adsb_fi", fail=True), "opensky": osky}
    region = AircraftJob("region", ProviderChain("region", providers, ctx.status, cooldown_s=0), ctx)
    global_ = AircraftJob("global", ProviderChain("global", providers, ctx.status), ctx)
    for i in range(24 * 60):  # 1분 단위: 전세계 1회 + 관심 지역 6회
        await global_.run_once()
        global_.chain._down_until.clear()  # 예산 소진 후 10분 대기를 건너뛰어 최악(매분 재시도)을 만든다
        if i % 10 == 0:
            for _ in range(6):
                await region.run_once()
    used, limit = await ctx.budget.usage("opensky")
    assert used <= 2880 and limit == 2880
    assert osky.calls * 4 == used == 2880


async def test_reserve_pause_is_shared_by_provider_and_lasts_until_utc_midnight():
    r = FakeRedis()
    ctx = make_ctx(r)
    osky = FakeOpenSky(remaining=100)  # < 예비분 400
    providers = {"opensky": osky}
    job = AircraftJob("global", ProviderChain("global", providers, ctx.status), ctx)
    await job.run_once()
    assert osky.calls == 1 and osky.paused_until == next_utc_midnight()
    other_chain = ProviderChain("global2", providers, ctx.status)
    assert await other_chain.pick(["opensky"], need_global=True) is None  # 다른 체인도 건너뛴다
    await job.run_once()
    assert osky.calls == 1
    osky.paused_until = datetime.now(UTC) - timedelta(seconds=1)
    await job.run_once()
    assert osky.calls == 2


async def test_opensky_fails_closed_when_budget_store_unavailable():
    r = FakeRedis()
    ctx = make_ctx(r)
    osky = FakeOpenSky()
    job = AircraftJob("global", ProviderChain("global", {"opensky": osky}, ctx.status), ctx)
    r.down = True
    await job.run_once()
    assert osky.calls == 0  # 예산을 셀 수 없으면 크레딧을 쓰지 않는다
    assert ctx.db.names == ["ingest_run(global)"]


# ---- REL-3 ---------------------------------------------------------------------------------------------------------
async def test_publish_happens_while_database_is_down():
    attempts = 0

    async def broken_pool():
        nonlocal attempts
        attempts += 1
        raise OSError("db down")

    r = FakeRedis()
    ctx = make_ctx(r)
    ctx.db._factory = broken_pool  # type: ignore[attr-defined]
    ctx.db.start()
    job = AircraftJob("region", ProviderChain("region", {"adsb_lol": FakeReadsb("adsb_lol")}, ctx.status), ctx)
    await asyncio.wait_for(job.run_once(), 2)  # DB 를 기다리지 않는다
    await asyncio.wait_for(job.run_once(), 2)
    assert len(r.streams[STREAM_AIRCRAFT]) == 2
    assert _decode(r.streams[STREAM_AIRCRAFT][0][1])["states"][0]["hex"] == "71c0a1"
    await asyncio.sleep(0.05)
    assert attempts >= 1 and ctx.db.pending == 2 and not ctx.db.available  # 쓰기는 큐에서 재연결을 기다린다
    hb = await r.hgetall("wakeline:collector")
    assert hb["region_at"]
    await ctx.db.close(drain_s=0.2)


async def test_redis_status_errors_do_not_fail_the_job_and_publish_is_queued():
    r = FakeRedis()
    ctx = make_ctx(r)
    job = AircraftJob("region", ProviderChain("region", {"adsb_lol": FakeReadsb("adsb_lol")}, ctx.status), ctx)
    r.down = True
    await job.run_once()  # 예외 없음(스케줄러 백오프로 가지 않는다)
    assert ctx.publisher.queued == 1
    r.down = False
    await job.run_once()
    assert ctx.publisher.queued == 0 and len(r.streams[STREAM_AIRCRAFT]) == 2  # 밀린 것 먼저, 순서 보존


async def test_disabled_flag_uses_last_known_value_when_redis_errors():
    r = FakeRedis()
    ctx = make_ctx(r)
    await r.hset("wakeline:provider:adsb_lol", "disabled", "1")
    chain = ProviderChain("region", {"adsb_lol": FakeReadsb("adsb_lol"), "adsb_fi": FakeReadsb("adsb_fi")}, ctx.status)
    assert (await chain.pick(["adsb_lol", "adsb_fi"])).name == "adsb_fi"
    r.down = True
    assert (await chain.pick(["adsb_lol", "adsb_fi"])).name == "adsb_fi"  # 마지막으로 읽은 disabled 유지


def test_next_midnight():
    t = datetime(2026, 9, 27, 23, 59, 59, tzinfo=UTC)
    assert next_utc_midnight(t) == datetime(2026, 9, 28, tzinfo=UTC)


# ---- COL-5 · DH-13 · COL-2 · 속도 상한 ----------------------------------------------------------------------------------
async def test_region_heartbeat_carries_effective_poll_for_health():
    r = FakeRedis()
    ctx = make_ctx(r)
    ctx.rt.region_poll_s = 120  # type: ignore[misc]
    job = AircraftJob("region", ProviderChain("region", {"adsb_lol": FakeReadsb("adsb_lol")}, ctx.status), ctx)
    await job.run_once()
    assert (await r.hgetall("wakeline:collector"))["region_poll_s"] == "120"
    g = AircraftJob("global", ProviderChain("global", {"opensky": FakeOpenSky()}, ctx.status), ctx)
    await g.run_once()
    assert "global_at" in await r.hgetall("wakeline:collector")


class RejectingReadsb(FakeReadsb):
    async def fetch_region(self, lat, lon, radius):
        self.calls += 1
        now = datetime.now(UTC)
        data = {
            "ac": [
                {"hex": "71c0a1", "lat": 37.0, "lon": 127.0, "alt_baro": "ground", "seen_pos": 1},
                {"hex": "71c0a2", "lat": 37.1, "lon": 127.1, "alt_baro": 1000},  # seen_pos 없음
                {"hex": "71c0a3"},  # 위치 없음
                "garbage",
            ]
        }
        return ProviderResult(self.name, orjson.dumps(data), now, 200, 12, data=data)


async def test_region_quarantines_missing_position_time_and_keeps_ground_altitude_null():
    r = FakeRedis()
    ctx = make_ctx(r)
    recorded = []
    real = ctx.db.record_run

    def spy(*a, **kw):
        recorded.append(kw)
        real(*a, **kw)

    ctx.db.record_run = spy  # type: ignore[method-assign]
    job = AircraftJob("region", ProviderChain("region", {"adsb_lol": RejectingReadsb("adsb_lol")}, ctx.status), ctx)
    await job.run_once()
    states = _decode(r.streams[STREAM_AIRCRAFT][0][1])["states"]
    assert [(s["hex"], s["on_ground"], s["alt_ft"]) for s in states] == [("71c0a1", True, None)]
    q = recorded[0]["quality"]
    assert sorted(x[0] for x in q) == ["no_position", "no_position_time"]
    assert recorded[0]["records_in"] == 3 and recorded[0]["records_quarantined"] == 2


class ThrottledReadsb(FakeReadsb):
    async def fetch_region(self, lat, lon, radius):
        from wakeline_collector.ratelimit import Throttled

        self.calls += 1
        raise Throttled("opendata.adsb.fi", "cooling down 60 s after HTTP 429")


async def test_throttled_call_releases_budget():
    r = FakeRedis()
    ctx = make_ctx(r, limits={"adsb_fi": 100})
    job = AircraftJob("region", ProviderChain("region", {"adsb_fi": ThrottledReadsb("adsb_fi")}, ctx.status), ctx)
    await job.run_once()
    assert (await ctx.budget.usage("adsb_fi"))[0] == 0  # 보내지 않은 호출은 예산에서 되돌린다
    assert "throttled" in (await r.hgetall("wakeline:provider:adsb_fi"))["last_error"]


async def test_region_429_backs_off():
    from wakeline_collector.http import ProviderHttpError

    class RL(FakeReadsb):
        async def fetch_region(self, lat, lon, radius):
            raise ProviderHttpError(429, "too many")

    r = FakeRedis()
    ctx = make_ctx(r)
    chain = ProviderChain("region", {"adsb_lol": RL("adsb_lol")}, ctx.status)
    await AircraftJob("region", chain, ctx).run_once()
    assert chain._down_until["adsb_lol"] > 0 and ctx.db.names == ["ingest_run(region)"]  # type: ignore[attr-defined]
