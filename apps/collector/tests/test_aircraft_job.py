"""항공기 작업: OpenSky 크레딧 상한(GAP-5/REL-14), 실시간 경로의 DB·Redis 비의존(REL-3)."""

from __future__ import annotations

import asyncio
import base64
import gzip
import logging
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

import httpx
import orjson
import pytest
import respx
from fakes import FakeRedis, make_ctx

from wakeline_collector import fallback
from wakeline_collector.config import Settings
from wakeline_collector.fallback import ProviderChain
from wakeline_collector.http import HttpClient
from wakeline_collector.jobs.aircraft import AircraftJob, next_utc_midnight
from wakeline_collector.main import build_limits
from wakeline_collector.models import BudgetInfo, ProviderResult
from wakeline_collector.providers.opensky import OpenSkyProvider
from wakeline_collector.providers.readsb import adsb_fi, adsb_lol
from wakeline_collector.publisher import STREAM_AIRCRAFT
from wakeline_collector.ratelimit import RateLimiter


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


def _spy_runs(ctx) -> list[dict]:
    recorded: list[dict] = []
    real = ctx.db.record_run

    def spy(*a, **kw):
        recorded.append({"job": a[0], "provider": a[1], **kw})
        real(*a, **kw)

    ctx.db.record_run = spy
    return recorded


async def test_throttled_call_releases_budget_and_is_not_a_failure():
    r = FakeRedis()
    ctx = make_ctx(r, limits={"adsb_fi": 100})
    runs = _spy_runs(ctx)
    chain = ProviderChain("region", {"adsb_fi": ThrottledReadsb("adsb_fi")}, ctx.status)
    job = AircraftJob("region", chain, ctx)
    for _ in range(3):
        await job.run_once()
    assert (await ctx.budget.usage("adsb_fi"))[0] == 0  # 보내지 않은 호출은 예산에서 되돌린다
    h = await r.hgetall("wakeline:provider:adsb_fi")
    assert "last_error" not in h and "consecutive_failures" not in h  # 공급자 실패로 보이지 않는다
    assert chain._fails.get("adsb_fi", 0) == 0 and "adsb_fi" not in chain._down_until  # 쿨다운 정보 없음 → 건너뛰지 않는다
    assert [x["status"] for x in runs] == ["throttled"] * 3


async def test_limiter_cooldown_from_another_call_does_not_take_region_offline(monkeypatch):
    """리뷰 2026-09-28b #0: focus·hot 이 받은 429 로 제한기가 막은 관심 지역 호출은 보내지 않은 것이다.
    3회 규칙(10분 쿨다운)·공급자 실패 기록에 넣지 않고, 제한기 쿨다운이 남은 동안만 그 공급자를 건너뛴다."""
    clk = [1000.0]
    monkeypatch.setattr(fallback, "time", SimpleNamespace(monotonic=lambda: clk[0]))
    r = FakeRedis()
    ctx = make_ctx(r, limits={"adsb_lol": 0, "adsb_fi": 100})
    runs = _spy_runs(ctx)
    http = HttpClient(RateLimiter(2.0, 2, {"opendata.adsb.fi": (0.8, 1)}, clock=lambda: clk[0]))
    chain = ProviderChain("region", {"adsb_lol": adsb_lol(http), "adsb_fi": adsb_fi(http)}, ctx.status)
    chain.mark_down("adsb_lol", 600)  # 1순위가 쉬는 중 → 관심 지역이 adsb.fi 폴백에 기댄다
    job = AircraftJob("region", chain, ctx)
    assert http.limiter.penalize("opendata.adsb.fi") == 30.0  # 다른 작업의 429
    with respx.mock:  # 모의 경로 없음 → 실제로 보내면 실패
        for dt in (1, 11, 21):
            clk[0] = 1000 + dt
            await job.run_once()
    assert chain._down_until["adsb_fi"] == pytest.approx(1030.0)  # 제한기 쿨다운 끝까지만(전: 600 s)
    assert chain._fails.get("adsb_fi", 0) == 0
    h = await r.hgetall("wakeline:provider:adsb_fi")
    assert "consecutive_failures" not in h and "last_error" not in h
    assert (await ctx.budget.usage("adsb_fi"))[0] == 0
    assert [x["status"] for x in runs] == ["throttled"]  # 건너뛴 주기는 호출도 기록도 없다

    clk[0] = 1031.0  # 쿨다운이 끝나면 바로 돌아온다
    body = {"now": datetime.now(UTC).timestamp() * 1000, "ac": [{"hex": "71c0a1", "lat": 37.0, "lon": 127.0, "seen_pos": 1}]}
    with respx.mock:
        route = respx.get(url__startswith="https://opendata.adsb.fi/api/v3/lat/").mock(
            return_value=httpx.Response(200, json=body)
        )
        await job.run_once()
    assert route.call_count == 1 and len(r.streams[STREAM_AIRCRAFT]) == 1
    assert (await r.hgetall("wakeline:provider:adsb_fi"))["consecutive_failures"] == "0"
    await http.aclose()


