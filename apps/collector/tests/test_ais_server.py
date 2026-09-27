"""가짜 aisstream 서버(websockets.serve, 127.0.0.1)로 수신 경로 전체를 시험한다 — 외부 호출 없음.

연결 → 1 s 안 구독(APIKey·BoundingBoxes·FilterMessageTypes) → deflate 협상 → 이진 프레임 수신 → 끊김 → 공백 열림 →
백오프 → 재연결·재구독 → 첫 메시지에서 공백 닫힘. 구독 갱신 속도 제한, 조용한 연결 감지, 핸드셰이크 거절, 키 비노출.
"""

from __future__ import annotations

import asyncio
import json
import logging
import random
import time
from collections.abc import Awaitable, Callable
from http import HTTPStatus

import pytest
from fakes import FakeRedis
from test_ais_helpers import decode, dumps, fixture_docs, validator
from websockets.asyncio.server import ServerConnection, serve
from websockets.extensions.permessage_deflate import PerMessageDeflate

from wakeline_collector.ais import main as ais_main
from wakeline_collector.ais.backoff import Backoff
from wakeline_collector.ais.bbox import BboxState, parse_bboxes
from wakeline_collector.ais.client import AisStreamClient
from wakeline_collector.ais.config import AisSettings
from wakeline_collector.ais.feed import FeedState, parse_iso
from wakeline_collector.ais.health import evaluate
from wakeline_collector.ais.parse import SUBSCRIBED_TYPES, go_time
from wakeline_collector.ais.queue import RawQueue
from wakeline_collector.ais.sink import STATUS_KEY
from wakeline_collector.publisher import STREAM_SHIPS

KEY = "test-ais-key-0123456789abcdef"  # 가짜 키 — 로그·상태·스트림 어디에도 나오면 안 된다


def frames(n: int) -> list[bytes]:
    now = time.time()
    out = []
    for d in fixture_docs()[:n]:
        d.pop("_recv_offset_s")
        d["MetaData"]["time_utc"] = go_time(now)
        out.append(dumps(d))
    return out


class FakeAis:
    """연결마다 script(idx, ws, server) 를 돈다. 받은 텍스트 프레임(구독)을 연결별로 기록한다."""

    def __init__(self, script: Callable[[int, ServerConnection, FakeAis], Awaitable[None]]):
        self.script = script
        self.subs: list[list[tuple[float, dict]]] = []
        self.deflate: list[bool] = []
        self.user_agents: list[str] = []
        self.sub_delay: list[float] = []

    async def handler(self, ws: ServerConnection) -> None:
        idx = len(self.subs)
        got: list[tuple[float, dict]] = []
        self.subs.append(got)
        self.deflate.append(any(isinstance(e, PerMessageDeflate) for e in ws.protocol.extensions))
        self.user_agents.append(ws.request.headers.get("User-Agent", ""))
        t0 = time.monotonic()
        first = await asyncio.wait_for(ws.recv(), 1.0)  # 계약: 연결 뒤 1 s 안에 구독
        self.sub_delay.append(time.monotonic() - t0)
        got.append((time.monotonic(), json.loads(first)))

        async def reader():
            async for m in ws:
                got.append((time.monotonic(), json.loads(m)))

        rt = asyncio.create_task(reader())
        try:
            await self.script(idx, ws, self)
        finally:
            rt.cancel()


async def start(fake: FakeAis, **kw):
    server = await serve(fake.handler, "127.0.0.1", 0, compression="deflate", **kw).__aenter__()
    port = server.sockets[0].getsockname()[1]
    return server, f"ws://127.0.0.1:{port}"


async def wait_until(pred: Callable[[], bool], timeout: float = 5.0) -> None:
    end = time.monotonic() + timeout
    while not pred():
        if time.monotonic() > end:
            raise AssertionError("condition not met in time")
        await asyncio.sleep(0.01)


