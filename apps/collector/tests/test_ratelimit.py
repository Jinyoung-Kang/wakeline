"""속도 상한(계약 v2 §A2): 토큰 버킷 · 우선순위 · 대기 상한 · 429 쿨다운 · 대기열 상한."""

from __future__ import annotations

import asyncio
import time

import pytest

from wakeline_collector import ratelimit as rl
from wakeline_collector.ratelimit import (
    PRIORITY_FIXED,
    PRIORITY_FOCUS,
    PRIORITY_HOT,
    PRIORITY_ROUTE,
    RateLimiter,
    Throttled,
    TokenBucket,
    default_limiter,
)


def test_bucket_math_with_fake_clock():
    b = TokenBucket(0.8, 1, now=0.0)
    assert b.wait_s(0.0) == 0
    b.take(0.0)
    assert b.wait_s(0.0) == pytest.approx(1.25)  # 0.8 req/s → 1.25 s 간격
    assert b.wait_s(1.0) == pytest.approx(0.25)
    assert b.wait_s(1.25) == 0
    b2 = TokenBucket(2.0, 2, now=0.0)
    b2.take(0.0)
    b2.take(0.0)
    assert b2.wait_s(0.0) == pytest.approx(0.5)
    assert b2.wait_s(100.0) == 0 and b2.tokens == 2  # burst 이상 쌓이지 않는다
    with pytest.raises(ValueError):
        TokenBucket(0, 1, now=0.0)
    with pytest.raises(ValueError):
        TokenBucket(1, 0.5, now=0.0)


def test_default_limiter_matches_contract():
    lim = default_limiter(2.0, 0.8)
    assert lim.global_rps == 2.0 and lim.host_rps("opendata.adsb.fi") == 0.8 and lim.host_rps("api.adsb.lol") is None
    # 계약 v4 §A: api.adsbdb.com 0.5 req/s · burst 2(수집기 전체 버킷도 함께 통과)
    assert lim.host_rps("api.adsbdb.com") == 0.5 and lim._hosts["api.adsbdb.com"].burst == 2
    assert default_limiter(2.0, 0.8, 0.25).host_rps("api.adsbdb.com") == 0.25


async def test_route_lookup_waits_behind_hot_on_the_shared_global_bucket():
    """계약 v4 §A: 노선 조회는 핫 리전보다 낮은 우선순위로 수집기 전체 버킷을 같이 쓴다."""
    assert PRIORITY_ROUTE > PRIORITY_HOT
    lim = RateLimiter(20, 1, {"api.adsbdb.com": (100.0, 2)})
    await lim.acquire("api.adsbdb.com")  # 전체 버킷 비움(호스트 버킷은 남아 있다)
    order: list[str] = []

    async def call(name: str, host: str, prio: int, delay: float) -> None:
        await asyncio.sleep(delay)
        await lim.acquire(host, priority=prio, wait_s=2)
        order.append(name)

    await asyncio.gather(call("route", "api.adsbdb.com", PRIORITY_ROUTE, 0), call("hot", "opendata.adsb.fi", PRIORITY_HOT, 0.001))
    assert order == ["hot", "route"] and lim.rate_1m("api.adsbdb.com") == pytest.approx(2 / 60)


async def test_host_bucket_spaces_calls():
    lim = RateLimiter(100, 100, {"h": (20.0, 1)})  # 50 ms 간격
    t0 = time.monotonic()
    for _ in range(4):
        await lim.acquire("h", wait_s=1)
    elapsed = time.monotonic() - t0
    assert 0.13 <= elapsed < 1.0  # 첫 호출은 즉시, 이후 3번 × 50 ms(상한은 느린 CI 여유)
    assert lim.rate_1m("h") == pytest.approx(4 / 60) and lim.rate_1m() == pytest.approx(4 / 60)
    assert lim.rate_1m("other") == 0


async def test_global_cap_applies_across_hosts():
    lim = RateLimiter(20, 1, {})  # 전체 20 req/s
    t0 = time.monotonic()
    await lim.acquire("a", wait_s=1)
    await lim.acquire("b", wait_s=1)
    await lim.acquire("c", wait_s=1)
    assert time.monotonic() - t0 >= 0.09


async def test_priority_order_region_before_focus_before_hot():
    lim = RateLimiter(100, 100, {"h": (20.0, 1)})
    await lim.acquire("h")  # 버킷 비움
    order: list[str] = []

    async def call(name: str, prio: int, delay: float) -> None:
        await asyncio.sleep(delay)
        await lim.acquire("h", priority=prio, wait_s=2)
        order.append(name)

    # 도착 순서는 hot → focus → region 이지만, 토큰은 우선순위대로
    await asyncio.gather(
        call("hot", PRIORITY_HOT, 0), call("focus", PRIORITY_FOCUS, 0.001), call("region", PRIORITY_FIXED, 0.002)
    )
    assert order == ["region", "focus", "hot"]


async def test_lower_priority_other_host_is_not_blocked_by_host_bucket():
    lim = RateLimiter(100, 100, {"h": (2.0, 1)})
    await lim.acquire("h")
    waiter = asyncio.create_task(lim.acquire("h", priority=PRIORITY_FIXED, wait_s=2))
    await asyncio.sleep(0)
    t0 = time.monotonic()
    await lim.acquire("other", priority=PRIORITY_HOT, wait_s=1)  # 다른 호스트는 전체 버킷만 본다
    assert time.monotonic() - t0 < 0.3  # 호스트 버킷 대기(0.5 s)보다 확실히 짧다
    await waiter