async def test_real_provider_errors_keep_three_strike_rule():
    r = FakeRedis()
    ctx = make_ctx(r)
    chain = ProviderChain("region", {"adsb_lol": FakeReadsb("adsb_lol", fail=True)}, ctx.status)
    job = AircraftJob("region", chain, ctx)
    for _ in range(3):
        await job.run_once()
    assert "adsb_lol" in chain._down_until  # 3회 연속 실패 → 쿨다운
    assert (await r.hgetall("wakeline:provider:adsb_lol"))["consecutive_failures"] == "3"


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


async def test_r20_region_lag_is_age_of_newest_published_observation():
    """리뷰 R-20: lag_s 가 응답 처리 시간(now − fetched_at, 늘 0.x s)이었다. 이제 발행한 관측 중 가장 새 seen_at 의 나이."""

    class Aged(FakeReadsb):
        async def fetch_region(self, lat, lon, radius):
            now = datetime.now(UTC)
            data = {
                "ac": [
                    {"hex": "71c0a1", "lat": 37.0, "lon": 127.0, "alt_baro": 30000, "gs": 400, "track": 90, "seen_pos": 12.0},
                    {"hex": "71c0a2", "lat": 37.1, "lon": 127.1, "alt_baro": 30000, "gs": 400, "track": 90, "seen_pos": 20.0},
                ]
            }
            return ProviderResult(self.name, orjson.dumps(data), now, 200, 12, data=data)

    r = FakeRedis()
    ctx = make_ctx(r)
    await AircraftJob("region", ProviderChain("region", {"adsb_lol": Aged("adsb_lol")}, ctx.status), ctx).run_once()
    lag = float((await r.hgetall("wakeline:collector"))["region_lag_s"])
    assert 12.0 <= lag < 14.0  # 가장 새 관측(seen_pos 12 s)의 나이


async def test_r20_region_lag_is_unknown_when_nothing_was_published():
    class Empty(FakeReadsb):
        async def fetch_region(self, lat, lon, radius):
            data: dict = {"ac": []}
            return ProviderResult(self.name, orjson.dumps(data), datetime.now(UTC), 200, 12, data=data)

    r = FakeRedis()
    ctx = make_ctx(r)
    await AircraftJob("region", ProviderChain("region", {"adsb_lol": Empty("adsb_lol")}, ctx.status), ctx).run_once()
    assert (await r.hgetall("wakeline:collector"))["region_lag_s"] == ""


