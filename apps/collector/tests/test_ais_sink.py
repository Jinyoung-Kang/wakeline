"""발행 태스크: 바뀐 선박 XADD(스키마 검증), 나누기, Redis 장애 시 합치기(쌓지 않음), 공백 이벤트, 상태 해시."""

from __future__ import annotations

import asyncio
import time

import pytest
from fakes import FakeRedis
from test_ais_helpers import decode, dumps, fixture_docs, validator

from wakeline_collector.ais import sink as sink_mod
from wakeline_collector.ais.book import ShipBook
from wakeline_collector.ais.feed import FeedState, GapTracker
from wakeline_collector.ais.parse import go_time, parse_message
from wakeline_collector.ais.queue import RawQueue
from wakeline_collector.ais.sink import STATUS_KEY, AisSink
from wakeline_collector.ais.worker import Worker
from wakeline_collector.publisher import STREAM_SHIPS

ENV = validator("stream_envelope.v1.json")
SHIPS = validator("stream_envelope.v1.json", "/$defs/ships_payload")
GAP = validator("stream_envelope.v1.json", "/$defs/ais_gap_payload")


def _setup(provider="aisstream", r=None, **kw):
    r = r if r is not None else FakeRedis()
    q = RawQueue(1000)
    book = ShipBook(provider)
    feed = FeedState(provider)
    w = Worker(q, book)
    sink = AisSink(r, book=book, feed=feed, worker=w, queue=q, provider=provider, raw_ref="-", **kw)  # type: ignore[arg-type]
    return r, q, book, feed, w, sink


def _load_fixture(w: Worker, feed: FeedState) -> None:
    now = time.time()
    for d in fixture_docs():
        d["MetaData"]["time_utc"] = go_time(now + d.pop("_recv_offset_s") - 90)
        w.handle(dumps(d))
        feed.on_message(now)


def _assert_valid(fields):
    errs = [e.message for e in ENV.iter_errors(fields)]
    payload = decode(fields)
    v = SHIPS if fields["kind"] == "ships" else GAP
    errs += [f"{e.json_path}: {e.message}" for e in v.iter_errors(payload)]
    assert not errs, errs[:5]
    return payload


async def test_flush_publishes_changed_ships_valid_against_schema():
    r, _q, book, feed, w, sink = _setup()
    feed.on_subscribed("18,105,46,150", deflate=True)
    _load_fixture(w, feed)
    assert await sink.flush() == 1
    ((sid, fields),) = r.streams[STREAM_SHIPS]
    assert (
        fields["kind"] == "ships"
        and fields["scope"] == "ships"
        and fields["provider"] == "aisstream"
        and fields["raw_ref"] == "-"
    )
    payload = _assert_valid(fields)
    assert int(fields["count"]) == len(payload["ships"]) > 250 and len(payload["static"]) > 40
    st = payload["stats"]
    assert st["msgs"] == 484 and st["connected"] is True and st["bbox"] == "18,105,46,150" and st["dropped"] == 0
    assert payload["part"] == payload["parts"] == 1
    # 바뀐 것이 없으면 보내지 않는다
    assert await sink.flush() == 0 and len(r.streams[STREAM_SHIPS]) == 1
    assert sink.published_ships == len(payload["ships"])


async def test_flush_splits_large_batches(monkeypatch):
    monkeypatch.setattr(sink_mod, "CHUNK", 100)
    r, _q, _book, feed, w, sink = _setup()
    _load_fixture(w, feed)
    n = await sink.flush()
    entries = r.streams[STREAM_SHIPS]
    assert n == len(entries) >= 3
    payloads = [_assert_valid(f) for _, f in entries]
    assert [p["part"] for p in payloads] == list(range(1, n + 1)) and {p["parts"] for p in payloads} == {n}
    assert all(len(p["ships"]) <= 100 and len(p["static"]) <= 100 for p in payloads)
    mmsis = [s["mmsi"] for p in payloads for s in p["ships"]]
    assert len(mmsis) == len(set(mmsis))


