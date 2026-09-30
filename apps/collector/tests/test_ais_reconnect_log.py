"""끊김 로그 수준(로그 화면의 'ais shard 1 disconnected: client closed (1011 keepalive ping timeout)' 2026-09-30).

- 받던 연결이 끊겨 열린 공백(마지막 데이터 → 다시 받음)이 회복 창(30 s) 안에 닫히면 INFO(누적 수와 함께) — 로그 화면(WARN·ERROR 만)에 매번 오르지 않는다.
  창은 끊긴 순간이 아니라 공백 길이로 잰다: idle 끊김처럼 끊기기 전부터 조용했으면 재연결이 빨라도 WARN.
  **공백은 그대로 기록한다**(AIS 수신 공백 목록·상태 해시 — 로그 수준만 바뀐다).
- WARN: 같은 연결이 30 분 안에 3번째로 끊김(되풀이) · 끊길 때 공백이 이미 창을 넘음 · 데이터 없이 끝난 연결(재연결 실패 · 오류만 받음) ·
  공백이 창을 넘도록 다시 받지 못함(한 번), 그 뒤 늦게 회복하면 그 회복도 WARN(로그 화면에서 이야기가 닫히게).
"""

from __future__ import annotations

import asyncio
import logging
import random
import time
from http import HTTPStatus

from fakes import FakeRedis
from test_ais_server import KEY, FakeAis, frames, start, wait_until

from wakeline_collector.ais.backoff import Backoff
from wakeline_collector.ais.bbox import BboxState, parse_bboxes
from wakeline_collector.ais.book import ShipBook
from wakeline_collector.ais.client import AisStreamClient
from wakeline_collector.ais.feed import FeedState
from wakeline_collector.ais.queue import RawQueue
from wakeline_collector.ais.reconnect import RECOVER_WINDOW_S, REPEAT_WARN_COUNT, REPEAT_WINDOW_S, ReconnectLog
from wakeline_collector.ais.shards import ShardSet
from wakeline_collector.ais.sink import AisSink
from wakeline_collector.ais.worker import Worker


def _client(url: str, **kw) -> tuple[AisStreamClient, FeedState]:
    feed = FeedState("aisstream")
    c = AisStreamClient(
        api_key=KEY,
        queue=RawQueue(5000),
        feed=feed,
        bboxes=BboxState(parse_bboxes("18,105,46,150")),
        backoff=Backoff(base_s=0.05, cap_s=0.1, rng=random.Random(2)),
        url=url,
        label="shard 1",
        idle_timeout_s=5,
        **kw,
    )
    return c, feed


def _records(caplog, level: int) -> list[str]:
    return [r.getMessage() for r in caplog.records if r.name == "ais.client" and r.levelno == level]


async def _run(c: AisStreamClient, until, timeout: float = 5.0) -> None:
    stop = asyncio.Event()
    task = asyncio.create_task(c.run(stop))
    try:
        await wait_until(until, timeout)
    finally:
        stop.set()
        await asyncio.wait_for(task, 5)


def test_chosen_windows_are_the_documented_values():
    assert (RECOVER_WINDOW_S, REPEAT_WINDOW_S, REPEAT_WARN_COUNT) == (30.0, 1800.0, 3)


async def test_quick_reconnect_is_info_with_a_counter_and_the_gap_is_still_recorded(caplog):
    caplog.set_level(logging.INFO)

    async def script(idx, ws, srv):
        for f in frames(10):
            await ws.send(f)
        if idx == 0:
            await asyncio.sleep(0.05)
            await ws.close(1011, "keepalive ping timeout")
        else:
            await asyncio.sleep(10)

    server, url = await start(FakeAis(script))
    c, feed = _client(url)
    try:
        await _run(c, lambda: feed.gaps.last is not None and feed.reconnects_quick == 1)
    finally:
        server.close()
    assert not _records(caplog, logging.WARNING), _records(caplog, logging.WARNING)
    infos = _records(caplog, logging.INFO)
    disc = [m for m in infos if "disconnected" in m]
    rec = [m for m in infos if "recovered" in m]
    assert len(disc) == 1 and "ais shard 1 disconnected: server closed (1011 keepalive ping timeout)" in disc[0]
    assert "1 disconnect(s) in the last 30 min" in disc[0] and "keepalive rtt" in disc[0]  # 진단 맥락도 함께
    assert len(rec) == 1 and "1 quick reconnect(s) since start" in rec[0] and "gap" in rec[0]
    # 공백은 그대로(로그 수준만 바뀐다)
    assert feed.gaps.last["reason"] == "server closed (1011 keepalive ping timeout)"
    assert list(feed.gaps.pending) == [feed.gaps.last]