async def test_r33_one_inf_record_does_not_sink_the_region_batch():
    """리뷰 R-33: 정상 50대 + alt_baro='inf' 1대 → 전에는 OverflowError 로 발행 0건. 이제 51대 모두 발행(그 1대는 고도 모름)."""

    class InfReadsb(FakeReadsb):
        async def fetch_region(self, lat, lon, radius):
            now = datetime.now(UTC)
            ac = [
                {"hex": f"71c{i:03x}", "lat": 37.0, "lon": 127.0, "alt_baro": 30000, "gs": 400, "track": 90, "seen_pos": 1}
                for i in range(50)
            ]
            ac.append(
                {"hex": "71cfff", "lat": 37.1, "lon": 127.1, "alt_baro": "inf", "gs": "Infinity", "track": 90, "seen_pos": 1}
            )
            data = {"ac": ac}
            return ProviderResult(self.name, orjson.dumps(data), now, 200, 12, data=data)

    r = FakeRedis()
    ctx = make_ctx(r)
    chain = ProviderChain("region", {"adsb_lol": InfReadsb("adsb_lol")}, ctx.status)
    await AircraftJob("region", chain, ctx).run_once()
    ((_sid, fields),) = r.streams[STREAM_AIRCRAFT]
    states = {s["hex"]: s for s in _decode(fields)["states"]}
    assert len(states) == 51 and states["71cfff"]["alt_ft"] is None and states["71cfff"]["gs_kt"] is None
    assert (await r.hgetall("wakeline:collector"))["region_at"]


# ---- 429 경고는 다음에 무엇을 하는지 말한다 · 전환 사유 ---------------------------------------------------------------------
class RL429(FakeReadsb):
    async def fetch_region(self, lat, lon, radius):
        from wakeline_collector.http import ProviderHttpError

        self.calls += 1
        raise ProviderHttpError(429, "too many")


def _warnings(caplog) -> list[str]:
    return [r.getMessage() for r in caplog.records if r.name == "job.aircraft" and r.levelno == logging.WARNING]


async def test_region_429_warning_says_what_happens_next(monkeypatch, caplog):
    caplog.set_level(logging.INFO, logger="job.aircraft")
    clk = [80_000.0]
    monkeypatch.setattr(fallback, "time", SimpleNamespace(monotonic=lambda: clk[0]))
    r = FakeRedis()
    ctx = make_ctx(r)
    lol, fi = RL429("adsb_lol"), FakeReadsb("adsb_fi")
    chain = ProviderChain("region", {"adsb_lol": lol, "adsb_fi": fi}, ctx.status)
    job = AircraftJob("region", chain, ctx)
    await job.run_once()
    assert _warnings(caplog)[-1] == (
        "region: adsb_lol rate limited (429) — backing off 60 s, deferred 0 min; next: 'adsb_fi takes over'"
    )
    await job.run_once()  # adsb_fi
    assert fi.calls == 1
    assert (await r.hgetall("wakeline:active"))["region_reason"] == "fallback — adsb_lol 429 쉼(60 s)"
    clk[0] += 61
    await job.run_once()  # 1순위 복귀 → 다시 429(15분 안) → 120 s 쉬고 10분 뒤로 미룸
    assert _warnings(caplog)[-1] == (
        "region: adsb_lol rate limited (429) — backing off 120 s, deferred 10 min; next: 'adsb_fi takes over'"
    )


async def test_region_429_warning_when_no_other_provider(monkeypatch, caplog):
    caplog.set_level(logging.INFO, logger="job.aircraft")
    clk = [80_000.0]
    monkeypatch.setattr(fallback, "time", SimpleNamespace(monotonic=lambda: clk[0]))
    ctx = make_ctx(FakeRedis())
    job = AircraftJob("region", ProviderChain("region", {"adsb_lol": RL429("adsb_lol")}, ctx.status), ctx)
    await job.run_once()
    assert _warnings(caplog)[-1] == (
        "region: adsb_lol rate limited (429) — backing off 60 s, deferred 0 min; "
        "next: 'adsb_lol again after the backoff (no other provider)'"
    )
    clk[0] += 61
    await job.run_once()  # 15분 안에 되풀이 — 미룸이 걸렸지만 다른 공급자가 없어 쉼 뒤 다시 쓴다
    assert _warnings(caplog)[-1] == (
        "region: adsb_lol rate limited (429) — backing off 120 s, deferred 10 min; "
        "next: 'adsb_lol again after the backoff (no other provider — deferral not applied)'"
    )