async def test_redis_outage_coalesces_instead_of_queueing():
    r, _q, book, feed, w, sink = _setup()
    _load_fixture(w, feed)
    r.down = True
    assert await sink.flush() == 0 and sink.publish_errors == 1
    dirty = book.dirty
    assert dirty[0] > 250  # 표시가 되돌아왔다(변경분을 따로 쌓지 않는다)
    r.down = False
    assert await sink.flush() == 1
    payload = _assert_valid(r.streams[STREAM_SHIPS][0][1])
    assert len(payload["ships"]) == dirty[0] and book.dirty == (0, 0)


async def test_partial_failure_keeps_unsent_parts(monkeypatch):
    monkeypatch.setattr(sink_mod, "CHUNK", 100)
    r, _q, book, feed, w, sink = _setup()
    _load_fixture(w, feed)
    calls = {"n": 0}
    orig = r.xadd

    async def flaky(stream, fields, **kw):
        calls["n"] += 1
        if calls["n"] == 2:
            raise OSError("reset")
        return await orig(stream, fields, **kw)

    r.xadd = flaky  # type: ignore[method-assign]
    total_ships, total_static = book.dirty
    assert await sink.flush() == 1
    first = decode(r.streams[STREAM_SHIPS][0][1])
    # 보낸 part 1 은 다시 표시하지 않고, 못 보낸 part 2.. 만 다음 발행으로 넘긴다
    assert book.dirty == (total_ships - len(first["ships"]), total_static - len(first["static"]))
    assert await sink.flush() >= 1
    resent = {s["mmsi"] for _, f in r.streams[STREAM_SHIPS][1:] for s in decode(f)["ships"]}
    assert not resent & {s["mmsi"] for s in first["ships"]} and len(resent) == total_ships - len(first["ships"])


async def test_gap_events_published_in_order_and_retried():
    r, _q, _book, feed, _w, sink = _setup()
    t = time.time()
    for i in range(3):
        feed.gaps.open(t + 10 * i, f"server closed (100{i})")
        feed.gaps.close(t + 10 * i + 5)
    r.down = True
    assert await sink.publish_gaps() == 0 and len(feed.gaps.pending) == 3
    r.down = False
    assert await sink.publish_gaps() == 3 and not feed.gaps.pending
    gaps = [_assert_valid(f) for _, f in r.streams[STREAM_SHIPS]]
    assert [g["reason"] for g in gaps] == ["server closed (1000)", "server closed (1001)", "server closed (1002)"]
    assert all(f["kind"] == "ais_gap" and f["scope"] == "ships" and f["count"] == "1" for _, f in r.streams[STREAM_SHIPS])


class StallingRedis(FakeRedis):
    """다음 XADD 하나를 gate 가 열릴 때까지 붙잡는다 — Redis 가 잠깐 멈춘 사이 종료·새 공백이 겹치는 상황(리뷰 #8)."""

    def __init__(self) -> None:
        super().__init__()
        self.gate = asyncio.Event()
        self.stalled = asyncio.Event()
        self.stall_next = True

    async def xadd(self, stream, fields, maxlen=None, approximate=True):
        if self.stall_next:
            self.stall_next = False
            self.stalled.set()
            await self.gate.wait()
        return await super().xadd(stream, fields, maxlen=maxlen, approximate=approximate)


def _close_gaps(feed: FeedState, n: int, t0: float = 0.0) -> list[str]:
    t = t0 or time.time()
    out = []
    for i in range(n):
        feed.gaps.open(t + 10 * i, f"server closed (100{i})")
        out.append(feed.gaps.close(t + 10 * i + 5)["started_at"])
    return out


def _sent_gaps(r: FakeRedis) -> list[str]:
    return [decode(f)["started_at"] for _, f in r.streams.get(STREAM_SHIPS, []) if f["kind"] == "ais_gap"]


