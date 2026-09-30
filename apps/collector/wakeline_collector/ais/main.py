"""ais 진입점(`python -m wakeline_collector.ais`, ADR-014 · 계약 v2 §B1).

태스크 4개(+설정 감시)가 한 이벤트 루프에서 돈다. Redis 를 기다리는 것은 발행(sink)·설정 감시뿐이다.
  수신  pool(구역마다 aisstream WebSocket 하나, 최대 3) 또는 replay(fixture, 구역 하나) → RawQueue(20,000, 가득 차면 가장 오래된 것 버림)
  정리  worker: 파싱·검증·게이트 → ShipBook(MMSI 별 최신값, 바뀐 선박 표시)
  발행  sink: 10 s 마다 바뀐 선박 XADD wakeline:ships · 닫힌 공백 XADD · 상태 해시 wakeline:ais:status
  설정  BboxWatcher: wakeline:settings.ais_bboxes 30 s 마다(실시간 모드만) — 구역 수·상자가 바뀌면 pool 이 연결을 맞춘다
  진단  LoopLag: 0.5 s 마다 이벤트 루프 지연을 잰다(ADR-014 부록 C — 상태 해시 loop_lag_max_s, 끊김 로그의 맥락). 이 태스크가 끝나도 수신은
        계속한다(진단이 수집을 멈추지 않게 — 표본 오류는 ERROR 로 남기고 계속 잰다).
키가 없으면(실시간 모드) 수신하지 않고 상태를 disabled 로 둔다 — 프로세스는 살아서 이유를 보여 준다. 이때 구역은 구역 없는(scope null)
항목 하나뿐이다: 구독하지 않은 영역을 수신 범위처럼 싣지 않는다(계약 v4 G D-2).
구역(과 이전 실행에서 이어받은 공백)은 발행·정리 태스크보다 먼저 만든다 — 첫 상태 쓰기가 이어받은 공백을 지우지 않게(G D-3).

WARN·ERROR 로그는 가려서 wakeline:logs 로도 보낸다(계약 v5 §C2 · logsink.py) — 싱크는 Redis 클라이언트를 만든 직후 붙여 기동 경고
(키 없음 등)부터 싣고, 어느 경로로 끝나든 Redis 를 닫기 전에 뗀다(main → _run).

종료(SIGTERM): 모든 구역의 연결을 함께 닫고(close_timeout 3 s) 대기열에 남은 원문을 정리한 뒤, 마지막 변경분·공백을 보내고 상태를
stopped(구역마다 마지막 메시지 시각부터 공백 열림)로 쓴다. 상한 합계 4 + 1 + 3 s(+ 대기열 정리 < 0.5 s) + 남은 로그 전송 0.5 s 는
compose 기본 stop 유예(10 s) 안이다.
발행 루프가 1 s 안에 빠져나오지 못하면(Redis 멈춤) 취소하고 끝난 것을 확인한 뒤에 마지막 발행을 한다 — 두 곳이 같은 공백을
동시에 보내거나 옛 상태 쓰기가 stopped 뒤에 도착하지 않게.
"""

from __future__ import annotations

import asyncio
import logging
import signal
from collections.abc import Iterable
from pathlib import Path
from typing import Any

from redis.asyncio import Redis

from wakeline_collector.ais.backoff import Backoff
from wakeline_collector.ais.bbox import ShardsState, format_shards, parse_shards
from wakeline_collector.ais.book import ShipBook
from wakeline_collector.ais.client import make_redactor
from wakeline_collector.ais.config import AisSettings
from wakeline_collector.ais.diag import LoopLag
from wakeline_collector.ais.pool import AisStreamPool
from wakeline_collector.ais.queue import RawQueue
from wakeline_collector.ais.replay import FIXTURE_NAME, FixtureReplayer
from wakeline_collector.ais.runtime import BboxWatcher
from wakeline_collector.ais.shards import ShardSet
from wakeline_collector.ais.sink import AisSink
from wakeline_collector.ais.worker import Worker
from wakeline_collector.logsink import LogSink, close_log_sink, sink_metrics, start_log_sink
from wakeline_collector.masking import install_log_masking, register_secrets
from wakeline_collector.redis_retry import REDIS_SOCKET_TIMEOUT_S, short_retry

