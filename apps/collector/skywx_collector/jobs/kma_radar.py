"""기상청 레이더 합성 수집(5분): 목록에서 아직 없는 최신 tm 을 고르고 → 바이너리 → 해석·웹 메르카토르 PNG → Redis(최근 12프레임).
활용신청 전(403)에는 사유만 상태에 남긴다. 격자·투영은 문서 값(kma_grid.py 참조)만 쓴다."""

from __future__ import annotations

import base64
import logging
from datetime import UTC, datetime

import orjson

from skywx_collector.http import ProviderHttpError
from skywx_collector.jobs.context import JobContext
from skywx_collector.kma_grid import read_echo, render_mercator_png
from skywx_collector.providers.kma_radar import KmaRadarProvider, kst_now

log = logging.getLogger("job.kma_radar")
KEY_META = "skywx:radar_kr:meta"  # hash
KEY_FRAMES = "skywx:radar_kr:frames"  # JSON list (오래된 → 최신)
KEY_FRAME = "skywx:radar_kr:frame:{tm}"  # base64 PNG, TTL
KEEP_FRAMES = 12
MAX_PER_CYCLE = 4
FRAME_TTL_S = 3 * 3600


def _iso(dt: datetime) -> str:
    return dt.astimezone(UTC).isoformat().replace("+00:00", "Z")


class KmaRadarJob:
    job_name = "radar_kr"

    def __init__(self, provider: KmaRadarProvider, ctx: JobContext):
        self.p, self.ctx = provider, ctx
        self._warned = False

    async def _frames(self) -> list[dict]:
        raw = await self.ctx.status.redis.get(KEY_FRAMES)
        return orjson.loads(raw) if raw else []

    async def _fail(self, run_id: int, e: Exception) -> None:
        http_status = e.status if isinstance(e, ProviderHttpError) else None
        note = "활용신청 필요(API허브에서 레이더합성자료 신청 후 승인 대기)" if http_status == 403 else f"{type(e).__name__}"
        await self.ctx.status.failure(
            self.p.name, at=datetime.now(UTC), error=note if http_status == 403 else repr(e), http_status=http_status
        )
        await self.ctx.db.finish_run(
            run_id,
            status="error",
            http_status=http_status,
            latency_ms=None,
            records_in=0,
            records_quarantined=0,
            raw_ref=None,
            error_text=repr(e),
        )
        await self.ctx.status.redis.hset(
            KEY_META, mapping={"status": str(http_status or ""), "note": note[:200], "checked_at": _iso(datetime.now(UTC))}
        )
        if not await self._frames():
            await self.ctx.status.redis.hset(KEY_META, "available", "0")
        log.warning("kma radar: %s", note if http_status == 403 else repr(e)[:160])

    async def run_once(self) -> None:
        ctx = self.ctx
        if not self.p.configured:
            if not self._warned:
                log.info("kma radar: KMA_APIHUB_KEY not set — disabled")
                self._warned = True
            return
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
            listing = await self.p.file_list(kst_now().strftime("%Y%m%d"))
            have = {f["tm"] for f in await self._frames()}
            now_tm = kst_now().strftime("%Y%m%d%H%M")
            # 없는 프레임을 최신부터 최대 4개(첫 기동 백필). 정상 상태에서는 주기당 1개.
            candidates = [tm for tm in listing.data if tm <= now_tm and tm not in have][-MAX_PER_CYCLE:]
            if not candidates:
                await ctx.db.finish_run(
                    run_id,
                    status="ok",
                    http_status=listing.http_status,
                    latency_ms=listing.latency_ms,
                    records_in=0,
                    records_quarantined=0,
                    raw_ref=None,
                    error_text=None,
                )
                await ctx.status.hset_meta(KEY_META, {"checked_at": _iso(datetime.now(UTC)), "status": "200", "note": ""})
                return
        except Exception as e:  # noqa: BLE001
            await self._fail(run_id, e)
            return
        stored = 0
        for tm in candidates:
            ok, used = await ctx.budget.reserve(self.p.name, 1)
            if not ok:
                break
            try:
                res = await self.p.binary(tm)
                await self._store(run_id, tm, res)
                stored += 1
            except Exception as e:  # noqa: BLE001
                await self._fail(run_id, e)
                return
        await ctx.db.finish_run(
            run_id,
            status="ok",
            http_status=200,
            latency_ms=listing.latency_ms,
            records_in=stored,
            records_quarantined=0,
            raw_ref=None,
            error_text=None,
        )
        used, limit = await ctx.budget.usage(self.p.name)
        await ctx.status.success(
            self.p.name, at=datetime.now(UTC), latency_ms=listing.latency_ms, records=stored, used=used, limit=limit
        )
        await ctx.status.heartbeat(self.job_name, lag_s=0.0, fixture=ctx.fixture)

    async def _store(self, run_id: int, tm: str, res) -> None:
        ctx = self.ctx
        raw_ref = ctx.raw.save("kma_radar", res.raw, res.fetched_at)
        try:
            header, grid = read_echo(res.raw)
            png, meta = render_mercator_png(header, grid)
        except Exception as e:  # noqa: BLE001 — 해석 실패는 격리(원천은 남는다)
            await ctx.db.quality_events(run_id, [("kma_radar_parse", None, {"tm": tm, "error": repr(e)[:200]})])
            raise
        r = ctx.status.redis
        await r.set(KEY_FRAME.format(tm=tm), base64.b64encode(png).decode("ascii"), ex=FRAME_TTL_S)
        frames = [f for f in await self._frames() if f["tm"] != tm]
        frames.append(
            {
                "tm": tm,
                "obs_tm": header.tm.strftime("%Y%m%d%H%M"),
                "fetched_at": _iso(res.fetched_at),
                "bytes": len(png),
                "echo_cells": meta["echo_cells"],
                "raw_ref": raw_ref,
            }
        )
        frames = sorted(frames, key=lambda f: f["tm"])[-KEEP_FRAMES:]
        await r.set(KEY_FRAMES, orjson.dumps(frames).decode())
        await r.hset(
            KEY_META,
            mapping={
                "available": "1",
                "status": "200",
                "note": "",
                "latest_tm": tm,
                "product": header.product,
                "cmp": self.p.cmp,
                "coordinates": orjson.dumps(meta["coordinates"]).decode(),
                "width": str(meta["width"]),
                "height": str(meta["height"]),
                "projection": meta["projection"],
                "grid": orjson.dumps(meta["grid"]).decode(),
                "legend": orjson.dumps(meta["legend"]).decode(),
                "min_dbz": str(meta["min_dbz"]),
                "stations": ",".join(header.stations),
                "observed_cells": str(meta["observed_cells"]),
                "fetched_at": _iso(res.fetched_at),
                "checked_at": _iso(datetime.now(UTC)),
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
        log.info(
            "kma radar: tm=%s %s echo cells=%d png=%d B (%d frames)",
            tm,
            header.product,
            meta["echo_cells"],
            len(png),
            len(frames),
        )
