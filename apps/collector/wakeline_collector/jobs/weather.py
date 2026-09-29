"""SIGMET(300 s) · 레이더 프레임(60 s) · METAR/TAF(600 s) 수집 작업.

발행(Redis)이 먼저, DB 기록은 큐에 넣기만 한다(비동기 writer). 상태 기록의 Redis 오류는 삼킨다.

일시 오류(시간 초과 · 연결 실패 · 프로토콜 오류)는 공급자 호출마다 같은 주기 안에서 5 s 뒤 한 번 다시 부른다 — KMA 와 같은 규칙(retry.py):
예산 1 을 따로 예약하고(fixture 모드는 예산을 쓰지 않는다), 다시 부른 호출도 속도 상한을 지난다. 그 예약은 남은 하루(UTC)의 정규 주기 몫을
남기고만 한다(retry_headroom — 하루 내내 일시 오류여도 정규 주기가 budget_exhausted 로 막히지 않게), 보내지 않은 시도(연결 전 실패 · 연결 풀
대기 초과 · 속도 상한)는 예산 1 을 돌려준다(aircraft · route 와 같다). HTTP 오류(ProviderHttpError)·속도 상한
(Throttled)·응답 모양 오류는 다시 부르지 않는다. 다시 불러 살리면 경고 없이 INFO 한 줄, 다시 불러도 실패하면 경고 한 번(단계 · 걸린 시간 ·
첫 시도)과 같은 내용의 상태 last_error · 실행 기록. 5 s · 한 번은 선택값이다(2026-09-29 관찰: AWC SIGMET 호출 하나가 "ReadTimeout —
read 제한 8 s 초과 (aviationweather.gov)" 로 실패해 그 주기를 잃었고 다음 주기는 성공했다 — 응답 시간을 재서 정한 값이 아니다).
최악의 주기 길이(설정값으로 계산): 호출마다 전체 상한 30 s × 2 + 5 s — SIGMET 두 호출 130 s(주기 300 s), METAR 상자 둘 130 s(600 s),
레이더 한 호출 65 s(60 s — run_periodic 은 주기가 끝난 뒤 쉬므로 겹치지 않고 다음 주기가 늦어질 뿐이다). 속도 상한 대기(호출마다 최대 10 s)는 밖이다.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime
from typing import Any

from wakeline_collector.budget import UNKNOWN, regular_headroom
from wakeline_collector.errors import describe_error
from wakeline_collector.flight_category import assess_ceiling, flight_category, parse_visibility_sm
from wakeline_collector.geo import boxes_around
from wakeline_collector.http import ProviderHttpError
from wakeline_collector.jobs.context import JobContext
from wakeline_collector.models import Sigmet
from wakeline_collector.publisher import STREAM_RADAR, STREAM_SIGMET, decode_payload
from wakeline_collector.raw_store import archive
from wakeline_collector.retry import CallFailed, call_retry_once
from wakeline_collector.sigmet_parse import parse_airsigmet, parse_isigmet

log = logging.getLogger("job.weather")
_sleep = asyncio.sleep  # 다시 부르기 전 기다림 — 시험이 바꿔 끼운다


def _now() -> datetime:  # 다시 부르기 여유 계산의 시각 — 시험이 바꿔 끼운다
    return datetime.now(UTC)


# 공급자별 정규 주기: (주기 설정 이름 — RuntimeSettings, 주기마다 최대 호출 수). 같은 예산을 쓰는 작업을 모두 적는다.
# AWC = SIGMET(국제 · 미국 2) + METAR(상자 최대 2 — 날짜변경선, geo.boxes_around). RainViewer = 레이더 프레임 목록 1.
REGULAR_CALLS: dict[str, tuple[tuple[str, int], ...]] = {
    "awc": (("sigmet_poll_s", 2), ("metar_poll_s", 2)),
    "rainviewer": (("radar_poll_s", 1),),
}


def retry_headroom(rt: Any, provider: str, now: datetime) -> int:
    """다시 부르기 예약이 남겨 둘 몫: 예산 날(UTC — budget.day_key)이 끝날 때까지 정규 주기가 이 공급자 예산에서 더 쓸 수 있는 최대
    호출 수. 지금 주기 설정으로 계산한 상한이다(잰 값이 아니다) — run_periodic 은 주기가 끝난 뒤 주기만큼 쉬므로 남은 주기는
    남은 초 // 주기 + 1(지금 돌거나 곧 시작할 주기 하나) 이하다. 다시 부르기는 사용량 + 1 ≤ 한도 − 이 값일 때만 예약하므로(budget
    headroom) 하루 내내 일시 오류여도 정규 주기가 예산 소진으로 막히지 않는다. 정규 주기만으로 한도를 넘는 설정이면 다시 부르지 않는다.
    계산은 budget.regular_headroom — KMA 부분 합성 다시 받기(jobs/kma_radar.py)도 같은 규칙이다."""
    return regular_headroom(((getattr(rt, name), calls) for name, calls in REGULAR_CALLS.get(provider, ())), now)


def _iso(dt: datetime) -> str:
    return dt.astimezone(UTC).isoformat().replace("+00:00", "Z")


async def _call[T](ctx: JobContext, job: str, provider: str, step: str, fn: Callable[[], Awaitable[T]]) -> T:
    """공급자 호출 하나. 일시 오류면 5 s 뒤 한 번 다시 부른다(예산 1 추가 예약 — 남은 하루의 정규 주기 몫을 남기고만 · 속도 상한 통과 —
    retry.py). 보내지 않은 시도(연결 전 실패 · 속도 상한)는 예산 1 을 돌려준다. 실패는 모두 CallFailed."""

    async def reserve() -> tuple[bool, int]:
        if ctx.fixture:  # fixture 모드는 예산을 쓰지 않는다(_guard 와 같다)
            return True, 0
        return await ctx.budget.reserve(provider, 1, headroom=retry_headroom(ctx.rt, provider, _now()))

    async def release() -> None:
        await ctx.budget.release(provider, 1)

    return await call_retry_once(
        step,
        fn,
        reserve=reserve,
        log=log,
        label=f"{job}/{provider}",
        sleep=lambda s: _sleep(s),
        release=None if ctx.fixture else release,
    )


async def _guard(ctx: JobContext, job: str, provider: str, cost: int, coro_factory) -> tuple[datetime, Any | None]:
    """예산 예약 → 호출(_call 로 감싼 것) → 실패 기록. (started_at, result | None) 을 돌려준다.
    실패 기록(상태 last_error · 실행 기록 · 경고 한 번)에는 단계 · 걸린 시간 · 다시 불렀다면 첫 시도를 싣는다."""
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
        f = e if isinstance(e, CallFailed) else CallFailed(job, e, None)  # 단계를 모르는 예상 밖 오류는 작업 이름으로
        http_status = f.error.status if isinstance(f.error, ProviderHttpError) else None
        why = f.detail()
        await ctx.status.failure(provider, at=datetime.now(UTC), error=why, http_status=http_status)
        ctx.db.record_run(job, provider, started, status="error", http_status=http_status, error_text=why)
        log.warning("%s/%s failed: %s", job, provider, f.log_text())
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
            errors.append({"feed": parse.__name__, "error": describe_error(e, limit=200)})
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
        ctx, name = self.ctx, self.awc.name
        try:
            intl = await _call(ctx, "sigmet", name, "isigmet", self.awc.isigmet)  # 실패하면 _guard 가 기록한다(발행하지 않음)
        except CallFailed:
            if not ctx.fixture:  # 세트 예산 2 중 미국 호출 몫 — 부르지 않으므로 돌려준다
                await ctx.budget.release(name, 1)
            raise
        try:
            us, err = await _call(ctx, "sigmet", name, "airsigmet", self.awc.airsigmet), None
        except CallFailed as f:  # 미국 경보 실패는 국제 경보를 막지 않는다(직전 미국 세트를 싣는다)
            us, err = None, f.detail(limit=200)
            log.warning("airsigmet failed: %s", f.log_text())
        return intl, us, err


class RadarJob:
    job_name = "radar"

    def __init__(self, rv: Any, ctx: JobContext):
        self.rv, self.ctx = rv, ctx

    async def run_once(self) -> None:
        ctx = self.ctx
        started, res = await _guard(
            ctx, "radar", self.rv.name, 1, lambda: _call(ctx, "radar", self.rv.name, "frames", self.rv.frames)
        )
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
        # 날짜변경선을 넘는 관심 지역은 상자 두 개로 나눠 묻는다(lomin > lomax 상자를 보내지 않는다, R-68). 조회마다 예산 1.
        got: list[tuple[datetime, Any]] = []
        boxes = boxes_around(lat, lon, radius)
        for lamin, lomin, lamax, lomax in boxes:
            b = (lamin, lomin, lamax, lomax)
            step = "metar bbox " + ",".join(f"{v:.2f}" for v in b)  # 상자 둘(날짜변경선)이면 어느 쪽이 실패했는지
            started_i, res_i = await _guard(
                ctx,
                "metar",
                self.awc.name,
                1,
                lambda b=b, step=step: _call(ctx, "metar", self.awc.name, step, lambda: self.awc.metar_bbox(*b)),
            )
            if res_i is not None:
                got.append((started_i, res_i))
        if not got:
            return
        started, res = got[0]
        raw_ref = res.extra.get("raw_ref") or await archive(ctx.raw, "awc_metar", res.raw, res.fetched_at)
        for _s, extra_res in got[1:]:
            if not extra_res.extra.get("raw_ref"):
                await archive(ctx.raw, "awc_metar", extra_res.raw, extra_res.fetched_at)
        airports: list[dict[str, Any]] = []
        obs: list[dict[str, Any]] = []
        bad: list[tuple[str, str | None, dict[str, Any]]] = []
        seen: set[tuple[str, datetime]] = set()  # 두 상자에 같은 관측이 오면 한 번만
        for _s, r_i in got:
            for it in r_i.data:
                try:
                    row = metar_row(it, self.awc.name, r_i.fetched_at) if isinstance(it, dict) else None
                except (TypeError, ValueError, OverflowError) as e:
                    bad.append(
                        ("metar_parse_error", None, {"icao": str(it.get("icaoId"))[:8], "error": describe_error(e, limit=200)})
                    )
                    continue
                if row is not None and (row[1]["icao"], row[1]["obs_time"]) not in seen:
                    seen.add((row[1]["icao"], row[1]["obs_time"]))
                    airports.append(row[0])
                    obs.append(row[1])
        # METAR 의 출력은 DB 뿐이다 — 쓰기는 writer 가 순서대로(airport → metar_obs, FK) 처리한다
        ctx.db.upsert_airports(airports)
        ctx.db.upsert_metar(obs)
        if len(got) < len(boxes):
            # 상자 하나가 실패했다(실패·예산 없음은 _guard 가 이미 기록). 받은 쪽 관측은 실자료라 저장하지만, 관심 지역 일부가
            # 갱신되지 않았으므로 성공(ok 실행 · 공급자 상태 success · heartbeat)을 쓰지 않는다 — 운영 화면이 정상으로 보이지 않게.
            log.warning(
                "metar: %d of %d boxes failed — %d stations stored, not reported as success",
                len(boxes) - len(got),
                len(boxes),
                len(obs),
            )
            return
        await _ok(ctx, "metar", started, self.awc.name, res, records=len(obs), quarantined=len(bad), raw_ref=raw_ref, quality=bad)
        await ctx.status.heartbeat("metar", lag_s=None, fixture=ctx.fixture)  # 자료 나이를 재지 않는다 — 0 이 아니라 모름(R-20)
        log.info("metar: %d stations", len(obs))
