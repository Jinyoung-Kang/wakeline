"""원문 대기열의 버림 정책, 재연결 백오프(지터·60 s 정상 뒤 초기화), 구독 갱신 속도 제한."""

from __future__ import annotations

import asyncio
import random

import pytest

from wakeline_collector.ais.backoff import Backoff, SubscribeLimiter
from wakeline_collector.ais.queue import RawQueue


async def test_queue_drops_oldest_when_full_and_counts():
    q = RawQueue(3)
    assert all(q.put(f"m{i}") for i in range(3))
    assert q.dropped == 0 and q.qsize() == 3
    assert q.put("m3") is False and q.put("m4") is False  # 가득 참 → 가장 오래된 m0, m1 을 버림
    assert q.dropped == 2 and q.qsize() == 3
    assert [await q.get(), q.get_nowait(), q.get_nowait()] == ["m2", "m3", "m4"]  # 순서 유지, 신선한 쪽이 남는다
    with pytest.raises(asyncio.QueueEmpty):
        q.get_nowait()


def test_queue_never_blocks_the_reader_under_flood():
    q = RawQueue(20_000)
    for i in range(50_000):
        q.put(b"x%d" % i)
    assert q.qsize() == 20_000 and q.dropped == 30_000
    assert q.get_nowait() == b"x30000"


def test_queue_byte_cap_drops_oldest():
    q = RawQueue(100, max_bytes=10)
    assert q.put(b"aaaa") and q.put(b"bbbb")
    assert q.put(b"cccc") is False  # 12 B > 10 B → 가장 오래된 aaaa 를 버림
    assert q.bytes == 8 and q.dropped == 1 and q.qsize() == 2
    assert q.put(b"x" * 11) is False and q.dropped == 2 and q.qsize() == 2  # 상한보다 큰 원문 하나는 넣지 않는다
    assert q.get_nowait() == b"bbbb" and q.bytes == 4


async def test_queue_bytes_tracked_through_async_get():
    q = RawQueue(10)
    q.put("héllo")
    assert await q.get() == "héllo" and q.bytes == 0


def test_queue_rejects_bad_size():
    for kw in ({"maxsize": 0}, {"max_bytes": 0}):
        with pytest.raises(ValueError):
            RawQueue(**kw)


def test_backoff_sequence_and_cap():
    b = Backoff(jitter=0.0)
    assert [b.next_delay() for _ in range(9)] == [1, 2, 4, 8, 16, 32, 60, 60, 60]
    for _ in range(100):  # 오래 실패해도 넘치지 않는다
        assert b.next_delay() == 60


def test_backoff_jitter_bounds():
    b = Backoff(rng=random.Random(7))
    for _ in range(200):
        nominal = b.nominal()
        d = b.next_delay()
        assert 0.8 * nominal <= d <= 1.2 * nominal
    b2 = Backoff(rng=random.Random(1))
    delays = {round(b2.next_delay(), 6) for _ in range(20)}
    assert len(delays) > 1  # 실제로 흔들린다


def test_backoff_resets_only_after_60s_healthy():
    b = Backoff(jitter=0.0)
    for _ in range(4):
        b.next_delay()
    assert b.nominal() == 16
    assert b.session_ended(None) is False  # 메시지를 하나도 못 받음(잘못된 키 등) → 계속 늘어난다
    assert b.session_ended(59.9) is False
    assert b.nominal() == 16
    assert b.session_ended(60.0) is True
    assert b.next_delay() == 1


def test_backoff_rejects_bad_params():
    for kw in ({"base_s": 0}, {"base_s": 10, "cap_s": 5}, {"jitter": 1.0}, {"jitter": -0.1}):
        with pytest.raises(ValueError):
            Backoff(**kw)


def test_subscribe_limiter_at_most_once_per_interval():
    now = [100.0]
    lim = SubscribeLimiter(5.0, mono=lambda: now[0])
    assert lim.wait_s() == 0.0  # 첫 구독은 기다리지 않는다
    lim.mark()
    now[0] += 1.0
    assert lim.wait_s() == pytest.approx(4.0)
    now[0] += 4.0
    assert lim.wait_s() == 0.0
    lim.mark()
    now[0] += 0.5
    assert lim.wait_s() == pytest.approx(4.5)