def test_region_429_warnings_share_one_log_fingerprint():
    """/logs 에서 429 한 계열이 한 묶음(지문)으로 보인다 — 바뀌는 값은 숫자와 따옴표 안에만 둔다(logsink.message_template).
    이전: 뒤에 붙인 '다음에 무엇을 하는지'의 문장 모양이 4가지라 한 계열이 2–4개 지문으로 갈렸다."""
    from wakeline_collector.logsink import fingerprint

    msgs = [
        "region: adsb_lol rate limited (429) — backing off 60 s, deferred 0 min; next: 'adsb_fi takes over'",
        "region: adsb_lol rate limited (429) — backing off 300 s, deferred 60 min; next: 'adsb_fi takes over'",
        "region: adsb_lol rate limited (429) — backing off 60 s, deferred 0 min; "
        "next: 'adsb_lol again after the backoff (no other provider)'",
        "region: adsb_lol rate limited (429) — backing off 240 s, deferred 20 min; "
        "next: 'adsb_lol again after the backoff (no other provider — deferral not applied)'",
    ]
    assert len({fingerprint("collector", "job.aircraft", "", m) for m in msgs}) == 1


async def test_budget_and_limiter_cooldowns_name_their_reason(monkeypatch):
    clk = [80_000.0]
    monkeypatch.setattr(fallback, "time", SimpleNamespace(monotonic=lambda: clk[0]))
    r = FakeRedis()
    ctx = make_ctx(r, limits={"adsb_lol": 1, "adsb_fi": 0, "opensky": 2880})
    chain = ProviderChain("region", {"adsb_lol": FakeReadsb("adsb_lol"), "adsb_fi": FakeReadsb("adsb_fi")}, ctx.status)
    job = AircraftJob("region", chain, ctx)
    await job.run_once()  # adsb_lol 예산 1회분 사용
    await job.run_once()  # 예산 소진 → 10분 쉼
    await job.run_once()  # → adsb_fi
    assert (await r.hgetall("wakeline:active"))["region_reason"] == "fallback — adsb_lol 예산 소진(10분 쉼)"


async def test_region_429_history_survives_a_collector_restart(monkeypatch):
    """재배포(재시작) 직후 1순위(adsb_lol)를 바로 다시 부르지 않는다 — 429 이력을 Redis 에서 되살린다(R-17 보존)."""
    from wakeline_collector.chain_store import ChainStateStore

    clk = [80_000.0]
    wall = [1_790_000_000.0]
    monkeypatch.setattr(fallback, "time", SimpleNamespace(monotonic=lambda: clk[0]))
    r = FakeRedis()

    def build():
        ctx = make_ctx(r)
        lol, fi = RL429("adsb_lol"), FakeReadsb("adsb_fi")
        store = ChainStateStore(r, wall=lambda: wall[0])  # type: ignore[arg-type]
        chain = ProviderChain("region", {"adsb_lol": lol, "adsb_fi": fi}, ctx.status, store=store)
        return AircraftJob("region", chain, ctx), lol, fi

    job, lol, fi = build()
    await job.run_once()  # 429 → 60 s 쉼, 저장
    assert "wakeline:provider:adsb_lol:ratelimit:region" in r.kv
    clk[0], wall[0] = 5.0, wall[0] + 15  # 재시작: 새 단조 시계, 벽시계는 15 s 뒤
    job2, lol2, fi2 = build()
    await job2.run_once()
    assert lol2.calls == 0 and fi2.calls == 1
    assert (await r.hgetall("wakeline:active"))["region_reason"] == "initial — adsb_lol 429 쉼(60 s)(재시작 전 기록)"
