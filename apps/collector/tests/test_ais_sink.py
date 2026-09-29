"""발행 태스크: 바뀐 선박 XADD(스키마 검증), 나누기, Redis 장애 시 합치기(쌓지 않음), 공백 이벤트, 상태 해시."""

from __future__ import annotations

import asyncio
import json
import time

import pytest
from fakes import FakeRedis
from test_ais_helpers import decode, dumps, fixture_docs, validator

from wakeline_collector.ais import sink as sink_mod
from wakeline_collector.ais.book import ShipBook
from wakeline_collector.ais.feed import FeedState, GapTracker
from wakeline_collector.ais.parse import go_time, iso_ms, parse_message
from wakeline_collector.ais.queue import RawQueue
from wakeline_collector.ais.shards import SHARD_FIELDS, ShardSet
from wakeline_collector.ais.sink import STATUS_KEY, AisSink
from wakeline_collector.ais.worker import Worker
from wakeline_collector.publisher import STREAM_SHIPS

ENV = validator("stream_envelope.v1.json")
SHIPS = validator("stream_envelope.v1.json", "/$defs/ships_payload")
GAP = validator("stream_envelope.v1.json", "/$defs/ais_gap_payload")


def _setup(provider="aisstream", r=None, scope=None, **kw):
    """구역 하나(scope=None 이면 구역 없는 수신원 — v4 이전과 같은 공백 모양)."""
    r = r if r is not None else FakeRedis()
    q = RawQueue(1000)
    book = ShipBook(provider)
    shards = ShardSet(provider)
    feed = shards.add(scope).feed
    w = Worker(q, book)
    sink = AisSink(r, book=book, shards=shards, worker=w, queue=q, provider=provider, raw_ref="-", **kw)  # type: ignore[arg-type]
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

    async def xadd(self, stream, fields, **kw):
        if self.stall_next:
            self.stall_next = False
            self.stalled.set()
            await self.gate.wait()
        return await super().xadd(stream, fields, **kw)


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


# ── 구역(계약 v4 §D) ────────────────────────────────────────

A, B = "-90,-180,90,0", "-90,45,90,180"


def _multi(r=None, scopes=(A, B)):
    r = r if r is not None else FakeRedis()
    q = RawQueue(1000)
    book = ShipBook("aisstream")
    shards = ShardSet("aisstream")
    for sc in scopes:
        shards.add(sc)
    w = Worker(q, book)
    sink = AisSink(r, book=book, shards=shards, worker=w, queue=q, provider="aisstream", raw_ref="-")  # type: ignore[arg-type]
    return r, q, shards, w, sink


def _cycle(feed: FeedState, scope: str, t: float, reason: str) -> None:
    """받던 연결이 끊겼다가 다시 붙어 첫 메시지를 받는다 → 닫힌 공백 하나."""
    feed.on_subscribed(scope, deflate=True)
    feed.on_message(t)
    feed.on_disconnected(reason)
    feed.on_subscribed(scope, deflate=True)
    feed.on_message(t + 7)


async def test_gap_events_carry_their_shard_scope():
    r, _q, shards, _w, sink = _multi()
    a, b = shards.active
    t = time.time()
    _cycle(a.feed, A, t, "server closed (1006)")
    _cycle(b.feed, B, t, "client closed (1011 keepalive ping timeout)")  # 같은 시각의 다른 구역 공백
    assert await sink.publish_gaps() == 2 and shards.gaps_pending == 0
    gaps = [_assert_valid(f) for _, f in r.streams[STREAM_SHIPS]]
    assert [(g["scope"], g["reason"]) for g in gaps] == [
        (A, "server closed (1006)"),
        (B, "client closed (1011 keepalive ping timeout)"),
    ]
    assert gaps[0]["started_at"] == gaps[1]["started_at"] == iso_ms(t)  # api 는 (source, scope, started_at) 로 가른다


async def test_unscoped_gap_event_has_no_scope_key():
    r, _q, _book, feed, _w, sink = _setup(provider="fixture")
    feed.on_subscribed("fixture:ais_east_asia_90s.jsonl", deflate=None, state="replaying")
    feed.on_message(time.time())
    feed.on_disconnected("ais process restart")
    feed.on_message(time.time() + 1)
    assert await sink.publish_gaps() == 1
    assert "scope" not in _assert_valid(r.streams[STREAM_SHIPS][0][1])


async def test_gap_publish_across_shards_stops_on_redis_error_and_resumes_in_order():
    r, _q, shards, _w, sink = _multi()
    a, b = shards.active
    t = time.time()
    _cycle(a.feed, A, t, "r-a1")
    _cycle(a.feed, A, t + 20, "r-a2")
    _cycle(b.feed, B, t + 5, "r-b1")
    r.down = True
    assert await sink.publish_gaps() == 0 and shards.gaps_pending == 3 and sink.publish_errors == 1
    r.down = False
    assert await sink.publish_gaps() == 3
    assert [decode(f)["reason"] for _, f in r.streams[STREAM_SHIPS]] == ["r-a1", "r-a2", "r-b1"]


