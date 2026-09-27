"""관심 지역(10 s) · 전세계(120 s) 항공기 수집 작업.

실시간 경로: 공급자 선택 → 예산 예약 → 호출 → 정규화·품질 게이트 → Redis 발행.
DB 기록(ingest_run·품질)은 발행 뒤 큐에 넣기만 하고(비동기 writer), 상태·예산 조회의 Redis 오류는 삼킨다.
그래서 이 작업이 실패로 끝나는(스케줄러 백오프) 경우는 예상하지 못한 코드 오류뿐이다.
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime, timedelta

import httpx

from wakeline_collector.budget import UNKNOWN
from wakeline_collector.config import settings
from wakeline_collector.fallback import ProviderChain
from wakeline_collector.http import ProviderHttpError
from wakeline_collector.jobs.context import JobContext
from wakeline_collector.normalize import from_opensky, from_readsb
from wakeline_collector.publisher import STREAM_AIRCRAFT
from wakeline_collector.quality import AircraftGate

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
            await ctx.status.heartbeat(self.job_name, lag_s=None, fixture=ctx.fixture)
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
            self.chain.mark_down(prov.name, 60 if unavailable else 600)
            log.warning("%s: %s budget %s", self.scope, prov.name, "unavailable" if unavailable else "exhausted")
            return
        try:
            result = await (prov.fetch_global() if need_global else prov.fetch_region(lat, lon, radius))
        except Exception as e:  # noqa: BLE001 — 모든 공급자 실패는 기록·폴백으로 흡수
            await self._on_fetch_error(prov.name, cost, started, e)
            return

        raw_ref = result.extra.get("raw_ref") or ctx.raw.save(prov.name, result.raw, result.fetched_at)
        fetched_at = result.fetched_at
        if prov.name == "opensky":
            vectors = result.data.get("states") or []
            states = [from_opensky(v, fetched_at) for v in vectors]
        else:
            states = [from_readsb(ac, prov.name, fetched_at) for ac in result.data.get("ac") or []]
        missing = sum(1 for s in states if s is None)
        gate = self.gate.apply(states, missing, datetime.now(UTC))
        payload = {
            "region": None if need_global else {"lat": lat, "lon": lon, "radius_nm": radius},
            "states": [s.model_dump(mode="json") for s in gate.kept],
        }
        fields = ctx.publisher.envelope(
            kind="aircraft",
            scope=self.scope,
            provider=prov.name,
            fetched_at=fetched_at,
            raw_ref=raw_ref,
            count=len(gate.kept),
            payload=payload,
        )
        await ctx.publisher.publish(STREAM_AIRCRAFT, fields)

        # ---- 이하 부가 기록(실패해도 다음 주기에 영향 없음) ----
        ctx.db.record_run(
            self.job_name,
            prov.name,
            started,
            status="ok",
            http_status=result.http_status,
            latency_ms=result.latency_ms,
            records_in=len(states),
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
        await ctx.status.heartbeat(self.job_name, lag_s=(datetime.now(UTC) - fetched_at).total_seconds(), fixture=ctx.fixture)
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

    async def _on_fetch_error(self, name: str, cost: int, started: datetime, e: Exception) -> None:
        ctx = self.ctx
        http_status = e.status if isinstance(e, ProviderHttpError) else None
        if isinstance(e, httpx.ConnectError | httpx.ConnectTimeout) and cost:
            await ctx.budget.release(name, cost)  # 연결조차 못 했으면 공급자 쪽 사용량도 없다
        await ctx.status.failure(name, at=datetime.now(UTC), error=repr(e), http_status=http_status)
        ctx.db.record_run(self.job_name, name, started, status="error", http_status=http_status, error_text=repr(e))
        if http_status == 429:
            wait = self.chain.record_rate_limited(name)
            log.warning("%s: %s rate limited (429) — backing off %.0f s", self.scope, name, wait)
        elif self.chain.record_failure(name):
            log.warning("%s: %s failed 3x — cooling down", self.scope, name)
        else:
            log.info("%s: %s failed (%s)", self.scope, name, type(e).__name__)
