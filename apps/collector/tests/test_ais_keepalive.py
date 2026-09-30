"""keepalive 1011(ping 시간 초과) 재현 — 로그 화면의 'ais shard 1 disconnected: client closed (1011 keepalive ping timeout)'(2026-09-30).

가설을 가정하지 않고 시험한다(가짜 서버 websockets.serve 127.0.0.1, 외부 호출 없음). ping 20 s · 시간 초과 20 s 를 0.2 s · 0.5 s 로 줄여 같은 기제를 본다.
- websockets 의 수신 버퍼(max_queue 64 프레임)는 **소켓을 읽는 쪽(recv 를 부르는 코드)** 이 멈출 때만 찬다: 64 를 넘으면 읽기를 멈추고(pause_reading),
  pong 도 읽히지 않아 1011 이 난다. 우리 수신 태스크(client._read)는 받은 원문을 대기열(RawQueue)에 넣기만 하고 기다리지 않으므로
  정리(파싱 → ShipBook)·발행(Redis)이 밀려도 소켓 읽기는 멈추지 않는다 — 소비자 적체는 1011 의 원인이 될 수 없다.
- 이벤트 루프가 ping 이 나가 있는 동안 시간 초과보다 오래 멈추면(루프 위의 CPU 작업) 버퍼 크기와 상관없이 1011 — pong 이 이미 도착했어도
  같은 루프 한 바퀴에서 시간 초과 콜백이 먼저 돈다. 같은 작업을 루프 밖(스레드)에서 하면 나지 않는다.
- 서버가 pong 을 시간 초과보다 늦게 보내면(공급자 쪽 연결별 전달 적체 — VERIFICATION #17) 버퍼 크기와 상관없이 1011.
"""

from __future__ import annotations

import asyncio
import random
import time
from collections.abc import Callable

import pytest
from test_ais_helpers import dumps, fixture_docs
from websockets.asyncio.client import connect
from websockets.asyncio.server import ServerConnection, serve
from websockets.exceptions import ConnectionClosed
from websockets.frames import Opcode

from wakeline_collector.ais.backoff import Backoff
from wakeline_collector.ais.bbox import BboxState, parse_bboxes
from wakeline_collector.ais.client import AisStreamClient
from wakeline_collector.ais.feed import FeedState
from wakeline_collector.ais.parse import go_time
from wakeline_collector.ais.queue import RawQueue

KEY = "test-ais-key-keepalive-0123456789"
PING_S, TIMEOUT_S = 0.2, 0.5  # 운영 20 s · 20 s 를 줄인 값(같은 기제)
RATE_HZ = 400  # 가짜 서버가 보내는 프레임 수/초 — 0.5 s 멈춤이면 64 프레임을 넘친다
KEEPALIVE_1011 = "client closed (1011 keepalive ping timeout)"


def _frames(n: int = 50) -> list[bytes]:
    out = []
    for d in fixture_docs()[:n]:
        d.pop("_recv_offset_s", None)
        d["MetaData"]["time_utc"] = go_time(time.time())
        out.append(dumps(d))
    return out


def _busy(seconds: float) -> None:
    """CPU 를 쓰는 작업(sleep 이 아님) — 스레드에서 돌면 GIL 을 5 ms 마다 내준다."""
    end = time.perf_counter() + seconds
    while time.perf_counter() < end:
        pass


class Server:
    """구독(텍스트 한 줄)이 오면 받아 두고 이진 프레임을 RATE_HZ 로 보낸다.

    pong_hook(frame) — 서버가 pong 을 보내려는 순간(= 클라이언트의 ping 이 나가 있는 동안) 부른다. None 을 돌려주면 그 pong 을 보내지 않는다
    (나중에 보내는 것은 hook 의 몫)."""

    def __init__(
        self, *, subscribe: bool = True, pong_hook: Callable[[ServerConnection, Callable[[], None]], bool] | None = None
    ):
        self.subscribe = subscribe
        self.pong_hook = pong_hook
        self.connections = 0

    async def handler(self, ws: ServerConnection) -> None:
        self.connections += 1
        if self.subscribe:
            await asyncio.wait_for(ws.recv(), 1.0)
        if self.pong_hook is not None:
            original = ws.protocol.send_frame
            hook = self.pong_hook

            def send_frame(frame):
                if frame.opcode is Opcode.PONG:

                    def send_now() -> None:
                        if ws.protocol.state.name == "OPEN":
                            original(frame)
                            ws.send_data()

                    if not hook(ws, send_now):
                        return None
                return original(frame)

            ws.protocol.send_frame = send_frame
        frames = _frames()
        i = 0
        try:
            while True:
                await ws.send(frames[i % len(frames)])
                i += 1
                await asyncio.sleep(1 / RATE_HZ)
        except ConnectionClosed:
            pass