async def test_gaps_of_a_removed_shard_are_still_published():
    r, _q, shards, _w, sink = _multi()
    _a, b = shards.active
    _cycle(b.feed, B, time.time(), "server closed (1006)")
    r.down = True
    await sink.publish_gaps()
    shards.begin_closing(b)
    shards.retire(b)
    r.down = False
    assert await sink.publish_gaps() == 1
    g = _assert_valid(r.streams[STREAM_SHIPS][0][1])
    assert g["scope"] == B and not shards.retired_pending


async def test_status_hash_aggregates_shards_and_lists_them():
    r, q, shards, w, sink = _multi()
    a, b = shards.active
    now = time.time()
    a.feed.on_subscribed(A, deflate=True)
    b.feed.on_subscribed(B, deflate=True)
    docs = fixture_docs()
    for i, d in enumerate(docs[:200]):
        d.pop("_recv_offset_s")
        shard = a if i % 4 else b  # a 150건 · b 50건
        lag = 2.0 if shard is a else 9.0
        d["MetaData"]["time_utc"] = go_time(now - lag)
        q.put(dumps(d), shard.id)
        shard.feed.on_message(now)
    w.drain_nowait(1000)
    b.feed.on_disconnected("server closed (1006)")
    await sink.flush()
    stats = decode(r.streams[STREAM_SHIPS][0][1])["stats"]
    assert stats["msgs"] == 200 and stats["connected"] is False and stats["bbox"] == f"{A}|{B}"
    await sink.write_status()
    h = r.kv[STATUS_KEY]
    view = json.loads(h["shards"])
    assert [tuple(v) for v in view] == [SHARD_FIELDS, SHARD_FIELDS] and [v["scope"] for v in view] == [A, B]
    va, vb = view
    assert va["connected"] is True and vb["connected"] is False and h["connected"] == "0"  # 모든 구역 연결일 때만 1
    assert va["msgs_per_s"] > 0 and vb["msgs_per_s"] > 0
    assert float(h["msgs_per_s"]) == pytest.approx(va["msgs_per_s"] + vb["msgs_per_s"], abs=0.02)  # 합
    assert va["lag_p50_s"] == pytest.approx(2.0, abs=0.2) and vb["lag_p50_s"] == pytest.approx(9.0, abs=0.2)
    assert float(h["lag_p50_s"]) == pytest.approx(9.0, abs=0.2)  # 최댓값
    assert (
        h["gap_open_since"] == vb["gap_open_since"] == iso_ms(now)
        and h["gap_reason"] == vb["gap_reason"] == "server closed (1006)"
    )
    assert va["gap_open_since"] is None and h["last_msg_at"] == iso_ms(now) and h["msgs_total"] == "200"
    assert h["bbox"] == f"{A}|{B}" and h["sessions_ended"] == "1" and h["state"] == "receiving"
    b.feed.on_backoff(3.0)
    await sink.write_status()
    assert r.kv[STATUS_KEY]["state"] == "backoff" and json.loads(r.kv[STATUS_KEY]["shards"])[1]["state"] == "backoff"


async def test_single_shard_status_keeps_the_pre_v4_fields():
    r, _q, _book, feed, _w, sink = _setup(scope="18,105,46,150")
    feed.on_subscribed("18,105,46,150", deflate=True)
    _load_fixture(_w, feed)
    await sink.flush()
    await sink.write_status()
    h = r.kv[STATUS_KEY]
    assert h["bbox"] == "18,105,46,150" and h["connected"] == "1" and h["state"] == "receiving" and h["msgs_total"] == "484"
    (only,) = json.loads(h["shards"])
    assert only["scope"] == "18,105,46,150" and only["sessions_ended"] == 0
    assert float(h["msgs_per_s"]) == pytest.approx(only["msgs_per_s"], abs=0.01)
    # R-18: 선박 쪽 손실 신호는 wakeline:ais:status 에 남는다(대기열 버림·격리·발행 실패·예산 트리밍)
    for k in ("dropped_total", "quarantined_total", "invalid_total", "publish_errors", "gaps_pending", "stream_budget_trims"):
        assert h[k].isdigit(), k


# ---- R-14: 선박 스트림도 개수(200 ≈ 33분)가 아니라 시간으로 자른다 ------------------------------------------------------
async def test_r14_ships_stream_keeps_a_two_hour_api_outage_then_trims_by_time():
    from wakeline_collector.publisher import STREAM_RETENTION_S

    clk = [1_790_000_000.0]
    r, _q, book, feed, w, sink = _setup(r=FakeRedis(clock=lambda: clk[0]), wall=lambda: clk[0])
    feed.on_subscribed("18,105,46,150", deflate=True)
    _load_fixture(w, feed)
    assert await sink.flush() == 1
    some = next(iter(book._ships))
    for _ in range(2 * 360):  # 10 s 마다 바뀐 선박 1척 — 2 h
        clk[0] += 10.0
        book.mark_dirty([some], [])
        assert await sink.flush() == 1
    assert len(r.streams[STREAM_SHIPS]) == 1 + 2 * 360  # api 가 2 h 멈춰도 하나도 지우지 않았다
    for _ in range(2 * 360):  # 2 h 더 → 보존 창보다 오래된 것은 지운다
        clk[0] += 10.0
        book.mark_dirty([some], [])
        await sink.flush()
    oldest_ms = min(int(sid.split("-")[0]) for sid, _ in r.streams[STREAM_SHIPS])
    assert (clk[0] * 1000 - oldest_ms) / 1000 <= STREAM_RETENTION_S + 10


