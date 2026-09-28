"""collector 진입점 — 주기 작업 7종(region·global·sigmet·radar·metar·maintenance·radar_kr)과 수요 기반 추적(focus·hot,
ADR-013)·선택 항공기 노선 조회(계약 v4 §A)를 하나의 이벤트 루프에서 돌린다.

실시간 경로(수집 → Redis 발행)는 DB 에 의존하지 않는다: DB 는 백그라운드 writer 가 연결·재연결하며, 기동 시 DB 를 기다리지 않는다.
외부 호출은 모두 한 HttpClient(허용 호스트 · 수집기 전체/호스트별 속도 상한)를 지난다.

종료(SIGTERM, COL-4): 진행 중 작업을 SHUTDOWN_GRACE_S 동안 끝내게 두고, 남은 작업은 취소한 뒤 DB 쓰기 큐를 DB_DRAIN_S 안에서 비운다.
합계(18 + 4 + 4 s)는 compose stop_grace_period(30 s) 안이다 — 그래야 SIGKILL 전에 close() 가 돈다.
"""

from __future__ import annotations

import asyncio
import logging
import signal
from typing import Any

from redis.asyncio import Redis

from wakeline_collector.budget import Budget
from wakeline_collector.config import Settings, settings
from wakeline_collector.db import Db
from wakeline_collector.demand import DemandPoller, DemandStatus
from wakeline_collector.fallback import ProviderChain
from wakeline_collector.http import HttpClient
from wakeline_collector.jobs.aircraft import AircraftJob
from wakeline_collector.jobs.context import JobContext
from wakeline_collector.jobs.demand import DemandProvider, DemandTracker
from wakeline_collector.jobs.kma_radar import KmaRadarJob
from wakeline_collector.jobs.maintenance import MaintenanceJob
from wakeline_collector.jobs.route import RouteLookup
from wakeline_collector.jobs.weather import MetarJob, RadarJob, SigmetJob
from wakeline_collector.providers import fixture as fx
from wakeline_collector.providers.adsbdb import ADSBDB_HOST, AdsbdbProvider
from wakeline_collector.providers.awc import AwcProvider
from wakeline_collector.providers.base import AircraftProvider
from wakeline_collector.providers.kma_radar import KmaRadarProvider
from wakeline_collector.providers.opensky import OpenSkyProvider
from wakeline_collector.providers.rainviewer import RainViewerProvider
from wakeline_collector.providers.readsb import ADSB_FI_HOST, AdsbFiDemandProvider, adsb_fi, adsb_lol
from wakeline_collector.publisher import STREAM_AIRCRAFT, Publisher
from wakeline_collector.ratelimit import default_limiter
from wakeline_collector.raw_store import RawStore
from wakeline_collector.runtime_settings import RuntimeSettings
from wakeline_collector.scheduler import run_periodic
from wakeline_collector.status import ProviderStatus

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
# httpx 는 INFO 로 전체 URL(쿼리의 authKey 포함)을 찍는다 — 비밀값이 로그에 남지 않도록 끈다
logging.getLogger("httpx").setLevel(logging.WARNING)
logging.getLogger("httpcore").setLevel(logging.WARNING)
log = logging.getLogger("main")

SHUTDOWN_GRACE_S = 18.0  # 진행 중 작업(KMA 실측 최대 25 s 중 대부분)을 끝낼 시간
DB_DRAIN_S = 4.0  # db.close: 큐 비우기 + 풀 닫기 각각의 상한


def build_limits(s: Settings) -> dict[str, int]:
    """공급자별 하루 예산(0 = 한도 없음, 카운트만). 유지보수 작업의 일별 스냅샷 대상 목록이기도 하다."""
    return {
        "adsb_lol": s.budget_adsb_lol,
        "adsb_fi": s.budget_adsb_fi,
        "opensky": s.budget_opensky,
        "awc": s.budget_awc,
        "rainviewer": s.budget_rainviewer,
        "kma_radar": s.budget_kma_radar,
        "adsbdb": s.budget_adsbdb,
        "fixture": 0,
    }


def snapshot_providers(limits: dict[str, int], *, fixture: bool) -> list[str]:
    """일별 예산 스냅샷 대상. 실시간 모드에서는 fixture 공급자를 빼 'fixture|0|0' 행이 쌓이지 않게 한다(R-19)."""
    return [p for p in limits if fixture or p != "fixture"]


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


