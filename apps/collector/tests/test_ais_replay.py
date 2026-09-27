"""fixture 재생: 오프셋 순서·시각 이동·상한, 빠른 재생으로 한 바퀴 전부 대기열에 들어가는지."""

from __future__ import annotations

import asyncio
import time

import orjson
import pytest
from test_ais_helpers import FIXTURE

from wakeline_collector.ais.feed import FeedState
from wakeline_collector.ais.parse import parse_message
from wakeline_collector.ais.queue import RawQueue
from wakeline_collector.ais.replay import FixtureReplayer, load_fixture


def test_load_fixture_sorted_without_offsets():
    items = load_fixture(FIXTURE)
    assert len(items) == 484
    offs = [o for o, _ in items]
    assert offs == sorted(offs) and 85 < offs[-1] < 95
    assert all("_recv_offset_s" not in d for _, d in items)


def test_load_fixture_skips_bad_lines_and_bounds_size(tmp_path, monkeypatch):
    p = tmp_path / "f.jsonl"
    p.write_text(
        '{"MetaData": {}, "MessageType": "x", "_recv_offset_s": 2}\nnot json\n[1]\n{"MetaData": {}, "_recv_offset_s": -5}\n'
    )
    assert [o for o, _ in load_fixture(p)] == [0.0, 2.0]  # 음수 오프셋은 0
    from wakeline_collector.ais import replay

    monkeypatch.setattr(replay, "MAX_FILE_BYTES", 10)
    with pytest.raises(ValueError):
        load_fixture(p)


async def test_replay_one_round_fast_shifts_time_to_now():
    q, feed = RawQueue(1000), FeedState("fixture")
    r = FixtureReplayer(FIXTURE, q, feed, speed=2000, loop=False)
    t0 = time.time()
    await asyncio.wait_for(r.run(asyncio.Event()), 5)
    assert q.qsize() == 484 and feed.msgs_total == 484 and feed.state == "replaying"
    assert feed.bbox == "fixture:ais_east_asia_90s.jsonl" and r.rounds == 1
    raws = [q.get_nowait() for _ in range(484)]
    parsed = [parse_message(x) for x in raws]
    assert not [p for p in parsed if p.reject]
    times = [p.position.t for p in parsed if p.position]
    assert min(times) >= t0 - 1 and max(times) <= time.time() + 1  # time_utc 를 지금으로 옮겼다
    # Timestamp 60(값 없음) 보고 10건은 위치 출처 null, 나머지는 epfs(계약 v3 §B)
    srcs = [p.position.position_source for p in parsed if p.position]
    assert srcs.count(None) == 10 and srcs.count("epfs") == len(srcs) - 10
    assert all(b"_recv_offset_s" not in x for x in raws)
    assert orjson.loads(raws[0])["MetaData"]["time_utc"].endswith("+0000 UTC")


async def test_replay_loops_until_stopped():
    q, feed = RawQueue(5000), FeedState("fixture")
    r = FixtureReplayer(FIXTURE, q, feed, speed=5000)
    stop = asyncio.Event()
    task = asyncio.create_task(r.run(stop))
    for _ in range(200):
        await asyncio.sleep(0.01)
        if r.rounds >= 2:
            break
    stop.set()
    await asyncio.wait_for(task, 2)
    assert r.rounds >= 2 and feed.msgs_total >= 968


def test_replay_rejects_bad_speed():
    with pytest.raises(ValueError):
        FixtureReplayer(FIXTURE, RawQueue(10), FeedState("fixture"), speed=0)
