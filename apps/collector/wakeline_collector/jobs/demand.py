"""수요 기반 정밀 추적(ADR-013, 계약 v2 §A2): 선택 항공기 집중 추적(focus, 5 s) · 뷰포트 핫 리전(hot, 30 s).

1 s 틱: 임대 읽기(DemandPoller) → focus 차례면 조회 태스크 → hot 셀마다 차례면 조회 태스크 → 상태 정리.
- focus: 활성 hex 전부를 5 s 마다 adsb.fi 묶음 요청(≤ 50 hex/요청, 넘으면 여러 요청이 속도 상한을 차례로 지난다).
  주기는 시작 시각 기준(고정 주기)이고, 새 hex 가 생기면 최소 간격(2 s)만 지키고 바로 조회한다(fast path — 수집기 전체에서
  5 s 에 1회까지, 계약 v3 §C). 이전 조회가 끝나지 않았으면 겹쳐 보내지 않는다.
- hot: 셀마다 30 s. 용량 계획(adsb.fi 상한 × 0.8 − 관심 지역 폴백 − focus)이 모자라면 30 → 60 → 120 s 로 늘리고,
  그래도 모자라면 순위(세션 수) 밖의 셀은 건너뛴다(state throttled). 실제로 허가를 못 받은 셀은 그 셀만 한 단계 물러난다.
  새 셀의 즉시 첫 조회는 30 s 에 2개까지, 나머지는 한 주기 뒤 첫 조회(계약 v3 §C).
- 운영자가 공급자를 끄면(wakeline:provider:{name} disabled=1) 틱마다 확인해 호출하지 않고 state throttled 로 알린다.
- 우선순위 region > focus > hot: 속도 상한 대기열 우선순위(0 > 1 > 2) + 하루 예산 여유분(focus 는 관심 지역 몫을,
  hot 은 거기에 focus 몫까지 남기고 멈춘다).
- 발행: wakeline:aircraft 에 scope focus(requested·missing) / hot(cell·region). 품질 게이트는 관심 지역과 같은 규칙.
- 상태: wakeline:demand:status 에 실제 결과를 그대로 쓴다 — 약속한 주기를 못 지키면 throttled, 공급자가 모르면 not_found.
외부 호출은 HttpClient(허용 호스트·속도 상한·크기 상한)만 거친다. fixture 모드는 외부 호출이 없다(provider "fixture").
"""

from __future__ import annotations

import asyncio
import logging
import math
import time
from collections import deque
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Protocol

import httpx

from wakeline_collector.budget import UNKNOWN
from wakeline_collector.config import settings
from wakeline_collector.demand import Demand, DemandPoller, DemandStatus, HotCell, status_value
from wakeline_collector.http import ProviderHttpError
from wakeline_collector.jobs.context import JobContext
from wakeline_collector.models import AircraftState, ProviderResult
from wakeline_collector.normalize import Rejected, normalize_readsb, readsb_reference_time
from wakeline_collector.publisher import STREAM_AIRCRAFT
from wakeline_collector.quality import AircraftGate, Quarantine
from wakeline_collector.ratelimit import RateLimiter, Throttled

log = logging.getLogger("job.demand")

TICK_S = 1.0
FOCUS_INTERVAL_S = 5
FOCUS_MIN_GAP_S = 2.0
FOCUS_FAST_EVERY_S = 5.0  # 새 hex 의 빠른 첫 조회(fast path)는 수집기 전체에서 이 간격에 1회까지
FOCUS_BATCH = 50
FOCUS_WAIT_S = 4.0  # 한 묶음이 속도 상한을 기다리는 최대 시간(주기 5 s 안에서)
HOT_LEVELS_S = (30, 60, 120)
HOT_WAIT_MAX_S = 15.0
HOT_NEW_BURST = 2  # 새 셀의 즉시 첫 조회는 HOT_NEW_WINDOW_S 에 이만큼까지(나머지는 정규 일정)
HOT_NEW_WINDOW_S = 30.0
DISABLED_MSG = "provider disabled by operator"
PLAN_UTILIZATION = 0.8  # 계획은 호스트 상한의 80 %까지만 채운다(지터·재시도 여유)
SHUTDOWN_WAIT_S = 5.0