def make_client(url: str, **kw):
    q = RawQueue(1000)
    feed = FeedState("aisstream")
    bboxes = BboxState(parse_bboxes("18,105,46,150"))
    backoff = kw.pop("backoff", Backoff(base_s=0.05, cap_s=0.2, rng=random.Random(3)))
    c = AisStreamClient(
        api_key=KEY, queue=q, feed=feed, bboxes=bboxes, backoff=backoff, url=url, user_agent="wakeline-test/1", **kw
    )
    return c, q, feed, bboxes


async def test_connect_subscribe_disconnect_gap_reconnect(caplog):
    caplog.set_level(logging.DEBUG)  # websockets DEBUG 로그가 켜져도 키가 새지 않아야 한다
    sent_last: dict[int, float] = {}

    async def script(idx, ws, srv):
        for f in frames(20 if idx == 0 else 10):
            await ws.send(f)  # aisstream 은 이진 프레임(UTF-8 JSON)
        sent_last[idx] = time.time()
        if idx == 0:
            await asyncio.sleep(0.1)
            await ws.close(1011, "try again later")
        else:
            await asyncio.sleep(10)

    fake = FakeAis(script)
    server, url = await start(fake)
    c, q, feed, _ = make_client(url, idle_timeout_s=5)
    stop = asyncio.Event()
    task = asyncio.create_task(c.run(stop))
    try:
        await wait_until(lambda: feed.gaps.last is not None and q.qsize() >= 30)
        # 구독: 1 s 안, 키·상자·형식 필터
        assert len(fake.subs) == 2 and all(d < 1.0 for d in fake.sub_delay)
        sub = fake.subs[0][0][1]
        assert sub == {
            "APIKey": KEY,
            "BoundingBoxes": [[[18.0, 105.0], [46.0, 150.0]]],
            "FilterMessageTypes": list(SUBSCRIBED_TYPES),
        }
        assert fake.subs[1][0][1] == sub  # 재연결 뒤 같은 구독
        # permessage-deflate 협상(양쪽에서 확인), User-Agent
        assert fake.deflate == [True, True] and feed.deflate is True
        assert fake.user_agents[0] == "wakeline-test/1"
        # 받은 프레임은 파싱하지 않은 원문(bytes) 그대로 대기열에
        raws = [q.get_nowait() for _ in range(q.qsize())]
        assert len(raws) == 30 and all(isinstance(r, bytes) for r in raws)
        # 공백: 첫 연결의 마지막 메시지 시각 → 재연결 뒤 첫 메시지 시각
        gap = feed.gaps.last
        assert gap["reason"] == "server closed (1011 try again later)"
        started, ended = parse_iso(gap["started_at"]), parse_iso(gap["ended_at"])
        assert started <= sent_last[0] + 0.05 and started < ended
        assert list(feed.gaps.pending) == [gap] and feed.gaps.open_since is None
        assert feed.sessions_ended == 1 and feed.connected and feed.state == "receiving"
        assert c.backoff.attempt == 1  # 60 s 정상 연결이 아니었으므로 초기화하지 않았다
    finally:
        stop.set()
        await asyncio.wait_for(task, 5)
        server.close()
    assert KEY not in caplog.text and KEY not in feed.last_error


async def test_abrupt_disconnect_without_close_frame():
    async def script(idx, ws, srv):
        if idx == 0:
            for f in frames(3):
                await ws.send(f)
            await asyncio.sleep(0.05)
            ws.transport.abort()  # close 프레임 없이 끊는다(실측: 전세계 구독 3회 중 1회)
        else:
            await ws.send(frames(1)[0])
            await asyncio.sleep(10)

    server, url = await start(FakeAis(script))
    c, q, feed, _ = make_client(url)
    stop = asyncio.Event()
    task = asyncio.create_task(c.run(stop))
    try:
        await wait_until(lambda: feed.gaps.last is not None)
        assert feed.gaps.last["reason"] == "connection lost (no close frame)"
    finally:
        stop.set()
        await asyncio.wait_for(task, 5)
        server.close()


