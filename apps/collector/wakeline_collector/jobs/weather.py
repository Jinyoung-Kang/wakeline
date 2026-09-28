"""SIGMET(300 s) · 레이더 프레임(60 s) · METAR/TAF(600 s) 수집 작업.

발행(Redis)이 먼저, DB 기록은 큐에 넣기만 한다(비동기 writer). 상태 기록의 Redis 오류는 삼킨다.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import UTC, datetime
from typing import Any

from wakeline_collector.budget import UNKNOWN
from wakeline_collector.flight_category import assess_ceiling, flight_category, parse_visibility_sm
from wakeline_collector.geo import bbox_around
from wakeline_collector.http import ProviderHttpError
from wakeline_collector.jobs.context import JobContext
from wakeline_collector.models import Sigmet
from wakeline_collector.publisher import STREAM_RADAR, STREAM_SIGMET, decode_payload
from wakeline_collector.raw_store import archive
from wakeline_collector.sigmet_parse import parse_airsigmet, parse_isigmet

log = logging.getLogger("job.weather")


def _iso(dt: datetime) -> str:
    return dt.astimezone(UTC).isoformat().replace("+00:00", "Z")


async def _guard(ctx: JobContext, job: str, provider: str, cost: int, coro_factory) -> tuple[datetime, Any | None]:
    """예산 예약 → 호출 → 실패 기록. (started_at, result | None) 을 돌려준다."""
    started = datetime.now(UTC)
    ok, used = (True, 0) if ctx.fixture or not cost else await ctx.budget.reserve(provider, cost)
    if not ok:
        unavailable = used == UNKNOWN
        ctx.db.record_run(
            job,
            provider,
            started,
            status="budget_unavailable" if unavailable else "budget_exhausted",
            error_text="budget store unavailable (fail closed)" if unavailable else f"daily budget exhausted (used={used})",
        )
        return started, None
    try:
        return started, await coro_factory()
    except Exception as e:  # noqa: BLE001
        http_status = e.status if isinstance(e, ProviderHttpError) else None
        await ctx.status.failure(provider, at=datetime.now(UTC), error=repr(e), http_status=http_status)
        ctx.db.record_run(job, provider, started, status="error", http_status=http_status, error_text=repr(e))
        log.warning("%s/%s failed: %s", job, provider, type(e).__name__)
        return started, None


async def _ok(
    ctx: JobContext,
    job: str,
    started: datetime,
    provider: str,
    result,
    *,
    records: int,
    quarantined: int,
    raw_ref: str,
    quality: list[tuple[str, str | None, dict[str, Any]]] | None = None,
) -> None:
    ctx.db.record_run(
        job,
        provider,
        started,
        status="ok",
        http_status=result.http_status,
        latency_ms=result.latency_ms,
        records_in=records,
        records_quarantined=quarantined,
        raw_ref=raw_ref,
        quality=quality,
    )
    used, limit = await ctx.budget.usage(provider)
    await ctx.status.success(
        provider, at=result.fetched_at, latency_ms=result.latency_ms, records=records, used=used, limit=limit
    )


def _parse_feed(items: list, at: datetime, parse, provider: str, errors: list[dict[str, str]]) -> list[Sigmet]:
    out: list[Sigmet] = []
    for it in items:
        try:
            s = parse(it, at, provider) if isinstance(it, dict) else None
        except Exception as e:  # noqa: BLE001 — 한 건의 이상 자료가 전체 발행을 막지 않게 격리
            errors.append({"feed": parse.__name__, "error": repr(e)[:200]})
            continue
        if s is not None:
            out.append(s)
    return out


def _parse_all(intl_items: list, intl_at: datetime, us_items: list | None, us_at: datetime | None, fixture: bool):
    """(국제, 미국 | None, 해석 오류). 스레드에서 돈다(shapely 연산이 이벤트 루프를 막지 않도록)."""
    errors: list[dict[str, str]] = []
    intl = _parse_feed(intl_items, intl_at, parse_isigmet, "fixture" if fixture else "awc_isigmet", errors)
    us = None
    if us_items is not None and us_at is not None:
        us = _parse_feed(us_items, us_at, parse_airsigmet, "fixture" if fixture else "awc_airsigmet", errors)
    return intl, us, errors


class SigmetJob:
    """국제 SIGMET(isigmet) + 미국 SIGMET/AIRMET(airsigmet) 을 한 세트로 발행한다(api 는 세트 전체를 교체).

    부분 실패(REL-12): 미국 호출만 실패하면 마지막으로 성공한 미국 세트(원래 fetched_at 유지, 유효시간 안의 것만)를
    그대로 실어 세트가 줄어들지 않게 한다. 국제 호출이 실패하면 아무것도 발행하지 않는다(api 는 직전 세트를 유지).
    재시작 직후에는 스트림의 마지막 발행분에서 미국 세트를 복원한다.
    """

    job_name = "sigmet"

    def __init__(self, awc: Any, ctx: JobContext):
        self.awc, self.ctx = awc, ctx
        self._last_us: list[Sigmet] | None = None  # 마지막으로 성공한 미국 세트(각 항목은 원래 fetched_at 을 가진다)
        self._seeded = False

    async def _seed_last_us(self) -> None:
        """재시작 직후 1회: 스트림의 마지막 SIGMET 세트에서 미국 항목을 복원한다(best-effort)."""
        self._seeded = True
        if self.ctx.fixture:
            return
        try:
            entries = await self.ctx.status.redis.xrevrange(STREAM_SIGMET, count=1)
            if not entries:
                return
            fields = entries[0][1] or {}
            payload = decode_payload(str(fields["payload"]))
            # 고도대 출처가 없는 옛 형식은 복원하지 않는다(출처를 추정해 채우지 않음)
            us = [
                Sigmet.model_validate(d)
                for d in payload.get("sigmets", [])
                if d.get("provider") == "awc_airsigmet" and "base_source" in d and "top_source" in d
            ]
            self._last_us = us
            log.info("sigmet: restored %d US records from the last published set", len(us))
        except Exception as e:  # noqa: BLE001
            log.warning("sigmet: could not restore last US set (%s)", type(e).__name__)

    async def run_once(self) -> None:
        ctx = self.ctx
        if not self._seeded:
            await self._seed_last_us()
        started, res = await _guard(ctx, "sigmet", self.awc.name, 2, self._fetch_both)
        if res is None:
            return  # 국제 호출 실패 → 발행하지 않는다
        intl, us, us_error = res
        fetched_at = intl.fetched_at
        raw_ref = intl.extra.get("raw_ref") or await archive(ctx.raw, "awc_isigmet", intl.raw, fetched_at)
        if us is not None and not us.extra.get("raw_ref"):
            await archive(ctx.raw, "awc_airsigmet", us.raw, us.fetched_at)
        fx = self.awc.name == "fixture"  # 재생 자료는 출처를 fixture 로 남긴다(실 AWC 자료로 오인되지 않게)
        intl_list, us_list, parse_errors = await asyncio.to_thread(
            _parse_all, intl.data, fetched_at, us.data if us is not None else None, us.fetched_at if us else None, fx
        )
        sigmets = list(intl_list)
        carried = 0
        if us_list is not None:
            self._last_us = us_list
            sigmets += us_list
        elif self._last_us is not None:
            now = datetime.now(UTC)
            keep = [s for s in self._last_us if s.valid_to > now]
            sigmets += keep
            carried = len(keep)
        # 자연키 중복 제거(같은 경보가 두 번 오는 경우가 실응답에서 관측됨)
        uniq: dict[str, Sigmet] = {}
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
            payload=payload,
        )
        await ctx.publisher.publish(STREAM_SIGMET, fields)

        quality: list[tuple[str, str | None, dict[str, Any]]] = [
            ("sigmet_no_polygon", None, {"id": s.id, "reason": s.excluded_reason}) for s in uniq.values() if s.geometry is None
        ]
        quality += [("sigmet_invalid_band", None, {"id": s.id, "note": s.band_note}) for s in uniq.values() if s.band_note]
        quality += [("sigmet_parse_error", None, e) for e in parse_errors]
        await _ok(
            ctx, "sigmet", started, self.awc.name, intl, records=len(uniq), quarantined=excluded, raw_ref=raw_ref, quality=quality
        )
        if us is None:
            # 부분 실패를 상태에 남긴다(운영 화면: last_error + 미국 세트 기준 시각)
            await ctx.status.failure(self.awc.name, at=datetime.now(UTC), error=f"airsigmet failed: {us_error}", http_status=None)
        us_at = min((s.fetched_at for s in self._last_us), default=None) if self._last_us else None
        await ctx.status.hset_meta(
            ctx.status.key(self.awc.name),
            {
                "sigmet_partial": "" if us is not None else "airsigmet",
                "airsigmet_fetched_at": _iso(us_at) if us_at else "",
            },
        )
        await ctx.status.heartbeat("sigmet", lag_s=None, fixture=ctx.fixture)  # 자료 나이를 재지 않는다 — 0 이 아니라 모름(R-20)
        log.info(
            "sigmet: %d (no polygon %d)%s",
            len(uniq),
            excluded,
            f" — airsigmet failed, carried {carried} US records" if us is None else "",
        )

    async def _fetch_both(self):
        intl = await self.awc.isigmet()
        try:
            us, err = await self.awc.airsigmet(), None
        except Exception as e:  # noqa: BLE001 — 미국 경보 실패는 국제 경보를 막지 않는다(직전 미국 세트를 싣는다)
            log.warning("airsigmet failed: %s", type(e).__name__)
            us, err = None, repr(e)[:200]
        return intl, us, err


class RadarJob:
    job_name = "radar"

    def __init__(self, rv: Any, ctx: JobContext):
        self.rv, self.ctx = rv, ctx

    async def run_once(self) -> None:
        ctx = self.ctx
        started, res = await _guard(ctx, "radar", self.rv.name, 1, self.rv.frames)
        if res is None:
            return
        raw_ref = res.extra.get("raw_ref") or await archive(ctx.raw, "rainviewer", res.raw, res.fetched_at)
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
            payload=payload,
        )
        await ctx.publisher.publish(STREAM_RADAR, fields)
        ctx.db.insert_radar_frames(host, past, res.fetched_at)
        await _ok(ctx, "radar", started, self.rv.name, res, records=len(past), quarantined=0, raw_ref=raw_ref)
        await ctx.status.heartbeat("radar", lag_s=None, fixture=ctx.fixture)  # 자료 나이를 재지 않는다 — 0 이 아니라 모름(R-20)


def metar_row(it: dict[str, Any], provider: str, fetched_at: datetime) -> tuple[dict[str, Any], dict[str, Any]] | None:
    """AWC METAR 1건 → (airport, obs). 필수 값이 없으면 None. 실링 상태·카테고리는 계약 §5."""
    icao = it.get("icaoId")
    if not icao or it.get("lat") is None or it.get("lon") is None or it.get("obsTime") is None:
        return None
    name = it.get("name") or ""
    country = name.rsplit(",", 1)[-1].strip() if "," in name else None
    airport = {
        "icao": icao,
        "name": name,
        "country": country[:2] if country else None,
        "lat": float(it["lat"]),
        "lon": float(it["lon"]),
        "elev_ft": int(round(float(it["elev"]) * 3.28084)) if it.get("elev") is not None else None,
    }
    vis = parse_visibility_sm(it.get("visib"))
    ceiling, ceiling_state = assess_ceiling(it.get("clouds"), it.get("cover"))
    awc_cat = it.get("fltCat") if it.get("fltCat") in ("VFR", "MVFR", "IFR", "LIFR") else None
    cat: str | None
    cat_src: str | None
    if awc_cat:
        cat, cat_src = awc_cat, "awc"
    else:
        cat = flight_category(ceiling, vis, ceiling_state)
        cat_src = "computed" if cat else None
    obs = {
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
        "ceiling_state": ceiling_state,
        "flight_cat": cat,
        "flight_cat_source": cat_src,
        "wx_string": it.get("wxString"),
        "taf_raw": it.get("rawTaf"),
        "provider": provider,
        "fetched_at": fetched_at,
    }
    return airport, obs


class MetarJob:
    job_name = "metar"

    def __init__(self, awc: Any, ctx: JobContext):
        self.awc, self.ctx = awc, ctx

    async def run_once(self) -> None:
        ctx = self.ctx
        lat, lon, radius = ctx.rt.region
        lamin, lomin, lamax, lomax = bbox_around(lat, lon, radius)
        started, res = await _guard(ctx, "metar", self.awc.name, 1, lambda: self.awc.metar_bbox(lamin, lomin, lamax, lomax))
        if res is None:
            return
        raw_ref = res.extra.get("raw_ref") or await archive(ctx.raw, "awc_metar", res.raw, res.fetched_at)
        airports: list[dict[str, Any]] = []
        obs: list[dict[str, Any]] = []
        bad: list[tuple[str, str | None, dict[str, Any]]] = []
        for it in res.data:
            try:
                row = metar_row(it, self.awc.name, res.fetched_at) if isinstance(it, dict) else None
            except (TypeError, ValueError, OverflowError) as e:
                bad.append(("metar_parse_error", None, {"icao": str(it.get("icaoId"))[:8], "error": repr(e)[:200]}))
                continue
            if row is not None:
                airports.append(row[0])
                obs.append(row[1])
        # METAR 의 출력은 DB 뿐이다 — 쓰기는 writer 가 순서대로(airport → metar_obs, FK) 처리한다
        ctx.db.upsert_airports(airports)
        ctx.db.upsert_metar(obs)
        await _ok(ctx, "metar", started, self.awc.name, res, records=len(obs), quarantined=len(bad), raw_ref=raw_ref, quality=bad)
        await ctx.status.heartbeat("metar", lag_s=None, fixture=ctx.fixture)  # 자료 나이를 재지 않는다 — 0 이 아니라 모름(R-20)
        log.info("metar: %d stations", len(obs))
