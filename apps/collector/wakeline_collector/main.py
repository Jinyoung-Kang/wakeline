"""collector 진입점 — 주기 작업 8종(region·global·sigmet·radar·metar·maintenance·radar_kr·traffic_grid)과 수요 기반 추적(focus·hot,
ADR-013)·선택 항공기 노선 조회(계약 v4 §A)·한국 항만 입출항 색인(portcalls_index — ADR-022 개정)을 하나의 이벤트 루프에서 돌린다.
traffic_grid = 연안 교통량(ADR-023). 입출항 색인 · 연안 교통량은 공공데이터포털 키 하나 · apis.data.go.kr 호스트 버킷 하나를 나눠 쓴다(키가 있을 때만).

실시간 경로(수집 → Redis 발행)는 DB 에 의존하지 않는다: DB 는 백그라운드 writer 가 연결·재연결하며, 기동 시 DB 를 기다리지 않는다.
외부 호출은 모두 한 HttpClient(허용 호스트 · 수집기 전체/호스트별 속도 상한)를 지난다.

WARN·ERROR 로그는 가려서 wakeline:logs 로도 보낸다(계약 v5 §C2 · logsink.py). 작업 태스크 이름(job:<작업>)이 로그 항목의 context.task 다.

종료(SIGTERM, COL-4): 진행 중 작업을 SHUTDOWN_GRACE_S 동안 끝내게 두고, 남은 작업은 취소한 뒤 DB 쓰기 큐를 DB_DRAIN_S 안에서 비우고,
남은 로그 항목을 logsink.CLOSE_S 안에서 보낸다. 합계(18 + 4 + 4 + 0.5 s)는 compose stop_grace_period(30 s) 안이다 — 그래야 SIGKILL 전에
close() 가 돈다.
"""

from __future__ import annotations

import asyncio
import logging
import signal
from collections.abc import Iterable
from typing import Any

from redis.asyncio import Redis

from wakeline_collector.budget import Budget
from wakeline_collector.chain_store import ChainStateStore
from wakeline_collector.config import Settings, settings
from wakeline_collector.db import Db
from wakeline_collector.demand import DemandPoller, DemandStatus
from wakeline_collector.fallback import ProviderChain
from wakeline_collector.http import HttpClient, build_limiter
from wakeline_collector.jobs.aircraft import AircraftJob
from wakeline_collector.jobs.context import JobContext
from wakeline_collector.jobs.demand import DemandProvider, DemandTracker
from wakeline_collector.jobs.kma_radar import KmaRadarJob
from wakeline_collector.jobs.maintenance import MaintenanceJob
from wakeline_collector.jobs.portcalls_index import STATE_FIXTURE, STATE_NO_KEY, PortCallIndexJob
from wakeline_collector.jobs.route import RouteLookup
from wakeline_collector.jobs.traffic_grid import TrafficGridJob
from wakeline_collector.jobs.weather import MetarJob, RadarJob, SigmetJob
from wakeline_collector.logsink import LogSink, close_log_sink, sink_metrics, start_log_sink
from wakeline_collector.masking import install_log_masking, register_secrets
from wakeline_collector.providers import fixture as fx
from wakeline_collector.providers.adsbdb import ADSBDB_HOST, AdsbdbProvider
from wakeline_collector.providers.awc import AwcProvider
from wakeline_collector.providers.base import AircraftProvider
from wakeline_collector.providers.data_go_kr import DATA_GO_KR_HOST, Grid4WfsProvider, KomsaTrafficProvider, service_key_forms
from wakeline_collector.providers.kma_radar import KmaRadarProvider
from wakeline_collector.providers.opensky import OpenSkyProvider
from wakeline_collector.providers.portmis import PortMisProvider
from wakeline_collector.providers.rainviewer import RainViewerProvider
from wakeline_collector.providers.readsb import ADSB_FI_HOST, AdsbFiDemandProvider, adsb_fi, adsb_lol
from wakeline_collector.publisher import STREAM_AIRCRAFT, Publisher, limit_fields
from wakeline_collector.raw_store import RawStore
from wakeline_collector.redis_retry import REDIS_SOCKET_TIMEOUT_S, short_retry
from wakeline_collector.runtime_settings import RuntimeSettings
from wakeline_collector.scheduler import run_periodic
from wakeline_collector.status import ProviderStatus

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
# httpx 는 INFO 로 전체 URL(쿼리의 authKey 포함)을 찍는다 — 비밀값이 로그에 남지 않도록 끈다
logging.getLogger("httpx").setLevel(logging.WARNING)
logging.getLogger("httpcore").setLevel(logging.WARNING)
log = logging.getLogger("main")


