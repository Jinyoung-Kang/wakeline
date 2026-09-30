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


# ---- 운영 로그 2026-09-30 KST: 'region: no provider available …'(12:16:32 · 12:22:28) — 무엇이 왜 없는지 알린다 ---------------------
class Once429(FakeReadsb):
    """처음 한 번 429, 그 뒤 성공."""

    async def fetch_region(self, lat, lon, radius):
        from wakeline_collector.http import ProviderHttpError

        if self.calls == 0:
            self.calls += 1
            raise ProviderHttpError(429, "too many")
        return await super().fetch_region(lat, lon, radius)


async def test_region_without_any_provider_is_explicit_in_redis_events_and_the_log(monkeypatch, caplog):
    """고치기 전: wakeline:active 는 그대로 'region: adsb_lol'(운영 화면 초록 배지), 로그는 까닭 없는 한 줄
    'no provider available (not configured, disabled, cooling down or paused)', 전환 기록 없음."""
    from wakeline_collector.logsink import fingerprint

    caplog.set_level(logging.INFO, logger="job.aircraft")
    clk = [80_000.0]
    monkeypatch.setattr(fallback, "time", SimpleNamespace(monotonic=lambda: clk[0]))
    r = FakeRedis()
    ctx = make_ctx(r)
    await r.hset("wakeline:provider:adsb_fi", mapping={"disabled": "1"})  # 운영자가 끔
    lol, fi = Once429("adsb_lol"), FakeReadsb("adsb_fi")
    job = AircraftJob("region", ProviderChain("region", {"adsb_lol": lol, "adsb_fi": fi}, ctx.status), ctx)
    await job.run_once()  # adsb_lol 429 → 60 s 쉼
    before = datetime.now(UTC)
    await job.run_once()  # 공급자 없음
    act = await r.hgetall("wakeline:active")
    assert act["region"] == "adsb_lol"  # 마지막으로 쓴 공급자(기록) — 지금 상태는 아래 필드가 말한다
    assert act["region_none_reason"] == "adsb_lol 429 쉼(60 s) · adsb_fi 운영자 끔"
    since = datetime.fromisoformat(act["region_none_since"].replace("Z", "+00:00"))
    nxt = datetime.fromisoformat(act["region_none_next"].replace("Z", "+00:00"))
    assert abs((since - before).total_seconds()) < 5 and 55 <= (nxt - before).total_seconds() <= 61
    warns = _warnings(caplog)
    assert (
        warns[-1]
        == "region: no provider available — skipped: 'adsb_lol 429 쉼(60 s) · adsb_fi 운영자 끔'; next: 'adsb_lol after 60 s'"
    )
    other = "region: no provider available — skipped: 'adsb_lol 운영자 끔'; next: 'none known — an operator must switch one on'"
    assert fingerprint("collector", "job.aircraft", "", warns[-1]) == fingerprint("collector", "job.aircraft", "", other)
    await job.run_once()  # 같은 공백 — 다시 WARN 하지 않는다
    assert len([w for w in _warnings(caplog) if "no provider" in w]) == 1
    clk[0] += 61
    await job.run_once()  # 쉼 끝 — adsb_lol 성공
    act = await r.hgetall("wakeline:active")
    assert act["region"] == "adsb_lol" and act["region_none_since"] == "" and act["region_none_reason"] == ""
    assert act["region_reason"] == "recovery — 공급자 없음 61 s 끝 · adsb_lol 쉼 끝"
    ev = [f for _id, f in r.streams["wakeline:events"]]
    assert [(e["from"], e["to"]) for e in ev] == [("adsb_lol", "none"), ("none", "adsb_lol")]
    infos = [x.getMessage() for x in caplog.records if x.name == "job.aircraft" and x.levelno == logging.INFO]
    assert "region: a provider is available again after 61 s without one — 'adsb_lol'" in infos


