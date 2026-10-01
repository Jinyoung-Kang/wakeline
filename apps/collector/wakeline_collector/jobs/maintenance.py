"""원천 보관 정리(72 h) · 예산 카운터 일별 스냅샷 · 입출항 색인 보존(목록 날짜 60일 — ADR-022 개정) — 매시.

스냅샷은 오늘 키와 함께 어제 키(TTL 48 h)도 다시 적는다(R-19): 매시 실행이라 오늘 키만 보면 자정 전 마지막 최대 1시간 호출이
어제 행에서 빠진다. 어제 키가 없으면(호출 없음·Redis 초기화) 그 행은 건드리지 않는다 — 모르는 값을 0 으로 덮지 않는다.
입출항 색인(port_call)은 목록 날짜(KST)가 PORT_CALL_RETENTION_DAYS 보다 오래된 행을 지우고 범위의 시작을 함께 올린다(db.purge_port_calls — 멱등).
색인 창은 30일이므로 60일은 창의 두 배다(선택값 — 창 밖 기록은 화면에 쓰지 않는다. 날짜 경계 · 되돌림 여유).
"""

from __future__ import annotations

import asyncio
import logging
from datetime import UTC, datetime, timedelta

from wakeline_collector.jobs.context import JobContext
from wakeline_collector.timeutil import kst_date

log = logging.getLogger("job.maintenance")
PORT_CALL_RETENTION_DAYS = 60


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
        self.ctx.db.purge_port_calls(kst_date(now) - timedelta(days=PORT_CALL_RETENTION_DAYS))
        log.info("maintenance: purged %d raw files, budget snapshot for %d/%d providers", removed, snap, len(self.providers))