async def test_resubscribe_is_rate_limited_and_last_value_wins():
    async def script(idx, ws, srv):
        await ws.send(frames(1)[0])
        await asyncio.sleep(10)

    fake = FakeAis(script)
    server, url = await start(fake)
    c, q, feed, bboxes = make_client(url, resubscribe_min_s=0.3)
    stop = asyncio.Event()
    task = asyncio.create_task(c.run(stop))
    try:
        await wait_until(lambda: feed.state == "receiving")
        for spec in ("10,100,20,110", "11,101,21,111", "12,102,22,112"):  # 빠르게 세 번 바꾼다
            bboxes.set(parse_bboxes(spec))
            await asyncio.sleep(0.02)
        await wait_until(lambda: len(fake.subs[0]) >= 2)
        await asyncio.sleep(0.4)
        subs = fake.subs[0]
        assert len(subs) == 2  # 처음 구독 + 갱신 1회(마지막 값)
        assert subs[1][1]["BoundingBoxes"] == [[[12.0, 102.0], [22.0, 112.0]]]
        assert subs[1][0] - subs[0][0] >= 0.3 - 0.02
        bboxes.set(parse_bboxes("-90,-180,90,180"))
        await wait_until(lambda: len(fake.subs[0]) >= 3)
        assert fake.subs[0][2][0] - fake.subs[0][1][0] >= 0.3 - 0.02
        assert feed.subscribe_updates == 2 and feed.bbox == "-90,-180,90,180"
        assert len(fake.subs) == 1  # 같은 연결에서 갱신(재접속 아님)
    finally:
        stop.set()
        await asyncio.wait_for(task, 5)
        server.close()


async def test_idle_connection_is_recycled_and_gap_starts_at_last_message():
    first_msg_at: list[float] = []

    async def script(idx, ws, srv):
        if idx == 0:
            first_msg_at.append(time.time())
            await ws.send(frames(1)[0])
        else:
            await ws.send(frames(1)[0])
        await asyncio.sleep(10)  # 조용한 연결(ping 은 오가지만 데이터 없음)

    server, url = await start(FakeAis(script))
    c, q, feed, _ = make_client(url, idle_timeout_s=0.3)
    stop = asyncio.Event()
    task = asyncio.create_task(c.run(stop))
    try:
        await wait_until(lambda: feed.gaps.last is not None)
        gap = feed.gaps.last
        assert gap["reason"] == "idle 0.3 s — no messages"
        assert abs(parse_iso(gap["started_at"]) - first_msg_at[0]) < 0.2
    finally:
        stop.set()
        await asyncio.wait_for(task, 5)
        server.close()


async def test_handshake_rejected_backs_off_without_gap():
    def reject(connection, request):
        return connection.respond(HTTPStatus.UNAUTHORIZED, "no\n")

    async def script(idx, ws, srv):  # pragma: no cover — 핸드셰이크에서 거절되어 오지 않는다
        await asyncio.sleep(1)

    server, url = await start(FakeAis(script), process_request=reject)
    c, q, feed, _ = make_client(url)
    stop = asyncio.Event()
    task = asyncio.create_task(c.run(stop))
    try:
        await wait_until(lambda: feed.sessions_ended >= 3)
        assert feed.last_error == "handshake rejected: HTTP 401"
        assert feed.gaps.open_since is None and feed.gaps.last is None  # 받은 적이 없으면 공백이 아니다
        assert c.backoff.attempt >= 3 and feed.state in ("backoff", "connecting")
    finally:
        stop.set()
        await asyncio.wait_for(task, 5)
        server.close()


async def test_connection_refused_is_reported():
    c, q, feed, _ = make_client("ws://127.0.0.1:9", open_timeout_s=1)  # discard 포트 — 열려 있지 않다
    stop = asyncio.Event()
    task = asyncio.create_task(c.run(stop))
    await wait_until(lambda: feed.sessions_ended >= 1)
    stop.set()
    await asyncio.wait_for(task, 5)
    assert feed.last_error.startswith(("network error:", "connect timeout"))