log = logging.getLogger("ais.main")

SOURCE_STOP_S = 4.0  # 수신 연결 닫기(client close_timeout 3 s) 상한
SINK_STOP_S = 1.0  # 발행 루프가 stop 을 보고 빠져나오는 상한(틱 ≤ 1 s)
FINAL_S = 3.0  # 마지막 발행·상태 쓰기 상한(Redis 가 답하지 않으면 명령마다 socket_timeout 2 s — 합계를 여기서 끊는다)
DRAIN_LIMIT = 200_000


def make_redis(s: AisSettings) -> Redis:
    return Redis(
        host=s.redis_host,
        port=s.redis_port,
        username=s.redis_username or None,
        password=s.redis_password.get_secret_value() or None,
        decode_responses=True,
        socket_timeout=REDIS_SOCKET_TIMEOUT_S,
        socket_connect_timeout=REDIS_SOCKET_TIMEOUT_S,
        health_check_interval=30,
        retry=short_retry(),  # R-43: 연결 오류만 2회 재시도(응답 없음은 socket_timeout 한 번으로 포기)
    )


def _configure_logging(secrets: Iterable[str | None] = ()) -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    logging.getLogger("websockets").setLevel(logging.WARNING)  # DEBUG 는 구독 프레임(API 키)을 찍는다
    register_secrets(*secrets)  # R-83: aisstream 키·Redis 비밀번호 값 자체도 모든 로그에서 가린다
    install_log_masking()  # 루트 핸들러에 MaskFilter — %r 로 찍는 예외·트레이스백까지


async def main(
    stop: asyncio.Event | None = None,
    redis: Any = None,
    settings: AisSettings | None = None,
    *,
    replay_speed: float = 1.0,
    client_kw: dict[str, Any] | None = None,
) -> int:
    """stop·redis·settings·replay_speed·client_kw 는 시험용 주입(client_kw 의 backoff_factory 는 구역마다 새 Backoff 를 만든다).
    반환: 종료 코드(태스크가 예상 밖으로 죽으면 1)."""
    s = settings or AisSettings()
    _configure_logging([s.aisstream_api_key.get_secret_value(), s.redis_password.get_secret_value()])
    if stop is None:  # 기동 중(Redis 대기 등)에 온 SIGTERM 도 정상 종료 경로로
        stop = asyncio.Event()
        loop = asyncio.get_running_loop()
        for sig in (signal.SIGTERM, signal.SIGINT):
            loop.add_signal_handler(sig, stop.set)
    redis = redis if redis is not None else make_redis(s)
    logsink = start_log_sink("ais", redis, enabled=s.log_sink_enabled)  # MaskFilter(_configure_logging) 뒤에 붙인다
    try:
        return await _run(s, stop, redis, logsink, replay_speed=replay_speed, client_kw=client_kw)
    finally:
        await close_log_sink(logsink)  # 루트 로거에서 떼고 남은 항목을 보낸다(Redis 를 닫기 전에)
        await redis.aclose()
        log.info("ais stopped")


