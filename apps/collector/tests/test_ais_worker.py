"""정리 태스크: fixture 원문 → ShipBook, 규칙별 집계, 공급자 오류, 예외 격리, 양보."""

from __future__ import annotations

import asyncio
import time

from test_ais_helpers import dumps, fixture_docs, position

from wakeline_collector.ais import worker as worker_mod
from wakeline_collector.ais.book import ShipBook
from wakeline_collector.ais.parse import go_time
from wakeline_collector.ais.queue import RawQueue
from wakeline_collector.ais.worker import Worker


def _now_docs():
    now = time.time()
    out = []
    for d in fixture_docs():
        d["MetaData"]["time_utc"] = go_time(now + d.pop("_recv_offset_s") - 90)
        out.append(dumps(d))
    return out


def test_worker_processes_fixture():
    q = RawQueue(1000)
    book = ShipBook("fixture")
    w = Worker(q, book)
    for raw in _now_docs():
        q.put(raw)
    assert w.drain_nowait(10_000) == 484
    assert w.processed == 484 and w.invalid_total == 0 and w.quarantined_total == 0
    assert w.counts["accepted"] > 300 and w.counts["static_changed"] > 40
    states, statics = book.drain()
    pos_types = {"PositionReport", "StandardClassBPositionReport", "ExtendedClassBPositionReport"}
    docs = fixture_docs()
    assert len(states) == len({d["Message"][d["MessageType"]]["UserID"] for d in docs if d["MessageType"] in pos_types})
    assert len(statics) == len(
        {
            d["Message"][d["MessageType"]]["UserID"]
            for d in docs
            if d["MessageType"] not in pos_types or d["MessageType"] == "ExtendedClassBPositionReport"
        }
    )
    lag = w.take_lag_p50()
    assert lag is not None and 0 <= lag <= 120
    assert w.take_lag_p50() is None  # 표본을 비웠다


def test_worker_counts_rejects_quarantine_and_provider_error():
    errors: list[str] = []
    q = RawQueue(100)
    now = time.time()
    w = Worker(q, ShipBook("aisstream"), wall=lambda: now, on_provider_error=errors.append)
    w.handle(b"{bad")
    w.handle(b'{"error": "Api Key Is Not Valid"}')
    w.handle(dumps(position(time_utc=go_time(now), Latitude=91)))
    w.handle(dumps(position(time_utc=go_time(now + 120))))  # 미래 → 격리
    w.handle(dumps(position(time_utc=go_time(now))))
    w.handle(dumps(position(time_utc=go_time(now + 1), Latitude=39.0)))  # 1 s 에 96 NM → 격리
    assert w.counts["json"] == 1 and w.invalid_total == 1
    assert errors == ["Api Key Is Not Valid"]
    assert w.counts["no_position"] == 1  # '값 없음' 은 오류로 세지 않는다
    assert w.counts["seen_in_future"] == 1 and w.counts["position_jump"] == 1 and w.quarantined_total == 2
    assert w.counts["accepted"] == 1


async def test_worker_run_yields_and_survives_errors(monkeypatch):
    q = RawQueue(5000)
    now = time.time()
    w = Worker(q, ShipBook("aisstream"), batch=100)
    for i in range(1000):
        q.put(dumps(position(mmsi=440000000 + i, time_utc=go_time(now))))
    task = asyncio.create_task(w.run())
    for _ in range(50):
        await asyncio.sleep(0)
        if q.qsize() == 0:
            break
    assert q.qsize() == 0 and w.processed == 1000

    # 예상 밖 예외가 나도 태스크는 살아 있다
    def boom(raw):
        raise RuntimeError("boom")

    monkeypatch.setattr(worker_mod, "parse_message", boom)
    q.put(b"x")
    await asyncio.sleep(0.01)
    assert not task.done() and w.counts["worker_error"] == 1
    task.cancel()
