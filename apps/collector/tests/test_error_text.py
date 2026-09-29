"""작업이 운영 화면(공급자 상태 last_error)·실행 기록(error_text)·로그에 싣는 오류 문구 — repr(e) 대신 describe_error.

운영 화면에 보였던 문구: "ProviderHttpError('HTTP 429: <html>\\r\\n<head><title>429 To…" · "ReadTimeout('')" · "ConnectError('')".
"""

from __future__ import annotations

import logging

import httpx
import pytest
import respx
from fakes import FakeRedis, make_ctx
from test_aircraft_job import FakeReadsb
from test_errors import NGINX_429

from wakeline_collector.fallback import ProviderChain
from wakeline_collector.http import HttpClient, ProviderHttpError
from wakeline_collector.jobs.aircraft import AircraftJob
from wakeline_collector.providers.readsb import adsb_lol
from wakeline_collector.ratelimit import RateLimiter


def _runs(ctx) -> list[dict]:
    runs: list[dict] = []
    real = ctx.db.record_run

    def rec(job, provider, started_at, **kw):
        runs.append({"job": job, "provider": provider, **kw})
        real(job, provider, started_at, **kw)

    ctx.db.record_run = rec
    return runs


class Raising(FakeReadsb):
    def __init__(self, name: str, exc: Exception):
        super().__init__(name)
        self.exc = exc

    async def fetch_region(self, lat, lon, radius):
        self.calls += 1
        raise self.exc


async def test_aircraft_429_html_body_is_shown_as_status_line():
    r = FakeRedis()
    ctx = make_ctx(r)
    runs = _runs(ctx)
    chain = ProviderChain("region", {"adsb_lol": Raising("adsb_lol", ProviderHttpError(429, NGINX_429))}, ctx.status)
    await AircraftJob("region", chain, ctx).run_once()
    st = await r.hgetall("wakeline:provider:adsb_lol")
    assert st["last_error"] == "HTTP 429 Too Many Requests" and st["last_http_status"] == "429"
    assert [x["error_text"] for x in runs] == ["HTTP 429 Too Many Requests"]


async def test_aircraft_read_timeout_names_the_limit_and_host(caplog):
    """실제 HttpClient 경로: 예외에 붙은 요청의 시간 제한 값(설정 http_timeout_s 8 s)과 호스트가 문구에 실린다."""
    caplog.set_level(logging.INFO, logger="job.aircraft")
    r = FakeRedis()
    ctx = make_ctx(r)
    runs = _runs(ctx)
    http = HttpClient(RateLimiter(100, 100))
    chain = ProviderChain("region", {"adsb_lol": adsb_lol(http)}, ctx.status)
    with respx.mock:
        respx.get(url__regex=r"https://api\.adsb\.lol/.*").mock(side_effect=httpx.ReadTimeout(""))
        await AircraftJob("region", chain, ctx).run_once()
    want = "ReadTimeout — read 제한 8 s 초과 (api.adsb.lol)"
    assert (await r.hgetall("wakeline:provider:adsb_lol"))["last_error"] == want
    assert [x["error_text"] for x in runs] == [want]
    assert f"region: adsb_lol failed ({want})" in caplog.messages
    await http.aclose()


async def test_aircraft_throttled_run_records_a_legible_reason():
    from wakeline_collector.ratelimit import Throttled

    r = FakeRedis()
    ctx = make_ctx(r)
    runs = _runs(ctx)
    exc = Throttled("api.adsb.lol", "cooling down 60 s after HTTP 429", cooldown_s=60)
    chain = ProviderChain("region", {"adsb_lol": Raising("adsb_lol", exc)}, ctx.status)
    await AircraftJob("region", chain, ctx).run_once()
    assert [x["error_text"] for x in runs] == ["Throttled — throttled api.adsb.lol: cooling down 60 s after HTTP 429"]


async def test_weather_guard_failure_is_legible_in_status_run_and_log(caplog):
    from test_weather_jobs import FakeRainViewer

    from wakeline_collector.jobs.weather import RadarJob

    class Down(FakeRainViewer):
        async def frames(self):
            raise ProviderHttpError(503, "<html><head><title>503 Service Temporarily Unavailable</title></head></html>")

    caplog.set_level(logging.INFO, logger="job.weather")
    r = FakeRedis()
    ctx = make_ctx(r, limits={"rainviewer": 1000})
    runs = _runs(ctx)
    await RadarJob(Down(), ctx).run_once()
    want = "HTTP 503 Service Temporarily Unavailable"
    assert (await r.hgetall("wakeline:provider:rainviewer"))["last_error"] == want
    assert [x["error_text"] for x in runs] == [want]
    assert f"radar/rainviewer failed: {want}" in caplog.messages


async def test_kma_http_error_is_legible_in_status_and_run(caplog):
    from test_kma_radar import FakeKma, _tms

    from wakeline_collector.jobs import kma_radar as mod

    class Bad(FakeKma):
        async def binary(self, tm):
            self.binaries.append(tm)
            raise ProviderHttpError(502, "<html><head><title>502 Bad Gateway</title></head><body>nginx</body></html>")

    caplog.set_level(logging.INFO, logger="job.kma_radar")
    r = FakeRedis()
    ctx = make_ctx(r, limits={"kma_radar": 1000})
    runs = _runs(ctx)
    await mod.KmaRadarJob(Bad(_tms("202609272000")), ctx).run_once()
    st = await r.hgetall("wakeline:provider:kma_radar")
    assert st["last_error"].startswith("HTTP 502 Bad Gateway")
    assert [x["error_text"].startswith("HTTP 502 Bad Gateway") for x in runs] == [True]
    assert "<html>" not in st["last_error"] and all("<html>" not in m for m in caplog.messages)


@pytest.mark.parametrize(
    ("exc", "want"),
    [
        (ProviderHttpError(500, "boom"), "HTTP 500 Internal Server Error — boom"),
        (httpx.ConnectError(""), "ConnectError — 연결 실패"),
    ],
    ids=["http500", "connect"],
)
async def test_demand_failure_run_and_log_are_legible(caplog, exc, want):
    import time

    from test_demand_job import FakeDemandProvider, _drain, _tracker

    from wakeline_collector.demand import FOCUS_KEY

    caplog.set_level(logging.INFO, logger="job.demand")
    r = FakeRedis()
    await r.zadd(FOCUS_KEY, {"abcdef": time.time() * 1000 + 60_000})
    prov = FakeDemandProvider()
    prov.fail = exc
    t, ctx, _clk = _tracker(r, prov)
    runs = _runs(ctx)
    await t.tick()
    await _drain(t)
    assert [x["error_text"] for x in runs] == [want]
    assert any(want in m for m in caplog.messages)
