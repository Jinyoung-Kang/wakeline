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


def _capture(ctx) -> list[tuple]:
    rows: list[tuple] = []
    ctx.db.upsert_budget_day = lambda p, day, used, limit: rows.append((p, day.date().isoformat(), used, limit))
    return rows


async def test_r19_first_snapshot_after_midnight_finalizes_yesterday(monkeypatch):
    """리뷰 R-19: 매시 스냅샷은 '오늘' 키만 봐서 전날 마지막 최대 1시간 호출이 일별 표에서 빠졌다(adsb_fi 3549/3559 등)."""
    from datetime import UTC, datetime

    from wakeline_collector.jobs import maintenance as mod

    now = datetime(2026, 9, 28, 0, 20, tzinfo=UTC)
    monkeypatch.setattr(mod, "_utcnow", lambda: now, raising=False)
    r = FakeRedis()
    ctx = make_ctx(r)
    rows = _capture(ctx)
    await r.hset(day_key("adsb_fi", datetime(2026, 9, 27, 12, tzinfo=UTC)), mapping={"used": "3559", "limit": "40000"})
    await r.hset(day_key("adsb_fi", now), mapping={"used": "7", "limit": "40000"})
    await MaintenanceJob(["adsb_fi", "awc"], ctx).run_once()
    assert ("adsb_fi", "2026-09-27", 3559, 40000) in rows  # 어제 키(TTL 48 h)의 최종값
    assert ("adsb_fi", "2026-09-28", 7, 40000) in rows
    assert not [x for x in rows if x[0] == "awc" and x[1] == "2026-09-27"]  # 어제 키가 없으면 0 으로 덮어쓰지 않는다


def test_r19_live_mode_does_not_snapshot_the_fixture_provider():
    from wakeline_collector.config import Settings
    from wakeline_collector.main import build_limits, snapshot_providers

    limits = build_limits(Settings())
    assert "fixture" not in snapshot_providers(limits, fixture=False)
    assert "adsb_fi" in snapshot_providers(limits, fixture=False)
    assert "fixture" in snapshot_providers(limits, fixture=True)
