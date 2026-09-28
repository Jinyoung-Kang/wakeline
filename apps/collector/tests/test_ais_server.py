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
from wakeline_collector.ais.bbox import BboxState, ShardsState, parse_bboxes, parse_shards
from wakeline_collector.ais.client import AisStreamClient
from wakeline_collector.ais.config import AisSettings
from wakeline_collector.ais.feed import FeedState, parse_iso
from wakeline_collector.ais.health import evaluate
from wakeline_collector.ais.parse import SUBSCRIBED_TYPES, go_time
from wakeline_collector.ais.pool import AisStreamPool
from wakeline_collector.ais.queue import RawQueue
from wakeline_collector.ais.shards import ShardSet
from wakeline_collector.ais.sink import STATUS_KEY, AisSink
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


def _error_frame(text: str = "Api Key Is Not Valid") -> bytes:
    return json.dumps({"error": text}).encode()


async def test_error_only_sessions_are_not_recovery():
    """공급자 오류 프레임({"error": ...})은 데이터가 아니다(리뷰 #4): 오류만 받고 끊기는 연결이 되풀이돼도 열린 공백을 닫지 않고,
    last_msg_at·msgs_total·수신 상태(receiving)를 바꾸지 않는다. 오류 프레임은 대기열에 넣어 정리 태스크가 provider_error 로 남긴다."""
    error_sent: list[float] = []

    async def script(idx, ws, srv):
        if idx == 0:
            for f in frames(5):
                await ws.send(f)
        else:  # 키 폐기·연결 수 초과: 오류 한 줄 뒤 끊김
            error_sent.append(time.time())
            await ws.send(_error_frame())
        await asyncio.sleep(0.05)
        await ws.close(1011, "try again later")

    server, url = await start(FakeAis(script))
    c, q, feed, _ = make_client(url, idle_timeout_s=5)
    stop = asyncio.Event()
    task = asyncio.create_task(c.run(stop))
    try:
        await wait_until(lambda: feed.sessions_ended >= 4)
        assert feed.msgs_total == 5 and feed.last_msg_at is not None and feed.last_msg_at < min(error_sent)
        # 첫 끊김에서 연 공백(마지막 데이터 수신 시각부터)이 그대로 열려 있고, '회복' 으로 닫힌 공백은 없다
        assert feed.gaps.open_since == feed.last_msg_at
        assert not feed.gaps.pending and feed.gaps.last is None
        assert feed.state != "receiving"
        raws = [q.get_nowait() for _ in range(q.qsize())]
        assert sum(r == _error_frame() for r in raws) >= 3 and len(raws) - sum(r == _error_frame() for r in raws) == 5
    finally:
        stop.set()
        await asyncio.wait_for(task, 5)
        server.close()


async def test_error_only_sessions_from_start_record_no_gap():
    """한 번도 데이터를 받지 못한 채 오류 프레임만 오면 '끊김' 도 '회복' 도 아니다 — 공백을 만들지 않는다."""

    async def script(idx, ws, srv):
        await ws.send(_error_frame())
        await asyncio.sleep(0.05)
        await ws.close(1008, "policy violation")

    server, url = await start(FakeAis(script))
    c, q, feed, _ = make_client(url, idle_timeout_s=5)
    stop = asyncio.Event()
    task = asyncio.create_task(c.run(stop))
    try:
        await wait_until(lambda: feed.sessions_ended >= 3)
        assert feed.last_msg_at is None and feed.msgs_total == 0
        assert feed.gaps.open_since is None and feed.gaps.last is None and not feed.gaps.pending
        assert feed.last_error == "server closed (1008 policy violation)" and feed.state != "receiving"
    finally:
        stop.set()
        await asyncio.wait_for(task, 5)
        server.close()