async def test_a_long_silence_before_a_fast_reconnect_is_not_quick(caplog):
    """조용히 멈춘 서버(데이터 없이 연결만 유지) → idle 끊김 → 곧바로 다시 받음. 끊긴 뒤 회복은 빠르지만 기록되는 공백(마지막 데이터부터)은 회복 창보다
    길다 — '짧은 재연결' 이 아니다. 끊김 줄부터 WARN(로그 화면), 회복도 WARN, reconnects_quick 에 세지 않는다. 공백은 그대로 기록한다."""
    caplog.set_level(logging.INFO)

    async def script(idx, ws, srv):
        for f in frames(5):
            await ws.send(f)
        await asyncio.sleep(10)  # 첫 연결: 5개 뒤 조용히 멈춘다(닫지 않음) · 다음 연결: 5개 받고 유지

    server, url = await start(FakeAis(script))
    c, feed = _client(url, recover_window_s=0.5)
    c.idle_timeout_s = 1.5
    try:
        await _run(c, lambda: feed.gaps.last is not None, timeout=6.0)
    finally:
        server.close()
    warns = _records(caplog, logging.WARNING)
    disc = [m for m in warns if "disconnected" in m]
    assert len(disc) == 1 and "idle 1.5 s — no messages" in disc[0] and "over the 0.5 s quick-recovery window" in disc[0], warns
    rec = [m for m in warns if "recovered" in m]
    assert len(rec) == 1 and "over the 0.5 s quick-recovery window" in rec[0], warns
    assert not [m for m in _records(caplog, logging.INFO) if "recovered" in m or "disconnected" in m]
    assert feed.reconnects_quick == 0
    assert feed.gaps.last["reason"] == "idle 1.5 s — no messages"  # 공백은 그대로


async def test_a_gap_that_outgrows_the_window_warns_even_when_the_reconnect_itself_is_fast(caplog):
    """끊기기 0.9 s 전부터 데이터가 없었고(끊길 때 공백은 아직 창 1.5 s 안 — 끊김 줄은 INFO) 다시 붙은 뒤 0.9 s 만에 받음: 끊긴 뒤 회복까지(약 1 s)는
    창 안이지만 공백(약 1.9 s)은 창보다 길다 → 공백이 창을 넘는 순간 WARN 한 번, 회복도 WARN."""
    caplog.set_level(logging.INFO)

    async def script(idx, ws, srv):
        if idx == 0:
            for f in frames(5):
                await ws.send(f)
            await asyncio.sleep(0.9)
            await ws.close(1011, "keepalive ping timeout")
        else:
            await asyncio.sleep(0.9)
            await ws.send(frames(1)[0])
            await asyncio.sleep(10)

    server, url = await start(FakeAis(script))
    c, feed = _client(url, recover_window_s=1.5)
    try:
        await _run(c, lambda: feed.gaps.last is not None)
    finally:
        server.close()
    infos, warns = _records(caplog, logging.INFO), _records(caplog, logging.WARNING)
    assert len([m for m in infos if "disconnected" in m]) == 1, infos  # 끊긴 순간 공백은 창 안
    late = [m for m in warns if "not receiving" in m]
    assert len(late) == 1 and "ais shard 1 not receiving 1.5 s after the last message" in late[0], warns
    rec = [m for m in warns if "recovered" in m]
    assert len(rec) == 1 and "over the 1.5 s quick-recovery window" in rec[0], warns
    assert feed.reconnects_quick == 0


async def test_the_third_disconnect_within_the_repeat_window_warns(caplog):
    caplog.set_level(logging.INFO)

    async def script(idx, ws, srv):
        for f in frames(3):
            await ws.send(f)
        await asyncio.sleep(0.03)
        await ws.close(1011, "keepalive ping timeout")

    server, url = await start(FakeAis(script))
    c, feed = _client(url)
    try:
        await _run(c, lambda: feed.sessions_ended >= 4)
    finally:
        server.close()
    disc = [(r.levelno, r.getMessage()) for r in caplog.records if r.name == "ais.client" and "disconnected" in r.getMessage()]
    assert [lv for lv, _ in disc[:4]] == [logging.INFO, logging.INFO, logging.WARNING, logging.WARNING]
    assert "disconnected 3 times in the last 30 min (WARN threshold 3)" in disc[2][1] and "4 times" in disc[3][1]
    assert feed.reconnects_quick >= 2  # 되풀이도 회복은 회복이다(공백은 모두 기록)
    assert len(feed.gaps.pending) >= 3