async def test_stop_while_connected_closes_promptly():
    async def script(idx, ws, srv):
        await ws.send(frames(1)[0])
        await ws.wait_closed()

    server, url = await start(FakeAis(script))
    c, q, feed, _ = make_client(url)
    stop = asyncio.Event()
    task = asyncio.create_task(c.run(stop))
    await wait_until(lambda: feed.state == "receiving")
    t0 = time.monotonic()
    stop.set()
    await asyncio.wait_for(task, 5)
    assert time.monotonic() - t0 < 2.0
    server.close()


def test_url_and_key_validation():
    q, feed, bb = RawQueue(10), FeedState("aisstream"), BboxState(parse_bboxes("1,1,2,2"))
    with pytest.raises(ValueError):
        AisStreamClient(
            api_key=KEY, queue=q, feed=feed, bboxes=bb, url="ws://example.com/v0/stream"
        )  # 평문으로 키를 보내지 않는다
    with pytest.raises(ValueError):
        AisStreamClient(api_key="", queue=q, feed=feed, bboxes=bb)
    c = AisStreamClient(api_key=KEY, queue=q, feed=feed, bboxes=bb)
    assert c.url == "wss://stream.aisstream.io/v0/stream"
    assert c.redact(f"error apikey={KEY} and {KEY}") == "error apikey=*** and ***"


# ── 진입점 전체(가짜 서버 + 가짜 Redis) ──────────────────────────────


class ClosableRedis(FakeRedis):
    async def aclose(self) -> None:
        return None


async def test_main_live_mode_end_to_end():
    async def script(idx, ws, srv):
        if idx == 0:
            await ws.send(json.dumps({"error": f"quota warning for {KEY}"}).encode())
            for f in frames(40):
                await ws.send(f)
            await asyncio.sleep(0.2)
            await ws.close(1001, "going away")
        else:
            for f in frames(40):
                await ws.send(f)
            await asyncio.sleep(10)

    server, url = await start(FakeAis(script))
    r = ClosableRedis()
    s = AisSettings(aisstream_api_key=KEY, ais_flush_s=1.0, wakeline_fixture_mode=0)
    stop = asyncio.Event()
    task = asyncio.create_task(
        ais_main.main(stop=stop, redis=r, settings=s, client_kw={"url": url, "backoff": Backoff(base_s=0.05, cap_s=0.1)})
    )
    try:
        await wait_until(lambda: any(f["kind"] == "ais_gap" for _, f in r.streams.get(STREAM_SHIPS, [])), 6)
        await wait_until(lambda: sum(f["kind"] == "ships" for _, f in r.streams.get(STREAM_SHIPS, [])) >= 1, 4)
    finally:
        stop.set()
        rc = await asyncio.wait_for(task, 10)
        server.close()
    assert rc == 0
    env = validator("stream_envelope.v1.json")
    ships_v = validator("stream_envelope.v1.json", "/$defs/ships_payload")
    gap_v = validator("stream_envelope.v1.json", "/$defs/ais_gap_payload")
    for _, f in r.streams[STREAM_SHIPS]:
        assert not list(env.iter_errors(f))
        assert not list((ships_v if f["kind"] == "ships" else gap_v).iter_errors(decode(f)))
        assert f["provider"] == "aisstream"
    gaps = [decode(f) for _, f in r.streams[STREAM_SHIPS] if f["kind"] == "ais_gap"]
    assert gaps[0]["reason"] == "server closed (1001 going away)"
    h = r.kv[STATUS_KEY]
    assert h["state"] == "stopped" and h["connected"] == "0" and h["gap_reason"] == "ais process stopped"
    assert h["last_gap_reason"] == "server closed (1001 going away)" and h["provider_error"] == "quota warning for ***"
    assert int(h["msgs_total"]) >= 81 and h["deflate"] == "1"
    # 키는 Redis 어디에도 없다(상태 해시·스트림 원문)
    blob = json.dumps(r.kv) + json.dumps([decode(f) for _, f in r.streams[STREAM_SHIPS]]) + json.dumps(r.streams)
    assert KEY not in blob