async def test_error_frames_do_not_extend_the_idle_deadline():
    """오류 프레임만 계속 오고 데이터가 없으면 조용한 연결과 같다 — idle 기한이 지나면 다시 붙는다."""

    async def script(idx, ws, srv):
        for _ in range(40):
            await ws.send(_error_frame("slow down"))
            await asyncio.sleep(0.05)
        await ws.wait_closed()

    server, url = await start(FakeAis(script))
    c, q, feed, _ = make_client(url, idle_timeout_s=0.3)
    stop = asyncio.Event()
    task = asyncio.create_task(c.run(stop))
    try:
        await wait_until(lambda: feed.sessions_ended >= 1, 3)
        assert feed.last_error == "idle 0.3 s — no messages" and feed.msgs_total == 0
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
        ais_main.main(
            stop=stop,
            redis=r,
            settings=s,
            client_kw={"url": url, "backoff_factory": lambda: Backoff(base_s=0.05, cap_s=0.1)},
        )
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
    assert int(h["msgs_total"]) == 80 and h["deflate"] == "1"  # 데이터 80건만 센다(오류 프레임 1건은 제외)
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


async def test_main_cancels_a_stuck_sink_loop_before_final(monkeypatch):
    """발행 루프가 제한 시간 안에 빠져나오지 못하면(Redis 멈춤) 취소하고 끝난 것을 확인한 뒤에야 final() 을 부른다(리뷰 #8)."""
    order: list[str] = []

    async def stuck(self, stop):
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            order.append("sink cancelled")
            raise

    orig_final = AisSink.final

    async def final(self):
        order.append("final")
        await orig_final(self)

    monkeypatch.setattr(AisSink, "run", stuck)
    monkeypatch.setattr(AisSink, "final", final)
    monkeypatch.setattr(ais_main, "SINK_STOP_S", 0.1)
    r = ClosableRedis()
    stop = asyncio.Event()
    s = AisSettings(wakeline_fixture_mode=1)
    task = asyncio.create_task(ais_main.main(stop=stop, redis=r, settings=s, replay_speed=60))
    await asyncio.sleep(0.3)
    stop.set()
    assert await asyncio.wait_for(task, 10) == 0
    assert order == ["sink cancelled", "final"]
    assert r.kv[STATUS_KEY]["state"] == "stopped"


async def test_main_writes_stopped_status_when_the_final_publish_fails(monkeypatch):
    async def boom(self):
        raise RuntimeError("boom")

    monkeypatch.setattr(AisSink, "flush", boom)
    r = ClosableRedis()
    stop = asyncio.Event()
    task = asyncio.create_task(ais_main.main(stop=stop, redis=r, settings=AisSettings(wakeline_fixture_mode=1), replay_speed=60))
    await asyncio.sleep(0.3)
    stop.set()
    assert await asyncio.wait_for(task, 10) == 0
    assert r.kv[STATUS_KEY]["state"] == "stopped"


async def test_main_exits_cleanly_when_final_itself_fails(monkeypatch):
    async def boom(self):
        raise RuntimeError("boom")

    closed: list[bool] = []

    class Tracking(ClosableRedis):
        async def aclose(self) -> None:
            closed.append(True)

    monkeypatch.setattr(AisSink, "final", boom)
    stop = asyncio.Event()
    task = asyncio.create_task(
        ais_main.main(stop=stop, redis=Tracking(), settings=AisSettings(wakeline_fixture_mode=1), replay_speed=60)
    )
    await asyncio.sleep(0.2)
    stop.set()
    assert await asyncio.wait_for(task, 10) == 0 and closed == [True]


async def test_main_returns_1_when_a_task_dies(monkeypatch):
    async def dead(self):
        raise RuntimeError("worker died")

    monkeypatch.setattr(ais_main.Worker, "run", dead)
    r = ClosableRedis()
    rc = await asyncio.wait_for(ais_main.main(stop=asyncio.Event(), redis=r, settings=AisSettings(wakeline_fixture_mode=1)), 10)
    assert rc == 1 and r.kv[STATUS_KEY]["state"] == "stopped"


# ── 구역마다 연결 하나(계약 v4 §D) ─────────────────────────────

