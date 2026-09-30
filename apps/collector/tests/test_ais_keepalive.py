"""keepalive 1011(ping 시간 초과) 재현 — 로그 화면의 'ais shard 1 disconnected: client closed (1011 keepalive ping timeout)'(2026-09-30).

가설을 가정하지 않고 시험한다(가짜 서버 websockets.serve 127.0.0.1, 외부 호출 없음). ping 20 s · 시간 초과 20 s 를 PING_S · TIMEOUT_S(0.2 s · 0.8 s)로 줄여
같은 기제를 본다. 멈춤은 STALL_S(시간 초과의 두 배) — 시험 기계가 바빠도 결과가 바뀌지 않게 여유를 둔다.
- websockets 의 수신 버퍼(max_queue 64 프레임)가 상한을 넘으면 소켓 읽기를 멈추고(pause_reading), 그동안 pong 도 읽히지 않는다. **소켓을 읽는 쪽(recv 를
  부르는 코드)** 이 시간 초과보다 오래 멈추면 1011. 우리 수신 태스크(client._read)는 받은 원문을 대기열(RawQueue)에 넣기만 하고 기다리지 않으므로
  정리(파싱 → ShipBook)·발행(Redis)이 밀려도 소켓 읽기는 멈추지 않는다 — 소비자 적체는 1011 의 원인이 될 수 없다.
- 이벤트 루프가 ping 이 나가 있는 동안 시간 초과보다 오래 멈추면 1011 이 **날 수 있다**(늘 나는 것은 아니다 — 콜백 순서에 달림, websockets 17.1 ·
  CPython asyncio). 멈춘 사이 pong 이 도착해 있어도, 멈춤이 끝난 뒤 pong 을 읽는 소켓 콜백과 keepalive 의 시간 초과 콜백이 같은 바퀴에 들면
  시간 초과가 keepalive 태스크보다 먼저 돌아 1011 이다(버퍼 크기와 상관없다). 반대로 멈춤이 시작되기 전(또는 같은 바퀴 안)에 소켓 콜백이 pong 을
  이미 처리했으면 keepalive 태스크가 다음 바퀴 맨 앞에서 깨어 시간 초과 콜백을 거둔다 — 끊기지 않는다. 두 순서를 각각 고정해 시험한다
  (서버는 별도 스레드 · 별도 루프 — 원격 공급자처럼 클라이언트 루프가 멈춰도 pong 을 제때 보낸다). 같은 작업을 루프 밖(스레드)에서 하면 나지 않는다.
- 서버가 pong 을 시간 초과보다 늦게 보내면(공급자 쪽 연결별 전달 적체 — VERIFICATION #17) 버퍼 크기와 상관없이 1011.
"""

from __future__ import annotations

import asyncio
import random
import threading
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
PING_S, TIMEOUT_S = 0.2, 0.8  # 운영 20 s · 20 s 를 줄인 값(같은 기제)
STALL_S = 2 * TIMEOUT_S  # 멈춤 길이 — 시간 초과의 두 배
RATE_HZ = 400  # 가짜 서버가 보내는 프레임 수/초 — 0.2 s 만 멈춰도 64 프레임을 넘친다
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
    """recv 를 부르지 않는 1.6 s(시간 초과 0.8 s 의 두 배, 루프는 자유) 동안 서버는 약 640 프레임을 보낸다.
    max_queue 64 → 64 를 넘는 순간 읽기를 멈춰 pong 을 못 읽고 1011. 버퍼를 없애거나(None — 메모리 상한 없음) 멈춤 × 수신률보다 크게 하면(4096)
    pong 을 계속 읽어 끊기지 않는다 — 큰 버퍼는 문턱을 옮길 뿐이다(멈춤이 4096 / 400 ≈ 10 s 를 넘으면 같은 일)."""
    server, url = await _serve(Server(subscribe=False))
    try:
        async with connect(url, ping_interval=PING_S, ping_timeout=TIMEOUT_S, max_queue=max_queue, close_timeout=0.3) as ws:
            await asyncio.sleep(STALL_S)  # 소켓을 읽는 코드가 멈춘다(이벤트 루프는 돈다)
            closed = None
            end = time.monotonic() + TIMEOUT_S + 0.5  # 쌓인 것을 읽으며 시간 초과보다 조금 더 본다
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
    """정리 태스크가 대기열을 전혀 비우지 않는 1.6 s(시간 초과의 두 배) — 수신 태스크는 계속 읽어 대기열에 넣고 keepalive 는 살아 있다.
    가설(소비자 적체 → max_queue 64 → 소켓 읽기 멈춤 → 1011)은 이 구조에서 성립하지 않는다."""
    server, url = await _serve(Server())
    c, q, feed = _client(url)
    stop = asyncio.Event()
    task = asyncio.create_task(c.run(stop))
    try:
        await _connected(feed)
        n0 = q.qsize()
        await asyncio.sleep(STALL_S)  # 아무도 q 를 비우지 않는다
        assert feed.sessions_ended == 0 and feed.connected, feed.last_error
        assert q.qsize() - n0 > 300  # 멈춘 동안에도 소켓에서 읽어 대기열에 넣었다
    finally:
        stop.set()
        await asyncio.wait_for(task, 5)
        server.close()