async def test_takeover_calls_adsb_lol_once_per_cycle_and_never_retries_a_429_within_the_cycle(monkeypatch):
    """(운영 로그 질문 2) 넘겨받은 직후 우리 쪽 adsb.lol 호출 속도: 관심 지역 주기마다 한 번 — 넘겨받을 때 몰아 부르지 않고, 429 를 같은 주기에
    다시 부르지 않는다. 저장소가 인용한 adsb.lol 한도 수치는 없다(README: 'dynamic based on the environment load' — ADR-011) — 그래서 속도를 추정해
    늦추지 않는다. 고치기 전후 모두 통과하는 특성 시험이다 — 이 작업의 호출 수만 센다(회귀 방지가 아니다, 리뷰 2026-09-30). 'adsb.lol 을 부르는
    작업은 관심 지역 체인뿐'은 아래 test_only_the_aircraft_chain_calls_adsb_lol 이 소스에서 지킨다."""
    clk = [80_000.0]
    monkeypatch.setattr(fallback, "time", SimpleNamespace(monotonic=lambda: clk[0]))
    ctx = make_ctx(FakeRedis())
    lol, fi = RL429("adsb_lol"), FakeReadsb("adsb_fi", fail=True)
    job = AircraftJob("region", ProviderChain("region", {"adsb_fi": fi, "adsb_lol": lol}, ctx.status), ctx)
    for _ in range(3):  # adsb_fi 3회 연속 실패 → 넘겨준다
        await job.run_once()
        clk[0] += 10
    await job.run_once()  # 넘겨받은 첫 주기 — adsb_lol 한 번(429)
    assert lol.calls == 1


async def test_region_429_warning_names_the_cooling_provider_that_is_retried_next(monkeypatch, caplog):
    """12:16:22 KST 의 429 경고는 'adsb_lol again after the backoff (no other provider …)' 였다. 이제 다음 주기에 3회 연속 실패로 쉬는 adsb_fi 를 다시
    시도하므로 그렇게 적는다 — 'takes over' 가 아니다(쉬는 공급자를 다시 시도하는 것). 따옴표 안만 달라 지문은 같다."""
    from wakeline_collector.logsink import fingerprint

    caplog.set_level(logging.INFO, logger="job.aircraft")
    clk = [80_000.0]
    monkeypatch.setattr(fallback, "time", SimpleNamespace(monotonic=lambda: clk[0]))
    r = FakeRedis()
    ctx = make_ctx(r)
    lol, fi = RL429("adsb_lol"), FakeReadsb("adsb_fi", fail=True)
    job = AircraftJob("region", ProviderChain("region", {"adsb_lol": lol, "adsb_fi": fi}, ctx.status), ctx)
    await r.hset("wakeline:provider:adsb_lol", mapping={"disabled": "1"})  # 그동안 adsb_fi 가 맡는다
    for _ in range(3):  # adsb_fi 3회 연속 실패 → 쉼
        await job.run_once()
        clk[0] += 10
    await r.hset("wakeline:provider:adsb_lol", mapping={"disabled": "0"})
    await job.run_once()  # adsb_lol 429
    w = _warnings(caplog)[-1]
    assert (
        w
        == "region: adsb_lol rate limited (429) — backing off 60 s, deferred 0 min; next: 'adsb_fi retried while cooling down (no other provider)'"
    )
    old = "region: adsb_lol rate limited (429) — backing off 60 s, deferred 0 min; next: 'adsb_fi takes over'"
    assert fingerprint("collector", "job.aircraft", "", w) == fingerprint("collector", "job.aircraft", "", old)
    clk[0] += 10
    await job.run_once()
    assert fi.calls == 4  # 다음 주기에 다시 시도했다