AMERICAS, ASIA = "-90,-180,90,0", "-90,45,90,180"
AMERICAS_BOXES = [[[-90.0, -180.0], [90.0, 0.0]]]
ASIA_BOXES = [[[-90.0, 45.0], [90.0, 180.0]]]


def boxes_of(srv: FakeAis, idx: int) -> list:
    return srv.subs[idx][0][1]["BoundingBoxes"]


def conns(srv: FakeAis, boxes: list) -> list[int]:
    """처음 구독이 boxes 인 연결 번호들."""
    return [i for i in range(len(srv.subs)) if srv.subs[i] and srv.subs[i][0][1]["BoundingBoxes"] == boxes]


def make_pool(url: str, spec: str, **kw):
    q = RawQueue(5000)
    shards = ShardSet("aisstream")
    desired = ShardsState(parse_shards(spec))
    pool = AisStreamPool(
        api_key=KEY,
        queue=q,
        shards=shards,
        desired=desired,
        backoff_factory=lambda: Backoff(base_s=0.05, cap_s=0.2, rng=random.Random(5)),
        url=url,
        user_agent="wakeline-test/1",
        **kw,
    )
    return pool, q, shards, desired


async def test_pool_one_connection_per_shard_with_its_own_gap_and_backoff():
    async def script(idx, ws, srv):
        asia = boxes_of(srv, idx) == ASIA_BOXES
        for f in frames(5 if asia else 8):
            await ws.send(f)
        if asia and len(conns(srv, ASIA_BOXES)) == 1:  # 아시아 구역의 첫 연결만 끊는다
            await asyncio.sleep(0.05)
            await ws.close(1011, "try again later")
            return
        await ws.wait_closed()

    fake = FakeAis(script)
    server, url = await start(fake)
    pool, q, shards, _ = make_pool(url, f"{AMERICAS}|{ASIA}", idle_timeout_s=5)
    stop = asyncio.Event()
    task = asyncio.create_task(pool.run(stop))
    try:
        await wait_until(lambda: len(shards.active) == 2 and shards.active[1].feed.gaps.last is not None)
        am, asia = shards.active
        # 구역마다 연결 하나, 구독은 그 구역의 상자만
        assert len(conns(fake, AMERICAS_BOXES)) == 1 and len(conns(fake, ASIA_BOXES)) == 2
        assert all(fake.subs[i][0][1]["APIKey"] == KEY for i in range(len(fake.subs)))
        # 공백·백오프는 끊긴 구역에만
        gap = asia.feed.gaps.last
        assert gap["scope"] == ASIA and gap["reason"] == "server closed (1011 try again later)"
        assert am.feed.gaps.last is None and am.feed.gaps.open_since is None and am.feed.sessions_ended == 0
        assert asia.feed.sessions_ended == 1 and am.feed.state == "receiving" and asia.feed.state == "receiving"
        # 대기열의 원문에는 받은 구역 번호가 붙는다
        tags = [q.get_tagged_nowait()[0] for _ in range(q.qsize())]
        assert tags.count(am.id) == 8 and tags.count(asia.id) == 10
    finally:
        stop.set()
        await asyncio.wait_for(task, 5)
        server.close()