# ── 3. 이벤트 루프 멈춤: 1011 이 날 수 있다(순서에 달림) — 두 순서를 각각 고정, 같은 작업을 루프 밖에서 하면 없음 ───────


PongHook = Callable[[ServerConnection, Callable[[], None]], bool]


class RemoteServer:
    """Server 를 별도 스레드의 이벤트 루프에서 돌린다 — 원격 공급자처럼, 시험(클라이언트) 루프가 멈춰도 서버는 pong · 데이터를 제때 보낸다."""

    def __init__(self, server: Server) -> None:
        self.server = server
        self.url = ""
        self._ready = threading.Event()
        self._thread = threading.Thread(target=self._run, name="fake-ais-server", daemon=True)
        self._loop: asyncio.AbstractEventLoop | None = None
        self._stop: asyncio.Event | None = None

    def _run(self) -> None:
        asyncio.run(self._main())

    async def _main(self) -> None:
        self._loop, self._stop = asyncio.get_running_loop(), asyncio.Event()
        async with serve(self.server.handler, "127.0.0.1", 0, compression="deflate") as srv:
            self.url = f"ws://127.0.0.1:{srv.sockets[0].getsockname()[1]}"
            self._ready.set()
            await self._stop.wait()

    def __enter__(self) -> str:
        self._thread.start()
        assert self._ready.wait(5), "fake server thread did not start"
        return self.url

    def __exit__(self, *exc: object) -> None:
        if self._loop is not None and self._stop is not None:
            self._loop.call_soon_threadsafe(self._stop.set)
        self._thread.join(10)
        assert not self._thread.is_alive(), "fake server thread did not stop"


def _stall_client(loop: asyncio.AbstractEventLoop, seconds: float, *, on_loop: bool) -> PongHook:
    """서버(RemoteServer 스레드)가 첫 pong 을 보내려는 순간 — 클라이언트 ping 이 나가 있는 동안 — 클라이언트 쪽에 CPU 작업 seconds 를 한 번 건다.
    on_loop: 클라이언트 이벤트 루프의 **타이머 콜백** 으로. asyncio 한 바퀴는 [앞 바퀴가 넘긴 콜백] → [소켓 읽기 콜백] → [때가 된 타이머 콜백]
    순서라, 타이머 콜백으로 멈추면 그 바퀴에는 더 읽을 소켓 콜백이 없다 — pong 은 다음 바퀴에서 읽히고, 그 바퀴에 시간 초과 콜백도 든다(1011 순서 고정).
    아니면 스레드에서(루프는 자유). pong 은 작업이 시작된 뒤에 보낸다 — 작업 전에 읽혀 순서가 바뀌지 않게."""
    started = threading.Event()
    fired: list[asyncio.Task[None]] = []

    def work() -> None:
        started.set()
        _busy(seconds)

    def schedule() -> None:
        if on_loop:
            loop.call_later(0, work)
        else:
            loop.run_in_executor(None, work)

    def hook(ws: ServerConnection, send_now: Callable[[], None]) -> bool:
        if fired:
            return True

        async def pong_after_start() -> None:
            while not started.is_set():
                await asyncio.sleep(0.001)
            send_now()

        fired.append(asyncio.get_running_loop().create_task(pong_after_start()))  # 참조를 쥔다(태스크가 수거되지 않게)
        loop.call_soon_threadsafe(schedule)
        return False

    return hook


