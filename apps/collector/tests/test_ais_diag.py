"""수신 진단(1011 keepalive 원인 가리기): 최근 최댓값 창 · 이벤트 루프 지연 · 원문 대기열 대기 시간 · websockets 수신 버퍼 · keepalive 왕복.

다음에 끊겼을 때 원인을 가를 수 있게 잰다(test_ais_keepalive 가 보인 세 기제):
- 이벤트 루프 멈춤 → loop_lag_max_s 가 시간 초과만큼 커진다(프로세스에 하나 — 1011 은 콜백 순서에 따라 한 구역만 날 수도 있다).
- 소켓을 읽는 쪽이 멈춤 → ws 수신 버퍼가 max_queue(64)를 넘는다(루프 지연은 작다).
- 서버·망이 pong 을 늦게 보냄 → keepalive 왕복(ping_rtt)과 공급자 지연이 커지고 루프 지연·버퍼는 작다.
모르는 값은 None(상태 해시 "") — 0 으로 채우지 않는다.
"""

from __future__ import annotations

import asyncio
import logging
import re
import time

import pytest
from fakes import FakeRedis
from test_ais_keepalive import (
    STALL_S,
    TIMEOUT_S,
    RemoteServer,
    Server,
    _client,
    _connected,
    _delay_pongs,
    _frames,
    _run_for,
    _serve,
    _stall_client,
)
from websockets.exceptions import ConnectionClosed

from wakeline_collector.ais import client as client_mod
from wakeline_collector.ais.book import ShipBook
from wakeline_collector.ais.diag import BUCKET_S, DIAG_WINDOW_S, LOOP_STALL_S, LOOP_WARN_S, LoopLag, WindowMax
from wakeline_collector.ais.queue import RawQueue
from wakeline_collector.ais.shards import SHARD_FIELDS, ShardSet
from wakeline_collector.ais.sink import AisSink
from wakeline_collector.ais.worker import Worker


class Clock:
    def __init__(self, t: float = 1000.0) -> None:
        self.t = t

    def __call__(self) -> float:
        return self.t


# ── 최근 최댓값 창 ────────────────────────────────────────────────


def test_window_max_is_unknown_without_samples_and_forgets_after_the_window():
    clk = Clock()
    w = WindowMax(mono=clk)
    assert w.value() is None  # 표본이 없으면 모름 — 0 이 아니다
    w.add(0.3)
    clk.t += 1
    w.add(0.1)
    assert w.value() == 0.3
    clk.t += DIAG_WINDOW_S + BUCKET_S  # 창(과 칸 하나)이 지나면 잊는다
    assert w.value() is None
    w.add(0.05)
    assert w.value() == 0.05


def test_window_max_memory_is_bounded_by_the_bucket_count():
    clk = Clock()
    w = WindowMax(mono=clk)
    for i in range(10_000):
        clk.t += 0.37
        w.add(float(i % 7))
    assert len(w._buckets) <= DIAG_WINDOW_S / BUCKET_S + 1
    assert w.value() == 6.0


# ── 이벤트 루프 지연 ──────────────────────────────────────────────


def test_loop_lag_counts_stalls_and_warns_rate_limited(caplog):
    caplog.set_level(logging.INFO)
    clk = Clock()
    lag = LoopLag(mono=clk)
    assert lag.max_s() is None and lag.stalls == 0
    lag.observe(0.01)
    lag.observe(LOOP_STALL_S)  # 멈춤으로 센다(경고는 아님)
    assert lag.stalls == 1 and lag.max_s() == LOOP_STALL_S
    assert not [r for r in caplog.records if r.levelno >= logging.WARNING]
    lag.observe(LOOP_WARN_S + 1)
    lag.observe(LOOP_WARN_S + 2)  # 같은 분 안 두 번째는 로그를 남기지 않는다(수는 센다)
    warns = [r for r in caplog.records if r.levelno == logging.WARNING]
    assert lag.stalls == 3 and len(warns) == 1 and "event loop" in warns[0].getMessage()
    clk.t += 61
    lag.observe(LOOP_WARN_S)
    assert len([r for r in caplog.records if r.levelno == logging.WARNING]) == 2


async def test_loop_lag_monitor_measures_a_real_blocking_call():
    lag = LoopLag(tick_s=0.05)
    task = asyncio.create_task(lag.run())
    try:
        await asyncio.sleep(0.12)
        time.sleep(0.3)  # 루프를 막는 동기 호출
        await asyncio.sleep(0.12)
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
    assert lag.max_s() is not None and 0.2 <= lag.max_s() < 1.0


# ── 원문 대기열: 머문 시간 · 깊이 ────────────────────────────────