@pytest.mark.parametrize("n", [1, 2, 3])
async def test_final_during_a_stalled_loop_publish_never_pops_an_unsent_gap(n):
    """발행 루프가 XADD 에서 멈춘 사이 final() 이 겹쳐도 IndexError·보내지 않은 공백의 제거가 없다(리뷰 #8)."""
    r = StallingRedis()
    _r, _q, _book, feed, _w, sink = _setup(r=r)
    started = _close_gaps(feed, n)
    loop_pub = asyncio.create_task(sink.publish_gaps())
    await asyncio.wait_for(r.stalled.wait(), 1)
    feed.on_stopped()
    fin = asyncio.create_task(sink.final())
    await asyncio.sleep(0.05)
    r.gate.set()
    await asyncio.wait_for(asyncio.gather(loop_pub, fin), 2)
    assert _sent_gaps(r) == started  # 모두 한 번씩, 순서대로
    assert not feed.gaps.pending and r.kv[STATUS_KEY]["state"] == "stopped"


async def test_gap_evicted_while_in_flight_does_not_drop_the_next_one():
    """보내는 중인 공백이 보관 상한 때문에 밀려나도, 다음(아직 안 보낸) 공백을 대신 지우지 않는다."""
    r = StallingRedis()
    _r, _q, _book, feed, _w, sink = _setup(r=r)
    feed.gaps = GapTracker(pending_max=2)
    t = time.time()
    started = _close_gaps(feed, 2, t)
    pub = asyncio.create_task(sink.publish_gaps())
    await asyncio.wait_for(r.stalled.wait(), 1)  # 첫 공백을 보내는 중
    started += _close_gaps(feed, 1, t + 100)  # 새 공백 → 가득 차 첫 공백이 보관에서 밀려난다
    r.gate.set()
    assert await asyncio.wait_for(pub, 2) == 3  # 밀려난 첫 공백(이미 보냄) + 남은 두 공백
    assert _sent_gaps(r) == started and not feed.gaps.pending


async def test_final_writes_stopped_status_even_if_publishing_fails(monkeypatch):
    r, _q, _book, feed, _w, sink = _setup()

    async def boom():
        raise RuntimeError("boom")

    monkeypatch.setattr(sink, "flush", boom)
    feed.on_stopped()
    await sink.final()
    assert r.kv[STATUS_KEY]["state"] == "stopped" and sink.publish_errors == 1


async def test_flush_cancelled_mid_xadd_keeps_ships_for_the_final_flush():
    """종료 때 발행 루프를 취소해도 꺼낸 변경분을 잃지 않는다 — final() 의 flush 가 싣는다."""
    r = StallingRedis()
    _r, _q, book, feed, w, sink = _setup(r=r)
    _load_fixture(w, feed)
    dirty = book.dirty
    t = asyncio.create_task(sink.flush())
    await asyncio.wait_for(r.stalled.wait(), 1)
    t.cancel()
    with pytest.raises(asyncio.CancelledError):
        await t
    assert book.dirty == dirty
    assert await sink.flush() == 1
    assert len(decode(r.streams[STREAM_SHIPS][0][1])["ships"]) == dirty[0]


async def test_timestamp_60_reports_publish_null_position_source():
    """fixture 의 Timestamp 60(값 없음) 보고 10건은 발행 경로(정리 → ShipBook → XADD)를 지나도 null 이다(리뷰 #5)."""
    r, _q, _book, feed, w, sink = _setup()
    now = time.time()
    ts60 = set()
    for d in fixture_docs():
        d["MetaData"]["time_utc"] = go_time(now + d.pop("_recv_offset_s") - 90)
        body = d["Message"][d["MessageType"]]
        if body.get("Timestamp") == 60:
            ts60.add(parse_message(dumps(d)).position.mmsi)
            w.handle(dumps(d))
    assert await sink.flush() == 1
    ships = _assert_valid(r.streams[STREAM_SHIPS][0][1])["ships"]
    assert {s["mmsi"] for s in ships} == ts60 and all(s["position_source"] is None for s in ships)
    # 전체 fixture: "gnss" 는 더 이상 만들지 않는다
    r2, _q2, _book2, feed2, w2, sink2 = _setup()
    _load_fixture(w2, feed2)
    await sink2.flush()
    srcs = {s["position_source"] for s in decode(r2.streams[STREAM_SHIPS][0][1])["ships"]}
    assert "gnss" not in srcs and srcs <= {"epfs", "manual", "estimated", "inoperative", None}


