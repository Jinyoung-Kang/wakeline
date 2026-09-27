"""collector 진입점 — 작업 7종(region·global·sigmet·radar·metar·maintenance·radar_kr)을 하나의 이벤트 루프에서 돌린다.

실시간 경로(수집 → Redis 발행)는 DB 에 의존하지 않는다: DB 는 백그라운드 writer 가 연결·재연결하며, 기동 시 DB 를 기다리지 않는다.
"""

from __future__ import annotations

import asyncio
import logging
import signal

from redis.asyncio import Redis

from skywx_collector.budget import Budget
from skywx_collector.config import Settings, settings
from skywx_collector.db import Db
from skywx_collector.fallback import ProviderChain
from skywx_collector.http import HttpClient
from skywx_collector.jobs.aircraft import AircraftJob
from skywx_collector.jobs.context import JobContext
from skywx_collector.jobs.kma_radar import KmaRadarJob
from skywx_collector.jobs.maintenance import MaintenanceJob
from skywx_collector.jobs.weather import MetarJob, RadarJob, SigmetJob
from skywx_collector.providers import fixture as fx
from skywx_collector.providers.awc import AwcProvider
from skywx_collector.providers.kma_radar import KmaRadarProvider
from skywx_collector.providers.opensky import OpenSkyProvider
from skywx_collector.providers.rainviewer import RainViewerProvider
from skywx_collector.providers.readsb import adsb_fi, adsb_lol
from skywx_collector.publisher import Publisher
from skywx_collector.raw_store import RawStore
from skywx_collector.runtime_settings import RuntimeSettings
from skywx_collector.scheduler import run_periodic
from skywx_collector.status import ProviderStatus

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
# httpx 는 INFO 로 전체 URL(쿼리의 authKey 포함)을 찍는다 — 비밀값이 로그에 남지 않도록 끈다
logging.getLogger("httpx").setLevel(logging.WARNING)
logging.getLogger("httpcore").setLevel(logging.WARNING)
log = logging.getLogger("main")


def build_limits(s: Settings) -> dict[str, int]:
    """공급자별 하루 예산(0 = 한도 없음, 카운트만). 유지보수 작업의 일별 스냅샷 대상 목록이기도 하다."""
    return {
        "adsb_lol": s.budget_adsb_lol,
        "adsb_fi": s.budget_adsb_fi,
        "opensky": s.budget_opensky,
        "awc": s.budget_awc,
        "rainviewer": s.budget_rainviewer,
        "kma_radar": s.budget_kma_radar,
        "fixture": 0,
    }


def make_redis(s: Settings) -> Redis:
    """ACL 사용자(계약 §6: REDIS_USERNAME)를 지원한다. 비우면 default 사용자."""
    return Redis(
        host=s.redis_host,
        port=s.redis_port,
        username=s.redis_username or None,
        password=s.redis_password or None,
        decode_responses=True,
        socket_timeout=5,
        socket_connect_timeout=5,
        health_check_interval=30,
    )


async def main() -> None:
    fixture = settings.fixture_mode
    log.info("skywx collector starting (fixture_mode=%s)", fixture)
    redis = make_redis(settings)
    db = Db()
    db.start()  # 연결은 writer 가 백그라운드에서(실패해도 수집·발행은 계속)
    http = HttpClient()
    limits = build_limits(settings)
    publisher = Publisher(redis)

    def metrics() -> dict[str, str]:
        return {**db.metrics(), "publish_queued": str(publisher.queued), "publish_dropped": str(publisher.dropped)}

    ctx = JobContext(
        budget=Budget(redis, limits),
        db=db,
        publisher=publisher,
        raw=RawStore(),
        status=ProviderStatus(redis, metrics=metrics),
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
        if "opensky" in settings.provider_order:
            log.info(
                "opensky is global-only; region chain uses adsb_lol → adsb_fi (daily cap %d credits)", settings.budget_opensky
            )

    region = AircraftJob("region", ProviderChain("region", aircraft_providers, ctx.status), ctx)
    global_ = AircraftJob("global", ProviderChain("global", aircraft_providers, ctx.status), ctx)
    sigmet, radar, metar = SigmetJob(awc, ctx), RadarJob(rv, ctx), MetarJob(awc, ctx)
    maint = MaintenanceJob(list(limits), ctx)
    kma = KmaRadarJob(KmaRadarProvider(http, "" if fixture else settings.kma_apihub_key, settings.kma_radar_cmp), ctx)

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
        run_periodic("radar_kr", kma.run_once, lambda: settings.kma_radar_poll_s, stop, initial_delay=8),
    ]
    try:
        await asyncio.gather(*tasks)
    finally:
        await http.aclose()
        await db.close()
        await redis.aclose()
        log.info("collector stopped")
