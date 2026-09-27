"""SIGMET(300 s) · 레이더 프레임(60 s) · METAR/TAF(600 s) 수집 작업."""

from __future__ import annotations

import logging
from datetime import UTC, datetime
from typing import Any

from skywx_collector.flight_category import ceiling_from_clouds, flight_category, parse_visibility_sm
from skywx_collector.geo import bbox_around
from skywx_collector.http import ProviderHttpError
from skywx_collector.jobs.context import JobContext
from skywx_collector.publisher import STREAM_RADAR, STREAM_SIGMET
from skywx_collector.sigmet_parse import parse_airsigmet, parse_isigmet

log = logging.getLogger("job.weather")


async def _guard(ctx: JobContext, job: str, provider: str, cost: int, coro_factory):
    """예산 예약 → 호출 → 실패 기록. (run_id, result | None) 을 돌려준다."""
    started = datetime.now(UTC)
    run_id = await ctx.db.start_run(job, provider, started)
    ok, used = (True, 0) if ctx.fixture or not cost else await ctx.budget.reserve(provider, cost)
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
        return run_id, None
    try:
        return run_id, await coro_factory()
    except Exception as e:  # noqa: BLE001
        http_status = e.status if isinstance(e, ProviderHttpError) else None
        await ctx.status.failure(provider, at=datetime.now(UTC), error=repr(e), http_status=http_status)
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
        log.warning("%s/%s failed: %s", job, provider, type(e).__name__)
        return run_id, None


async def _ok(ctx: JobContext, run_id: int, provider: str, result, *, records: int, quarantined: int, raw_ref: str) -> None:
    await ctx.db.finish_run(
        run_id,
        status="ok",
        http_status=result.http_status,
        latency_ms=result.latency_ms,
        records_in=records,
        records_quarantined=quarantined,
        raw_ref=raw_ref,
        error_text=None,
    )
    used, limit = await ctx.budget.usage(provider)
    await ctx.status.success(
        provider, at=result.fetched_at, latency_ms=result.latency_ms, records=records, used=used, limit=limit
    )


class SigmetJob:
    job_name = "sigmet"

    def __init__(self, awc: Any, ctx: JobContext):
        self.awc, self.ctx = awc, ctx

    async def run_once(self) -> None:
        ctx = self.ctx
        run_id, res = await _guard(ctx, "sigmet", self.awc.name, 2, self._fetch_both)
        if res is None:
            return
        intl, us = res
        fetched_at = intl.fetched_at
        raw_ref = intl.extra.get("raw_ref") or ctx.raw.save("awc_isigmet", intl.raw, fetched_at)
        if us is not None and not us.extra.get("raw_ref"):
            ctx.raw.save("awc_airsigmet", us.raw, us.fetched_at)
        sigmets = [s for s in (parse_isigmet(it, fetched_at) for it in intl.data) if s is not None]
        if us is not None:
            sigmets += [s for s in (parse_airsigmet(it, us.fetched_at) for it in us.data) if s is not None]
        # 자연키 중복 제거(같은 경보가 두 번 오는 경우가 실응답에서 관측됨)
        uniq: dict[str, Any] = {}
        for s in sigmets:
            uniq[s.id] = s
        excluded = sum(1 for s in uniq.values() if s.geometry is None)
        payload = {"sigmets": [s.model_dump(mode="json") for s in uniq.values()]}
        fields = ctx.publisher.envelope(
            kind="sigmet",
            scope="-",
            provider=self.awc.name,
            fetched_at=fetched_at,
            raw_ref=raw_ref,
            count=len(uniq),
            run_id=str(run_id),
            payload=payload,
        )
        await ctx.publisher.publish(STREAM_SIGMET, fields)
        await ctx.db.quality_events(
            run_id,
            [("sigmet_no_polygon", None, {"id": s.id, "reason": s.excluded_reason}) for s in uniq.values() if s.geometry is None],
        )
        await _ok(ctx, run_id, self.awc.name, intl, records=len(uniq), quarantined=excluded, raw_ref=raw_ref)
        await ctx.status.heartbeat("sigmet", lag_s=0.0, fixture=ctx.fixture)
        log.info("sigmet: %d (no polygon %d)", len(uniq), excluded)

    async def _fetch_both(self):
        intl = await self.awc.isigmet()
        try:
            us = await self.awc.airsigmet()
        except Exception as e:  # noqa: BLE001 — 미국 경보 실패는 국제 경보를 막지 않는다
            log.warning("airsigmet failed: %s", type(e).__name__)
            us = None
        return intl, us