async def test_status_hash_fields():
    r, q, _book, feed, w, sink = _setup(redact=lambda s: s.replace("SECRETKEY", "***"))
    feed.on_subscribed("18,105,46,150", deflate=True)
    _load_fixture(w, feed)
    feed.on_error("server said SECRETKEY is bad")
    feed.last_error = "closed: SECRETKEY"
    await sink.flush()
    assert await sink.write_status() is True
    h = r.kv[STATUS_KEY]
    for k in (
        "connected",
        "connected_since",
        "last_msg_at",
        "msgs_per_s",
        "dropped_total",
        "quarantined_total",
        "gap_open_since",
        "updated_at",
    ):
        assert k in h
    assert h["connected"] == "1" and h["state"] == "receiving" and h["provider"] == "aisstream" and h["fixture"] == "0"
    assert h["gap_open_since"] == "" and h["deflate"] == "1" and h["msgs_total"] == "484"
    assert "SECRETKEY" not in h["last_error"] + h["provider_error"] and "***" in h["provider_error"] and "***" in h["last_error"]
    assert float(h["msgs_per_s"]) > 0 and int(h["ships_tracked"]) > 250 and h["queue_max"] == str(q.maxsize)
    # 끊김 → 공백 열림이 상태에 보인다
    feed.on_disconnected("server closed (1006)")
    await sink.write_status()
    h = r.kv[STATUS_KEY]
    assert h["connected"] == "0" and h["gap_open_since"] != "" and h["gap_reason"] == "server closed (1006)"
    r.down = True
    assert await sink.write_status() is False and sink.status_errors == 1
    assert await sink.read_previous_status() == {}


async def test_run_loop_flushes_on_schedule_and_writes_status_on_change():
    r, _q, _book, feed, w, sink = _setup(flush_s=0.2)
    stop = asyncio.Event()
    task = asyncio.create_task(sink.run(stop))
    await asyncio.sleep(0.05)
    assert r.kv[STATUS_KEY]["state"] == "starting"  # 바로 한 번 쓴다
    feed.on_subscribed("x", deflate=None, state="replaying")
    _load_fixture(w, feed)
    await asyncio.sleep(0.7)
    assert r.kv[STATUS_KEY]["state"] == "replaying"
    assert len(r.streams.get(STREAM_SHIPS, [])) == 1
    feed.on_disconnected("idle 120 s — no messages")  # 공백 열림(마지막 메시지 시각부터)
    feed.on_subscribed("x", deflate=None)
    feed.on_message(time.time() + 0.5)  # 재구독 뒤 첫 메시지 → 공백 닫힘 → 다음 틱(≤ 1 s)에 발행
    await asyncio.sleep(1.2)
    kinds = [f["kind"] for _, f in r.streams[STREAM_SHIPS]]
    assert "ais_gap" in kinds
    stop.set()
    await asyncio.wait_for(task, 2)
    feed.on_stopped()
    await sink.final()
    assert r.kv[STATUS_KEY]["state"] == "stopped" and r.kv[STATUS_KEY]["gap_reason"] == "ais process stopped"


async def test_run_loop_survives_unexpected_errors(monkeypatch):
    r, _q, _book, _feed, _w, sink = _setup(flush_s=0.05)

    async def boom():
        raise RuntimeError("boom")

    monkeypatch.setattr(sink, "flush", boom)
    stop = asyncio.Event()
    task = asyncio.create_task(sink.run(stop))
    await asyncio.sleep(1.3)
    assert not task.done() and sink.publish_errors >= 1
    stop.set()
    await asyncio.wait_for(task, 2)
