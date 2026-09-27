"""원천 보관 정리(72 h) · 예산 카운터 일별 스냅샷 — 매시."""

from __future__ import annotations

import logging
from datetime import UTC, datetime

from skywx_collector.jobs.context import JobContext

log = logging.getLogger("job.maintenance")


class MaintenanceJob:
    job_name = "maintenance"

    def __init__(self, providers: list[str], ctx: JobContext):
        self.providers, self.ctx = providers, ctx

    async def run_once(self) -> None:
        removed = self.ctx.raw.purge()
        now = datetime.now(UTC)
        for p in self.providers:
            used, limit = await self.ctx.budget.usage(p)
            await self.ctx.db.upsert_budget_day(p, now, used, limit)
        log.info("maintenance: purged %d raw files, budget snapshot for %d providers", removed, len(self.providers))
