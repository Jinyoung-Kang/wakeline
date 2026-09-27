"""관심 지역(10 s) · 전세계(120 s) 항공기 수집 작업."""

from __future__ import annotations

import logging
from datetime import UTC, datetime, timedelta

import httpx

from skywx_collector.config import settings
from skywx_collector.fallback import ProviderChain
from skywx_collector.http import ProviderHttpError
from skywx_collector.jobs.context import JobContext
from skywx_collector.normalize import from_opensky, from_readsb
from skywx_collector.publisher import STREAM_AIRCRAFT
from skywx_collector.quality import AircraftGate

log = logging.getLogger("job.aircraft")


class AircraftJob:
    def __init__(self, scope: str, chain: ProviderChain, ctx: JobContext):
        assert scope in ("region", "global")
        self.scope = scope
        self.chain = chain
        self.ctx = ctx
        self.gate = AircraftGate()
        self._global_paused_until: datetime | None = None
        self._warned_no_provider = False

    @property
    def job_name(self) -> str:
        return self.scope

    async def run_once(self) -> None:
        ctx = self.ctx
        need_global = self.scope == "global"
        if need_global:
            if not ctx.rt.global_enabled:
                return
            if self._global_paused_until and datetime.now(UTC) < self._global_paused_until:
                return
        order = ["fixture"] if ctx.fixture else ctx.rt.provider_order
        prov = await self.chain.pick(order, need_global=need_global)
        if prov is None:
            await ctx.status.heartbeat(self.job_name, lag_s=None, fixture=ctx.fixture)
            if not self._warned_no_provider:
                log.warning("%s: no provider available%s", self.scope, " (opensky credentials not set)" if need_global else "")
                self._warned_no_provider = True
            return
        self._warned_no_provider = False
        lat, lon, radius = ctx.rt.region
        cost = prov.global_cost if need_global else prov.region_cost
        started = datetime.now(UTC)
        run_id = await ctx.db.start_run(self.job_name, prov.name, started)
        ok, used = await ctx.budget.reserve(prov.name, cost) if cost else (True, 0)
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
            self.chain.mark_down(prov.name, 600)
            log.warning("%s: budget exhausted for %s", self.scope, prov.name)
            return
        try:
            result = await (prov.fetch_global() if need_global else prov.fetch_region(lat, lon, radius))
        except Exception as e:  # noqa: BLE001 — 모든 실패는 기록·폴백으로 흡수
            http_status = e.status if isinstance(e, ProviderHttpError) else None
            if isinstance(e, httpx.ConnectError | httpx.ConnectTimeout) and cost:
                await ctx.budget.release(prov.name, cost)
            await ctx.status.failure(prov.name, at=datetime.now(UTC), error=repr(e), http_status=http_status)
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
            if http_status == 429:
                wait = self.chain.record_rate_limited(prov.name)
                log.warning("%s: %s rate limited (429) — backing off %.0f s", self.scope, prov.name, wait)
            elif self.chain.record_failure(prov.name):
                log.warning("%s: %s failed 3x — cooling down", self.scope, prov.name)
            return

        raw_ref = result.extra.get("raw_ref") or ctx.raw.save(prov.name, result.raw, result.fetched_at)
        fetched_at = result.fetched_at
        if prov.name == "opensky":
            vectors = result.data.get("states") or []
            states = [from_opensky(v, fetched_at) for v in vectors]
            if (
                result.budget
                and result.budget.remaining is not None
                and result.budget.remaining < settings.opensky_reserve_credits
            ):
                midnight = datetime.now(UTC).replace(hour=0, minute=0, second=0, microsecond=0)
                self._global_paused_until = midnight + timedelta(days=1)
                log.warning(
                    "opensky credits %s < reserve %s — global paused until next day",
                    result.budget.remaining,
                    settings.opensky_reserve_credits,
                )
        else:
            provider_label = prov.name
            states = [from_readsb(ac, provider_label, fetched_at) for ac in result.data.get("ac") or []]
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
            run_id=str(run_id),
            payload=payload,
        )
        await ctx.publisher.publish(STREAM_AIRCRAFT, fields)
        await ctx.db.quality_events(run_id, [(q.rule, q.hex, q.detail) for q in gate.quarantined])
        await ctx.db.finish_run(
            run_id,
            status="ok",
            http_status=result.http_status,
            latency_ms=result.latency_ms,
            records_in=len(states),
            records_quarantined=len(gate.quarantined),
            raw_ref=raw_ref,
            error_text=None,
        )
        used, limit = await ctx.budget.usage(prov.name)
        await ctx.status.success(
            prov.name,
            at=fetched_at,
            latency_ms=result.latency_ms,
            records=len(gate.kept),
            used=used,
            limit=limit,
            remaining=result.budget.remaining if result.budget else None,
            scope=self.scope,
        )
        await ctx.status.heartbeat(self.job_name, lag_s=(datetime.now(UTC) - fetched_at).total_seconds(), fixture=ctx.fixture)
        self.chain.record_success(prov.name)
        log.info(
            "%s: %s %d states (%d quarantined) %d ms",
            self.scope,
            prov.name,
            len(gate.kept),
            len(gate.quarantined),
            result.latency_ms,
        )