async def test_retrying_a_cooling_provider_is_shown_as_no_provider_until_it_answers(monkeypatch, caplog):
    """운영 로그 2026-09-30 의 모양(adsb_fi 연결 실패 3회로 쉼 · adsb_lol 429 쉼): 다른 공급자가 없어 adsb_fi 를 주기마다 다시 시도하는 동안에도
    '공급자 없음'이다 — wakeline:active 의 region_none_*(+ region_none_retry = adsb_fi), 전환 기록 adsb_lol → none, 공백마다 WARN 한 번.
    리뷰 2026-09-30: 고친 뒤 첫 판은 이 상태를 비워 두었다 — 운영 배지 초록 'region: adsb_fi', 상태 바에 '공급자 없음' 없음, 다시 시도의 실패는 INFO
    (로그 화면은 WARN 이상). adsb_fi 가 답하면 그 주기에 끝난다(none → adsb_fi · INFO)."""
    from wakeline_collector.logsink import fingerprint

    caplog.set_level(logging.INFO, logger="job.aircraft")
    clk = [80_000.0]
    monkeypatch.setattr(fallback, "time", SimpleNamespace(monotonic=lambda: clk[0]))
    r = FakeRedis()
    ctx = make_ctx(r)
    ctx.rt.provider_order = ["adsb_fi", "adsb_lol"]  # 로그 때처럼 adsb_fi 가 맡고 있었다(adsb_lol 은 429 미룸 중이었다)
    lol, fi = RL429("adsb_lol"), FakeReadsb("adsb_fi", fail=True)
    job = AircraftJob("region", ProviderChain("region", {"adsb_fi": fi, "adsb_lol": lol}, ctx.status), ctx)
    for _ in range(3):  # 12:14:50 — adsb_fi 3회 연속 실패 → 10분 쉼
        await job.run_once()
        clk[0] += 10
    await job.run_once()  # adsb_lol 이 맡아 429 → 60 s 쉼
    clk[0] += 10
    snaps = []
    for _ in range(3):  # adsb_lol 쉼 안: adsb_fi 다시 시도(실패)
        await job.run_once()
        clk[0] += 10
        snaps.append(await r.hgetall("wakeline:active"))
    assert fi.calls == 6
    assert all(a["region_none_since"] for a in snaps) and len({a["region_none_since"] for a in snaps}) == 1
    assert {a["region_none_retry"] for a in snaps} == {"adsb_fi"}
    assert snaps[-1]["region_none_reason"] == "adsb_fi 3회 연속 실패(10분 쉼) · adsb_lol 429 쉼(60 s)"
    assert snaps[-1]["region"] == "adsb_lol"  # 마지막으로 쓴 공급자(기록)
    gap = [w for w in _warnings(caplog) if "no provider available" in w]
    assert gap == [
        "region: no provider available — skipped: 'adsb_fi 3회 연속 실패(10분 쉼) · adsb_lol 429 쉼(60 s)'; "
        "next: 'adsb_fi retried each cycle while cooling down (no other provider); adsb_lol after 50 s'"
    ]
    other = "region: no provider available — skipped: 'adsb_lol 운영자 끔'; next: 'none known'"
    assert fingerprint("collector", "job.aircraft", "", gap[0]) == fingerprint("collector", "job.aircraft", "", other)  # 한 묶음
    fi.fail = False
    await job.run_once()  # adsb_fi 가 답했다
    act = await r.hgetall("wakeline:active")
    assert act["region"] == "adsb_fi" and act["region_none_since"] == "" and act["region_none_retry"] == ""
    assert act["region_reason"] == "recovery — 공급자 없음 30 s 끝 · adsb_fi 다시 시도 성공"
    ev = [(f["from"], f["to"]) for _id, f in r.streams["wakeline:events"]]
    assert ev == [("adsb_fi", "adsb_lol"), ("adsb_lol", "none"), ("none", "adsb_fi")]
    infos = [x.getMessage() for x in caplog.records if x.name == "job.aircraft" and x.levelno == logging.INFO]
    assert "region: a provider is available again after 30 s without one — 'adsb_fi'" in infos
    clk[0] += 10
    await job.run_once()
    assert len([w for w in _warnings(caplog) if "no provider available" in w]) == 1