async def _run(
    s: AisSettings,
    stop: asyncio.Event,
    redis: Any,
    logsink: LogSink | None,
    *,
    replay_speed: float,
    client_kw: dict[str, Any] | None,
) -> int:
    fixture = s.fixture_mode
    provider = "fixture" if fixture else "aisstream"
    key = s.aisstream_api_key.get_secret_value()
    redact = make_redactor(key)

    queue = RawQueue(s.ais_queue_max)
    shards = ShardSet(provider)
    loop_lag = LoopLag()
    book = ShipBook(provider, max_ships=s.ais_max_ships)
    worker = Worker(queue, book, on_provider_error=lambda tag, text: shards.on_provider_error(tag, redact(text)))
    sink = AisSink(
        redis,
        book=book,
        shards=shards,
        worker=worker,
        queue=queue,
        provider=provider,
        raw_ref=f"fixture/{FIXTURE_NAME}" if fixture else "-",  # 실시간 AIS 원문은 보관하지 않는다(재전송 없음·양 많음)
        flush_s=s.ais_flush_s,
        redact=redact,
        log_metrics=lambda: sink_metrics(logsink),  # 계약 v5 §C2: 상태 해시의 log_sent · log_dropped · log_suppressed
        loop_lag=loop_lag,
    )
    shards.load_previous(await sink.read_previous_status())

    default_shards = parse_shards(s.ais_bboxes)
    sources: list[Any] = []
    if fixture:
        log.info("ais starting in fixture mode (replay %s, no external calls)", FIXTURE_NAME)
        replay = shards.add(None)  # 재생은 구역 하나(구독 영역 없음)
        shards.restore_leftover()
        sources.append(
            FixtureReplayer(Path(s.fixtures_dir) / FIXTURE_NAME, queue, replay.feed, speed=replay_speed, tag=replay.id).run(stop)
        )
    elif not key:
        log.warning("AISSTREAM_API_KEY is not set — ship layer disabled (process stays up and reports it)")
        shards.add(None).feed.on_disabled("AISSTREAM_API_KEY not set")  # 구독하지 않으므로 구역(scope)도 없다
        shards.restore_leftover()
    else:
        kw = dict(client_kw or {})
        kw.setdefault("loop_lag", loop_lag.max_s)  # 끊김 로그의 맥락
        backoff_factory = kw.pop("backoff_factory", Backoff)
        desired = ShardsState(default_shards)
        pool = AisStreamPool(
            api_key=key,
            queue=queue,
            shards=shards,
            desired=desired,
            backoff_factory=backoff_factory,
            user_agent=s.http_user_agent,
            idle_timeout_s=s.ais_idle_timeout_s,
            **kw,
        )
        watcher = BboxWatcher(redis, desired, default_shards)
        await watcher.refresh()  # 첫 구독부터 운영 설정(wakeline:settings.ais_bboxes)을 쓴다
        target = desired.snapshot()[0]
        log.info(
            "ais starting: %d shard(s) bbox=%s queue=%d flush=%.0fs",
            len(target),
            format_shards(target),
            s.ais_queue_max,
            s.ais_flush_s,
        )
        pool.start()  # 발행 태스크보다 먼저 — 첫 상태 쓰기에 이어받은 공백이 있게
        sources += [pool.run(stop), watcher.run(stop)]

    lag_task = asyncio.create_task(loop_lag.run(), name="ais-loop-lag")
    worker_task = asyncio.create_task(worker.run(), name="ais-worker")
    sink_task = asyncio.create_task(sink.run(stop), name="ais-sink")
    src_tasks = [asyncio.create_task(c) for c in sources]
    stopper = asyncio.create_task(stop.wait())
    crashed = False
    try:
        done, _ = await asyncio.wait([stopper, worker_task, sink_task, *src_tasks], return_when=asyncio.FIRST_COMPLETED)
        if stopper not in done:  # 수신·정리·발행 중 하나가 멈췄다 — 나머지를 정리하고 1 로 끝낸다(compose 가 다시 띄운다)
            crashed = True
            for t in done:
                exc = None if t.cancelled() else t.exception()
                log.error("ais task %s ended unexpectedly: %r", t.get_name(), exc)
        stop.set()
        if src_tasks:
            _done, pending = await asyncio.wait(src_tasks, timeout=SOURCE_STOP_S)
            for t in pending:
                t.cancel()
        n = worker.drain_nowait(DRAIN_LIMIT)  # 이미 받은 원문은 버리지 않고 정리한다
        if n:
            log.info("ais shutdown: processed %d queued message(s)", n)
        await asyncio.wait([sink_task], timeout=SINK_STOP_S)
        if not sink_task.done():
            log.warning("ais shutdown: sink loop still busy after %.0f s — cancelling it", SINK_STOP_S)
            sink_task.cancel()
        await asyncio.gather(sink_task, return_exceptions=True)
        shards.on_stopped()
        try:
            await asyncio.wait_for(sink.final(), timeout=FINAL_S)
        except TimeoutError:
            log.warning("ais shutdown: final publish timed out")
        except Exception:  # noqa: BLE001 — 예상 밖 오류도 나머지 정리(연결 닫기)를 막지 않게
            log.exception("ais shutdown: final publish failed")
    finally:
        for t in (stopper, lag_task, worker_task, sink_task, *src_tasks):
            t.cancel()
        await asyncio.gather(stopper, lag_task, worker_task, sink_task, *src_tasks, return_exceptions=True)
    return 1 if crashed else 0
