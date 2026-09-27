"""기상청 레이더 영상 수집(10분). 최신 영상을 Redis(base64)와 원천 보관에 둔다. 활용신청 전(403)에는 상태만 남긴다."""

from __future__ import annotations

import base64
import logging
from datetime import UTC, datetime

from skywx_collector.http import ProviderHttpError
from skywx_collector.jobs.context import JobContext
from skywx_collector.providers.kma_radar import KmaRadarProvider, latest_tm

log = logging.getLogger("job.kma_radar")
KEY_IMG = "skywx:radar_kr:image"  # base64 PNG
KEY_META = "skywx:radar_kr:meta"  # hash


class KmaRadarJob:
    job_name = "radar_kr"

    def __init__(self, provider: KmaRadarProvider, ctx: JobContext):
        self.p, self.ctx = provider, ctx
        self._warned = False

    async def run_once(self) -> None:
        ctx = self.ctx
        if not self.p.configured:
            if not self._warned:
                log.info("kma radar: KMA_APIHUB_KEY not set — disabled")
                self._warned = True
            return
        tm = latest_tm()
        started = datetime.now(UTC)
        run_id = await ctx.db.start_run(self.job_name, self.p.name, started)
        ok, used = await ctx.budget.reserve(self.p.name, 1)
        if not ok:
            await ctx.db.finish_run(
                run_id,
                status="budget_exhausted",
                http_status=None,
                latency_ms=None,
                records_in=0,
                records_quarantined=0,
                raw_ref=None,
                error_text=f"daily budget exhausted (used={used})",
            )
            return
        try:
            res = await self.p.image(tm)
        except Exception as e:  # noqa: BLE001
            http_status = e.status if isinstance(e, ProviderHttpError) else None
            note = "활용신청 필요(API허브에서 레이더합성자료 신청 후 승인 대기)" if http_status == 403 else repr(e)
            await ctx.status.failure(
                self.p.name, at=datetime.now(UTC), error=note if http_status == 403 else repr(e), http_status=http_status
            )
            await ctx.db.finish_run(
                run_id,
                status="error",
                http_status=http_status,
                latency_ms=None,
                records_in=0,
                records_quarantined=0,
                raw_ref=None,
                error_text=repr(e),
            )
            await ctx.status.redis.hset(
                KEY_META,
                mapping={
                    "available": "0",
                    "status": str(http_status or ""),
                    "note": note[:200],
                    "checked_at": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
                },
            )
            log.warning("kma radar: %s", note if http_status == 403 else type(e).__name__)
            return
        raw_ref = ctx.raw.save("kma_radar", res.raw, res.fetched_at)
        await ctx.status.redis.set(KEY_IMG, base64.b64encode(res.raw).decode("ascii"), ex=3600)
        await ctx.status.redis.hset(
            KEY_META,
            mapping={
                "available": "1",
                "tm_kst": tm,
                "cmp": self.p._cmp,
                "content_type": res.data["content_type"],
                "bytes": str(res.data["bytes"]),
                "fetched_at": res.fetched_at.isoformat().replace("+00:00", "Z"),
                "raw_ref": raw_ref,
                "status": "200",
                "note": "",
            },
        )
        await ctx.db.finish_run(
            run_id,
            status="ok",
            http_status=res.http_status,
            latency_ms=res.latency_ms,
            records_in=1,
            records_quarantined=0,
            raw_ref=raw_ref,
            error_text=None,
        )
        used, limit = await ctx.budget.usage(self.p.name)
        await ctx.status.success(self.p.name, at=res.fetched_at, latency_ms=res.latency_ms, records=1, used=used, limit=limit)
        await ctx.status.heartbeat(self.job_name, lag_s=0.0, fixture=ctx.fixture)
        log.info("kma radar: tm=%s %s %d bytes", tm, res.data["content_type"], res.data["bytes"])