async def test_pool_follows_runtime_shard_changes():
    async def script(idx, ws, srv):
        await ws.send(frames(1)[0])
        await ws.wait_closed()

    fake = FakeAis(script)
    server, url = await start(fake)
    pool, _q, shards, desired = make_pool(url, AMERICAS, resubscribe_min_s=0.05)
    stop = asyncio.Event()
    task = asyncio.create_task(pool.run(stop))
    try:
        await wait_until(lambda: len(shards.active) == 1 and shards.active[0].feed.state == "receiving")
        first = shards.active[0]
        # 구역 추가 → 새 연결
        desired.set(parse_shards(f"{AMERICAS}|{ASIA}"))
        await wait_until(lambda: len(shards.active) == 2 and shards.active[1].feed.state == "receiving")
        assert len(fake.subs) == 2 and boxes_of(fake, 1) == ASIA_BOXES
        second = shards.active[1]
        # 같은 순번 구역의 상자만 바뀜 → 그 연결에서 재구독(새 연결 없음)
        desired.set(parse_shards(f"-90,-180,90,-30|{ASIA}"))
        await wait_until(lambda: len(fake.subs[0]) == 2)
        assert fake.subs[0][1][1]["BoundingBoxes"] == [[[-90.0, -180.0], [90.0, -30.0]]]
        assert len(fake.subs) == 2 and len(fake.subs[1]) == 1 and shards.active[0] is first
        assert first.feed.subscribe_updates == 1 and first.feed.scope == "-90,-180,90,-30"
        # 구역 제거 → 그 연결만 닫고, 끊김이 아니므로 공백을 만들지 않는다
        desired.set(parse_shards("-90,-180,90,-30"))
        await wait_until(lambda: not shards.closing and len(shards.active) == 1)
        assert shards.active == [first] and second.task.done() and first.feed.connected
        assert second.feed.gaps.open_since is None and not shards.retired_pending and shards.retired_msgs_total == 1
        assert first.feed.gaps.open_since is None and first.feed.sessions_ended == 0
        # 다시 추가하면 새 연결(새 구역 번호)
        desired.set(parse_shards(f"-90,-180,90,-30|{ASIA}"))
        await wait_until(lambda: len(shards.active) == 2 and shards.active[1].feed.state == "receiving")
        assert len(fake.subs) == 3 and shards.active[1].id not in (first.id, second.id)
        assert shards.active[1].label == "shard 2"
    finally:
        stop.set()
        await asyncio.wait_for(task, 5)
        server.close()


async def test_pool_closes_all_shards_promptly_on_stop():
    async def script(idx, ws, srv):
        await ws.send(frames(1)[0])
        await ws.wait_closed()

    server, url = await start(FakeAis(script))
    pool, _q, shards, _ = make_pool(url, "1,1,2,2|3,3,4,4|5,5,6,6")
    stop = asyncio.Event()
    task = asyncio.create_task(pool.run(stop))
    await wait_until(lambda: len(shards.active) == 3 and all(f.state == "receiving" for f in shards.feeds()))
    t0 = time.monotonic()
    stop.set()
    await asyncio.wait_for(task, 5)
    assert time.monotonic() - t0 < 2.0 and all(s.task.done() for s in shards.active)
    assert all(s.feed.gaps.open_since is None for s in shards.active)  # 종료 공백은 진입점(on_stopped)이 연다
    server.close()


async def test_pool_task_ends_when_a_connection_task_dies(monkeypatch):
    calls: list[int] = []

    async def dying(self, stop):
        calls.append(self.tag)
        if self.tag == 1:
            raise RuntimeError("boom")
        await stop.wait()

    monkeypatch.setattr(AisStreamClient, "run", dying)
    pool, _q, shards, _ = make_pool("ws://127.0.0.1:9", f"{AMERICAS}|{ASIA}")
    with pytest.raises(RuntimeError, match="shard 2 connection task ended unexpectedly"):
        await asyncio.wait_for(pool.run(asyncio.Event()), 5)
    assert sorted(calls) == [0, 1] and all(s.stop.is_set() for s in shards.active)  # 나머지 연결도 닫았다


async def test_pool_survives_a_removed_shard_failing_while_it_closes(monkeypatch, caplog):
    async def run(self, stop):
        await stop.wait()
        if self.tag == 1:
            raise RuntimeError("close failed")

    monkeypatch.setattr(AisStreamClient, "run", run)
    pool, _q, shards, desired = make_pool("ws://127.0.0.1:9", f"{AMERICAS}|{ASIA}")
    stop = asyncio.Event()
    task = asyncio.create_task(pool.run(stop))
    await wait_until(lambda: len(shards.active) == 2)
    desired.set(parse_shards(AMERICAS))
    await wait_until(lambda: len(shards.active) == 1 and not shards.closing)
    assert not task.done() and "shard 2 ended with RuntimeError('close failed') while closing" in caplog.text
    stop.set()
    await asyncio.wait_for(task, 5)