class RadarJob:
    job_name = "radar"

    def __init__(self, rv: Any, ctx: JobContext):
        self.rv, self.ctx = rv, ctx

    async def run_once(self) -> None:
        ctx = self.ctx
        run_id, res = await _guard(ctx, "radar", self.rv.name, 1, self.rv.frames)
        if res is None:
            return
        raw_ref = res.extra.get("raw_ref") or ctx.raw.save("rainviewer", res.raw, res.fetched_at)
        host = str(res.data["host"])
        past = [
            {"time": int(f["time"]), "path": str(f["path"])}
            for f in res.data.get("radar", {}).get("past", [])
            if "time" in f and "path" in f
        ]
        payload = {"host": host, "generated": int(res.data.get("generated", 0)), "past": past}
        fields = ctx.publisher.envelope(
            kind="radar",
            scope="-",
            provider=self.rv.name,
            fetched_at=res.fetched_at,
            raw_ref=raw_ref,
            count=len(past),
            run_id=str(run_id),
            payload=payload,
        )
        await ctx.publisher.publish(STREAM_RADAR, fields)
        await ctx.db.insert_radar_frames(host, past, res.fetched_at)
        await _ok(ctx, run_id, self.rv.name, res, records=len(past), quarantined=0, raw_ref=raw_ref)
        await ctx.status.heartbeat("radar", lag_s=0.0, fixture=ctx.fixture)


class MetarJob:
    job_name = "metar"

    def __init__(self, awc: Any, ctx: JobContext):
        self.awc, self.ctx = awc, ctx

    async def run_once(self) -> None:
        ctx = self.ctx
        lat, lon, radius = ctx.rt.region
        lamin, lomin, lamax, lomax = bbox_around(lat, lon, radius)
        run_id, res = await _guard(ctx, "metar", self.awc.name, 1, lambda: self.awc.metar_bbox(lamin, lomin, lamax, lomax))
        if res is None:
            return
        raw_ref = res.extra.get("raw_ref") or ctx.raw.save("awc_metar", res.raw, res.fetched_at)
        airports, obs = [], []
        for it in res.data:
            icao = it.get("icaoId")
            if not icao or it.get("lat") is None or it.get("lon") is None or it.get("obsTime") is None:
                continue
            name = it.get("name") or ""
            country = name.rsplit(",", 1)[-1].strip() if "," in name else None
            airports.append(
                {
                    "icao": icao,
                    "name": name,
                    "country": country[:2] if country else None,
                    "lat": float(it["lat"]),
                    "lon": float(it["lon"]),
                    "elev_ft": int(round(float(it["elev"]) * 3.28084)) if it.get("elev") is not None else None,
                }
            )
            vis = parse_visibility_sm(it.get("visib"))
            ceiling = ceiling_from_clouds(it.get("clouds"))
            cat_src = "awc" if it.get("fltCat") else "computed"
            cat = it.get("fltCat") or flight_category(ceiling, vis)
            obs.append(
                {
                    "icao": icao,
                    "obs_time": datetime.fromtimestamp(int(it["obsTime"]), UTC),
                    "raw": it.get("rawOb") or "",
                    "temp_c": it.get("temp"),
                    "dewp_c": it.get("dewp"),
                    "wind_dir": it["wdir"] if isinstance(it.get("wdir"), int) else None,
                    "wind_kt": it["wspd"] if isinstance(it.get("wspd"), int | float) else None,
                    "vis_sm": vis,
                    "vis_raw": str(it.get("visib")) if it.get("visib") is not None else None,
                    "ceiling_ft": ceiling,
                    "flight_cat": cat,
                    "flight_cat_source": cat_src,
                    "wx_string": it.get("wxString"),
                    "taf_raw": it.get("rawTaf"),
                    "provider": self.awc.name,
                    "fetched_at": res.fetched_at,
                }
            )
        await ctx.db.upsert_airports(airports)
        await ctx.db.upsert_metar(obs)
        await _ok(ctx, run_id, self.awc.name, res, records=len(obs), quarantined=0, raw_ref=raw_ref)
        await ctx.status.heartbeat("metar", lag_s=0.0, fixture=ctx.fixture)
        log.info("metar: %d stations", len(obs))