# ---- 운영 관찰(2026-09-29): 선박 스트림 597항목 · MEMORY USAGE 16,825,126 B · 첫 항목 약 99분 — 예산 16 MiB 가 2.5 h 창을
# 약 1.66 h 로 줄였다(ais stream_budget_trims 233). 실측 평균 항목 크기로 2.5 h(900항목)를 예산 트림 없이 담아야 한다.
MEASURED_SHIP_ENTRY_B = 16_825_126 // 597  # 측정값(MEMORY USAGE ÷ XLEN, 약 28.2 KB) — 필드 길이 합은 이보다 조금 작다(안전 쪽)


async def test_ships_budget_keeps_the_full_retention_window_at_the_measured_entry_size():
    from wakeline_collector.publisher import STREAM_BUDGET_BYTES, STREAM_RETENTION_S

    clk = [1_790_000_000.0]
    r, _q, _book, _feed, _w, sink = _setup(r=FakeRedis(clock=lambda: clk[0]), wall=lambda: clk[0])
    env = {"payload": "x" * (MEASURED_SHIP_ENTRY_B - len("payload"))}
    for _ in range(int(STREAM_RETENTION_S // 10) + 60):  # 10 s 마다 한 항목, 보존 창보다 10분 더
        await sink._xadd(env)
        clk[0] += 10.0
    assert sink._trim.budget_trims == 0  # 예산이 창을 줄이지 않았다
    oldest_ms = min(int(sid.split("-")[0]) for sid, _ in r.streams[STREAM_SHIPS])
    window_s = (clk[0] * 1000 - oldest_ms) / 1000
    assert STREAM_RETENTION_S - 20 <= window_s <= STREAM_RETENTION_S + 10  # 창이 시간(2.5 h)으로만 잘린다
    kept = sum(len(k) + len(v) for _sid, f in r.streams[STREAM_SHIPS] for k, v in f.items())
    assert kept / STREAM_BUDGET_BYTES[STREAM_SHIPS] <= 0.8  # 선택값 32 MiB: 필요량(약 25.4 MB)이 예산의 약 76 %


async def test_status_carries_the_ships_stream_retention_target_and_budget():
    """필드 계약: wakeline:ais:status 에 선박 스트림의 시간 트림 목표(초)와 바이트 예산 — 이 sink 가 실제로 쓰는 값(정수 문자열)."""
    r, _q, _book, _feed, _w, sink = _setup()
    await sink.write_status()
    h = r.kv[STATUS_KEY]
    assert h["stream_retention_s"] == "9000" and h["stream_budget_bytes"] == str(32 * 2**20)
    sink._trim.retention_s, sink._trim.budget_bytes = 7200.0, 1234  # 설정이 바뀌면 그 값을 싣는다(상수를 따로 적지 않는다)
    assert (sink.status_fields()["stream_retention_s"], sink.status_fields()["stream_budget_bytes"]) == ("7200", "1234")


async def test_ships_budget_is_32_mib_and_aircraft_stays_80_mib():
    from wakeline_collector.publisher import STREAM_AIRCRAFT, STREAM_BUDGET_BYTES

    assert STREAM_BUDGET_BYTES == {STREAM_AIRCRAFT: 80 * 2**20, STREAM_SHIPS: 32 * 2**20}


# ---- 계약 v5 §C2: 로그 싱크의 자기 지표(log_sent · log_dropped · log_suppressed)가 상태 해시에 -----------------------------
async def test_v5_status_carries_log_sink_counts_and_unknown_without_a_sink():
    r, _q, _book, _feed, _w, sink = _setup(log_metrics=lambda: {"log_sent": "12", "log_dropped": "3", "log_suppressed": "40"})
    await sink.write_status()
    h = r.kv[STATUS_KEY]
    assert (h["log_sent"], h["log_dropped"], h["log_suppressed"]) == ("12", "3", "40")
    r2, _q, _book, _feed, _w, plain = _setup()
    await plain.write_status()  # 싱크를 끈 경우(LOG_SINK_ENABLED=0): 빈 값 = 모름(0 이 아니다 — 지난 실행의 값도 덮는다)
    assert [r2.kv[STATUS_KEY][k] for k in ("log_sent", "log_dropped", "log_suppressed")] == ["", "", ""]