async def _serve(server: Server):
    srv = await serve(server.handler, "127.0.0.1", 0, compression="deflate").__aenter__()
    return srv, f"ws://127.0.0.1:{srv.sockets[0].getsockname()[1]}"


def _client(url: str, queue: RawQueue | None = None) -> tuple[AisStreamClient, RawQueue, FeedState]:
    q = queue or RawQueue(20_000)
    feed = FeedState("aisstream")
    c = AisStreamClient(
        api_key=KEY,
        queue=q,
        feed=feed,
        bboxes=BboxState(parse_bboxes("18,105,46,150")),
        backoff=Backoff(base_s=5.0, cap_s=5.0, rng=random.Random(1)),  # 끊기면 5 s 쉰다 — 시험 창 안에 다시 붙지 않는다
        url=url,
        ping_interval_s=PING_S,
        ping_timeout_s=TIMEOUT_S,
        close_timeout_s=0.3,
        idle_timeout_s=30,
    )
    return c, q, feed


async def _run_for(c: AisStreamClient, seconds: float) -> None:
    """끊길 때까지(최대 seconds) 돌리고 멈춘다."""
    stop = asyncio.Event()
    task = asyncio.create_task(c.run(stop))
    try:
        end = time.monotonic() + seconds
        while time.monotonic() < end and c.feed.sessions_ended == 0:
            await asyncio.sleep(0.02)
    finally:
        stop.set()
        await asyncio.wait_for(task, 5)


async def _connected(feed: FeedState, timeout: float = 3.0) -> None:
    end = time.monotonic() + timeout
    while feed.state != "receiving":
        assert time.monotonic() < end, "never started receiving"
        await asyncio.sleep(0.01)


# ── 1. 가설의 기제: recv 를 부르는 코드가 멈추면 max_queue 64 에서 읽기가 멈추고 1011 ─────────────────


@pytest.mark.parametrize(("max_queue", "trips"), [(64, True), (None, False), (4096, False)])
async def test_stalled_socket_reader_trips_keepalive_only_while_the_ws_buffer_is_full(max_queue, trips):
    """recv 를 부르지 않는 1.5 s(시간 초과 0.5 s 의 3배, 루프는 자유) 동안 서버는 약 600 프레임을 보낸다.
    max_queue 64 → 64 를 넘는 순간 읽기를 멈춰 pong 을 못 읽고 1011. 버퍼를 없애거나(None — 메모리 상한 없음) 멈춤 × 수신률보다 크게 하면(4096)
    pong 을 계속 읽어 끊기지 않는다 — 큰 버퍼는 문턱을 옮길 뿐이다(멈춤이 4096 / 400 ≈ 10 s 를 넘으면 같은 일)."""
    server, url = await _serve(Server(subscribe=False))
    try:
        async with connect(url, ping_interval=PING_S, ping_timeout=TIMEOUT_S, max_queue=max_queue, close_timeout=0.3) as ws:
            await asyncio.sleep(1.5)  # 소켓을 읽는 코드가 멈춘다(이벤트 루프는 돈다)
            closed = None
            end = time.monotonic() + 1.0  # 쌓인 것을 읽으며 1 s 더 본다(시간 초과 0.5 s 의 두 배)
            try:
                while time.monotonic() < end:
                    await asyncio.wait_for(ws.recv(), 1.0)
            except ConnectionClosed as e:
                closed = e
            except TimeoutError:
                pass
            if trips:
                assert closed is not None and closed.rcvd is None and closed.sent is not None
                assert (closed.sent.code, closed.sent.reason) == (1011, "keepalive ping timeout")
            else:
                assert closed is None and ws.state.name == "OPEN"
    finally:
        server.close()


# ── 2. 우리 수신 경로: 정리·발행이 멈춰도 소켓 읽기는 멈추지 않는다 ─────────────────────────────────