async def test_a_failed_reconnect_warns(caplog):
    caplog.set_level(logging.INFO)
    seen = [0]

    def reject_after_first(connection, request):
        seen[0] += 1
        if seen[0] > 1:
            return connection.respond(HTTPStatus.SERVICE_UNAVAILABLE, "busy\n")
        return None

    async def script(idx, ws, srv):
        for f in frames(5):
            await ws.send(f)
        await asyncio.sleep(0.03)
        await ws.close(1011, "keepalive ping timeout")

    server, url = await start(FakeAis(script), process_request=reject_after_first)
    c, feed = _client(url)
    try:
        await _run(c, lambda: feed.sessions_ended >= 2)
    finally:
        server.close()
    warns = _records(caplog, logging.WARNING)
    assert any("connection ended without data: handshake rejected: HTTP 503" in m for m in warns), warns
    assert feed.reconnects_quick == 0 and feed.gaps.open_since is not None  # 회복하지 못했다 — 공백은 열린 채


async def test_not_recovered_within_the_window_warns_once_and_the_late_recovery_too(caplog):
    caplog.set_level(logging.INFO)
    t_second: list[float] = []

    async def script(idx, ws, srv):
        if idx == 0:
            for f in frames(5):
                await ws.send(f)
            await asyncio.sleep(0.03)
            await ws.close(1011, "keepalive ping timeout")
        else:  # 붙었지만 한동안 데이터가 없다
            t_second.append(time.monotonic())
            await asyncio.sleep(0.6)
            await ws.send(frames(1)[0])
            await asyncio.sleep(10)

    server, url = await start(FakeAis(script))
    c, feed = _client(url, recover_window_s=0.25)
    try:
        await _run(c, lambda: feed.gaps.last is not None)
    finally:
        server.close()
    warns = _records(caplog, logging.WARNING)
    late = [m for m in warns if "not receiving" in m]
    assert len(late) == 1 and "ais shard 1 not receiving 0.25 s after the last message" in late[0], warns
    rec = [m for m in warns if "recovered" in m]
    assert len(rec) == 1 and "over the 0.25 s quick-recovery window" in rec[0]
    assert feed.reconnects_quick == 0
    assert not [m for m in _records(caplog, logging.INFO) if "recovered" in m]


async def test_stop_cancels_the_recovery_watchdog(caplog):
    caplog.set_level(logging.INFO)

    async def script(idx, ws, srv):
        if idx == 0:
            await ws.send(frames(1)[0])
            await asyncio.sleep(0.03)
            await ws.close(1011, "keepalive ping timeout")
        else:
            await asyncio.sleep(10)

    server, url = await start(FakeAis(script))
    c, feed = _client(url, recover_window_s=0.3)
    try:
        await _run(c, lambda: feed.sessions_ended >= 1 and feed.connected)
    finally:
        server.close()
    await asyncio.sleep(0.4)  # 멈춘 뒤에는 '회복하지 못함' 경고가 나오지 않는다
    assert not [m for m in _records(caplog, logging.WARNING) if "not receiving" in m]


def test_recent_disconnects_are_pruned_and_bounded():
    class Clock:
        t = 0.0

        def __call__(self):
            return self.t

    clk = Clock()
    rl = ReconnectLog("ais shard 1", FeedState("aisstream"), mono=clk, repeat_window_s=100.0, repeat_warn_count=3)
    assert rl.note_disconnect() == 1
    clk.t = 50
    assert rl.note_disconnect() == 2
    clk.t = 120  # 첫 끊김(0 s)은 창 밖
    assert rl.note_disconnect() == 2
    for _ in range(1000):
        clk.t += 0.01
        rl.note_disconnect()
    assert len(rl._recent) <= rl._recent.maxlen


def test_status_counts_quick_reconnects_including_removed_shards():
    q = RawQueue(10)
    shards = ShardSet("aisstream")
    a = shards.add("18,105,46,150")
    b = shards.add("-90,-180,90,0")
    sink = AisSink(FakeRedis(), book=ShipBook("aisstream"), shards=shards, worker=Worker(q, ShipBook("aisstream")), queue=q,
                   provider="aisstream", raw_ref="-")  # fmt: skip
    assert sink.status_fields()["reconnects_quick_total"] == "0"
    a.feed.reconnects_quick, b.feed.reconnects_quick = 2, 1
    assert sink.status_fields()["reconnects_quick_total"] == "3"
    shards.begin_closing(b)
    shards.retire(b)
    assert sink.status_fields()["reconnects_quick_total"] == "3"  # 없앤 구역 것도 줄지 않는다
