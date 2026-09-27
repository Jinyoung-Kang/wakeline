"""유지보수 작업: 원천 정리 + 예산 일별 스냅샷(모르는 사용량은 0 으로 적지 않는다)."""

from __future__ import annotations

from fakes import FakeRedis, make_ctx

from wakeline_collector.budget import day_key
from wakeline_collector.jobs.maintenance import MaintenanceJob


async def test_budget_snapshot_and_redis_down():
    r = FakeRedis()
    ctx = make_ctx(r)
    await r.hset(day_key("adsb_fi"), mapping={"used": "12", "limit": "40000"})
    job = MaintenanceJob(["adsb_fi", "awc"], ctx)
    await job.run_once()
    assert ctx.db.names == ["provider_budget_day(adsb_fi)", "provider_budget_day(awc)"]  # type: ignore[attr-defined]
    r.down = True
    await job.run_once()
    assert len(ctx.db.names) == 2  # type: ignore[attr-defined]