async def test_switching_global_off_clears_its_no_provider_state(monkeypatch, caplog):
    """리뷰 2026-09-30: 전세계가 켜진 동안 '공급자 없음'(예: OpenSky 설정 안 됨)을 쓴 뒤 운영자가 전세계를 끄면 run_once 가 공급자를 고르기 전에
    돌아가 아무도 지우지 않았다 — 운영 배지가 빨강 'global: 공급자 없음'으로 계속 남았다. 앞선 프로세스가 남긴 값도 같다."""
    caplog.set_level(logging.INFO, logger="job.aircraft")
    r = FakeRedis()
    ctx = make_ctx(r)
    osky = FakeOpenSky()
    osky._id = ""  # 설정 안 됨
    assert osky.configured is False
    job = AircraftJob("global", ProviderChain("global", {"opensky": osky}, ctx.status), ctx)
    await job.run_once()
    assert (await r.hgetall("wakeline:active"))["global_none_since"]
    ctx.rt.global_enabled = False
    await job.run_once()
    act = await r.hgetall("wakeline:active")
    assert act["global_none_since"] == "" and act["global_none_reason"] == "" and act["global_none_next"] == ""
    assert job.chain.none_since is None
    # 다시 띄운 수집기: 앞선 프로세스가 남긴 값도 지운다(끈 동안 한 번)
    await r.hset("wakeline:active", mapping={"global_none_since": "2026-09-30T03:16:32Z", "global_none_reason": "x"})
    job2 = AircraftJob("global", ProviderChain("global", {"opensky": osky}, ctx.status), ctx)
    await job2.run_once()
    assert (await r.hgetall("wakeline:active"))["global_none_since"] == ""
    await r.hset("wakeline:active", mapping={"global_none_since": "2026-09-30T03:16:32Z"})
    await job2.run_once()  # 끈 동안은 한 번만 쓴다
    assert (await r.hgetall("wakeline:active"))["global_none_since"] == "2026-09-30T03:16:32Z"


def test_only_the_aircraft_chain_calls_adsb_lol():
    """'넘겨받은 직후 adsb.lol 호출은 관심 지역 주기마다 한 번'이 수집기 전체의 속도가 되려면 adsb.lol 을 부르는 곳이 항공기 체인뿐이어야 한다(리뷰
    2026-09-30: 전에는 코드 검색으로만 확인했다). 수집기 소스에서 adsb.lol 주소는 공급자 정의 · 호스트 허용 목록에만, 공급자를 만드는 곳은 main.py 의
    항공기 공급자(관심 지역 · 전세계 체인 — adsb_lol 은 관심 지역만 지원)와 수동 도구 tools/snapshot.py(운영 작업이 아니다)뿐이다."""
    import re
    from pathlib import Path

    import wakeline_collector

    root = Path(wakeline_collector.__file__).parent
    url, make = {}, {}
    for f in sorted(root.rglob("*.py")):
        rel = f.relative_to(root).as_posix()
        code = "\n".join(line.split("#", 1)[0] for line in f.read_text(encoding="utf-8").splitlines())
        code = re.sub(r'"""[\s\S]*?"""', "", code)  # 설명 글은 빼고 코드만
        if "api.adsb.lol" in code:
            url[rel] = code.count("api.adsb.lol")
        n = len(re.findall(r"\badsb_lol\(", code))
        if n:
            make[rel] = n
    assert url == {"http.py": 1, "providers/readsb.py": 1}
    assert make == {"main.py": 1, "providers/readsb.py": 1, "tools/snapshot.py": 1}  # readsb.py 는 정의(def adsb_lol(…))