class DemandProvider(Protocol):
    name: str
    cost: int
    host: str

    async def fetch_icao(self, hexes: list[str], *, wait_s: float) -> ProviderResult: ...

    async def fetch_point(self, lat: float, lon: float, radius_nm: int, *, wait_s: float) -> ProviderResult: ...


def plan_hot(n_cells: int, capacity_rps: float, reserved_rps: float) -> tuple[int, int]:
    """(셀 주기 s, 조회할 셀 수). 남는 용량 안에서 가장 짧은 주기를 고르고, 120 s 로도 모자라면 앞 순위 셀만."""
    if n_cells <= 0:
        return HOT_LEVELS_S[0], 0
    avail = max(0.0, capacity_rps - reserved_rps)
    for iv in HOT_LEVELS_S:
        if n_cells <= avail * iv + 1e-9:
            return iv, n_cells
    return HOT_LEVELS_S[-1], min(n_cells, int(avail * HOT_LEVELS_S[-1] + 1e-9))


def focus_payload(requested: list[str], states: list[AircraftState], missing: list[str]) -> dict[str, Any]:
    """scope focus 의 aircraft_payload(schemas/stream_envelope.v1.json)."""
    return {"region": None, "requested": requested, "missing": missing, "states": [s.model_dump(mode="json") for s in states]}


def hot_payload(cell: HotCell, states: list[AircraftState]) -> dict[str, Any]:
    """scope hot 의 aircraft_payload — cell 키와 조회 원(region)."""
    return {
        "region": {"lat": cell.lat, "lon": cell.lon, "radius_nm": cell.radius_nm},
        "cell": cell.key,
        "states": [s.model_dump(mode="json") for s in states],
    }


def _chunks(items: list[str], n: int) -> list[list[str]]:
    return [items[i : i + n] for i in range(0, len(items), n)]


def _err(e: BaseException) -> str:
    if isinstance(e, Throttled):
        return e.reason
    if isinstance(e, ProviderHttpError):
        return f"HTTP {e.status}"
    return type(e).__name__


@dataclass
class _Cell:
    next_due: float
    level: int = 0  # 실제 허가 실패로 물러난 단계(HOT_LEVELS_S 색인)
    plan_s: int = HOT_LEVELS_S[0]  # 용량 계획이 정한 주기
    interval_s: int = HOT_LEVELS_S[0]  # 적용 주기 = max(계획, 물러난 단계)
    started: float = 0.0
    task: asyncio.Task[None] | None = None
    fresh: bool = True  # 아직 한 번도 조회 차례가 오지 않은 셀

    def apply_level(self) -> None:
        self.interval_s = max(self.plan_s, HOT_LEVELS_S[self.level])
        self.next_due = self.started + self.interval_s

    @property
    def busy(self) -> bool:
        return self.task is not None and not self.task.done()