def secret_values(s: Settings) -> list[str | None]:
    """값으로 가릴 설정 비밀값(R-83). 공공데이터포털 키는 모양 네 가지 모두(원문 · 디코딩 · 퍼센트 인코딩 · + 인코딩 — service_key_forms,
    ADR-022 · ADR-023: 세 서비스 공통 · 응답이 어느 형태로 되돌려 줘도 가린다)."""
    return [
        s.kma_apihub_key,
        s.opensky_client_secret,
        s.redis_password,
        s.db_collector_password,
        *service_key_forms(s.data_go_kr_service_key),
    ]


def configure_logging(secrets: Iterable[str | None]) -> None:
    """모든 로그(트레이스백 포함)가 mask 를 거치게 한다: 설정 비밀값을 값 치환 목록에 넣고 루트 핸들러에 MaskFilter(R-83)."""
    register_secrets(*secrets)
    install_log_masking()


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
        "portmis": s.budget_portmis,
        "komsa_traffic": s.budget_komsa_traffic,
        "mof_grid4": s.budget_mof_grid4,
        "fixture": 0,
    }


def region_chain_line(order: list[str], providers: dict[str, Any], opensky_cap: int) -> str:
    """기동 로그 한 줄: 관심 지역 체인의 실제 순서 — 설정 순서(운영 설정 aircraft_providers, 없으면 .env)에서 관심 지역을 지원하는 공급자만.
    전에는 'adsb_lol → adsb_fi' 를 글자로 박아 두어 설정 순서와 어긋나도 그렇게 적었다(계약 v5 §G25 — 기본 순서가 adsb_fi 먼저로 바뀌었다)."""
    region = [n for n in order if getattr(providers.get(n), "supports_region", False)]
    line = f"region chain uses {' → '.join(region) or 'no provider'} (aircraft_providers: runtime setting, else .env)"
    if "opensky" in order:
        line += f"; opensky is global-only (daily cap {opensky_cap} credits)"
    return line


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
        socket_timeout=REDIS_SOCKET_TIMEOUT_S,
        socket_connect_timeout=REDIS_SOCKET_TIMEOUT_S,
        health_check_interval=30,
        retry=short_retry(),  # R-43: 연결 오류만 2회 재시도(응답 없음은 socket_timeout 한 번으로 포기)
    )


