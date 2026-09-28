"""원천 보관 정리(72 h) · 예산 카운터 일별 스냅샷 — 매시.

스냅샷은 오늘 키와 함께 어제 키(TTL 48 h)도 다시 적는다(R-19): 매시 실행이라 오늘 키만 보면 자정 전 마지막 최대 1시간 호출이
어제 행에서 빠진다. 어제 키가 없으면(호출 없음·Redis 초기화) 그 행은 건드리지 않는다 — 모르는 값을 0 으로 덮지 않는다.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import UTC, datetime, timedelta

from wakeline_collector.jobs.context import JobContext

log = logging.getLogger("job.maintenance")


def _utcnow() -> datetime:
    return datetime.now(UTC)


class MaintenanceJob:
    job_name = "maintenance"

    def __init__(self, providers: list[str], ctx: JobContext):
        self.providers, self.ctx = providers, ctx

    async def run_once(self) -> None:
        removed = await asyncio.to_thread(self.ctx.raw.purge)  # 파일 순회는 이벤트 루프 밖에서
        now = _utcnow()
        yesterday = now - timedelta(days=1)
        snap = 0
        for p in self.providers:
            used, limit = await self.ctx.budget.usage(p, now)
            if used is None:  # Redis 장애 — 모르는 사용량을 0 으로 기록하지 않는다
                continue
            self.ctx.db.upsert_budget_day(p, now, used, limit)
            snap += 1
            prev = await self.ctx.budget.recorded_usage(p, yesterday)
            if prev is not None:  # 어제의 최종값(자정 전 마지막 시간 포함)
                self.ctx.db.upsert_budget_day(p, yesterday, *prev)
        log.info("maintenance: purged %d raw files, budget snapshot for %d/%d providers", removed, snap, len(self.providers))