async def test_raw_queue_reports_time_in_queue_and_depth_high_water():
    clk = Clock()
    q = RawQueue(10, mono=clk)
    assert q.wait_max_s() is None and q.depth_max() is None  # 아직 모름
    q.put(b"a")
    q.put(b"b")
    clk.t += 2.5
    assert q.get_tagged_nowait() == (0, b"a")
    clk.t += 0.5
    assert await q.get_tagged() == (0, b"b")
    assert q.wait_max_s() == pytest.approx(3.0) and q.depth_max() == 2
    for i in range(12):  # 넘쳐 버린 것은 머문 시간에 들어가지 않는다(소비되지 않았다)
        q.put(b"x%d" % i)
    assert q.depth_max() == 10 and q.dropped == 2


# ── websockets 수신 버퍼 · keepalive 왕복(가짜 서버) ───────────────


async def test_client_records_keepalive_rtt_and_ws_buffer_depth():
    """서버가 pong 을 0.32 s 늦게 보내면(시간 초과 0.8 s 아래) 끊기지 않고 왕복 0.32 s 가 기록된다 — 끊기기 전에 커지는 것을 본다."""
    server, url = await _serve(Server(pong_hook=_delay_pongs(TIMEOUT_S * 0.4)))
    c, q, feed = _client(url)
    stop = asyncio.Event()
    task = asyncio.create_task(c.run(stop))
    try:
        await _connected(feed)
        await asyncio.sleep(1.2)
        assert feed.sessions_ended == 0
        rtt = feed.ping_rtt.value()
        assert rtt is not None and TIMEOUT_S * 0.4 <= rtt < TIMEOUT_S
        depth = feed.ws_buffer.value()
        assert depth is not None and 0 <= depth <= client_mod.WS_MAX_QUEUE
    finally:
        stop.set()
        await asyncio.wait_for(task, 5)
        server.close()


async def test_ws_buffer_depth_is_readable_on_the_pinned_websockets():
    """수신 버퍼 깊이는 websockets 내부(recv_messages.frames)를 읽는다 — 판을 올려 사라지면 이 시험이 먼저 깨진다(조용히 '모름' 이 되지 않게)."""
    server, url = await _serve(Server(subscribe=False))
    try:
        from websockets.asyncio.client import connect

        async with connect(url) as ws:
            frames = client_mod.ws_frames(ws)
            assert frames is not None and len(frames) >= 0
    finally:
        server.close()


class Burst(Server):
    """구독을 받은 뒤 프레임 n 개를 한꺼번에(기다리지 않고) 보내고 연결을 유지한다 — 공급자 적체가 풀리거나 망이 잠깐 끊겼다 이어질 때처럼."""

    def __init__(self, n: int) -> None:
        super().__init__()
        self.n = n

    async def handler(self, ws) -> None:
        await asyncio.wait_for(ws.recv(), 1.0)
        fs = _frames()
        try:
            for i in range(self.n):
                await ws.send(fs[i % len(fs)])
            await asyncio.sleep(30)
        except ConnectionClosed:
            pass


async def test_a_burst_fills_the_ws_buffer_past_its_limit_without_a_loop_stall():
    """한 번 읽은 바이트(asyncio 는 최대 256 KiB)에 든 프레임은 websockets 가 모두 버퍼에 넣은 뒤 읽기를 멈춘다(상한 64 를 넘으면 pause — 16 이하로 줄면
    다시 읽음). 그래서 한꺼번에 받은 묶음만으로 버퍼가 상한을 넘는다 — 루프 지연은 작고 연결은 유지된다. ws_queue_max ≥ 상한은 '그때 소켓 읽기가 잠시
    멈췄다' 는 사실일 뿐 결함이 아니며, 버퍼 값만으로는 루프 멈춤과 한꺼번에 받음을 가르지 못한다(루프 지연과 함께 본다)."""
    lag = LoopLag(tick_s=0.05)
    lag_task = asyncio.create_task(lag.run())
    server, url = await _serve(Burst(600))
    c, q, feed = _client(url)
    stop = asyncio.Event()
    task = asyncio.create_task(c.run(stop))
    try:
        end = time.monotonic() + 5.0
        while feed.msgs_total < 600:
            assert time.monotonic() < end, feed.msgs_total
            await asyncio.sleep(0.02)
        await asyncio.sleep(0.2)
    finally:
        stop.set()
        await asyncio.wait_for(task, 5)
        server.close()
        lag_task.cancel()
        await asyncio.gather(lag_task, return_exceptions=True)
    depth, loop_lag = feed.ws_buffer.value(), lag.max_s()
    assert depth is not None and depth > client_mod.WS_MAX_QUEUE, depth  # 상한을 넘었다 — 멈춤 없이
    assert loop_lag is not None and loop_lag < TIMEOUT_S / 2, loop_lag
    assert feed.sessions_ended == 0 and feed.connected, feed.last_error