async def main(stop: asyncio.Event | None = None, redis: Any = None, db: Db | None = None) -> None:
    """stop·redis·db 는 테스트용 주입(기본: SIGTERM/SIGINT · 설정의 Redis · 실제 DB writer)."""
    fixture = settings.fixture_mode
    configure_logging(secret_values(settings))
    log.info("wakeline collector starting (fixture_mode=%s)", fixture)
    redis = redis if redis is not None else make_redis(settings)
    db = db or Db()
    db.start()  # 연결은 writer 가 백그라운드에서(실패해도 수집·발행은 계속)
    limiter = build_limiter(settings)  # 설정의 호스트 버킷 모두(kma_apihub_rps 포함) — HttpClient() 기본값과 같은 함수
    http = HttpClient(limiter)
    limits = build_limits(settings)
    publisher = Publisher(redis)
    tracker: DemandTracker | None = None
    portcalls: PortCallIndexJob | None = None
    logsink: LogSink | None = None

    def metrics() -> dict[str, str]:
        m = {
            **db.metrics(),
            "publish_queued": str(publisher.queued),
            "publish_dropped": str(publisher.dropped),
            # R-14: 항공기 스트림을 바이트 예산 때문에 보존 창(2.5 h)보다 일찍 자른 XADD 수(0 이 아니면 api 정지 시 손실 가능)
            "stream_budget_trims": str(publisher.budget_trims.get(STREAM_AIRCRAFT, 0)),
            # 항공기 스트림의 보존 창 목표(초)·바이트 예산 — 실제로 거는 설정값. api 가 스트림 첫 항목 나이(잰 값)와 견준다
            **limit_fields(publisher.stream_limits(STREAM_AIRCRAFT)),
            # api /status 의 demand.adsb_fi_rps_1m 원천: 최근 60 s 동안 실제로 보낸 adsb.fi 호출 수 / 60
            "adsb_fi_rps_1m": f"{limiter.rate_1m(ADSB_FI_HOST):.3f}",
            "adsbdb_rps_1m": f"{limiter.rate_1m(ADSBDB_HOST):.3f}",
            # apis.data.go.kr 호스트 하나(입출항 색인 · 해양교통 · 해양격자 합계 — ADR-022 · ADR-023)
            "data_go_kr_rps_1m": f"{limiter.rate_1m(DATA_GO_KR_HOST):.3f}",
            "http_rps_1m": f"{limiter.rate_1m():.3f}",
            "http_throttled": str(limiter.throttled),
            # 계약 v5 §C2: 로그 싱크가 wakeline:logs 로 보낸 수 · 대기열 상한으로 버린 수(기동 뒤 누계, 끄면 빈 값)
            **sink_metrics(logsink),
        }
        if tracker is not None:
            m.update(tracker.metrics())
        if portcalls is not None:
            m.update(portcalls.metrics())
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

    chain_store = ChainStateStore(redis)  # 429 이력(R-17)을 재시작 뒤에도 잇는다 — wakeline:provider:{name}:ratelimit:{job}
    region = AircraftJob("region", ProviderChain("region", aircraft_providers, ctx.status, store=chain_store), ctx)
    global_ = AircraftJob("global", ProviderChain("global", aircraft_providers, ctx.status, store=chain_store), ctx)
    sigmet, radar, metar = SigmetJob(awc, ctx), RadarJob(rv, ctx), MetarJob(awc, ctx)
    maint = MaintenanceJob(snapshot_providers(limits, fixture=fixture), ctx)
    kma = KmaRadarJob(KmaRadarProvider(http, "" if fixture else settings.kma_apihub_key, settings.kma_radar_cmp), ctx)
    # 연안 교통량(ADR-023): fixture 모드는 외부 호출이 없으므로 키를 넘기지 않는다(작업이 state fixture 로 알린다)
    dgk = "" if fixture else settings.data_go_kr_service_key
    traffic = TrafficGridJob(KomsaTrafficProvider(http, dgk), Grid4WfsProvider(http, dgk), ctx)
    if settings.demand_enabled:
        # 노선(계약 v4 §A · G A-2): 선택한 항공기의 콜사인만 adsbdb 에 묻는다. fixture 모드는 외부 호출이 없으므로 묻지 않고
        # 요청된 콜사인에 status "disabled" 를 쓴다(화면이 "노선 조회 중" 에 머물지 않게).
        routes = RouteLookup(redis, None if fixture else AdsbdbProvider(http), ctx.budget, ctx.status)
        tracker = DemandTracker(
            ctx, DemandPoller(redis), DemandStatus(redis), demand_provider, limiter=None if fixture else limiter, routes=routes
        )

    # 한국 항만 입출항 색인(ADR-022 개정): 항만청 10곳의 최근 30일(KST) 입출항 신고를 날짜별로 모두 받아 DB 에 둔다 — 선택은 외부 호출을 만들지
    # 않는다(api 가 색인을 호출부호로 찾는다). 키가 없거나 fixture 모드면 받지 않고 heartbeat 상태(no_key · fixture)로 알린다(api 가 '꺼짐' 을 말한다).
    portmis = None if fixture else PortMisProvider(http, settings.data_go_kr_service_key)
    if portmis is not None and not portmis.configured:
        log.info("DATA_GO_KR_SERVICE_KEY not set — Korean port-call index (PORT-MIS) disabled")
        portmis = None
    portcalls = PortCallIndexJob(portmis, ctx, off_state=STATE_FIXTURE if fixture else STATE_NO_KEY)

    if stop is None:
        stop = asyncio.Event()
        loop = asyncio.get_running_loop()
        for sig in (signal.SIGTERM, signal.SIGINT):
            loop.add_signal_handler(sig, stop.set)

    logsink = start_log_sink("collector", redis, enabled=settings.log_sink_enabled)  # MaskFilter(configure_logging) 뒤에 붙인다
    try:
        await ctx.rt.refresh()
        if not fixture:  # 운영 설정(Redis 미러)을 읽은 뒤 — 실제로 쓸 순서
            log.info("%s", region_chain_line(ctx.rt.provider_order, aircraft_providers, settings.budget_opensky))
        jobs = {
            "region": run_periodic("region", region.run_once, lambda: ctx.rt.region_poll_s, stop, ctx.rt.refresh),
            "global": run_periodic("global", global_.run_once, lambda: ctx.rt.global_poll_s, stop, initial_delay=5),
            "sigmet": run_periodic("sigmet", sigmet.run_once, lambda: ctx.rt.sigmet_poll_s, stop, initial_delay=1),
            "radar": run_periodic("radar", radar.run_once, lambda: ctx.rt.radar_poll_s, stop, initial_delay=2),
            "metar": run_periodic("metar", metar.run_once, lambda: ctx.rt.metar_poll_s, stop, initial_delay=3),
            "maintenance": run_periodic("maintenance", maint.run_once, lambda: 3600, stop, initial_delay=30),
            "radar_kr": run_periodic("radar_kr", kma.run_once, lambda: settings.kma_radar_poll_s, stop, initial_delay=8),
            "portcalls_index": portcalls.run(stop),
            "traffic_grid": run_periodic(
                "traffic_grid", traffic.run_once, lambda: settings.traffic_grid_tick_s, stop, initial_delay=12
            ),
        }
        if tracker is not None:
            jobs["demand"] = tracker.run(stop)
        tasks = [asyncio.create_task(c, name=f"job:{name}") for name, c in jobs.items()]  # 로그 항목 context.task
        await run_until_stopped(tasks, stop, grace_s=SHUTDOWN_GRACE_S)
    finally:
        await http.aclose()
        await db.close(drain_s=DB_DRAIN_S)
        await close_log_sink(logsink)  # 루트 로거에서 떼고 남은 항목을 보낸다(Redis 를 닫기 전에)
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
