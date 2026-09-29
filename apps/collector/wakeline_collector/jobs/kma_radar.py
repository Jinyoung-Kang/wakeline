"""기상청 레이더 합성 수집(5분): 목록에서 저장된 최신 프레임보다 새 tm 만 고르고 → 바이너리 → 해석·웹 메르카토르 PNG → Redis(최근 12프레임).
활용신청 전(403)에는 사유만 상태에 남긴다. 격자·투영은 문서 값(kma_grid.py 참조)만 쓴다.

- 예산: budget:kma_radar(한도 settings.budget_kma_radar)로 목록·바이너리 호출을 모두 예약한다. Redis 가 안 되면 호출하지 않는다.
- 후보: 보관 창(현재 이하 목록의 최신 12개) 안에서 아직 저장되지 않은 tm 중 최신 4개(R-03). 저장된 최신보다 오래됐어도
  창 안의 빈 프레임(늦게 생긴 프레임·일시 오류로 놓친 프레임)은 채우고, 창보다 오래된 프레임은 받지 않는다.
- 목록에 있으나 바이너리가 아직 없는 tm("file not exist" 등 gzip 아닌 응답)은 일시 상태다. tm 마다 MAX_NOT_READY_TRIES 번까지
  다음 주기에 다시 받고, 그래도 없으면 품질 이벤트(kma_radar_missing)를 남기고 건너뛴다. 해석 불가(_BadFrame·크기 초과)만 바로 제외한다.
- KST 자정 직후(00:00–00:14)에는 전날 목록도 본다(전날 23:5x 프레임이 아직 보관 창 안이다). 덧붙이는 목록이라 예산이 없거나
  실패하면 오늘 목록만으로 주기를 계속한다.
- 목록(frames)과 이미지(frame:{tm}) 일관성: 목록에서 빠진 프레임의 이미지는 지우고, 이미지가 없어진 항목은 목록에서 뺀다.
  목록 키도 이미지와 같은 TTL 을 갖는다(수집기가 멈추면 함께 만료). 각 항목에 expires_at 을 둔다.
- 해석(gzip 해제·재투영·PNG)은 CPU 작업이라 스레드에서 돈다(이벤트 루프를 막지 않게).
- 일시 오류(시간 초과 · 연결 실패 · 프로토콜 오류 — RETRY_ERRORS)는 같은 주기 안에서 RETRY_DELAY_S 뒤 한 번 다시 부른다(예산 1 을 따로
  예약한다). 다시 부르기는 한 주기에 MAX_RETRIES_PER_CYCLE 번뿐이다 — 최악 5호출 × 40 s + 5 s + 40 s = 245 s 가 주기(300 s) 안에 든다.
  HTTP 오류(ProviderHttpError — 403 활용신청 전 등)·속도 상한(Throttled)은 다시 부르지 않는다. 5 s·1회는 선택값이다(재어서 정한 값이 아니다).
- 실패 기록(상태 last_error · 실행 기록 · 경고 로그)에는 실패한 단계(목록 날짜 · 바이너리 tm)와 그 호출에 걸린 시간을 싣는다.
"""

from __future__ import annotations

import asyncio
import base64
import concurrent.futures
import functools
import logging
import time
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime, timedelta

import httpx
import orjson

from wakeline_collector.budget import UNKNOWN
from wakeline_collector.errors import describe_error
from wakeline_collector.http import ProviderHttpError, ResponseTooLarge
from wakeline_collector.jobs.context import JobContext
from wakeline_collector.kma_grid import read_echo, render_mercator_png
from wakeline_collector.models import ProviderResult
from wakeline_collector.providers.kma_radar import KmaRadarProvider, kst_now
from wakeline_collector.ratelimit import Throttled
from wakeline_collector.raw_store import archive

log = logging.getLogger("job.kma_radar")
KEY_META = "wakeline:radar_kr:meta"  # hash
KEY_FRAMES = "wakeline:radar_kr:frames"  # JSON list (오래된 → 최신)
KEY_FRAME = "wakeline:radar_kr:frame:{tm}"  # base64 PNG, TTL
KEEP_FRAMES = 12
MAX_PER_CYCLE = 4
FRAME_TTL_S = 3 * 3600
MAX_BAD = 64  # 해석 불가로 건너뛴 tm 기억 상한
MAX_NOT_READY_TRIES = 3  # 목록에 있으나 아직 받을 수 없는 tm 을 다시 시도하는 횟수(주기마다 1번 ≈ 15분)
PREV_DAY_LIST_MIN = 15  # KST 00:00 부터 이 분 동안은 전날 목록도 조회
RETRY_DELAY_S = 5.0  # 일시 오류 뒤 같은 주기 안에서 다시 부르기 전 기다림(선택값)
MAX_RETRIES_PER_CYCLE = 1  # 주기 시간 상한을 지키려고 한 주기에 한 번만(선택값)
# 다시 불러 볼 만한 일시 오류. RequestTimedOut(전체 상한 초과)은 httpx.TimeoutException 하위라 여기 든다.
RETRY_ERRORS: tuple[type[Exception], ...] = (httpx.TimeoutException, httpx.ConnectError, httpx.RemoteProtocolError)
_sleep = asyncio.sleep  # 시험이 바꿔 끼운다