async def test_missing_ws_buffer_is_unknown_and_logged_once(caplog):
    class NoInternals:
        pass

    caplog.set_level(logging.WARNING)
    client_mod._warned_no_frames = False
    assert client_mod.ws_frames(NoInternals()) is None
    assert client_mod.ws_frames(NoInternals()) is None
    assert len([r for r in caplog.records if "receive buffer" in r.getMessage()]) == 1


@pytest.mark.parametrize("cause", ["loop_stall", "late_pong"])
async def test_disconnect_log_tells_a_loop_stall_from_a_late_server_pong(cause, caplog):
    """1011 의 로그 한 줄로 원인을 가른다: 루프 멈춤이면 loop lag 가 시간 초과만큼, 서버의 늦은 pong 이면 loop lag 는 작고 keepalive 왕복은
    잰 적이 없다(—) — 데이터는 계속 받았다. 서버는 별도 스레드(원격 공급자처럼), 루프 멈춤은 1011 이 나는 순서로 고정한다(test_ais_keepalive §3)."""
    caplog.set_level(logging.INFO, logger="ais.client")
    loop = asyncio.get_running_loop()
    lag = LoopLag(tick_s=0.05)
    lag_task = asyncio.create_task(lag.run())
    hook = _stall_client(loop, STALL_S, on_loop=True) if cause == "loop_stall" else _delay_pongs(TIMEOUT_S + 0.3)
    try:
        with RemoteServer(Server(pong_hook=hook)) as url:
            c, q, feed = _client(url)
            c._loop_lag = lag.max_s
            await _run_for(c, STALL_S + 2.0)
    finally:
        lag_task.cancel()
        await asyncio.gather(lag_task, return_exceptions=True)
    line = next(r.getMessage() for r in caplog.records if "disconnected" in r.getMessage())
    assert "client closed (1011 keepalive ping timeout)" in line and "provider lag p50 —" in line, line
    loop_lag = float(re.search(r"loop lag ([0-9.]+) s", line)[1])
    buffer = int(re.search(r"ws buffer (\d+)/64 frames", line)[1])
    if cause == "loop_stall":
        assert loop_lag >= TIMEOUT_S, line
    else:
        assert loop_lag < TIMEOUT_S / 2 and "keepalive rtt —" in line and buffer < 64, line


# ── 상태 해시 ─────────────────────────────────────────────────────


def test_status_fields_carry_diagnostics_and_unknown_is_empty():
    clk = Clock()
    q = RawQueue(100, mono=clk)
    shards = ShardSet("aisstream", mono=clk)
    a = shards.add("18,105,46,150")
    b = shards.add("-90,-180,90,0")
    lag = LoopLag(mono=clk)
    sink = AisSink(
        FakeRedis(), book=ShipBook("aisstream"), shards=shards, worker=Worker(q, ShipBook("aisstream")), queue=q,
        provider="aisstream", raw_ref="-", loop_lag=lag, mono=clk,
    )  # fmt: skip
    st = sink.status_fields()
    for k in ("loop_lag_max_s", "queue_wait_max_s", "queue_depth_max", "ws_queue_max", "ping_rtt_max_s"):
        assert st[k] == "", k  # 아직 표본이 없다 — 모름
    assert (st["diag_window_s"], st["ws_queue_limit"], st["ping_timeout_s"]) == ("60", "64", "20")
    assert st["loop_stalls_total"] == "0"
    lag.observe(0.034)
    q.put(b"x")
    clk.t += 0.25
    q.get_nowait()
    a.feed.ping_rtt.add(0.31)
    b.feed.ping_rtt.add(4.5)
    a.feed.ws_buffer.add(3)
    b.feed.ws_buffer.add(70)
    st = sink.status_fields()
    assert (st["loop_lag_max_s"], st["queue_wait_max_s"], st["queue_depth_max"]) == ("0.03", "0.25", "1")
    assert (st["ws_queue_max"], st["ping_rtt_max_s"]) == ("70", "4.50")
    view = [dict(v) for v in shards.shards_view()]
    assert [tuple(v) for v in view] == [SHARD_FIELDS, SHARD_FIELDS]
    assert [(v["ping_rtt_max_s"], v["ws_queue_max"]) for v in view] == [(0.31, 3), (4.5, 70)]


def test_status_without_a_monitor_reports_loop_lag_unknown():
    q = RawQueue(10)
    shards = ShardSet("fixture")
    shards.add(None)
    sink = AisSink(FakeRedis(), book=ShipBook("fixture"), shards=shards, worker=Worker(q, ShipBook("fixture")), queue=q,
                   provider="fixture", raw_ref="-")  # fmt: skip
    st = sink.status_fields()
    assert st["loop_lag_max_s"] == "" and st["loop_stalls_total"] == ""
    assert shards.shards_view()[0]["ping_rtt_max_s"] is None and shards.shards_view()[0]["ws_queue_max"] is None
