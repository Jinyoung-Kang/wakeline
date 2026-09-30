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

# api 가 관심 지역 피드를 끊겼다고 보는 기준(EngineService.REGION_FEED_STALE_S · StatusService 의 region stale — 60 s). 다른 작업(focus · hot)이 받은 429 로
# 호출 제한기가 막은 호스트를 관심 지역이 기다려 줄지 이 값으로 정한다(_waits_out — 계약 v5 §G25 · ADR-011 '보강 3').
REGION_FEED_STALE_S = 60


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
        self._stood_down = False  # 작업이 꺼져(전세계 끔) 공급자 없음 필드를 비웠다 — 꺼진 동안 비울 때까지(비우면 한 번)
        # 이 작업의 마지막 호출 실패(공급자 · describe_error 글) — 성공하면 비운다. '공급자 없음' WARN 이 까닭으로 싣는다(속도 상한이 막은 호출은 실패가 아니다)
        self._last_error: tuple[str, str] | None = None

    @property
    def job_name(self) -> str:
        return self.scope

    async def run_once(self) -> None:
        ctx = self.ctx
        need_global = self.scope == "global"
        if need_global and not ctx.rt.global_enabled:
            if not self._stood_down:  # 꺼진 작업이 '공급자 없음'으로 남지 않게(앞선 프로세스가 남긴 값 포함 — 리뷰 2026-09-30)
                was = self.chain.none_elapsed_s()
                cleared = await self.chain.stand_down()  # 비우지 못했으면(Redis 오류) 다음 주기에 다시
                if was is not None:
                    log.info("%s: switched off — no-provider state cleared after %.0f s", self.scope, was)
                self._stood_down, self._warned_no_provider = cleared, False
            return
        self._stood_down = False
        order = ["fixture"] if ctx.fixture else ctx.rt.provider_order
        none_s = self.chain.none_elapsed_s()  # 공급자 없음이 이어지던 시간(고르면 체인이 비운다)
        prov = await self.chain.pick(order, need_global=need_global)
        if self.chain.none_since is not None:  # 고를 공급자가 없거나 쉬는 공급자를 다시 시도한다 — 일하는 공급자가 없다
            self._warn_no_provider()
        elif self._warned_no_provider or none_s is not None:
            self._available_again(none_s or 0.0, prov.name if prov is not None else "—")
        if prov is None:
            await ctx.status.heartbeat(self.job_name, lag_s=None, fixture=ctx.fixture, extra=self._hb_extra())
            return
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
        self._last_error = None
        gap = await self.chain.succeeded(prov.name)  # 다시 시도한 공급자가 답했으면 공급자 없음이 끝난다
        if gap is not None:
            self._available_again(gap, prov.name)
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

    def _warn_no_provider(self) -> None:
        """공백마다 WARN 한 번. 건너뛴 까닭 · next(다시 시도하는 쉬는 공급자 · 가장 먼저 풀리는 공급자 — 체인 상태)는 따옴표 안(지문에서 지워진다), 마지막 호출
        실패(공급자 · 오류 글)는 따옴표 밖 — 오류 글의 앞머리가 종류라(errors.py) 로그 지문이 오류 종류마다 한 묶음이다(weather._guard · kma_radar._fail 과 같다 —
        조사 errors F2 · 도전 2026-10-01: 전에는 로그 화면에 오는 이 WARN 에 까닭이 없었다). 성공 뒤 실패가 없었으면 '없음'(앞선 오류를 지금 까닭처럼 싣지 않는다)."""
        if self._warned_no_provider:
            return
        nxt, retry = self.chain.none_next, self.chain.none_retry
        parts = [f"{retry} retried each cycle while cooling down (no other provider)"] if retry else []
        if nxt and nxt[0] != retry:
            parts.append(f"{nxt[0]} after {nxt[1]:.0f} s")
        last = (
            f" ({self._last_error[0]}): {self._last_error[1]}" if self._last_error else ": none since the last success or start"
        )
        log.warning(
            "%s: no provider available — skipped: '%s'; next: '%s'; last error%s",
            self.scope,
            self.chain.none_reason,
            "; ".join(parts) or "none known (switched off, paused without an end, or not configured)",
            last,
        )
        self._warned_no_provider = True

    def _available_again(self, gap_s: float, name: str) -> None:
        log.info("%s: a provider is available again after %.0f s without one — '%s'", self.scope, gap_s, name)
        self._warned_no_provider = False

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
        self._last_error = (name, why)
        retried = self.chain.probing(name)  # 3회 연속 실패로 쉬는 중이지만 다른 공급자가 없어 다시 시도한 호출
        await ctx.status.failure(name, at=datetime.now(UTC), error=why, http_status=http_status)
        ctx.db.record_run(self.job_name, name, started, status="error", http_status=http_status, error_text=why)
        if http_status == 429:
            wait = await self.chain.on_rate_limited(name)  # 적고 저장 — 재시작해도 쉼·미룸을 잇는다(Redis 오류는 삼킨다)
            log.warning(
                "%s: %s rate limited (429) — backing off %.0f s, deferred %.0f min; next: '%s'",
                self.scope,
                name,
                wait,
                self.chain.hold_s(name) / 60,
                await self._after_429(name),
            )
        elif self.chain.record_failure(name):
            # 마지막 오류는 따옴표 밖 — 로그 지문이 오류 종류마다 한 묶음(위 _warn_no_provider 와 같은 규칙, 운영 2026-09-30 17:57–17:58 UTC 의 adsb_fi
            # ReadTimeout 은 INFO 라 로그 화면에 까닭이 없었다)
            log.warning("%s: %s failed 3x — cooling down; last error: %s", self.scope, name, why)
        elif retried:  # 쉼마다 WARN 은 한 번(위) — 다시 시도의 실패는 INFO(공급자 상태 · 실행 기록에는 그대로 남는다)
            log.info(
                "%s: %s failed again while cooling down — retried because no other provider is available (%s)",
                self.scope,
                name,
                why,
            )
        else:
            log.info("%s: %s failed (%s)", self.scope, name, why)

    async def _after_429(self, name: str) -> str:
        """429 경고의 next: '…' — 체인이 다음 주기에 고를 공급자(추정이 아니라 지금 상태로 정해진 값).
        바뀌는 글은 따옴표 안에만 둔다: 로그 지문(logsink.message_template)이 따옴표 안·숫자를 지워 한 429 계열이 한 묶음이 된다."""
        order = ["fixture"] if self.ctx.fixture else self.ctx.rt.provider_order
        nxt = await self.chain.peek(order, need_global=self.scope == "global")
        if nxt is not None and nxt != name and self.chain.probing(nxt):  # 3회 연속 실패로 쉬지만 다른 공급자가 없어 다시 시도한다
            return f"{nxt} retried while cooling down (no other provider)"
        if nxt is None or nxt == name:  # 미룸은 선호도일 뿐 — 대안이 없으면 쉼이 끝난 뒤 같은 공급자를 쓴다
            why = "no other provider — deferral not applied" if self.chain.hold_s(name) else "no other provider"
            return f"{name} again after the backoff ({why})"
        return f"{nxt} takes over"

    async def _on_throttled(self, name: str, cost: int, started: datetime, e: Throttled) -> None:
        """속도 상한이 막아 호출하지 않았다 — 공급자 실패가 아니다. 3회 규칙·공급자 상태 해시에 넣지 않는다.
        429 쿨다운 때문이면(다른 작업이 받은 429 포함): 관심 지역은 짧은 쿨다운을 같은 공급자로 기다린다(_waits_out — 전환 없음, 그동안의 주기는 실행 기록
        'throttled'), 길면 그 남은 시간만 이 공급자를 건너뛴다(다음 순위로 폴백할 수 있게)."""
        if cost:
            await self.ctx.budget.release(name, cost)
        self.ctx.db.record_run(self.job_name, name, started, status="throttled", error_text=describe_error(e))
        if e.cooldown_s > 0 and self._waits_out(e.cooldown_s):
            log.info("%s: %s not called (%s) — waiting it out on the same provider, no switch", self.scope, name, e.reason)
            return
        if e.cooldown_s > 0:
            self.chain.mark_down(name, e.cooldown_s, why=f"호출 제한기 429 쿨다운({e.cooldown_s:.0f} s)")
        log.info("%s: %s not called (%s)", self.scope, name, e.reason)

    def _waits_out(self, cooldown_s: float) -> bool:
        """관심 지역이 호출 제한기 쿨다운(다른 작업이 받은 429 — 관심 지역 자신의 429 는 체인이 제한기 쿨다운보다 오래(60 → 300 s) 쉬게 해 여기 오지 않는다)을 같은 공급자로 기다리는가.
        기다려도 관심 지역 자료가 api 의 끊김 기준(REGION_FEED_STALE_S)을 넘지 않을 때만 — 쿨다운 + 주기 2번(마지막 성공이 한 주기 전일 수 있고, 쿨다운이
        끝난 뒤 한 주기 안에 부른다) ≤ 60 s. 기본 10 s 주기면 첫 429 의 30 s 쿨다운은 기다리고, 15분 안에 되풀이된 60 → 300 s 쿨다운은 폴백한다.
        고른 규칙(계약 v5 §G25 · ADR-011 '보강 3'): 관심 지역 1순위가 adsb.fi 라 focus · hot 이 받은 429 하나로 30 s 동안 adsb.lol 로 갔다 오면(전환 둘 ·
        폴백의 429 위험) 끊기지 않는 짧은 공백보다 비싸다. 전세계는 기다리지 않는다(주기 120 s)."""
        return self.scope == "region" and cooldown_s + 2 * self.ctx.rt.region_poll_s <= REGION_FEED_STALE_S