async def test_pool_never_exceeds_three_connections_while_removed_shards_close(monkeypatch):
    """키당 연결은 3개(ADR-014) — 줄인 직후 다시 늘려도 닫는 중인 연결이 끝난 뒤에 새 연결을 연다."""
    peak = [0]
    open_now = [0]

    async def slow_close(self, stop):
        open_now[0] += 1
        peak[0] = max(peak[0], open_now[0])
        try:
            await stop.wait()
            await asyncio.sleep(0.3)  # close_timeout 동안 연결이 남아 있다
        finally:
            open_now[0] -= 1

    monkeypatch.setattr(AisStreamClient, "run", slow_close)
    pool, _q, shards, desired = make_pool("ws://127.0.0.1:9", "1,1,2,2|3,3,4,4|5,5,6,6")
    stop = asyncio.Event()
    task = asyncio.create_task(pool.run(stop))
    try:
        await wait_until(lambda: open_now[0] == 3)
        desired.set(parse_shards("1,1,2,2"))
        await wait_until(lambda: len(shards.closing) == 2)
        desired.set(parse_shards("1,1,2,2|7,7,8,8|9,9,10,10"))
        await asyncio.sleep(0.1)
        assert len(shards.active) == 1 and len(shards.closing) == 2  # 아직 열지 않았다
        await wait_until(lambda: len(shards.active) == 3 and open_now[0] == 3)
        assert [s.feed.scope for s in shards.active] == ["1,1,2,2", "7,7,8,8", "9,9,10,10"] and not shards.closing
        assert peak[0] == 3
    finally:
        stop.set()
        await asyncio.wait_for(task, 5)


def test_pool_validates_url_and_key_before_starting():
    with pytest.raises(ValueError):
        make_pool("ws://example.com/v0/stream", AMERICAS)
    with pytest.raises(ValueError):
        AisStreamPool(api_key="", queue=RawQueue(10), shards=ShardSet("aisstream"), desired=ShardsState(parse_shards(AMERICAS)))


async def test_main_two_shards_publish_scoped_gaps_and_status():
    async def script(idx, ws, srv):
        asia = boxes_of(srv, idx) == ASIA_BOXES
        for f in frames(10):
            await ws.send(f)
        if asia and len(conns(srv, ASIA_BOXES)) == 1:
            await asyncio.sleep(0.1)
            await ws.close(1001, "going away")
            return
        await ws.wait_closed()

    fake = FakeAis(script)
    server, url = await start(fake)
    r = ClosableRedis()
    await r.hset("wakeline:settings", "ais_bboxes", f"{AMERICAS}|{ASIA}")
    s = AisSettings(aisstream_api_key=KEY, ais_flush_s=1.0)
    kw = {"url": url, "backoff_factory": lambda: Backoff(base_s=0.05, cap_s=0.1)}

    def gaps() -> list[dict]:
        return [decode(f) for _, f in r.streams.get(STREAM_SHIPS, []) if f["kind"] == "ais_gap"]

    stop = asyncio.Event()
    task = asyncio.create_task(ais_main.main(stop=stop, redis=r, settings=s, client_kw=kw))
    try:
        await wait_until(lambda: len(gaps()) == 1, 6)
        await wait_until(lambda: len(json.loads(r.kv.get(STATUS_KEY, {}).get("shards", "[]"))) == 2, 3)
    finally:
        stop.set()
        assert await asyncio.wait_for(task, 10) == 0
    gap_v = validator("stream_envelope.v1.json", "/$defs/ais_gap_payload")
    (g,) = gaps()
    assert not list(gap_v.iter_errors(g)) and g["scope"] == ASIA and g["reason"] == "server closed (1001 going away)"
    h = r.kv[STATUS_KEY]
    view = json.loads(h["shards"])
    assert [v["scope"] for v in view] == [AMERICAS, ASIA] and all(v["state"] == "stopped" for v in view)
    assert [v["sessions_ended"] for v in view] == [0, 1] and all(v["gap_reason"] == "ais process stopped" for v in view)
    assert h["bbox"] == f"{AMERICAS}|{ASIA}" and h["state"] == "stopped" and int(h["msgs_total"]) == 30
    assert KEY not in json.dumps(r.kv) + json.dumps(r.streams)
    # 다시 띄우면 구역마다 자기 종료 공백을 이어받아 첫 메시지에서 닫는다(scope 그대로)
    stop2 = asyncio.Event()
    task2 = asyncio.create_task(ais_main.main(stop=stop2, redis=r, settings=s, client_kw=kw))
    try:
        await wait_until(lambda: len(gaps()) >= 3, 6)
    finally:
        stop2.set()
        assert await asyncio.wait_for(task2, 10) == 0
        server.close()
    restart = [g for g in gaps() if g["reason"] == "ais process stopped"]
    assert sorted(g["scope"] for g in restart) == sorted([AMERICAS, ASIA])
    assert all(not list(gap_v.iter_errors(g)) for g in gaps())


