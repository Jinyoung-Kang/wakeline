"""ais 진입점(`python -m wakeline_collector.ais`, ADR-014 · 계약 v2 §B1).

태스크 4개(+설정 감시)가 한 이벤트 루프에서 돈다. Redis 를 기다리는 것은 발행(sink)·설정 감시뿐이다.
  수신  client(aisstream WebSocket) 또는 replay(fixture) → RawQueue(20,000, 가득 차면 가장 오래된 것 버림)
  정리  worker: 파싱·검증·게이트 → ShipBook(MMSI 별 최신값, 바뀐 선박 표시)
  발행  sink: 10 s 마다 바뀐 선박 XADD wakeline:ships · 닫힌 공백 XADD · 상태 해시 wakeline:ais:status
  설정  BboxWatcher: wakeline:settings.ais_bboxes 30 s 마다(실시간 모드만)
키가 없으면(실시간 모드) 수신하지 않고 상태를 disabled 로 둔다 — 프로세스는 살아서 이유를 보여 준다.

종료(SIGTERM): 수신을 닫고(close_timeout 3 s) 대기열에 남은 원문을 정리한 뒤, 마지막 변경분·공백을 보내고 상태를
stopped(마지막 메시지 시각부터 공백 열림)로 쓴다. 상한 합계 4 + 1 + 3 s(+ 대기열 정리 < 0.5 s)는 compose 기본 stop 유예(10 s) 안이다.
"""

from __future__ import annotations

import asyncio
import logging
import signal
import time
from pathlib import Path
from typing import Any

from redis.asyncio import Redis

from wakeline_collector.ais.bbox import BboxState, format_bboxes, parse_bboxes
from wakeline_collector.ais.book import ShipBook
from wakeline_collector.ais.client import AisStreamClient, make_redactor
from wakeline_collector.ais.config import AisSettings
from wakeline_collector.ais.feed import FeedState
from wakeline_collector.ais.queue import RawQueue
from wakeline_collector.ais.replay import FIXTURE_NAME, FixtureReplayer
from wakeline_collector.ais.runtime import BboxWatcher
from wakeline_collector.ais.sink import AisSink
from wakeline_collector.ais.worker import Worker

log = logging.getLogger("ais.main")

SOURCE_STOP_S = 4.0  # 수신 연결 닫기(client close_timeout 3 s) 상한
SINK_STOP_S = 1.0  # 발행 루프가 stop 을 보고 빠져나오는 상한(틱 ≤ 1 s)
FINAL_S = 3.0  # 마지막 발행·상태 쓰기 상한(Redis socket_timeout 5 s 보다 짧게 끊는다)
DRAIN_LIMIT = 200_000


def make_redis(s: AisSettings) -> Redis:
    return Redis(
        host=s.redis_host,
        port=s.redis_port,
        username=s.redis_username or None,
        password=s.redis_password.get_secret_value() or None,
        decode_responses=True,
        socket_timeout=5,
        socket_connect_timeout=5,
        health_check_interval=30,
    )


def _configure_logging() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    logging.getLogger("websockets").setLevel(logging.WARNING)  # DEBUG 는 구독 프레임(API 키)을 찍는다


async def main(
    stop: asyncio.Event | None = None,
    redis: Any = None,
    settings: AisSettings | None = None,
    *,
    replay_speed: float = 1.0,
    client_kw: dict[str, Any] | None = None,
) -> int:
    """stop·redis·settings·replay_speed·client_kw 는 시험용 주입. 반환: 종료 코드(태스크가 예상 밖으로 죽으면 1)."""
    _configure_logging()
    if stop is None:  # 기동 중(Redis 대기 등)에 온 SIGTERM 도 정상 종료 경로로
        stop = asyncio.Event()
        loop = asyncio.get_running_loop()
        for sig in (signal.SIGTERM, signal.SIGINT):
            loop.add_signal_handler(sig, stop.set)
    s = settings or AisSettings()
    fixture = s.fixture_mode
    provider = "fixture" if fixture else "aisstream"
    key = s.aisstream_api_key.get_secret_value()
    redact = make_redactor(key)
    redis = redis if redis is not None else make_redis(s)

    queue = RawQueue(s.ais_queue_max)
    feed = FeedState(provider)
    book = ShipBook(provider, max_ships=s.ais_max_ships)
    worker = Worker(queue, book, on_provider_error=lambda text: feed.on_error(redact(text)))
    sink = AisSink(
        redis,
        book=book,
        feed=feed,
        worker=worker,
        queue=queue,
        provider=provider,
        raw_ref=f"fixture/{FIXTURE_NAME}" if fixture else "-",  # 실시간 AIS 원문은 보관하지 않는다(재전송 없음·양 많음)
        flush_s=s.ais_flush_s,
        redact=redact,
    )
    feed.gaps.restore(await sink.read_previous_status(), provider, time.time())
    if feed.gaps.open_since is not None:
        log.info("carrying over an open AIS gap from the previous run (%s)", feed.gaps.reason)

    default_boxes = parse_bboxes(s.ais_bboxes)
    bboxes = BboxState(default_boxes)
    sources: list[Any] = []
    if fixture:
        log.info("ais starting in fixture mode (replay %s, no external calls)", FIXTURE_NAME)
        sources.append(FixtureReplayer(Path(s.fixtures_dir) / FIXTURE_NAME, queue, feed, speed=replay_speed).run(stop))
    elif not key:
        log.warning("AISSTREAM_API_KEY is not set — ship layer disabled (process stays up and reports it)")
        feed.on_disabled("AISSTREAM_API_KEY not set")
    else:
        client = AisStreamClient(
            api_key=key,
            queue=queue,
            feed=feed,
            bboxes=bboxes,
            user_agent=s.http_user_agent,
            idle_timeout_s=s.ais_idle_timeout_s,
            **(client_kw or {}),
        )
        watcher = BboxWatcher(redis, bboxes, default_boxes)
        await watcher.refresh()  # 첫 구독부터 운영 설정(wakeline:settings.ais_bboxes)을 쓴다
        log.info(
            "ais starting: bbox=%s queue=%d flush=%.0fs", format_bboxes(bboxes.snapshot()[0]), s.ais_queue_max, s.ais_flush_s
        )
        sources += [client.run(stop), watcher.run(stop)]

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
        feed.on_stopped()
        try:
            await asyncio.wait_for(sink.final(), timeout=FINAL_S)
        except TimeoutError:
            log.warning("ais shutdown: final publish timed out")
    finally:
        for t in (stopper, worker_task, sink_task, *src_tasks):
            t.cancel()
        await asyncio.gather(stopper, worker_task, sink_task, *src_tasks, return_exceptions=True)
        await redis.aclose()
        log.info("ais stopped")
    return 1 if crashed else 0
