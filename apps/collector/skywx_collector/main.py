"""collector 진입점 — 작업 6종(region·global·sigmet·radar·metar·maintenance)을 하나의 이벤트 루프에서 돌린다."""

from __future__ import annotations

import asyncio
import logging
import signal

from redis.asyncio import Redis

from skywx_collector.budget import Budget
from skywx_collector.config import settings
from skywx_collector.db import Db
from skywx_collector.fallback import ProviderChain
from skywx_collector.http import HttpClient
from skywx_collector.jobs.aircraft import AircraftJob
from skywx_collector.jobs.context import JobContext
from skywx_collector.jobs.maintenance import MaintenanceJob
from skywx_collector.jobs.weather import MetarJob, RadarJob, SigmetJob
from skywx_collector.providers import fixture as fx
from skywx_collector.providers.awc import AwcProvider
from skywx_collector.providers.opensky import OpenSkyProvider
from skywx_collector.providers.rainviewer import RainViewerProvider
from skywx_collector.providers.readsb import adsb_fi, adsb_lol
from skywx_collector.publisher import Publisher
from skywx_collector.raw_store import RawStore
from skywx_collector.runtime_settings import RuntimeSettings
from skywx_collector.scheduler import run_periodic
from skywx_collector.status import ProviderStatus

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("main")


async def _connect_db(db: Db) -> None:
    for attempt in range(60):
        try:
            await db.connect()
            await db.pool.fetchval("SELECT 1 FROM ingest_run LIMIT 1")
            return
        except Exception as e:  # noqa: BLE001
            log.info("db not ready (%s) — retry %d", type(e).__name__, attempt + 1)
            await asyncio.sleep(3)
    raise RuntimeError("database not reachable")


async def main() -> None:
    fixture = settings.fixture_mode
    log.info("skywx collector starting (fixture_mode=%s)", fixture)
    redis = Redis(
        host=settings.redis_host,
        port=settings.redis_port,
        password=settings.redis_password or None,
        decode_responses=True,
        socket_timeout=5,
        socket_connect_timeout=5,
    )
    db = Db()
    await _connect_db(db)
    http = HttpClient()
    limits = {
        "adsb_lol": settings.budget_adsb_lol,
        "adsb_fi": settings.budget_adsb_fi,
        "opensky": settings.budget_opensky,
        "awc": settings.budget_awc,
        "rainviewer": settings.budget_rainviewer,
        "fixture": 0,
    }
    ctx = JobContext(
        budget=Budget(redis, limits),
        db=db,
        publisher=Publisher(redis),
        raw=RawStore(),
        status=ProviderStatus(redis),
        rt=RuntimeSettings(redis),
        fixture=fixture,
    )

    if fixture:
        aircraft_providers = {"fixture": fx.FixtureAircraftProvider()}
        awc, rv = fx.FixtureAwcProvider(), fx.FixtureRainViewerProvider()
    else:
        aircraft_providers = {
            "adsb_lol": adsb_lol(http),
            "adsb_fi": adsb_fi(http),
            "opensky": OpenSkyProvider(http, settings.opensky_client_id, settings.opensky_client_secret),
        }
        awc, rv = AwcProvider(http), RainViewerProvider(http)
        if not aircraft_providers["opensky"].configured:
            log.info("opensky credentials not set — global view disabled")

    region = AircraftJob("region", ProviderChain("region", aircraft_providers, ctx.status), ctx)
    global_ = AircraftJob("global", ProviderChain("global", aircraft_providers, ctx.status), ctx)
    sigmet, radar, metar = SigmetJob(awc, ctx), RadarJob(rv, ctx), MetarJob(awc, ctx)
    maint = MaintenanceJob(list(limits), ctx)

    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, stop.set)

    await ctx.rt.refresh()
    tasks = [
        run_periodic("region", region.run_once, lambda: ctx.rt.region_poll_s, stop, ctx.rt.refresh),
        run_periodic("global", global_.run_once, lambda: ctx.rt.global_poll_s, stop, initial_delay=5),
        run_periodic("sigmet", sigmet.run_once, lambda: ctx.rt.sigmet_poll_s, stop, initial_delay=1),
        run_periodic("radar", radar.run_once, lambda: ctx.rt.radar_poll_s, stop, initial_delay=2),
        run_periodic("metar", metar.run_once, lambda: ctx.rt.metar_poll_s, stop, initial_delay=3),
        run_periodic("maintenance", maint.run_once, lambda: 3600, stop, initial_delay=30),
    ]
    try:
        await asyncio.gather(*tasks)
    finally:
        await http.aclose()
        await db.close()
        await redis.aclose()
        log.info("collector stopped")