async def test_stalled_worker_does_not_stop_socket_reads():
    """정리 태스크가 대기열을 전혀 비우지 않는 1.5 s(시간 초과의 3배) — 수신 태스크는 계속 읽어 대기열에 넣고 keepalive 는 살아 있다.
    가설(소비자 적체 → max_queue 64 → 소켓 읽기 멈춤 → 1011)은 이 구조에서 성립하지 않는다."""
    server, url = await _serve(Server())
    c, q, feed = _client(url)
    stop = asyncio.Event()
    task = asyncio.create_task(c.run(stop))
    try:
        await _connected(feed)
        n0 = q.qsize()
        await asyncio.sleep(1.5)  # 아무도 q 를 비우지 않는다
        assert feed.sessions_ended == 0 and feed.connected, feed.last_error
        assert q.qsize() - n0 > 300  # 멈춘 동안에도 소켓에서 읽어 대기열에 넣었다
    finally:
        stop.set()
        await asyncio.wait_for(task, 5)
        server.close()


# ── 3. 이벤트 루프 멈춤: 버퍼 크기와 상관없이 1011, 같은 작업을 루프 밖에서 하면 없음 ───────────────


def _stall_once(seconds: float, *, on_loop: bool) -> Callable[[ServerConnection, Callable[[], None]], bool]:
    """첫 pong 을 보내려는 순간(클라이언트 ping 이 나가 있는 동안) CPU 작업을 한 번 한다 — on_loop 면 이벤트 루프 위에서(시험 프로세스의
    루프 하나를 클라이언트·서버가 함께 쓴다), 아니면 스레드에서."""
    done = [False]

    def hook(ws, send_now) -> bool:
        if not done[0]:
            done[0] = True
            if on_loop:
                _busy(seconds)
            else:
                asyncio.get_running_loop().run_in_executor(None, _busy, seconds)
        return True

    return hook


@pytest.mark.parametrize("max_queue", [64, None])
async def test_loop_stall_while_a_ping_is_outstanding_trips_keepalive_whatever_the_buffer(max_queue):
    server, url = await _serve(Server(pong_hook=_stall_once(1.0, on_loop=True)))
    c, q, feed = _client(url)
    c._connect_kw["max_queue"] = max_queue
    try:
        await _run_for(c, 3.0)
        assert feed.sessions_ended == 1 and feed.last_error == KEEPALIVE_1011
    finally:
        server.close()


async def test_same_cpu_work_off_the_loop_does_not_trip_keepalive():
    server, url = await _serve(Server(pong_hook=_stall_once(1.0, on_loop=False)))
    c, q, feed = _client(url)
    try:
        await _run_for(c, 2.0)
        assert feed.sessions_ended == 0 and feed.connected, feed.last_error
    finally:
        server.close()


# ── 4. 서버가 pong 을 늦게 보냄(공급자 쪽 적체): 버퍼 크기와 상관없이 1011 ─────────────────────────


def _delay_pongs(seconds: float) -> Callable[[ServerConnection, Callable[[], None]], bool]:
    def hook(ws, send_now) -> bool:
        asyncio.get_running_loop().call_later(seconds, send_now)
        return False  # 지금은 보내지 않는다(데이터는 계속 흐른다)

    return hook


@pytest.mark.parametrize("max_queue", [64, None])
async def test_server_delaying_pongs_beyond_the_timeout_trips_keepalive_whatever_the_buffer(max_queue):
    server, url = await _serve(Server(pong_hook=_delay_pongs(TIMEOUT_S + 0.3)))
    c, q, feed = _client(url)
    c._connect_kw["max_queue"] = max_queue
    try:
        await _run_for(c, 3.0)
        assert feed.sessions_ended == 1 and feed.last_error == KEEPALIVE_1011
        assert feed.msgs_total > 100  # 데이터는 끊길 때까지 계속 왔다(늦은 것은 pong 뿐)
    finally:
        server.close()


async def test_server_delaying_pongs_below_the_timeout_keeps_the_connection():
    server, url = await _serve(Server(pong_hook=_delay_pongs(TIMEOUT_S * 0.6)))
    c, q, feed = _client(url)
    try:
        await _run_for(c, 1.5)
        assert feed.sessions_ended == 0 and feed.connected, feed.last_error
    finally:
        server.close()