async def test_main_first_subscription_uses_runtime_bbox_setting():
    async def script(idx, ws, srv):
        await ws.send(frames(1)[0])
        await asyncio.sleep(10)

    fake = FakeAis(script)
    server, url = await start(fake)
    r = ClosableRedis()
    await r.hset("wakeline:settings", "ais_bboxes", "-90,-180,90,180")
    stop = asyncio.Event()
    task = asyncio.create_task(
        ais_main.main(stop=stop, redis=r, settings=AisSettings(aisstream_api_key=KEY), client_kw={"url": url})
    )
    try:
        await wait_until(lambda: len(fake.subs) == 1 and len(fake.subs[0]) >= 1)
        assert fake.subs[0][0][1]["BoundingBoxes"] == [[[-90.0, -180.0], [90.0, 180.0]]]
    finally:
        stop.set()
        assert await asyncio.wait_for(task, 10) == 0
        server.close()


async def test_main_without_key_reports_disabled_and_stays_healthy():
    r = ClosableRedis()
    s = AisSettings(aisstream_api_key="", wakeline_fixture_mode=0)
    stop = asyncio.Event()
    task = asyncio.create_task(ais_main.main(stop=stop, redis=r, settings=s))
    await wait_until(lambda: r.kv.get(STATUS_KEY, {}).get("state") == "disabled")
    ok, why = evaluate(r.kv[STATUS_KEY])
    assert ok and "disabled" in why
    assert "AISSTREAM_API_KEY" in r.kv[STATUS_KEY]["last_error"]
    stop.set()
    assert await asyncio.wait_for(task, 5) == 0


async def test_main_fixture_mode_publishes_and_carries_gap_over_restart():
    r = ClosableRedis()
    s = AisSettings(wakeline_fixture_mode=1, ais_flush_s=1.0)

    def count(kind: str) -> int:
        return sum(f["kind"] == kind for _, f in r.streams.get(STREAM_SHIPS, []))

    for round_ in range(2):
        stop = asyncio.Event()
        before = count("ships")
        task = asyncio.create_task(ais_main.main(stop=stop, redis=r, settings=s, replay_speed=60))
        await wait_until(lambda b=before, n=round_: count("ships") > b and count("ais_gap") == n, 5)
        stop.set()
        assert await asyncio.wait_for(task, 10) == 0
        h = r.kv[STATUS_KEY]
        assert h["provider"] == "fixture" and h["state"] == "stopped" and h["gap_open_since"]
    # 두 번째 실행이 첫 실행의 종료 공백을 이어받아 첫 메시지에서 닫고 발행했다
    gaps = [decode(f) for _, f in r.streams[STREAM_SHIPS] if f["kind"] == "ais_gap"]
    assert len(gaps) == 1 and gaps[0]["reason"] == "ais process stopped"
    ships = [f for _, f in r.streams[STREAM_SHIPS] if f["kind"] == "ships"]
    assert all(f["provider"] == "fixture" and f["raw_ref"] == "fixture/ais_east_asia_90s.jsonl" for f in ships)


async def test_main_returns_1_when_a_task_dies(monkeypatch):
    async def dead(self):
        raise RuntimeError("worker died")

    monkeypatch.setattr(ais_main.Worker, "run", dead)
    r = ClosableRedis()
    rc = await asyncio.wait_for(ais_main.main(stop=asyncio.Event(), redis=r, settings=AisSettings(wakeline_fixture_mode=1)), 10)
    assert rc == 1 and r.kv[STATUS_KEY]["state"] == "stopped"