@pytest.mark.parametrize("max_queue", [64, None])
async def test_loop_stall_that_ends_before_the_pong_is_read_trips_keepalive_whatever_the_buffer(max_queue):
    """ping 이 나가 있는 동안 루프가 2 × 시간 초과 멈추고, pong(멈춘 사이 도착)은 멈춤이 끝난 다음 바퀴에서 읽힌다 — 그 바퀴에 든 시간 초과 콜백이
    keepalive 태스크보다 먼저 돌아 1011. 수신 버퍼를 없애도(None) 같다."""
    loop = asyncio.get_running_loop()
    with RemoteServer(Server(pong_hook=_stall_client(loop, STALL_S, on_loop=True))) as url:
        c, q, feed = _client(url)
        c._connect_kw["max_queue"] = max_queue
        await _run_for(c, STALL_S + 2.0)
    assert feed.sessions_ended == 1 and feed.last_error == KEEPALIVE_1011


async def test_loop_stall_after_the_pong_was_read_does_not_trip_keepalive():
    """같은 길이의 멈춤이라도 소켓 읽기 콜백이 pong 을 처리한 뒤 멈추면(keepalive 태스크는 다음 바퀴 맨 앞에서 깬다 — 시간 초과 콜백보다 먼저) 끊기지
    않는다. 루프 멈춤은 1011 을 '낼 수 있다' — 멈춤이 시간 초과보다 길다는 것만으로 늘 나지는 않는다."""
    with RemoteServer(Server(subscribe=False)) as url:
        async with connect(url, ping_interval=PING_S, ping_timeout=TIMEOUT_S, max_queue=64, close_timeout=0.3) as ws:
            stalled: list[float] = []
            original = ws.data_received

            def data_received(data: bytes) -> None:
                waiting = bool(ws.pending_pings)
                original(data)
                # 이 읽기에서 pong 을 처리했다 — keepalive 태스크는 아직 깨지 않았다(다음 바퀴 맨 앞에서 깬다)
                if waiting and not ws.pending_pings and not stalled:
                    stalled.append(time.monotonic())
                    _busy(STALL_S)

            ws.data_received = data_received  # type: ignore[method-assign]
            closed: ConnectionClosed | None = None
            end = time.monotonic() + 3.0
            try:
                while time.monotonic() < end and not (stalled and time.monotonic() > stalled[0] + STALL_S + TIMEOUT_S + 0.5):
                    # 시험의 기다림 한도는 멈춤보다 길게(이 한도가 멈춤 사이에 지나면 시험 쪽이 먼저 끝난다)
                    await asyncio.wait_for(ws.recv(), 5.0)
            except ConnectionClosed as e:
                closed = e
            assert stalled, "pong was never read"
            assert closed is None and ws.state.name == "OPEN", closed


async def test_same_cpu_work_off_the_loop_does_not_trip_keepalive():
    loop = asyncio.get_running_loop()
    with RemoteServer(Server(pong_hook=_stall_client(loop, STALL_S, on_loop=False))) as url:
        c, q, feed = _client(url)
        await _run_for(c, STALL_S + 0.5)
    assert feed.sessions_ended == 0 and feed.connected, feed.last_error


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
    server, url = await _serve(Server(pong_hook=_delay_pongs(TIMEOUT_S * 0.4)))
    c, q, feed = _client(url)
    try:
        await _run_for(c, 2.0)
        assert feed.sessions_ended == 0 and feed.connected, feed.last_error
    finally:
        server.close()