class DemandTracker:
    def __init__(
        self,
        ctx: JobContext,
        poller: DemandPoller,
        status: DemandStatus,
        provider: DemandProvider,
        *,
        limiter: RateLimiter | None = None,
        clock: Callable[[], float] = time.monotonic,
    ):
        self.ctx, self.poller, self.status, self.provider = ctx, poller, status, provider
        self._limiter = limiter
        self._clock = clock
        self.focus_gate = AircraftGate()
        self.hot_gate = AircraftGate()
        self._focus_task: asyncio.Task[None] | None = None
        self._focus_due = 0.0
        self._focus_started = -math.inf
        self._focus_fast_at = -math.inf
        self._focus_asked: set[str] = set()
        self._hot_new_at: deque[float] = deque()  # 새 셀 즉시 조회 시각(최근 HOT_NEW_WINDOW_S)
        self._cells: dict[str, _Cell] = {}
        self._served: set[str] = set()  # 직전 계획에서 조회 대상이 된 셀(용량 밖 셀은 깨어날 이유가 없다)
        self._last_ok: dict[str, datetime] = {}
        self._written: dict[str, tuple[str, int | None, str | None]] = {}
        self.counts = {"focus_requests": 0, "hot_requests": 0, "throttled": 0, "errors": 0, "published": 0}

    # ---- 루프 --------------------------------------------------------------------------------------------------------
    async def run(self, stop: asyncio.Event) -> None:
        log.info("demand tracker started (provider=%s)", self.provider.name)
        while not stop.is_set():
            try:
                delay = await self.tick()
            except Exception:  # noqa: BLE001 — 틱 하나의 오류가 추적 전체를 멈추지 않게
                log.exception("demand tick failed")
                delay = TICK_S
            try:
                await asyncio.wait_for(stop.wait(), timeout=delay)
            except TimeoutError:
                pass
        await self.aclose()

    async def aclose(self, wait_s: float = SHUTDOWN_WAIT_S) -> None:
        """진행 중 조회를 wait_s 안에서 끝내고, 남으면 취소한다."""
        tasks = [t for t in [self._focus_task, *(c.task for c in self._cells.values())] if t is not None and not t.done()]
        if not tasks:
            return
        _done, pending = await asyncio.wait(tasks, timeout=wait_s)
        for t in pending:
            t.cancel()
        await asyncio.gather(*pending, return_exceptions=True)

    async def tick(self) -> float:
        demand = await self.poller.poll()
        now = self._clock()
        disabled = bool(demand.fields) and await self.ctx.status.is_disabled(self.provider.name)  # 운영자 스위치는 틱마다
        if disabled:
            # 이미 속도 상한 대기열에 들어간 조회도 보내지 않는다(리뷰 2026-09-28b #2 후속): 취소하면 대기열에서 빠진다.
            # 이미 전송된 요청이면 예산은 쓴 것으로 둔다(과대 집계는 안전 쪽).
            await self.aclose(wait_s=0)
            await self.status.put(self._disabled(demand))
        else:
            await self._lift_disabled()
            self._schedule_focus(demand, now)
            await self.status.put(self._schedule_hot(demand, now))
        await self.status.prune(demand.fields)
        self._forget(demand)
        return TICK_S if disabled else self._next_delay(demand, now)

    def _next_delay(self, demand: Demand, now: float) -> float:
        cands = [TICK_S]
        if demand.focus and not (self._focus_task and not self._focus_task.done()):
            cands.append(self._focus_due - now)
        cands += [c.next_due - now for k, c in self._cells.items() if k in self._served and not c.busy]
        return max(0.05, min(cands))

    def _forget(self, demand: Demand) -> None:
        live = {c.key for c in demand.hot}
        for key in [k for k, c in self._cells.items() if k not in live and not c.busy]:
            del self._cells[key]
        fields = demand.fields
        for f in [f for f in self._last_ok if f not in fields]:
            del self._last_ok[f]
        for f in [f for f in self._written if f not in fields]:
            del self._written[f]
        if not demand.focus:
            self._focus_asked = set()

    # ---- 계획 --------------------------------------------------------------------------------------------------------
    def _plan(self, n_cells: int, n_focus: int) -> tuple[int, int]:
        host_rps = self._limiter.host_rps(self.provider.host) if self._limiter and self.provider.host else None
        if host_rps is None:  # fixture 모드 또는 상한 없는 호스트
            return HOT_LEVELS_S[0], n_cells
        rt = self.ctx.rt
        region_rps = 1.0 / rt.region_poll_s if self.provider.name in rt.provider_order else 0.0
        focus_rps = math.ceil(n_focus / FOCUS_BATCH) / FOCUS_INTERVAL_S
        return plan_hot(n_cells, host_rps * PLAN_UTILIZATION, region_rps + focus_rps)

    def _schedule_focus(self, demand: Demand, now: float) -> None:
        hexes = demand.focus_hexes
        if not hexes or (self._focus_task is not None and not self._focus_task.done()):
            return
        fresh = bool(set(hexes) - self._focus_asked)
        due = now >= self._focus_due
        fast = (
            not due and fresh and now - self._focus_started >= FOCUS_MIN_GAP_S and now - self._focus_fast_at >= FOCUS_FAST_EVERY_S
        )
        if not (due or fast):
            return
        if fast:
            self._focus_fast_at = now
        self._focus_asked = set(hexes)
        self._focus_started = now
        self._focus_due = now + FOCUS_INTERVAL_S
        self._focus_task = asyncio.create_task(self._run_focus(hexes), name="demand-focus")

    def _schedule_hot(self, demand: Demand, now: float) -> dict[str, dict[str, Any]]:
        cells = demand.hot
        self._served = set()
        if not cells:
            return {}
        interval, served = self._plan(len(cells), len(demand.focus))
        updates: dict[str, dict[str, Any]] = {}
        for rank, cell in enumerate(cells):
            st = self._cells.get(cell.key)
            if st is None:
                st = self._cells[cell.key] = _Cell(next_due=now)
            if rank >= served:
                msg = f"capacity: {served} of {len(cells)} cells served at {interval} s"
                self._status_if_changed(updates, cell.field, "throttled", interval, msg)
                continue
            self._served.add(cell.key)
            st.plan_s = interval
            if not st.busy and now >= st.next_due:
                st.started = now
                st.apply_level()
                if st.fresh:
                    st.fresh = False
                    if not self._allow_new_hot(now):
                        continue  # 즉시 조회 몫 초과 → 정규 일정(한 주기 뒤 첫 조회), 그때까지 상태는 쓰지 않는다(대기)
                st.task = asyncio.create_task(self._run_hot(cell, st), name=f"demand-hot-{cell.key}")
        return updates

    def _allow_new_hot(self, now: float) -> bool:
        q = self._hot_new_at
        while q and now - q[0] >= HOT_NEW_WINDOW_S:
            q.popleft()
        if len(q) >= HOT_NEW_BURST:
            return False
        q.append(now)
        return True

    async def _lift_disabled(self) -> None:
        """다시 켜지면 '꺼짐' 상태를 지운다(다음 조회 결과가 쓰일 때까지 대기) — 지난 사유를 남겨 두지 않는다."""
        lifted = [f for f, w in self._written.items() if w[2] == DISABLED_MSG]
        for f in lifted:
            del self._written[f]
        await self.status.delete(lifted)

    def _disabled(self, demand: Demand) -> dict[str, dict[str, Any]]:
        """운영자가 끈 공급자: 조회하지 않고 모든 필드를 throttled 로(주기 없음 — 조회가 돌지 않는다)."""
        self._served = set()
        updates: dict[str, dict[str, Any]] = {}
        for f in demand.focus:
            self._status_if_changed(updates, f.field, "disabled", None, DISABLED_MSG)
        for c in demand.hot:
            self._status_if_changed(updates, c.field, "disabled", None, DISABLED_MSG)
        return updates

    # ---- 상태 --------------------------------------------------------------------------------------------------------
    def _status_if_changed(
        self, out: dict[str, dict[str, Any]], field: str, state: str, interval: int | None, err: str | None
    ) -> None:
        sig = (state, interval, err)
        if self._written.get(field) == sig:
            return
        self._written[field] = sig
        out[field] = status_value(state, interval, self._last_ok.get(field), err, self.provider.name)

    async def _put_status(self, items: dict[str, tuple[str, int, str | None]]) -> None:
        """조회 결과 상태. 그 사이 임대가 사라진 필드는 쓰지 않는다(지운 필드를 되살리지 않게)."""
        live = self.poller.current.fields
        out: dict[str, dict[str, Any]] = {}
        for field, (state, interval, err) in items.items():
            if field not in live:
                continue
            self._written[field] = (state, interval, err)
            out[field] = status_value(state, interval, self._last_ok.get(field), err, self.provider.name)
        await self.status.put(out)

    # ---- 예산 --------------------------------------------------------------------------------------------------------
    async def _reserve(self, headroom: int) -> tuple[bool, str | None]:
        if not self.provider.cost:
            return True, None
        ok, used = await self.ctx.budget.reserve(self.provider.name, self.provider.cost, headroom=headroom)
        if ok:
            return True, None
        if used == UNKNOWN:
            return False, "budget store unavailable"
        return False, f"daily budget share exhausted (used={used}, kept {headroom} for higher priority)"

    async def _release(self) -> None:
        if self.provider.cost:
            await self.ctx.budget.release(self.provider.name, self.provider.cost)

    # ---- 조회 --------------------------------------------------------------------------------------------------------
    async def _fetch(
        self, job: str, headroom: int, call: Callable[[], Any]
    ) -> tuple[ProviderResult | None, str | None, str | None, datetime]:
        """예산 → 호출. (결과 | None, 실패 시 상태, 실패 사유, 시작 시각)."""
        started = datetime.now(UTC)
        ok, why = await self._reserve(headroom)
        if not ok:
            self.counts["throttled"] += 1
            self.ctx.db.record_run(job, self.provider.name, started, status="budget_exhausted", error_text=why)
            return None, "throttled", why, started
        try:
            return await call(), None, None, started
        except Throttled as e:
            await self._release()  # 호출하지 않았다
            self.counts["throttled"] += 1
            return None, "throttled", _err(e), started
        except Exception as e:  # noqa: BLE001 — 공급자 실패는 상태로 드러내고 다음 주기에 다시
            http_status = e.status if isinstance(e, ProviderHttpError) else None
            if isinstance(e, httpx.ConnectError | httpx.ConnectTimeout):
                await self._release()
            self.counts["errors"] += 1
            self.ctx.db.record_run(job, self.provider.name, started, status="error", http_status=http_status, error_text=repr(e))
            log.info("%s: %s failed (%s)", job, self.provider.name, _err(e))
            return None, "throttled" if http_status == 429 else "error", _err(e), started

    async def _normalize(
        self, res: ProviderResult, gate: AircraftGate, keep: Callable[[str | None], bool]
    ) -> tuple[list[AircraftState], list[Quarantine], set[str]]:
        """(통과한 상태, 격리, 응답에 들어 있던 hex). keep(hex) 가 False 인 레코드는 보지 않는다(요청하지 않은 항공기)."""
        states: list[AircraftState] = []
        pre: list[Quarantine] = []
        seen: set[str] = set()
        ref = readsb_reference_time(res.data, res.fetched_at)  # 같은 관측은 어느 작업이 받아도 같은 seen_at
        for ac in res.data.get("ac") or []:
            if not isinstance(ac, dict):
                continue
            raw_hex = ac.get("hex")
            h = raw_hex.strip().lower() if isinstance(raw_hex, str) else None
            if not keep(h):
                continue
            if h:
                seen.add(h)
            r = normalize_readsb(ac, self.provider.name, res.fetched_at, ref)
            if isinstance(r, Rejected):
                pre.append(Quarantine(r.rule, r.hex, r.detail))
            else:
                states.append(r)
        g = gate.apply(states, 0, datetime.now(UTC), pre=pre)
        return g.kept, g.quarantined, seen

    async def _raw_ref(self, res: ProviderResult, kind: str) -> str:
        ref = res.extra.get("raw_ref")
        if ref:
            return str(ref)
        return await asyncio.to_thread(self.ctx.raw.save, f"{self.provider.name}_{kind}", res.raw, res.fetched_at)

    async def _publish(self, scope: str, res: ProviderResult, raw_ref: str, count: int, payload: dict[str, Any]) -> None:
        fields = self.ctx.publisher.envelope(
            kind="aircraft",
            scope=scope,
            provider=self.provider.name,
            fetched_at=res.fetched_at,
            raw_ref=raw_ref,
            count=count,
            payload=payload,
        )
        await self.ctx.publisher.publish(STREAM_AIRCRAFT, fields)
        self.counts["published"] += 1

    def _record_ok(
        self, job: str, started: datetime, res: ProviderResult, records_in: int, quarantined: list[Quarantine], ref: str
    ) -> None:
        self.ctx.db.record_run(
            job,
            self.provider.name,
            started,
            status="ok",
            http_status=res.http_status,
            latency_ms=res.latency_ms,
            records_in=records_in,
            records_quarantined=len(quarantined),
            raw_ref=ref,
            quality=[(q.rule, q.hex, q.detail) for q in quarantined],
        )

    async def _run_focus(self, hexes: list[str]) -> None:
        for chunk in _chunks(hexes, FOCUS_BATCH):
            await self._focus_chunk(chunk)

    async def _focus_chunk(self, chunk: list[str]) -> None:
        ctx = self.ctx
        headroom = settings.demand_budget_reserve_region
        self.counts["focus_requests"] += 1
        res, fail_state, why, started = await self._fetch(
            "focus", headroom, lambda: self.provider.fetch_icao(chunk, wait_s=FOCUS_WAIT_S)
        )
        if res is None:
            await self._put_status({f"focus:{h}": (fail_state or "error", FOCUS_INTERVAL_S, why) for h in chunk})
            return
        wanted = set(chunk)
        kept, quarantined, seen = await self._normalize(res, self.focus_gate, lambda h: h in wanted)
        kept_hex = {s.hex for s in kept}
        missing = [h for h in chunk if h not in kept_hex]
        ref = await self._raw_ref(res, "focus")
        await self._publish("focus", res, ref, len(kept), focus_payload(chunk, kept, missing))
        why_by_hex = {q.hex: q.rule for q in quarantined if q.hex}
        items: dict[str, tuple[str, int, str | None]] = {}
        for h in chunk:
            field = f"focus:{h}"
            if h in kept_hex:
                self._last_ok[field] = res.fetched_at
                items[field] = ("active", FOCUS_INTERVAL_S, None)
            elif h in seen:
                items[field] = ("not_found", FOCUS_INTERVAL_S, f"no usable position ({why_by_hex.get(h, 'quarantined')})")
            else:
                items[field] = ("not_found", FOCUS_INTERVAL_S, "not in provider response")
        await self._put_status(items)
        self._record_ok("focus", started, res, len(seen), quarantined, ref)
        lag = (datetime.now(UTC) - res.fetched_at).total_seconds()
        await ctx.status.heartbeat("focus", lag_s=lag, fixture=ctx.fixture)

    async def _run_hot(self, cell: HotCell, st: _Cell) -> None:
        ctx = self.ctx
        headroom = settings.demand_budget_reserve_region + settings.demand_budget_reserve_focus
        wait_s = min(HOT_WAIT_MAX_S, st.interval_s / 2)
        self.counts["hot_requests"] += 1
        res, fail_state, why, started = await self._fetch(
            "hot", headroom, lambda: self.provider.fetch_point(cell.lat, cell.lon, cell.radius_nm, wait_s=wait_s)
        )
        if res is None:
            if fail_state == "throttled":  # 이 셀만 한 단계 물러난다(30 → 60 → 120 s)
                st.level = min(len(HOT_LEVELS_S) - 1, st.level + 1)
                st.apply_level()
            await self._put_status({cell.field: (fail_state or "error", st.interval_s, why)})
            return
        if st.level:  # 성공하면 한 단계씩 돌아온다
            st.level -= 1
            st.apply_level()
        kept, quarantined, seen = await self._normalize(res, self.hot_gate, lambda _h: True)
        ref = await self._raw_ref(res, "hot")
        await self._publish("hot", res, ref, len(kept), hot_payload(cell, kept))
        self._last_ok[cell.field] = res.fetched_at
        await self._put_status({cell.field: ("active", st.interval_s, None)})
        self._record_ok("hot", started, res, len(res.data.get("ac") or []), quarantined, ref)
        lag = (datetime.now(UTC) - res.fetched_at).total_seconds()
        await ctx.status.heartbeat("hot", lag_s=lag, fixture=ctx.fixture)

    # ---- 지표 --------------------------------------------------------------------------------------------------------
    def metrics(self) -> dict[str, str]:
        d = self.poller.current
        return {
            "demand_focus": str(len(d.focus)),
            "demand_hot": str(len(d.hot)),
            "demand_ignored": str(d.ignored_focus + d.ignored_hot),
            "demand_throttled": str(self.counts["throttled"]),
            "demand_errors": str(self.counts["errors"]),
        }
