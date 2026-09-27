"""기상청 레이더 합성 수집(5분): 목록에서 저장된 최신 프레임보다 새 tm 만 고르고 → 바이너리 → 해석·웹 메르카토르 PNG → Redis(최근 12프레임).
활용신청 전(403)에는 사유만 상태에 남긴다. 격자·투영은 문서 값(kma_grid.py 참조)만 쓴다.

- 예산: budget:kma_radar(한도 settings.budget_kma_radar)로 목록·바이너리 호출을 모두 예약한다. Redis 가 안 되면 호출하지 않는다.
- 후보: 저장된 가장 새 프레임보다 새 것만(보관 창보다 오래된 프레임을 다시 받지 않는다). 첫 기동은 최신 4개.
- 목록(frames)과 이미지(frame:{tm}) 일관성: 목록에서 빠진 프레임의 이미지는 지우고, 이미지가 없어진 항목은 목록에서 뺀다.
  목록 키도 이미지와 같은 TTL 을 갖는다(수집기가 멈추면 함께 만료). 각 항목에 expires_at 을 둔다.
- 해석(gzip 해제·재투영·PNG)은 CPU 작업이라 스레드에서 돈다(이벤트 루프를 막지 않게).
"""

from __future__ import annotations

import asyncio
import base64
import logging
from datetime import UTC, datetime, timedelta

import httpx
import orjson

from wakeline_collector.budget import UNKNOWN
from wakeline_collector.http import ProviderHttpError, ResponseTooLarge
from wakeline_collector.jobs.context import JobContext
from wakeline_collector.kma_grid import read_echo, render_mercator_png
from wakeline_collector.providers.kma_radar import KmaRadarProvider, kst_now

log = logging.getLogger("job.kma_radar")
KEY_META = "wakeline:radar_kr:meta"  # hash
KEY_FRAMES = "wakeline:radar_kr:frames"  # JSON list (오래된 → 최신)
KEY_FRAME = "wakeline:radar_kr:frame:{tm}"  # base64 PNG, TTL
KEEP_FRAMES = 12
MAX_PER_CYCLE = 4
FRAME_TTL_S = 3 * 3600
MAX_BAD = 64  # 해석 불가로 건너뛴 tm 기억 상한


def _iso(dt: datetime) -> str:
    return dt.astimezone(UTC).isoformat().replace("+00:00", "Z")


def select_candidates(
    listing: list[str], stored: list[str], now_tm: str, bad: set[str] | frozenset[str] = frozenset()
) -> list[str]:
    """저장된 최신 프레임보다 새롭고 현재 시각 이하인 tm 중 최신 MAX_PER_CYCLE 개(오름차순)."""
    latest = max(stored, default="")
    return [tm for tm in listing if latest < tm <= now_tm and tm not in bad][-MAX_PER_CYCLE:]


def _decode(raw: bytes):
    header, grid = read_echo(raw)
    png, meta = render_mercator_png(header, grid)
    return header, png, meta


class _BadFrame(Exception):
    """이 tm 의 자료 자체가 해석 불가(폭탄·형식 오류). 다시 받아도 같으므로 건너뛴다."""


class KmaRadarJob:
    job_name = "radar_kr"

    def __init__(self, provider: KmaRadarProvider, ctx: JobContext):
        self.p, self.ctx = provider, ctx
        self._warned = False
        self._bad: dict[str, None] = {}  # 삽입 순서 유지(오래된 것부터 버림)

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

    async def _fail(self, started: datetime, e: Exception) -> None:
        http_status = e.status if isinstance(e, ProviderHttpError) else None
        note = "활용신청 필요(API허브에서 레이더합성자료 신청 후 승인 대기)" if http_status == 403 else f"{type(e).__name__}"
        await self.ctx.status.failure(
            self.p.name, at=datetime.now(UTC), error=note if http_status == 403 else repr(e), http_status=http_status
        )
        self.ctx.db.record_run(self.job_name, self.p.name, started, status="error", http_status=http_status, error_text=repr(e))
        await self.ctx.status.hset_meta(
            KEY_META, {"status": str(http_status or ""), "note": note[:200], "checked_at": _iso(datetime.now(UTC))}
        )
        log.warning("kma radar: %s", note if http_status == 403 else repr(e)[:160])

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
        self._bad[tm] = None
        while len(self._bad) > MAX_BAD:
            self._bad.pop(next(iter(self._bad)))

    async def run_once(self) -> None:
        ctx = self.ctx
        if not self.p.configured:
            if not self._warned:
                log.info("kma radar: KMA_APIHUB_KEY not set — disabled")
                self._warned = True
            return
        stored = await self.prune()
        started = datetime.now(UTC)
        if not await self._reserve(started):
            return
        try:
            listing = await self.p.file_list(kst_now().strftime("%Y%m%d"))
        except Exception as e:  # noqa: BLE001
            await self._fail(started, e)
            return
        now_tm = kst_now().strftime("%Y%m%d%H%M")
        candidates = select_candidates(listing.data, [f["tm"] for f in stored], now_tm, frozenset(self._bad))
        stored_n = 0
        quality: list[tuple[str, str | None, dict]] = []
        for tm in candidates:
            if not await self._reserve(started):
                break
            try:
                res = await self.p.binary(tm)
                await self._store(tm, res)
                stored_n += 1
            except (_BadFrame, ValueError, ResponseTooLarge) as e:
                # 이 tm 의 자료 자체가 문제(gzip 아님·"file not exist"·폭탄·형식 오류) — 건너뛰고 다음 후보로.
                # 다시 받아도 같으므로 기억해 두고 재시도하지 않는다(가장 오래된 후보에서 막혀 진행이 멈추지 않게).
                self._mark_bad(tm)
                quality.append(("kma_radar_parse", None, {"tm": tm, "error": str(e)[:200]}))
                log.warning("kma radar: tm=%s skipped — %s", tm, str(e)[:160])
            except (ProviderHttpError, httpx.HTTPError, OSError) as e:
                await self._fail(started, e)
                return
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
        await ctx.status.heartbeat(self.job_name, lag_s=0.0, fixture=ctx.fixture)

    async def _store(self, tm: str, res) -> None:
        ctx = self.ctx
        raw_ref = ctx.raw.save("kma_radar", res.raw, res.fetched_at)
        try:
            header, png, meta = await asyncio.to_thread(_decode, res.raw)
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
        await r.hset(
            KEY_META,
            mapping={
                "available": "1",
                "status": "200",
                "note": "",
                "latest_tm": frames[-1]["tm"],
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
                "checked_at": _iso(now),
            },
        )
        log.info(
            "kma radar: tm=%s %s echo cells=%d png=%d B (%d frames)",
            tm,
            header.product,
            meta["echo_cells"],
            len(png),
            len(frames),
        )