# ---- 관심 지역 순서 adsb_fi → adsb_lol(ADR-011 개정 2026-09-30 저녁 · 계약 v5 §G25) ----------------------------------------------
# 운영/로그 2026-09-30: adsb.lol 은 미룸이 끝나 체인이 돌아올 때마다 1–2분 안에 429 였다(05:46 · 11:48 · 12:16/12:22 · 18:24 KST) — adsb.fi 는 그날
# 관심 지역을 하루 내내 맡았다(ok 7,797). 기본 순서를 adsb_fi 먼저로 바꾼다 — adsb.lol 은 폴백으로만, 그때의 429 쉼 · 미룸(R-17)은 그대로.
# 이 절의 시험은 FakeRt(이 파일의 다른 시험이 쓰는 옛 순서) 대신 실제 RuntimeSettings(설정 해시가 빈 경우 — 기본값)를 쓴다.
async def _default_order_ctx(r):
    from wakeline_collector.runtime_settings import RuntimeSettings

    ctx = make_ctx(r)
    ctx.rt = RuntimeSettings(r)  # type: ignore[assignment] — wakeline:settings 가 비었다(api 미러 전) → 설정 기본값
    await ctx.rt.refresh()
    return ctx


async def test_the_default_region_chain_is_adsb_fi_then_adsb_lol():
    """고치기 전: 기본값 adsb_lol,adsb_fi,opensky — 첫 주기에 adsb.lol 을 불렀다."""
    from wakeline_collector.runtime_settings import RuntimeSettings

    assert Settings().provider_order == ["adsb_fi", "adsb_lol", "opensky"]
    rt = RuntimeSettings(FakeRedis())  # type: ignore[arg-type]
    await rt.refresh()
    assert rt.provider_order == ["adsb_fi", "adsb_lol", "opensky"]


async def test_default_order_starts_on_adsb_fi_falls_back_to_adsb_lol_and_returns(monkeypatch):
    clk = [80_000.0]
    monkeypatch.setattr(fallback, "time", SimpleNamespace(monotonic=lambda: clk[0]))
    r = FakeRedis()
    ctx = await _default_order_ctx(r)
    lol, fi, osky = FakeReadsb("adsb_lol"), FakeReadsb("adsb_fi"), FakeOpenSky()
    # main.py 의 사전 순서 그대로 — 순위는 설정(aircraft_providers)이 정한다
    providers = {"adsb_lol": lol, "adsb_fi": fi, "opensky": osky}
    job = AircraftJob("region", ProviderChain("region", providers, ctx.status), ctx)
    await job.run_once()
    assert (fi.calls, lol.calls) == (1, 0)
    act = await r.hgetall("wakeline:active")
    assert (act["region"], act["region_reason"]) == ("adsb_fi", "initial")
    fi.fail = True
    for _ in range(3):  # adsb_fi 3회 연속 실패 → 10분 쉼
        clk[0] += 10
        await job.run_once()
    clk[0] += 10
    await job.run_once()  # adsb.lol 이 폴백으로 맡는다
    assert (fi.calls, lol.calls) == (4, 1)
    act = await r.hgetall("wakeline:active")
    assert (act["region"], act["region_reason"]) == ("adsb_lol", "fallback — adsb_fi 3회 연속 실패(10분 쉼)")
    fi.fail = False
    clk[0] += 600
    await job.run_once()  # 쉼 끝 — 1순위로 돌아온다
    act = await r.hgetall("wakeline:active")
    assert (act["region"], act["region_reason"]) == ("adsb_fi", "recovery — adsb_fi 쉼 끝(1순위 복귀)")
    assert (fi.calls, lol.calls, osky.calls) == (5, 1, 0)
    ev = [(f["from"], f["to"]) for _id, f in r.streams["wakeline:events"]]
    assert ev == [("adsb_fi", "adsb_lol"), ("adsb_lol", "adsb_fi")]