async def test_wait_limit_raises_throttled_and_frees_queue():
    lim = RateLimiter(100, 100, {"h": (1.0, 1)})
    await lim.acquire("h")
    with pytest.raises(Throttled) as ei:
        await lim.acquire("h", priority=PRIORITY_HOT, wait_s=0.05)
    assert "no slot within" in ei.value.reason and lim.waiting == 0 and lim.throttled == 1


async def test_penalize_blocks_host_for_all_callers_and_escalates():
    lim = RateLimiter(100, 100, {"h": (100.0, 1)})
    assert lim.penalize("h") == 30.0 and lim.penalize("h") == 60.0
    assert lim.penalize("h", retry_after_s=500) == 500.0  # Retry-After 가 더 길면 따른다
    assert lim.penalize("h", retry_after_s=10_000) == rl.PENALTY_MAX_S
    assert lim.cooldown_remaining("h") > 500
    with pytest.raises(Throttled) as ei:  # 대기 상한보다 길게 막혀 있으면 기다리지 않고 바로
        await lim.acquire("h", wait_s=5)
    assert "cooling down" in ei.value.reason
    await lim.acquire("elsewhere", wait_s=1)  # 다른 호스트는 영향 없음


async def test_short_cooldown_is_waited_out():
    lim = RateLimiter(100, 100, {"h": (100.0, 5)})
    lim.penalize("h", retry_after_s=None)
    lim._blocked_until["h"] = time.monotonic() + 0.05  # 대기 상한보다 짧은 쿨다운 → 기다렸다가 보낸다
    t0 = time.monotonic()
    await lim.acquire("h", wait_s=1)
    assert time.monotonic() - t0 >= 0.04


async def test_penalty_steps_reset_after_quiet_period():
    t = [0.0]
    lim = RateLimiter(100, 100, {}, clock=lambda: t[0])
    assert lim.penalize("h") == 30.0 and lim.penalize("h") == 60.0
    t[0] += rl.PENALTY_RESET_S + 1
    assert lim.penalize("h") == 30.0


async def test_waiter_queue_is_bounded(monkeypatch):
    monkeypatch.setattr(rl, "MAX_WAITERS", 2)
    lim = RateLimiter(100, 100, {"h": (1.0, 1)})
    await lim.acquire("h")
    w1 = asyncio.create_task(lim.acquire("h", wait_s=5))
    w2 = asyncio.create_task(lim.acquire("h", wait_s=5))
    await asyncio.sleep(0)
    with pytest.raises(Throttled) as ei:
        await lim.acquire("h", wait_s=5)
    assert "already waiting" in ei.value.reason
    for w in (w1, w2):
        w.cancel()
    await asyncio.gather(w1, w2, return_exceptions=True)
    assert lim.waiting == 0  # 취소된 대기자는 대기열에서 빠진다


async def test_cancelled_high_priority_waiter_unblocks_lower_priority():
    lim = RateLimiter(100, 100, {"h": (5.0, 1)})
    await lim.acquire("h")
    hi = asyncio.create_task(lim.acquire("h", priority=PRIORITY_FIXED, wait_s=5))
    lo = asyncio.create_task(lim.acquire("h", priority=PRIORITY_HOT, wait_s=5))
    await asyncio.sleep(0)
    hi.cancel()
    await asyncio.gather(hi, return_exceptions=True)
    assert await asyncio.wait_for(lo, 1) >= 0
    assert lim.granted == 2


async def test_cooldown_waiter_blocks_only_its_host_not_the_shared_bucket():
    """리뷰 2026-09-28b #3: 429 쿨다운 중인 대기자가 전체 버킷을 잡아 두면, 토큰이 있어도 다른 호스트 호출이
    그 쿨다운 끝까지 막혀 Throttled 된다. 쿨다운 대기자는 자기 호스트만 막는다."""
    lim = RateLimiter(10.0, 2, {"h": (100.0, 1)})  # 전체 버킷은 0.1 s 마다 1개
    await lim.acquire("a")
    await lim.acquire("b")  # 전체 버킷을 비운다
    lim._blocked_until["h"] = time.monotonic() + 0.6  # h 는 429 쿨다운(대기 상한 안)
    head = asyncio.create_task(lim.acquire("h", priority=PRIORITY_FIXED, wait_s=2))
    await asyncio.sleep(0)
    t0 = time.monotonic()
    await lim.acquire("other", priority=PRIORITY_FIXED, wait_s=0.4)  # 전: h 쿨다운 끝(0.6 s)까지 막혀 Throttled
    assert time.monotonic() - t0 < 0.35
    assert await asyncio.wait_for(head, 2) >= 0.5  # 쿨다운은 그대로 지킨다
    assert lim.granted == 4 and lim.throttled == 0


async def test_waiters_behind_are_rechecked_when_a_shared_bucket_refills():
    """앞 대기자가 호스트 버킷(1 s)을 기다리는 동안 전체 버킷(0.1 s)이 차면 뒤 대기자를 바로 다시 본다."""
    lim = RateLimiter(10.0, 1, {"h": (1.0, 1)})
    await lim.acquire("h")  # 두 버킷 모두 비운다
    head = asyncio.create_task(lim.acquire("h", priority=PRIORITY_FIXED, wait_s=2))
    await asyncio.sleep(0)
    t0 = time.monotonic()
    await lim.acquire("other", priority=PRIORITY_HOT, wait_s=0.5)  # 전: 깨우는 시각이 h 버킷(1 s)이라 Throttled
    assert time.monotonic() - t0 < 0.45
    waited = await asyncio.wait_for(head, 2)
    assert 0.8 <= waited < 1.5  # 앞 대기자는 늦어지지 않는다(호스트 버킷이 찰 때 전체 버킷도 다시 차 있다)
