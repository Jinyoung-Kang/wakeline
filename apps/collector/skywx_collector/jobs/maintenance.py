"""원천 보관 정리(72 h) · 예산 카운터 일별 스냅샷 — 매시."""

from __future__ import annotations

import asyncio
import logging
from datetime import UTC, datetime

from skywx_collector.jobs.context import JobContext

log = logging.getLogger("job.maintenance")


class MaintenanceJob:
    job_name = "maintenance"

    def __init__(self, providers: list[str], ctx: JobContext):
        self.providers, self.ctx = providers, ctx

    async def run_once(self) -> None:
        removed = await asyncio.to_thread(self.ctx.raw.purge)  # 파일 순회는 이벤트 루프 밖에서
        now = datetime.now(UTC)
        snap = 0
        for p in self.providers:
            used, limit = await self.ctx.budget.usage(p)
            if used is None:  # Redis 장애 — 모르는 사용량을 0 으로 기록하지 않는다
                continue
            self.ctx.db.upsert_budget_day(p, now, used, limit)
            snap += 1
        log.info("maintenance: purged %d raw files, budget snapshot for %d/%d providers", removed, snap, len(self.providers))