async def test_adsb_lol_as_fallback_keeps_its_429_backoff_and_deferral(monkeypatch, caplog):
    """폴백으로 쓰일 때도 adsb.lol 의 429 쉼(60 → 120 … 300 s)과 15분 안에 되풀이되면 미룸(10 → … 360분 — R-17)은 그대로다.
    adsb_fi 가 돌아오면(운영자 켬) 1순위로 돌아가고, adsb.lol 의 미룸 이력은 남는다(그 뒤 폴백이 필요하면 미룸이 끝났는지 본다)."""
    caplog.set_level(logging.INFO, logger="job.aircraft")
    clk = [80_000.0]
    monkeypatch.setattr(fallback, "time", SimpleNamespace(monotonic=lambda: clk[0]))
    r = FakeRedis()
    ctx = await _default_order_ctx(r)
    lol, fi = RL429("adsb_lol"), FakeReadsb("adsb_fi")
    chain = ProviderChain("region", {"adsb_lol": lol, "adsb_fi": fi}, ctx.status)
    job = AircraftJob("region", chain, ctx)
    await r.hset("wakeline:provider:adsb_fi", mapping={"disabled": "1"})  # 운영자가 adsb_fi 를 껐다 → adsb.lol 이 맡는다
    await job.run_once()
    assert _warnings(caplog)[-1] == (
        "region: adsb_lol rate limited (429) — backing off 60 s, deferred 0 min; "
        "next: 'adsb_lol again after the backoff (no other provider)'"
    )
    clk[0] += 61
    await job.run_once()  # 15분 안에 되풀이 → 120 s 쉬고 10분 미룸
    assert _warnings(caplog)[-1] == (
        "region: adsb_lol rate limited (429) — backing off 120 s, deferred 10 min; "
        "next: 'adsb_lol again after the backoff (no other provider — deferral not applied)'"
    )
    assert chain.hold_s("adsb_lol") == 600
    await r.hset("wakeline:provider:adsb_fi", mapping={"disabled": "0"})
    clk[0] += 121  # adsb.lol 의 쉼(120 s)은 끝났고 미룸(10분)은 남았다
    await job.run_once()
    act = await r.hgetall("wakeline:active")
    assert (act["region"], act["region_reason"]) == ("adsb_fi", "recovery — adsb_fi 운영자 켬(1순위 복귀)")
    assert fi.calls == 1 and lol.calls == 2
    assert chain.hold_s("adsb_lol") == 600  # 미룸은 그대로(폴백 순위에서도 되풀이된 429 는 늦게 돌아온다)


async def test_the_global_chain_is_unaffected_by_the_region_order():
    """전세계는 OpenSky 만 지원한다 — 순서를 바꿔도 전세계 체인은 readsb 공급자를 부르지 않는다."""
    r = FakeRedis()
    ctx = await _default_order_ctx(r)
    lol, fi, osky = FakeReadsb("adsb_lol"), FakeReadsb("adsb_fi"), FakeOpenSky()
    job = AircraftJob("global", ProviderChain("global", {"adsb_lol": lol, "adsb_fi": fi, "opensky": osky}, ctx.status), ctx)
    await job.run_once()
    assert (osky.calls, fi.calls, lol.calls) == (1, 0, 0)
    act = await r.hgetall("wakeline:active")
    assert (act["global"], act["global_reason"]) == ("opensky", "initial")


def test_the_startup_line_names_the_region_chain_in_its_real_order():
    """기동 로그 한 줄은 순서를 박아 두지 않고(전에는 'region chain uses adsb_lol → adsb_fi' 고정 글) 설정의 실제 순서에서 관심 지역을 지원하는 공급자만 적는다."""
    from wakeline_collector.main import region_chain_line

    providers = {"adsb_lol": adsb_lol(None), "adsb_fi": adsb_fi(None), "opensky": OpenSkyProvider(None, "", "")}  # type: ignore[arg-type]
    assert region_chain_line(Settings().provider_order, providers, 2880) == (
        "region chain uses adsb_fi → adsb_lol (aircraft_providers: runtime setting, else .env); "
        "opensky is global-only (daily cap 2880 credits)"
    )
    assert region_chain_line(["adsb_lol", "adsb_fi"], providers, 2880) == (
        "region chain uses adsb_lol → adsb_fi (aircraft_providers: runtime setting, else .env)"
    )
    assert region_chain_line(["opensky"], providers, 2880).startswith("region chain uses no provider ")