async def main(stop: asyncio.Event | None = None, redis: Any = None, db: Db | None = None) -> None:
    """stop·redis·db 는 테스트용 주입(기본: SIGTERM/SIGINT · 설정의 Redis · 실제 DB writer)."""
    fixture = settings.fixture_mode
    log.info("wakeline collector starting (fixture_mode=%s)", fixture)
    redis = redis if redis is not None else make_redis(settings)
    db = db or Db()
    db.start()  # 연결은 writer 가 백그라운드에서(실패해도 수집·발행은 계속)
    limiter = default_limiter(settings.http_global_rps, settings.adsb_fi_rps, settings.adsbdb_rps)
    http = HttpClient(limiter)
    limits = build_limits(settings)
    publisher = Publisher(redis)
    tracker: DemandTracker | None = None

    def metrics() -> dict[str, str]:
        m = {
            **db.metrics(),
            "publish_queued": str(publisher.queued),
            "publish_dropped": str(publisher.dropped),
            # R-14: 항공기 스트림을 바이트 예산 때문에 보존 창(2.5 h)보다 일찍 자른 XADD 수(0 이 아니면 api 정지 시 손실 가능)
            "stream_budget_trims": str(publisher.budget_trims.get(STREAM_AIRCRAFT, 0)),
            # api /status 의 demand.adsb_fi_rps_1m 원천: 최근 60 s 동안 실제로 보낸 adsb.fi 호출 수 / 60
            "adsb_fi_rps_1m": f"{limiter.rate_1m(ADSB_FI_HOST):.3f}",
            "adsbdb_rps_1m": f"{limiter.rate_1m(ADSBDB_HOST):.3f}",
            "http_rps_1m": f"{limiter.rate_1m():.3f}",
            "http_throttled": str(limiter.throttled),
        }
        if tracker is not None:
            m.update(tracker.metrics())
        return m

    ctx = JobContext(
        budget=Budget(redis, limits),
        db=db,
        publisher=publisher,
        raw=RawStore(),
        status=ProviderStatus(redis, metrics=metrics),
        rt=RuntimeSettings(redis),
        fixture=fixture,
    )

    aircraft_providers: dict[str, AircraftProvider]  # 3.2절 어댑터 계약(구조적 타입 — mypy 가 확인)
    demand_provider: DemandProvider
    awc: Any
    rv: Any
    if fixture:
        fx_aircraft = fx.FixtureAircraftProvider()
        aircraft_providers = {"fixture": fx_aircraft}
        awc, rv = fx.FixtureAwcProvider(), fx.FixtureRainViewerProvider()
        demand_provider = fx.FixtureDemandProvider(fx_aircraft, lambda: ctx.rt.region)
    else:
        opensky = OpenSkyProvider(http, settings.opensky_client_id, settings.opensky_client_secret)
        aircraft_providers = {"adsb_lol": adsb_lol(http), "adsb_fi": adsb_fi(http), "opensky": opensky}
        awc, rv = AwcProvider(http), RainViewerProvider(http)
        demand_provider = AdsbFiDemandProvider(http)
        if not opensky.configured:
            log.info("opensky credentials not set — global view disabled")
        if "opensky" in settings.provider_order:
            log.info(
                "opensky is global-only; region chain uses adsb_lol → adsb_fi (daily cap %d credits)", settings.budget_opensky
            )

    region = AircraftJob("region", ProviderChain("region", aircraft_providers, ctx.status), ctx)
    global_ = AircraftJob("global", ProviderChain("global", aircraft_providers, ctx.status), ctx)
    sigmet, radar, metar = SigmetJob(awc, ctx), RadarJob(rv, ctx), MetarJob(awc, ctx)
    maint = MaintenanceJob(snapshot_providers(limits, fixture=fixture), ctx)
    kma = KmaRadarJob(KmaRadarProvider(http, "" if fixture else settings.kma_apihub_key, settings.kma_radar_cmp), ctx)
    if settings.demand_enabled:
        # 노선(계약 v4 §A · G A-2): 선택한 항공기의 콜사인만 adsbdb 에 묻는다. fixture 모드는 외부 호출이 없으므로 묻지 않고
        # 요청된 콜사인에 status "disabled" 를 쓴다(화면이 "노선 조회 중" 에 머물지 않게).
        routes = RouteLookup(redis, None if fixture else AdsbdbProvider(http), ctx.budget, ctx.status)
        tracker = DemandTracker(
            ctx, DemandPoller(redis), DemandStatus(redis), demand_provider, limiter=None if fixture else limiter, routes=routes
        )

    if stop is None:
        stop = asyncio.Event()
        loop = asyncio.get_running_loop()
        for sig in (signal.SIGTERM, signal.SIGINT):
            loop.add_signal_handler(sig, stop.set)

    await ctx.rt.refresh()
    coros = [
        run_periodic("region", region.run_once, lambda: ctx.rt.region_poll_s, stop, ctx.rt.refresh),
        run_periodic("global", global_.run_once, lambda: ctx.rt.global_poll_s, stop, initial_delay=5),
        run_periodic("sigmet", sigmet.run_once, lambda: ctx.rt.sigmet_poll_s, stop, initial_delay=1),
        run_periodic("radar", radar.run_once, lambda: ctx.rt.radar_poll_s, stop, initial_delay=2),
        run_periodic("metar", metar.run_once, lambda: ctx.rt.metar_poll_s, stop, initial_delay=3),
        run_periodic("maintenance", maint.run_once, lambda: 3600, stop, initial_delay=30),
        run_periodic("radar_kr", kma.run_once, lambda: settings.kma_radar_poll_s, stop, initial_delay=8),
    ]
    if tracker is not None:
        coros.append(tracker.run(stop))
    tasks = [asyncio.create_task(c) for c in coros]
    try:
        await run_until_stopped(tasks, stop, grace_s=SHUTDOWN_GRACE_S)
    finally:
        await http.aclose()
        await db.close(drain_s=DB_DRAIN_S)
        await redis.aclose()
        log.info("collector stopped")


async def run_until_stopped(tasks: list[asyncio.Task[Any]], stop: asyncio.Event, *, grace_s: float) -> None:
    """stop 이 켜질 때까지(또는 작업이 모두 끝날 때까지) 기다린 뒤, 진행 중 작업을 grace_s 동안 끝내게 두고 남은 것은 취소한다(COL-4)."""
    stopper = asyncio.create_task(stop.wait())
    try:
        await asyncio.wait([stopper, *tasks], return_when=asyncio.FIRST_COMPLETED)
        stop.set()  # 작업 하나가 예상 밖으로 끝났어도 나머지를 정리한다
        _done, pending = await asyncio.wait(tasks, timeout=grace_s)
        if pending:
            log.warning("shutdown: %d job(s) still running after %.0f s — cancelling", len(pending), grace_s)
            for t in pending:
                t.cancel()
            await asyncio.gather(*pending, return_exceptions=True)
    finally:
        stopper.cancel()