def _iso(dt: datetime) -> str:
    return dt.astimezone(UTC).isoformat().replace("+00:00", "Z")


def select_candidates(
    listing: list[str], stored: list[str], now_tm: str, bad: set[str] | frozenset[str] = frozenset()
) -> list[str]:
    """보관 창(현재 시각 이하 목록의 최신 KEEP_FRAMES 개) 안에서 아직 저장되지 않은 tm 중 최신 MAX_PER_CYCLE 개(오름차순).
    창보다 오래된 tm 은 받아도 곧바로 밀려나므로 고르지 않는다."""
    window = sorted({tm for tm in listing if tm <= now_tm})[-KEEP_FRAMES:]
    have = set(stored)
    return [tm for tm in window if tm not in have and tm not in bad][-MAX_PER_CYCLE:]


# 격자 해석(수십 MB numpy 버퍼)은 전용 스레드 하나에서만 — 공용 기본 풀(asyncio.to_thread, 최대 8)의 아무 스레드에서 돌면 스레드마다
# glibc malloc 아레나가 최고점을 따로 쥐어 RSS 가 계단식으로 늘었다(리뷰 4단계 측정). 해석은 원래 한 번에 하나씩이라 처리량 차이는 없다.
_DECODE_POOL = concurrent.futures.ThreadPoolExecutor(max_workers=1, thread_name_prefix="kma-decode")


def _decode(raw: bytes):
    header, grid = read_echo(raw)
    png, meta = render_mercator_png(header, grid)
    return header, png, meta


class _BadFrame(Exception):
    """이 tm 의 자료 자체가 해석 불가(폭탄·형식 오류). 다시 받아도 같으므로 건너뛴다."""


class _StepFailed(Exception):
    """한 단계(목록 · 바이너리)의 호출 실패. error = 마지막 시도의 예외, elapsed_s = 그 시도에 걸린 시간(모르면 None),
    first = 다시 불렀다면 첫 시도의 (예외, 걸린 시간)."""

    def __init__(
        self, step: str, error: Exception, elapsed_s: float | None, first: tuple[Exception, float] | None = None
    ) -> None:
        super().__init__(f"{step}: {type(error).__name__}")
        self.step, self.error, self.elapsed_s, self.first = step, error, elapsed_s, first