async def test_main_fixture_mode_is_one_unscoped_shard():
    r = ClosableRedis()
    stop = asyncio.Event()
    task = asyncio.create_task(ais_main.main(stop=stop, redis=r, settings=AisSettings(wakeline_fixture_mode=1), replay_speed=60))
    await wait_until(lambda: r.kv.get(STATUS_KEY, {}).get("state") == "replaying")
    stop.set()
    assert await asyncio.wait_for(task, 10) == 0
    (only,) = json.loads(r.kv[STATUS_KEY]["shards"])
    assert only["scope"] is None and only["state"] == "stopped" and r.kv[STATUS_KEY]["bbox"] == "fixture:ais_east_asia_90s.jsonl"


async def test_main_without_key_publishes_one_unscoped_disabled_entry():
    """계약 v4 G D-2: 키가 없으면 아무 영역도 구독하지 않는다 — 구역 없는(scope null) 항목 하나, 설정의 상자는 상태에 싣지 않는다."""
    r = ClosableRedis()
    await r.hset("wakeline:settings", "ais_bboxes", f"{AMERICAS}|{ASIA}")
    stop = asyncio.Event()
    s = AisSettings(aisstream_api_key="", ais_bboxes="18,105,46,150|-90,45,90,180")
    task = asyncio.create_task(ais_main.main(stop=stop, redis=r, settings=s))
    await wait_until(lambda: r.kv.get(STATUS_KEY, {}).get("state") == "disabled")
    h = r.kv[STATUS_KEY]
    (only,) = json.loads(h["shards"])
    assert only["scope"] is None and only["state"] == "disabled" and only["connected"] is False
    assert h["bbox"] == "" and evaluate(h)[0]
    blob = json.dumps(h)
    assert all(box not in blob for box in (AMERICAS, ASIA, "18,105,46,150"))  # 구독하지 않은 영역이 상태로 새지 않는다
    stop.set()
    assert await asyncio.wait_for(task, 5) == 0


class StatusLog(ClosableRedis):
    """상태 해시에 쓴 값을 차례로 남긴다(첫 쓰기를 보려고)."""

    def __init__(self) -> None:
        super().__init__()
        self.status_writes: list[dict[str, str]] = []

    async def hset(self, key, field=None, value=None, mapping=None):
        if key == STATUS_KEY and mapping:
            self.status_writes.append(dict(mapping))
        return await super().hset(key, field, value, mapping)


