"""관심 지역(10 s) · 전세계(120 s) 항공기 수집 작업.

실시간 경로: 공급자 선택 → 예산 예약 → 호출 → 정규화·품질 게이트 → Redis 발행.
DB 기록(ingest_run·품질)은 발행 뒤 큐에 넣기만 하고(비동기 writer), 상태·예산 조회의 Redis 오류는 삼킨다.
그래서 이 작업이 실패로 끝나는(스케줄러 백오프) 경우는 예상하지 못한 코드 오류뿐이다.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import UTC, datetime, timedelta
from typing import Any

import httpx

from wakeline_collector.budget import UNKNOWN
from wakeline_collector.config import settings
from wakeline_collector.errors import describe_error
from wakeline_collector.fallback import ProviderChain
from wakeline_collector.http import ProviderHttpError
from wakeline_collector.jobs.context import JobContext
from wakeline_collector.models import AircraftState
from wakeline_collector.normalize import Rejected, normalize_opensky, normalize_readsb, readsb_reference_time
from wakeline_collector.publisher import STREAM_AIRCRAFT
from wakeline_collector.quality import AircraftGate, Quarantine
from wakeline_collector.ratelimit import Throttled
from wakeline_collector.raw_store import archive
from wakeline_collector.status import newest_age_s

log = logging.getLogger("job.aircraft")


def next_utc_midnight(now: datetime | None = None) -> datetime:
    now = now or datetime.now(UTC)
    return now.astimezone(UTC).replace(hour=0, minute=0, second=0, microsecond=0) + timedelta(days=1)


class AircraftJob:
    def __init__(self, scope: str, chain: ProviderChain, ctx: JobContext):
        assert scope in ("region", "global")
        self.scope = scope
        self.chain = chain
        self.ctx = ctx
        self.gate = AircraftGate()
        self._warned_no_provider = False

    @property
    def job_name(self) -> str:
        return self.scope

    async def run_once(self) -> None:
        ctx = self.ctx
        need_global = self.scope == "global"
        if need_global and not ctx.rt.global_enabled:
            return
        order = ["fixture"] if ctx.fixture else ctx.rt.provider_order
        prov = await self.chain.pick(order, need_global=need_global)
        if prov is None:
            await ctx.status.heartbeat(self.job_name, lag_s=None, fixture=ctx.fixture, extra=self._hb_extra())
            if not self._warned_no_provider:
                log.warning("%s: no provider available (not configured, disabled, cooling down or paused)", self.scope)
                self._warned_no_provider = True
            return
        self._warned_no_provider = False
        lat, lon, radius = ctx.rt.region
        cost = prov.global_cost if need_global else prov.region_cost
        started = datetime.now(UTC)
        ok, used = await ctx.budget.reserve(prov.name, cost) if cost else (True, 0)
        if not ok:
            unavailable = used == UNKNOWN
            ctx.db.record_run(
                self.job_name,
                prov.name,
                started,
                status="budget_unavailable" if unavailable else "budget_exhausted",
                error_text="budget store unavailable (fail closed)" if unavailable else f"daily budget exhausted (used={used})",
            )
            self.chain.mark_down(
                prov.name, 60 if unavailable else 600, why="예산 저장소 불가(60 s 쉼)" if unavailable else "예산 소진(10분 쉼)"
            )
            log.warning("%s: %s budget %s", self.scope, prov.name, "unavailable" if unavailable else "exhausted")
            return
        try:
            result = await (prov.fetch_global() if need_global else prov.fetch_region(lat, lon, radius))
        except Exception as e:  # noqa: BLE001 — 모든 공급자 실패는 기록·폴백으로 흡수
            await self._on_fetch_error(prov.name, cost, started, e)
            return

        raw_ref = result.extra.get("raw_ref") or await archive(ctx.raw, prov.name, result.raw, result.fetched_at)
        fetched_at = result.fetched_at
        # 정규화·게이트·gzip 인코딩은 CPU 작업(전세계 약 6,600대 ≈ 100 ms) — 스레드에서(R-21). self.gate 는 이 작업만 쓴다.
        results, gate, fields = await asyncio.to_thread(self._process, prov.name, result, raw_ref, (lat, lon, radius))
        await ctx.publisher.publish(STREAM_AIRCRAFT, fields)

        # ---- 이하 부가 기록(실패해도 다음 주기에 영향 없음) ----
        ctx.db.record_run(
            self.job_name,
            prov.name,
            started,
            status="ok",
            http_status=result.http_status,
            latency_ms=result.latency_ms,
            records_in=len(results),
            records_quarantined=len(gate.quarantined),
            raw_ref=raw_ref,
            quality=[(q.rule, q.hex, q.detail) for q in gate.quarantined],
        )
        used_now, limit = await ctx.budget.usage(prov.name)
        remaining = result.budget.remaining if result.budget else None
        await ctx.status.success(
            prov.name,
            at=fetched_at,
            latency_ms=result.latency_ms,
            records=len(gate.kept),
            used=used_now,
            limit=limit,
            remaining=remaining,
            scope=self.scope,
        )
        await ctx.status.heartbeat(  # lag_s = 발행한 가장 새 관측의 나이(R-20, 처리 시간이 아니다)
            self.job_name, lag_s=newest_age_s(st.seen_at for st in gate.kept), fixture=ctx.fixture, extra=self._hb_extra()
        )
        self.chain.record_success(prov.name)
        if remaining is not None and remaining < settings.opensky_reserve_credits and hasattr(prov, "paused_until"):
            # 공급자 객체에 건다 → region·global 두 체인이 모두 건너뛴다
            prov.paused_until = next_utc_midnight()
            log.warning(
                "%s credits %s < reserve %s — paused until %s",
                prov.name,
                remaining,
                settings.opensky_reserve_credits,
                prov.paused_until.isoformat(),
            )
        log.info(
            "%s: %s %d states (%d quarantined) %d ms",
            self.scope,
            prov.name,
            len(gate.kept),
            len(gate.quarantined),
            result.latency_ms,
        )

    def _process(
        self, provider: str, result: Any, raw_ref: str, region: tuple[float, float, int]
    ) -> tuple[list, Any, dict[str, str]]:
        """응답 → (정규화 결과, 게이트 결과, 발행 필드). 이벤트 루프 밖(스레드)에서 돈다."""
        fetched_at = result.fetched_at
        if provider == "opensky":
            results = [normalize_opensky(v, fetched_at) for v in result.data.get("states") or []]
        else:
            ref = readsb_reference_time(result.data, fetched_at)
            results = [
                normalize_readsb(ac, provider, fetched_at, ref) for ac in result.data.get("ac") or [] if isinstance(ac, dict)
            ]
        states = [r for r in results if isinstance(r, AircraftState)]
        pre = [Quarantine(r.rule, r.hex, r.detail) for r in results if isinstance(r, Rejected)]
        gate = self.gate.apply(states, 0, datetime.now(UTC), pre=pre)
        lat, lon, radius = region
        payload = {
            "region": None if self.scope == "global" else {"lat": lat, "lon": lon, "radius_nm": radius},
            "states": [s.model_dump(mode="json") for s in gate.kept],
        }
        fields = self.ctx.publisher.envelope(
            kind="aircraft",
            scope=self.scope,
            provider=provider,
            fetched_at=fetched_at,
            raw_ref=raw_ref,
            count=len(gate.kept),
            payload=payload,
        )
        return results, gate, fields

    def _hb_extra(self) -> dict[str, str] | None:
        """관심 지역 heartbeat 에 실제 주기를 함께 싣는다 — 헬스체크 기준이 주기를 따른다(COL-5)."""
        return {"region_poll_s": str(self.ctx.rt.region_poll_s)} if self.scope == "region" else None

    async def _on_fetch_error(self, name: str, cost: int, started: datetime, e: Exception) -> None:
        ctx = self.ctx
        if isinstance(e, Throttled):
            await self._on_throttled(name, cost, started, e)
            return
        http_status = e.status if isinstance(e, ProviderHttpError) else None
        if isinstance(e, httpx.ConnectError | httpx.ConnectTimeout) and cost:
            await ctx.budget.release(name, cost)  # 연결조차 못 했으면 공급자 쪽 사용량도 없다
        why = describe_error(e)
        await ctx.status.failure(name, at=datetime.now(UTC), error=why, http_status=http_status)
        ctx.db.record_run(self.job_name, name, started, status="error", http_status=http_status, error_text=why)
        if http_status == 429:
            wait = await self.chain.on_rate_limited(name)  # 적고 저장 — 재시작해도 쉼·미룸을 잇는다(Redis 오류는 삼킨다)
            log.warning("%s: %s rate limited (429) — backing off %.0f s%s", self.scope, name, wait, await self._after_429(name))
        elif self.chain.record_failure(name):
            log.warning("%s: %s failed 3x — cooling down", self.scope, name)
        else:
            log.info("%s: %s failed (%s)", self.scope, name, why)

    async def _after_429(self, name: str) -> str:
        """429 경고 뒤에 붙이는 '다음에 무엇을 하는가' — 체인이 다음 주기에 고를 공급자(추정이 아니라 지금 상태로 정해진 값)."""
        order = ["fixture"] if self.ctx.fixture else self.ctx.rt.provider_order
        nxt = await self.chain.peek(order, need_global=self.scope == "global")
        hold = self.chain.hold_s(name)
        held = f"; repeated 429 → deferred {hold / 60:.0f} min" if hold else ""
        if nxt is None or nxt == name:  # 미룸은 선호도일 뿐 — 대안이 없으면 쉼이 끝난 뒤 같은 공급자를 쓴다
            tail = f"no other provider — {name} again after the backoff"
            return f"{held}, but {tail}" if held else f"; {tail}"
        return f"{held}, {nxt} takes over"

    async def _on_throttled(self, name: str, cost: int, started: datetime, e: Throttled) -> None:
        """속도 상한이 막아 호출하지 않았다 — 공급자 실패가 아니다. 3회 규칙·공급자 상태 해시에 넣지 않는다.
        429 쿨다운 때문이면(다른 작업이 받은 429 포함) 그 남은 시간만 이 공급자를 건너뛴다(다음 순위로 폴백할 수 있게)."""
        if cost:
            await self.ctx.budget.release(name, cost)
        self.ctx.db.record_run(self.job_name, name, started, status="throttled", error_text=describe_error(e))
        if e.cooldown_s > 0:
            self.chain.mark_down(name, e.cooldown_s, why=f"호출 제한기 429 쿨다운({e.cooldown_s:.0f} s)")
        log.info("%s: %s not called (%s)", self.scope, name, e.reason)
