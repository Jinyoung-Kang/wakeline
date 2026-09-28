"""공급자 상태·heartbeat·수요 상태 쓰기는 부가 경로다 — Redis 가 응답하지 않아도 오래 붙잡지 않는다(리뷰 R-43)."""

from __future__ import annotations

import asyncio
import time
from datetime import UTC, datetime

from fakes import FakeRedis

from wakeline_collector.demand import DemandStatus
from wakeline_collector.status import ProviderStatus


class HangingRedis(FakeRedis):
    """응답 없는 Redis(소켓은 열려 있지만 답이 없다) — 모든 명령이 오래 걸린다."""

    def __init__(self, hang_s: float = 30.0) -> None:
        super().__init__()
        self.hang_s = hang_s

    def __getattribute__(self, name):
        attr = super().__getattribute__(name)
        if name in {"hset", "hget", "hincrby", "xadd", "hdel", "hkeys"}:

            async def slow(*a, **kw):
                await asyncio.sleep(super(HangingRedis, self).__getattribute__("hang_s"))
                return await attr(*a, **kw)

            return slow
        return attr


async def test_r43_status_writes_give_up_quickly_when_redis_does_not_answer():
    from wakeline_collector import status as mod

    st = ProviderStatus(HangingRedis())  # type: ignore[arg-type]
    t0 = time.monotonic()
    await asyncio.wait_for(st.heartbeat("region", lag_s=1.0, fixture=False), 5)
    await asyncio.wait_for(st.success("adsb_lol", at=datetime.now(UTC), latency_ms=1, records=1, used=1, limit=0), 5)
    assert await asyncio.wait_for(st.failure("adsb_lol", at=datetime.now(UTC), error="x", http_status=None), 5) == 0
    await asyncio.wait_for(st.switch_event("region", "a", "b", "r"), 5)
    assert await asyncio.wait_for(st.is_disabled("adsb_lol"), 5) is False  # 마지막으로 읽은 값(없으면 False)
    assert time.monotonic() - t0 < 5 * mod.AUX_TIMEOUT_S + 1
    assert st.errors == 5


async def test_r43_demand_status_writes_give_up_quickly_when_redis_does_not_answer():
    from wakeline_collector import status as mod

    ds = DemandStatus(HangingRedis())  # type: ignore[arg-type]
    t0 = time.monotonic()
    await asyncio.wait_for(ds.put({"focus:abcdef": {"state": "active"}}), 5)
    await asyncio.wait_for(ds.prune(set()), 5)
    await asyncio.wait_for(ds.delete(["focus:abcdef"]), 5)
    assert time.monotonic() - t0 < 3 * mod.AUX_TIMEOUT_S + 1 and ds.errors == 3