@pytest.mark.parametrize(("runtime", "scope"), [(None, AMERICAS), (ASIA, None)])
async def test_main_first_status_write_after_restart_keeps_the_carried_gap(runtime, scope):
    """리뷰 v4 · G D-3: 구역은 발행 태스크보다 먼저 만들어 첫 상태 쓰기부터 이어받은 공백이 있다(지우면 재시작 공백을 잃는다).
    내려가 있던 사이 설정이 바뀌었으면(같은 구역 없음) 구역 없는 공백으로 잇는다."""
    from wakeline_collector.ais.parse import iso_ms

    async def script(idx, ws, srv):
        await ws.wait_closed()  # 구독만 받고 아무것도 보내지 않는다 — 공백은 열린 채

    server, url = await start(FakeAis(script))
    r = StatusLog()
    since = iso_ms(time.time() - 120)
    prev_entry = {"scope": AMERICAS, "state": "stopped", "connected": False, "last_msg_at": since, "msgs_per_s": None}
    prev_entry |= {"lag_p50_s": None, "gap_open_since": since, "gap_reason": "ais process stopped", "sessions_ended": 0}
    await r.hset(
        STATUS_KEY,
        mapping={
            "provider": "aisstream",
            "state": "stopped",
            "bbox": AMERICAS,
            "gap_open_since": since,
            "gap_reason": "ais process stopped",
            "last_msg_at": since,
            "shards": json.dumps([prev_entry]),
        },
    )
    if runtime:
        await r.hset("wakeline:settings", "ais_bboxes", runtime)
    r.status_writes.clear()
    stop = asyncio.Event()
    s = AisSettings(aisstream_api_key=KEY, ais_bboxes=AMERICAS)
    task = asyncio.create_task(ais_main.main(stop=stop, redis=r, settings=s, client_kw={"url": url}))
    try:
        await wait_until(lambda: len(r.status_writes) >= 1)
    finally:
        stop.set()
        assert await asyncio.wait_for(task, 10) == 0
        server.close()
    first = r.status_writes[0]
    assert first["gap_open_since"] == since and first["gap_reason"] == "ais process stopped"
    (entry,) = json.loads(first["shards"])
    assert entry["scope"] == scope and entry["gap_open_since"] == since
    assert all(w["gap_open_since"] == since for w in r.status_writes)  # 받은 것이 없으니 끝까지 열려 있다


async def test_pool_records_the_open_gap_of_a_shard_removed_during_backoff():
    """리뷰 v4 · G D-3: 백오프 중(공백 열림)인 구역을 설정에서 빼면 그 공백을 없앤 시각에 닫아 기록한다 — 조용히 버리지 않는다."""
    from wakeline_collector.ais.parse import iso_ms

    async def script(idx, ws, srv):
        asia = boxes_of(srv, idx) == ASIA_BOXES
        for f in frames(3):
            await ws.send(f)
        if asia:
            await asyncio.sleep(0.05)
            await ws.close(1011, "try again later")
            return
        await ws.wait_closed()

    server, url = await start(FakeAis(script))
    pool, _q, shards, desired = make_pool(url, f"{AMERICAS}|{ASIA}")
    pool._backoff_factory = lambda: Backoff(base_s=30.0, cap_s=30.0, rng=random.Random(1))  # 오래 쉬는 동안 뺀다
    stop = asyncio.Event()
    task = asyncio.create_task(pool.run(stop))
    try:
        await wait_until(lambda: len(shards.active) == 2 and shards.active[1].feed.state == "backoff")
        asia = shards.active[1]
        since = asia.feed.gaps.open_since
        assert since is not None
        t_remove = time.time()
        desired.set(parse_shards(AMERICAS))
        await wait_until(lambda: len(shards.active) == 1 and not shards.closing)
    finally:
        stop.set()
        await asyncio.wait_for(task, 5)
        server.close()
    (ev,) = list(shards.retired_pending)
    assert ev["scope"] == ASIA and ev["reason"] == "server closed (1011 try again later) · 구역 제거"
    assert ev["started_at"] == iso_ms(since) and t_remove - 0.01 <= parse_iso(ev["ended_at"]) <= time.time()
    assert shards.last_gap() == ev and shards.active[0].feed.gaps.open_since is None