class KmaRadarJob:
    job_name = "radar_kr"

    def __init__(self, provider: KmaRadarProvider, ctx: JobContext):
        self.p, self.ctx = provider, ctx
        self._warned = False
        self._bad: dict[str, None] = {}  # 삽입 순서 유지(오래된 것부터 버림)
        self._not_ready: dict[str, int] = {}  # tm → '아직 없음' 응답 횟수(R-03)
        self._retries_left = MAX_RETRIES_PER_CYCLE

    async def _frames(self) -> list[dict]:
        raw = await self.ctx.status.redis.get(KEY_FRAMES)
        try:
            frames = orjson.loads(raw) if raw else []
        except orjson.JSONDecodeError:
            return []
        return [f for f in frames if isinstance(f, dict) and isinstance(f.get("tm"), str)] if isinstance(frames, list) else []

    async def _save_frames(self, frames: list[dict]) -> None:
        """목록 저장 + 일관성: 목록 키 TTL = 가장 새 이미지의 남은 TTL(expires_at). 비면 키를 지우고 available=0."""
        r = self.ctx.status.redis
        if not frames:
            await r.delete(KEY_FRAMES)
            await r.hset(KEY_META, "available", "0")
            return
        ttl = FRAME_TTL_S
        try:
            exp = datetime.fromisoformat(str(frames[-1].get("expires_at", "")).replace("Z", "+00:00"))
            ttl = max(1, min(FRAME_TTL_S, int((exp - datetime.now(UTC)).total_seconds())))
        except ValueError:
            pass  # 옛 항목(expires_at 없음) — 최대 TTL
        await r.set(KEY_FRAMES, orjson.dumps(frames).decode(), ex=ttl)

    async def prune(self) -> list[dict]:
        """이미지가 만료·삭제된 항목을 목록에서 뺀다. 남은 목록을 돌려준다(비었으면 available=0)."""
        r = self.ctx.status.redis
        frames = await self._frames()
        if frames:
            pipe = r.pipeline(transaction=False)
            for f in frames:
                pipe.exists(KEY_FRAME.format(tm=f["tm"]))
            flags = await pipe.execute()
            kept = [f for f, ok in zip(frames, flags, strict=True) if ok]
            if len(kept) == len(frames):
                return kept
            log.info("kma radar: pruned %d list entries whose image expired", len(frames) - len(kept))
            frames = kept
        await self._save_frames(frames)
        return frames

    async def _fail(self, started: datetime, f: _StepFailed) -> None:
        e = f.error
        http_status = e.status if isinstance(e, ProviderHttpError) else None
        note = "활용신청 필요(API허브에서 레이더합성자료 신청 후 승인 대기)" if http_status == 403 else f"{type(e).__name__}"
        why = describe_error(e)  # 가린 한 줄(R-83: 응답 본문 앞부분이 실릴 수 있다)
        took = f" · {f.elapsed_s:.1f} s 경과" if f.elapsed_s is not None else ""
        retried = ""
        if f.first is not None:
            first_e, first_s = f.first
            retried = f" · {RETRY_DELAY_S:.0f} s 뒤 1회 재시도(첫 시도 {type(first_e).__name__} · {first_s:.1f} s)"
        detail = f"{why} · {f.step}{took}{retried}"
        await self.ctx.status.failure(
            self.p.name, at=datetime.now(UTC), error=note if http_status == 403 else detail, http_status=http_status
        )
        self.ctx.db.record_run(self.job_name, self.p.name, started, status="error", http_status=http_status, error_text=detail)
        await self.ctx.status.hset_meta(
            KEY_META, {"status": str(http_status or ""), "note": note[:200], "checked_at": _iso(datetime.now(UTC))}
        )
        if http_status == 403:
            log.warning("kma radar: %s — %s", f.step, note)
            return
        after = f" after {f.elapsed_s:.1f} s" if f.elapsed_s is not None else ""
        again = ""
        if f.first is not None:
            first_e, first_s = f.first
            again = f"; retried once after {RETRY_DELAY_S:.0f} s (first attempt: {type(first_e).__name__} after {first_s:.1f} s)"
        log.warning("kma radar: %s — %s%s%s", f.step, why, after, again)

    async def _call(self, step: str, fn: Callable[[], Awaitable[ProviderResult]]) -> ProviderResult:
        """step 호출. 실패는 모두 _StepFailed(단계·걸린 시간)로 올린다. 일시 오류(RETRY_ERRORS)면 이 주기의 재시도가 남아 있고
        예산 1 을 예약할 수 있을 때 RETRY_DELAY_S 뒤 한 번 다시 부른다. HTTP 오류·속도 상한은 다시 부르지 않는다."""
        t0 = time.monotonic()
        try:
            return await fn()
        except RETRY_ERRORS as e:
            first, first_s = e, time.monotonic() - t0
        except Exception as e:  # noqa: BLE001 — 호출자가 종류별로 나눈다(해석 불가·아직 없음·실패)
            raise _StepFailed(step, e, time.monotonic() - t0) from e
        if self._retries_left <= 0:
            raise _StepFailed(step, first, first_s) from first
        ok, used = await self.ctx.budget.reserve(self.p.name, 1)
        if not ok:
            log.info(
                "kma radar: %s — %s after %.1f s; not retried (budget %s)",
                step,
                describe_error(first),
                first_s,
                "unavailable" if used == UNKNOWN else f"exhausted (used={used})",
            )
            raise _StepFailed(step, first, first_s) from first
        self._retries_left -= 1
        log.info("kma radar: %s — %s after %.1f s — retrying once in %.0f s", step, describe_error(first), first_s, RETRY_DELAY_S)
        await _sleep(RETRY_DELAY_S)
        t1 = time.monotonic()
        try:
            return await fn()
        except Exception as e:  # noqa: BLE001
            raise _StepFailed(step, e, time.monotonic() - t1, first=(first, first_s)) from e

    async def _reserve(self, started: datetime) -> bool:
        ok, used = await self.ctx.budget.reserve(self.p.name, 1)
        if not ok:
            unavailable = used == UNKNOWN
            self.ctx.db.record_run(
                self.job_name,
                self.p.name,
                started,
                status="budget_unavailable" if unavailable else "budget_exhausted",
                error_text="budget store unavailable (fail closed)" if unavailable else f"daily budget exhausted (used={used})",
            )
            log.warning("kma radar: budget %s", "unavailable" if unavailable else f"exhausted (used={used})")
        return ok

    def _mark_bad(self, tm: str) -> None:
        self._not_ready.pop(tm, None)
        self._bad[tm] = None
        while len(self._bad) > MAX_BAD:
            self._bad.pop(next(iter(self._bad)))

    def _not_ready_again(self, tm: str) -> int:
        """'아직 없음' 횟수를 1 늘려 돌려준다(기억 상한 MAX_BAD, 오래된 것부터 버림)."""
        n = self._not_ready.pop(tm, 0) + 1
        self._not_ready[tm] = n
        while len(self._not_ready) > MAX_BAD:
            self._not_ready.pop(next(iter(self._not_ready)))
        return n

    async def _listing(self):
        """오늘(KST) 목록. 자정 직후에는 전날 목록도 합친다. 첫 결과(오늘)를 돌려준다.
        전날 목록은 덧붙이는 것이다 — 예산이 없거나 호출이 실패하면 오늘 목록만 쓴다(주기를 잃지 않고, 실행 기록을 따로 남기지 않는다)."""
        now_kst = kst_now()
        day = now_kst.strftime("%Y%m%d")
        today = await self._call(f"listing {day}", lambda: self.p.file_list(day))
        if now_kst.hour != 0 or now_kst.minute >= PREV_DAY_LIST_MIN:
            return today
        ok, used = await self.ctx.budget.reserve(self.p.name, 1)
        if not ok:
            log.info(
                "kma radar: previous-day listing skipped — budget %s",
                "unavailable" if used == UNKNOWN else f"exhausted (used={used})",
            )
            return today
        prev_day = (now_kst - timedelta(days=1)).strftime("%Y%m%d")
        t0 = time.monotonic()
        try:
            prev = await self.p.file_list(prev_day)  # 덧붙이는 목록 — 다시 부르지 않는다(재시도는 오늘 목록·바이너리 몫)
        except Exception as e:  # noqa: BLE001
            log.warning(
                "kma radar: previous-day listing %s — %s after %.1f s — using today's only",
                prev_day,
                describe_error(e),
                time.monotonic() - t0,
            )
            return today
        today.data = sorted({*prev.data, *today.data})
        return today

    async def run_once(self) -> None:
        ctx = self.ctx
        if not self.p.configured:
            if not self._warned:
                log.info("kma radar: KMA_APIHUB_KEY not set — disabled")
                self._warned = True
            return
        stored = await self.prune()
        started = datetime.now(UTC)
        self._retries_left = MAX_RETRIES_PER_CYCLE
        if not await self._reserve(started):
            return
        try:
            listing = await self._listing()
        except _StepFailed as f:
            await self._fail(started, f)
            return
        except Exception as e:  # noqa: BLE001 — 목록 호출 밖(예: 전날 목록 준비)의 예상 밖 오류도 주기 실패로
            await self._fail(started, _StepFailed("listing", e, None))
            return
        now_tm = kst_now().strftime("%Y%m%d%H%M")
        candidates = select_candidates(listing.data, [f["tm"] for f in stored], now_tm, frozenset(self._bad))
        stored_n = 0
        quality: list[tuple[str, str | None, dict]] = []
        for tm in candidates:
            if not await self._reserve(started):
                break
            try:
                res = await self._call(f"binary tm={tm}", functools.partial(self.p.binary, tm))
            except _StepFailed as f:
                err = f.error
                if isinstance(err, ResponseTooLarge):
                    self._skip_bad(tm, err, quality)
                elif isinstance(err, ValueError):
                    self._not_ready_or_missing(tm, err, quality)
                elif isinstance(err, ProviderHttpError | httpx.HTTPError | OSError | Throttled):  # Throttled: 429 쿨다운 등
                    await self._fail(started, f)
                    return
                else:
                    raise err from None  # 예상 밖 — 스케줄러가 기록한다(이전과 같다)
                continue
            try:
                await self._store(tm, res)
            except _BadFrame as e:
                self._skip_bad(tm, e, quality)
                continue
            except OSError as e:
                await self._fail(started, _StepFailed(f"store tm={tm}", e, None))
                return
            self._not_ready.pop(tm, None)
            stored_n += 1
        ctx.db.record_run(
            self.job_name,
            self.p.name,
            started,
            status="ok",
            http_status=listing.http_status,
            latency_ms=listing.latency_ms,
            records_in=stored_n,
            records_quarantined=len(quality),
            quality=quality,
        )
        used, limit = await ctx.budget.usage(self.p.name)
        await ctx.status.success(
            self.p.name, at=datetime.now(UTC), latency_ms=listing.latency_ms, records=stored_n, used=used, limit=limit
        )
        if not stored_n:
            await ctx.status.hset_meta(KEY_META, {"checked_at": _iso(datetime.now(UTC)), "status": "200", "note": ""})
        await ctx.status.heartbeat(self.job_name, lag_s=None, fixture=ctx.fixture)  # 재지 않은 값은 0 이 아니라 모름(R-20)

    def _skip_bad(self, tm: str, e: Exception, quality: list[tuple[str, str | None, dict]]) -> None:
        """이 tm 의 자료 자체가 해석 불가(폭탄·형식 오류) — 다시 받아도 같으므로 기억해 두고 건너뛴다."""
        self._mark_bad(tm)
        quality.append(("kma_radar_parse", None, {"tm": tm, "error": str(e)[:200]}))
        log.warning("kma radar: tm=%s skipped — %s", tm, str(e)[:160])

    def _not_ready_or_missing(self, tm: str, e: Exception, quality: list[tuple[str, str | None, dict]]) -> None:
        """gzip 아닌 응답("file not exist" 등): 목록에는 있으나 바이너리가 아직 없다 — 다음 주기에 다시 받는다(R-03)."""
        tries = self._not_ready_again(tm)
        if tries < MAX_NOT_READY_TRIES:
            log.info("kma radar: tm=%s not available yet (try %d/%d)", tm, tries, MAX_NOT_READY_TRIES)
            return
        self._mark_bad(tm)
        quality.append(("kma_radar_missing", None, {"tm": tm, "tries": tries, "error": str(e)[:200]}))
        log.warning("kma radar: tm=%s still unavailable after %d tries — skipped: %s", tm, tries, str(e)[:160])

    async def _store(self, tm: str, res) -> None:
        ctx = self.ctx
        raw_ref = await archive(ctx.raw, "kma_radar", res.raw, res.fetched_at)  # 이미 gzip → 그대로 .bin.gz(R-21)
        try:
            header, png, meta = await asyncio.get_running_loop().run_in_executor(_DECODE_POOL, _decode, res.raw)
        except Exception as e:  # noqa: BLE001 — 해석 실패는 격리(원천은 남는다)
            raise _BadFrame(f"{type(e).__name__}: {e} (raw={raw_ref})") from e
        r = ctx.status.redis
        now = datetime.now(UTC)
        await r.set(KEY_FRAME.format(tm=tm), base64.b64encode(png).decode("ascii"), ex=FRAME_TTL_S)
        frames = [f for f in await self._frames() if f["tm"] != tm]
        frames.append(
            {
                "tm": tm,
                "obs_tm": header.tm.strftime("%Y%m%d%H%M"),
                "fetched_at": _iso(res.fetched_at),
                "expires_at": _iso(now + timedelta(seconds=FRAME_TTL_S)),
                "bytes": len(png),
                "echo_cells": meta["echo_cells"],
                "raw_ref": raw_ref,
            }
        )
        frames = sorted(frames, key=lambda f: f["tm"])
        dropped, frames = frames[:-KEEP_FRAMES], frames[-KEEP_FRAMES:]
        await self._save_frames(frames)
        if dropped:
            await r.delete(*[KEY_FRAME.format(tm=f["tm"]) for f in dropped])  # 목록에서 빠진 이미지는 바로 지운다
        mapping: dict[str, str] = {
            "available": "1",
            "status": "200",
            "note": "",
            "latest_tm": frames[-1]["tm"],
            "checked_at": _iso(now),
        }
        # 헤더 값·fetched_at 은 latest_tm 프레임을 설명한다. 보관 창 안의 오래된 빈 곳을 채운 경우(R-03)에는 그대로 둔다 —
        # 옛 프레임 값으로 덮으면 meta 가 latest_tm 과 다른 프레임을 설명하고, fetched_at 이 새로 보여 STALE 이 가려진다.
        if frames[-1]["tm"] == tm:
            mapping |= {
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
            }
        await r.hset(KEY_META, mapping=mapping)  # type: ignore[arg-type]
        log.info(
            "kma radar: tm=%s %s echo cells=%d png=%d B (%d frames)",
            tm,
            header.product,
            meta["echo_cells"],
            len(png),
            len(frames),
        )
