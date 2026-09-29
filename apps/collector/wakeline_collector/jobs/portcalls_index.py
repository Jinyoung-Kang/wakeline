"""한국 항만 입출항 색인(ADR-022 개정) — 해양수산부 선박운항정보(PORT-MIS Info5)의 항만청 10곳 입출항 신고를 KST 날짜 하루씩 모두 받아 DB 에 둔다.

왜: Info5 의 clsgn(호출부호) 파라미터는 거르지 않는다(docs/review/evidence/public-data-apis-2026-09-29.txt 마지막 절) — 선택할 때 호출부호로 묻던
설계는 거의 모든 선박에 틀린 "최근 30일 기록 없음" 을 보였다. 이제 선택은 외부 호출을 만들지 않고, api 가 이 색인(port_call)을 AIS 호출부호로 찾는다.

단위 = (항만청, KST 날짜 하루): sde = ede = 그 날 · deGb=I(입항일 기준) · numOfRows 50 · totalCount 까지 모든 쪽(하루 MAX_PAGES_PER_DAY 쪽 상한).
완전하게 받은 하루만 적는다(쪽마다 totalCount 가 같고 · 받은 item 수 = totalCount · 다른 항만청 item 없음 · 키를 만들 수 없는 item 없음 · 겹친 item 없음) —
하나라도 어긋나면 그 날은 적지 않고(부분 결과를 '기록 없음' 처럼 보이지 않게) 그 항만청을 물러나게 한다. 적을 때는 한 트랜잭션으로 행 upsert ·
그 날 목록에서 빠진 행(철회된 신고) 삭제 · 범위(port_call_coverage) 넓히기(db.apply_port_call_day). 저장된 행이 하나라도 있는 날이 0건으로
오면 한 번에 지우지 않고 EMPTY_CONFIRM_S 넘게 지나 다시 받아 또 0건일 때 적는다(일시적인 빈 응답 하나로 색인을 지우지 않게 — 행이 1–2개인 날은
포항 · 목포에서 흔하다. 그동안 그 항만청은 물러나고 꼬리 갱신이 끝나지 않으므로 범위가 그 빈 응답으로 '새것' 이 되지 않는다).

순서(계획 plan — 매 단계 다시 계산, 앞의 것이 먼저):
1. 꼬리(항만청마다): 범위가 없거나 창(오늘 KST − 30일) 밖이면 새로 시작 · covered_to 와 오늘 − 3일 사이가 비었으면 앞으로 채우기(gap) ·
   꼬리 갱신(최근 TAIL_DAYS = 3일, 오래된 날부터)이 필요하면(refreshed_at 이 없거나 REFRESH_S 넘게 지났거나 날짜가 바뀌었으면) 그 날들.
   셋째 날까지 끝나면 refreshed_at = 그 갱신을 시작한 때(그 순간까지 올라온 신고는 covered_to 까지 모두 색인에 있다 — 보수적).
2. 채우기(backfill): covered_from 이 창의 첫날보다 늦은 항만청의 covered_from − 1일(가장 덜 채운 항만청부터).
3. 다시 받기(revisit): 꼬리보다 오래된 창 안의 날(출항 · 최종 신고가 늦게 붙는다) — 마지막으로 받은 지 REVISIT_S 가 지난 날(모르면 먼저, 같으면
   최근 날 먼저)을 시간당 REVISIT_UNITS_PER_HOUR 개까지. 재기동 뒤에는 모두 '모름' 이라 같은 속도로 하루에 걸쳐 돈다.

예산 · 우선순위(apis.data.go.kr 한도 하나를 나눈다 — providers/data_go_kr):
- 호스트 버킷 data_go_kr_rps(1 req/s) · 우선순위 PRIORITY_PORTCALL: 교통 5분 폴링(PRIORITY_FIXED)보다 낮고 격자 기하 채우기(PRIORITY_BACKFILL)보다 높다.
- 요청마다 보내기 전에 해양수산부 시간 창(budget:mof:h:{UTC 시} — 격자 WFS 와 함께 센다, MOF_HOURLY_CAP 390) → 하루 예산(portmis, UTC 날 3,000)을
  예약하고 보내지 않은 요청은 둘 다 되돌린다. 격자 채우기는 창의 MOF_GRID4_HOURLY_HEADROOM(100)을 남긴다 — 그 100 이 색인 몫이다. 색인 안에서는
  채우기 · 다시 받기가 TAIL_HEADROOM(50)을 남겨 꼬리 갱신이 매시 적어도 50회를 쓴다. 창이 차면 그 시(꼬리면 모두, 채우기 · 다시 받기면 그것만)는
  다음 UTC 정시까지, 하루 예산이 다 되면 다음 UTC 날까지 쉰다. 예산 저장소(Redis)를 못 쓰면 보내지 않는다(portmis 는 엄격 예산).
- 계산(선택값 — 부피는 2026-09-29 잰 값): 10곳 최근 3일 957건(하루 약 320건 · 부산 494건/6일) → 하루치 요청 ≈ 항만청마다 ⌈n/50⌉(최소 1) ≈ 13–15회.
  꼬리 갱신 3일 ≈ 40–45회/시 · 다시 받기 ≈ 15–20회/시 → 약 60회/시 < 색인 몫 100. 하루 약 1,450회 + 처음 한 번의 채우기(31일 × 약 14 ≈ 430회)
  → 하루 예산 3,000 안. 채우기는 매시 남는 몫으로 — 격자 채우기가 창을 다 쓰는 최악에도 시간당 약 40회라 약 11시간이면 끝난다.
- 실패: HTTP · 응답 모양 · resultCode · 연결 → 그 항만청만 60 → 120 → 300 → 900 s 물러남(공급자 상태 portmis 에 원문 — 가린 뒤). 속도 상한 대기 초과는
  30 s 모두 쉼. DB 에 쓰지 못하면 DB_RETRY_S 모두 쉰다(받아도 둘 곳이 없으면 부르지 않는다 — 범위를 읽을 수 없어도 같다).
- 꺼짐: 키 없음(no_key) · fixture 모드(fixture) · 운영자 스위치(operator_off — wakeline:provider:portmis disabled=1, 요청마다 보내기 직전에도 본다).
  heartbeat(wakeline:collector) portcalls_index_state · portcalls_index_at 으로 알린다 — api 가 이것으로 '꺼짐' 을 말한다(120 s 안의 heartbeat 만).
- 실행 기록(ingest_run): 하루 단위마다 job portcalls_index · provider portmis · status ok · error · incomplete · budget_exhausted · budget_unavailable.
- 비밀값: serviceKey 는 요청 쿼리에만 있다. 로그 · 공급자 상태 · DB 에는 항만청 · 날짜 · 수 · 사유(가린 뒤)만 남는다.
"""

from __future__ import annotations

import asyncio
import logging
import math
import time
from collections import deque
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, timedelta
from typing import Any, Literal, Protocol

import httpx

from wakeline_collector.budget import UNKNOWN
from wakeline_collector.db import DayApplied
from wakeline_collector.errors import describe_error
from wakeline_collector.http import (
    NOT_SENT_ERRORS,
    BeforeSend,
    HostNotAllowed,
    ProviderHttpError,
    ResponseTooLarge,
    SendCancelled,
)
from wakeline_collector.jobs.context import JobContext
from wakeline_collector.portcalls import (
    PORT_AUTHORITIES,
    WINDOW_DAYS,
    Coverage,
    PortCallApiError,
    PortCallParseError,
    PortCallRow,
    kst_date,
)
from wakeline_collector.providers.data_go_kr import MOF_HOUR_WINDOW, MOF_HOURLY_CAP
from wakeline_collector.providers.portmis import NUM_OF_ROWS, PORTMIS_WAIT_S, PageFetch
from wakeline_collector.ratelimit import Throttled

log = logging.getLogger("job.portcalls_index")

JOB = "portcalls_index"
TAIL_DAYS = 3  # 꼬리 갱신: 오늘과 앞의 이틀(KST)
REFRESH_S = 3600  # 꼬리 갱신 주기(선택값 — 출항 · 최종 신고가 하루 몇 번 붙는다)
REVISIT_S = 86400  # 꼬리보다 오래된 날을 다시 받는 간격(선택값)
REVISIT_UNITS_PER_HOUR = 15  # 다시 받기 속도 상한(하루 단위 수/시간 — 선택값)
TAIL_HEADROOM = 50  # 채우기 · 다시 받기가 해양수산부 시간 창에서 꼬리 갱신 몫으로 남기는 수(선택값)
MAX_PAGES_PER_DAY = (
    20  # 하루(항만청 하나)의 쪽 상한 = 1,000건(잰 부피 부산 하루 약 80건의 10배 넘게 — 넘으면 그 날은 적지 않는다)
)
EMPTY_GUARD = 1  # 저장된 행이 이만큼 이상인 날이 0건이면 다시 확인한다 — 1 = 행이 있는 날 모두
EMPTY_CONFIRM_S = 600
FAIL_BACKOFF_S = (60, 120, 300, 900)
THROTTLED_PAUSE_S = 30.0
BUDGET_UNAVAILABLE_PAUSE_S = 60.0
DB_RETRY_S = 60.0
IDLE_S = 30.0
HEARTBEAT_S = 30.0  # heartbeat 간격(상태가 바뀌면 곧바로) — api 는 120 s 안의 heartbeat 로만 '꺼짐' 을 말한다
COVERAGE_RELOAD_S = 3600.0  # 범위를 DB 에서 다시 읽는 간격(보존 정리가 covered_from 을 올린다)
FUTURE_SKEW_S = 300  # refreshed_at 이 이만큼 넘게 미래면 믿지 않는다(시계가 뒤로 갔다) — 갱신이 필요하다고 본다
STATE_ACTIVE, STATE_NO_KEY, STATE_FIXTURE, STATE_OPERATOR_OFF, STATE_DB = (
    "active",
    "no_key",
    "fixture",
    "operator_off",
    "db_unavailable",
)
PA_NAMES = dict(PORT_AUTHORITIES)
Kind = Literal["tail", "gap", "backfill", "revisit"]


class PortCallIndexSource(Protocol):
    name: str
    cost: int
    host: str

    async def fetch_day_page(
        self, *, port_authority: str, day: date, page_no: int, wait_s: float = ..., before_send: BeforeSend | None = None
    ) -> PageFetch: ...


def _utcnow() -> datetime:
    return datetime.now(UTC)


def _iso(dt: datetime | None) -> str:
    return "" if dt is None else dt.astimezone(UTC).isoformat().replace("+00:00", "Z")


def next_utc_hour(at: datetime) -> datetime:
    return at.astimezone(UTC).replace(minute=0, second=0, microsecond=0) + timedelta(hours=1)


def next_utc_day(at: datetime) -> datetime:
    return at.astimezone(UTC).replace(hour=0, minute=0, second=0, microsecond=0) + timedelta(days=1)


@dataclass(frozen=True)
class Unit:
    """받을 하루. reset = 범위를 이 날로 새로 시작 · completes_pass = 꼬리 갱신의 마지막 날(끝나면 refreshed_at)."""

    pa: str
    day: date
    kind: Kind
    reset: bool = False
    completes_pass: bool = False


@dataclass
class _Pass:
    """진행 중인 꼬리 갱신(항만청 하나): today 기준 days 를 차례로. started_at = refreshed_at 이 될 값."""

    today: date
    started_at: datetime
    days: list[date]
    reset: bool
    done: set[date] = field(default_factory=set)


@dataclass
class _DayFetch:
    rows: list[PortCallRow]
    total: int
    pages: int
    latency_ms: int
    fetched_at: datetime
    unmatchable: int
    date_mismatch: int


class _Stop(Exception):  # noqa: N818 — 단위를 멈춘 까닭(작업 흐름 — 예외로 나가지 않는다)
    """단위를 끝내지 못한 까닭. scope: pa(그 항만청만 물러남) · low(채우기 · 다시 받기만 쉼) · all(모두 쉼). until = 쉬는 끝."""

    def __init__(self, status: str, why: str, *, scope: Literal["pa", "low", "all", "off"], until: datetime | None = None):
        super().__init__(why)
        self.status, self.why, self.scope, self.until = status, why, scope, until


class PortCallIndexJob:
    job_name = JOB

    def __init__(
        self,
        provider: PortCallIndexSource | None,
        ctx: JobContext,
        *,
        off_state: str = STATE_FIXTURE,
        now: Callable[[], datetime] = _utcnow,
        mono: Callable[[], float] = time.monotonic,
        wait_s: float = PORTMIS_WAIT_S,
    ) -> None:
        # provider None = 받지 않는다(off_state: fixture 모드 또는 키 없음)
        self.provider, self.ctx = provider, ctx
        self._off_state = off_state
        self._now, self._mono = now, mono
        self._wait_s = wait_s
        self.state = STATE_ACTIVE if provider is not None else off_state
        self.coverage: dict[str, Coverage] = {}
        self._coverage_at: float | None = None  # 마지막으로 DB 에서 범위를 읽은 때(단조 시계) — None = 아직
        self._passes: dict[str, _Pass] = {}
        self._fetched: dict[tuple[str, date], datetime] = {}  # 마지막으로 끝까지 받은 때(다시 받기 순서)
        self._revisits: deque[datetime] = deque()
        self._backoff: dict[str, tuple[datetime, int]] = {}  # 항만청 → (쉬는 끝, 연달아 실패 수)
        self._hold_all: datetime | None = None
        self._hold_low: datetime | None = None
        self._suspect_empty: dict[tuple[str, date], datetime] = {}
        self._logged_state: str | None = None
        self._last_hb = -math.inf
        self.counts = {
            "requests": 0,
            "units_ok": 0,
            "units_failed": 0,
            "rows_upserted": 0,
            "rows_deleted": 0,
            "unmatchable": 0,
            "date_mismatch": 0,
        }

    # ---- 반복 --------------------------------------------------------------------------------------------------------
    async def run(self, stop: asyncio.Event) -> None:
        log.info("port-call index started (provider=%s)", "portmis" if self.provider is not None else self._off_state)
        while not stop.is_set():
            try:
                delay = await self.step()
            except Exception:  # noqa: BLE001 — 한 번의 오류가 작업을 멈추지 않게
                log.exception("port-call index step failed")
                delay = IDLE_S
            if delay <= 0:
                await asyncio.sleep(0)  # 다른 작업에 차례를 준다
                continue
            try:
                await asyncio.wait_for(stop.wait(), timeout=delay)
            except TimeoutError:
                pass

    async def step(self) -> float:
        """한 단계: 상태 확인 → (필요하면) 범위 읽기 → 계획 → 하루 받기. 다음 단계까지 기다릴 초(0 = 곧바로)."""
        now = self._now()
        p = self.provider
        if p is None:
            await self._set_state(self._off_state, now)
            return IDLE_S
        if await self.ctx.status.is_disabled(p.name):
            await self._set_state(STATE_OPERATOR_OFF, now)
            return IDLE_S
        if self._coverage_at is None or self._mono() - self._coverage_at >= COVERAGE_RELOAD_S:
            cov = await self.ctx.db.read_port_call_coverage()
            if cov is None:
                await self._set_state(STATE_DB, now)
                return DB_RETRY_S
            self.coverage = {pa: c for pa, c in cov.items() if pa in PA_NAMES}
            self._coverage_at = self._mono()
        await self._set_state(STATE_ACTIVE, now)
        if self._hold_all is not None and now < self._hold_all:
            return max(1.0, min(IDLE_S, (self._hold_all - now).total_seconds()))
        unit = self.plan(now)
        if unit is None:
            return IDLE_S
        return await self._run_unit(p, unit, now)

    # ---- 계획 --------------------------------------------------------------------------------------------------------
    def plan(self, now: datetime) -> Unit | None:
        today = kst_date(now)
        floor = today - timedelta(days=WINDOW_DAYS)
        self._forget(floor)
        waiting = {pa for pa, (until, _n) in self._backoff.items() if now < until}
        for pa, _name in PORT_AUTHORITIES:
            if pa not in waiting and (u := self._tail_unit(pa, today, floor, now)) is not None:
                return u
        if self._hold_low is not None and now < self._hold_low:
            return None
        behind = [
            (c.covered_from, pa)
            for pa, _name in PORT_AUTHORITIES
            if pa not in waiting and (c := self.coverage.get(pa)) is not None and c.covered_from > floor and c.covered_to >= floor
        ]
        if behind:
            start, pa = max(behind)  # 가장 덜 채운 항만청부터(같으면 코드 순서 뒤 — max 의 두 번째 값)
            return Unit(pa, start - timedelta(days=1), "backfill")
        return self._revisit_unit(today, floor, now, waiting)

    def _tail_unit(self, pa: str, today: date, floor: date, now: datetime) -> Unit | None:
        cov = self.coverage.get(pa)
        p = self._passes.get(pa)
        if p is not None and p.today != today:  # 날짜가 바뀌었다 — 새 날짜로 다시
            del self._passes[pa]
            p = None
        if p is None:
            fresh = cov is None or cov.covered_to < floor
            if not fresh and not self._tail_due(cov, today, now):
                return None
            if cov is not None and not fresh and cov.covered_to < today - timedelta(days=TAIL_DAYS):
                return Unit(pa, cov.covered_to + timedelta(days=1), "gap")  # 꼬리 앞의 빈 날을 먼저(범위가 이어지게)
            days = [today - timedelta(days=n) for n in range(TAIL_DAYS - 1, -1, -1)]
            if cov is not None and not fresh:
                days = [d for d in days if d >= cov.covered_from]  # 범위 앞쪽은 채우기가 한다(이어지게)
            p = self._passes[pa] = _Pass(today, now, days, fresh)
        left = [d for d in p.days if d not in p.done]
        if not left:  # 모두 끝났는데 남아 있다(정리 전 실패) — 다시
            self._passes.pop(pa, None)
            return None
        d = left[0]
        return Unit(pa, d, "tail", reset=p.reset and d == p.days[0], completes_pass=len(left) == 1)

    @staticmethod
    def _tail_due(cov: Coverage | None, today: date, now: datetime) -> bool:
        if cov is None or cov.refreshed_at is None or cov.covered_to < today:
            return True
        age = (now - cov.refreshed_at).total_seconds()
        return age >= REFRESH_S or age < -FUTURE_SKEW_S

    def _revisit_unit(self, today: date, floor: date, now: datetime, waiting: set[str]) -> Unit | None:
        while self._revisits and (now - self._revisits[0]).total_seconds() >= 3600:
            self._revisits.popleft()
        if len(self._revisits) >= REVISIT_UNITS_PER_HOUR:
            return None
        best: tuple[float, int, str, date] | None = None
        last_tail = today - timedelta(days=TAIL_DAYS)
        for pa, _name in PORT_AUTHORITIES:
            cov = self.coverage.get(pa)
            if pa in waiting or cov is None:
                continue
            d = min(cov.covered_to, last_tail)
            while d >= max(cov.covered_from, floor):
                at = self._fetched.get((pa, d))
                age = math.inf if at is None else (now - at).total_seconds()
                if age >= REVISIT_S:
                    cand = (age, d.toordinal(), pa, d)  # 오래 받지 않은 날 먼저, 같으면 최근 날 먼저
                    if best is None or cand[:2] > best[:2]:
                        best = cand
                d -= timedelta(days=1)
        return None if best is None else Unit(best[2], best[3], "revisit")

    def _forget(self, floor: date) -> None:
        if len(self._fetched) > 2 * len(PORT_AUTHORITIES) * (WINDOW_DAYS + 1):
            self._fetched = {k: v for k, v in self._fetched.items() if k[1] >= floor}
        self._suspect_empty = {k: v for k, v in self._suspect_empty.items() if k[1] >= floor}

    # ---- 하루 받기 --------------------------------------------------------------------------------------------------
    async def _run_unit(self, p: PortCallIndexSource, u: Unit, now: datetime) -> float:
        started = now
        try:
            got = await self._fetch_day(p, u)
        except _Stop as s:
            return await self._stopped(p, u, s, started)
        suspect_at = self._suspect_empty.get((u.pa, u.day))
        confirm = suspect_at is not None and (self._now() - suspect_at).total_seconds() >= EMPTY_CONFIRM_S
        pass_ = self._passes.get(u.pa) if u.kind == "tail" else None
        res = await self.ctx.db.apply_port_call_day(
            u.pa,
            u.day,
            got.rows,
            got.fetched_at,
            reset=u.reset,
            refreshed_at=pass_.started_at if pass_ is not None and u.completes_pass else None,
            refuse_empty_over=None if confirm else EMPTY_GUARD,
        )
        if res is None:
            self._coverage_at = None  # 무엇이 적혔는지 모른다 — 다시 읽는다
            self._passes.pop(u.pa, None)
            self._hold_all = self._now() + timedelta(seconds=DB_RETRY_S)
            self._record(
                u, started, "error", got, error=f"database write failed — {PA_NAMES[u.pa]} {u.day} will be fetched again"
            )
            return DB_RETRY_S
        if res.suspect_empty:
            self._suspect_empty.setdefault((u.pa, u.day), self._now())
            why = f"{u.pa} {u.day}: source returned 0 records but {res.stored} are indexed — kept, re-checking in {EMPTY_CONFIRM_S} s"
            log.warning("port-call index %s", why)
            return self._fail_pa(u, started, "incomplete", why, got)
        self._suspect_empty.pop((u.pa, u.day), None)
        self._applied(u, res, got, started)
        return 0.0

    def _applied(self, u: Unit, res: DayApplied, got: _DayFetch, started: datetime) -> None:
        if res.coverage is not None:
            self.coverage[u.pa] = res.coverage
        self._fetched[(u.pa, u.day)] = self._now()  # 작업의 시계(다시 받기 간격을 같은 시계로 잰다)
        self._backoff.pop(u.pa, None)
        if u.kind == "revisit":
            self._revisits.append(self._now())
        self.counts["units_ok"] += 1
        self.counts["rows_upserted"] += res.upserted
        self.counts["rows_deleted"] += res.deleted
        self.counts["unmatchable"] += got.unmatchable
        self.counts["date_mismatch"] += got.date_mismatch
        if not res.merged:
            # 계획은 이어지는 날만 고른다 — 여기에 오면 범위가 밖에서 바뀌었다(보존 정리 등). 행은 적었다. 범위를 다시 읽고 꼬리를 다시 시작한다
            log.warning("port-call index %s %s: stored but not contiguous with coverage — reloading coverage", u.pa, u.day)
            self._coverage_at = None
            self._passes.pop(u.pa, None)
        elif u.kind == "tail":
            p = self._passes.get(u.pa)
            if p is not None:
                p.done.add(u.day)
                if u.completes_pass:
                    self._passes.pop(u.pa, None)
                    c = res.coverage
                    log.info(
                        "port-call index %s(%s): tail %s..%s refreshed (as of %s) — coverage %s..%s",
                        u.pa,
                        PA_NAMES[u.pa],
                        p.days[0],
                        p.days[-1],
                        _iso(p.started_at),
                        c.covered_from if c else "?",
                        c.covered_to if c else "?",
                    )
        elif (
            u.kind == "backfill"
            and res.coverage is not None
            and res.coverage.covered_from <= kst_date(started) - timedelta(days=WINDOW_DAYS)
        ):
            log.info(
                "port-call index %s(%s): %d-day window indexed from %s",
                u.pa,
                PA_NAMES[u.pa],
                WINDOW_DAYS,
                res.coverage.covered_from,
            )
        extra: list[tuple[str, str | None, dict[str, Any]]] = []
        if got.date_mismatch:
            extra.append(
                ("portcall_index_date_mismatch", None, {"prt_ag_cd": u.pa, "day": u.day.isoformat(), "rows": got.date_mismatch})
            )
        self.ctx.db.record_run(
            JOB,
            "portmis",
            started,
            status="ok",
            http_status=200,
            latency_ms=round(got.latency_ms / max(1, got.pages)),
            records_in=len(got.rows),
            quality=extra,
        )

    async def _stopped(self, p: PortCallIndexSource, u: Unit, s: _Stop, started: datetime) -> float:
        """단위를 끝내지 못했다: 까닭에 따라 그 항만청 · 채우기 · 모두를 쉬게 하고 실행 기록에 한 번 적는다."""
        now = self._now()
        if s.scope == "off":
            await self._set_state(STATE_OPERATOR_OFF, now)
            return IDLE_S
        if s.scope == "pa":
            return self._fail_pa(u, started, s.status, s.why, None)
        until = s.until or now + timedelta(seconds=IDLE_S)
        if s.scope == "low":
            self._hold_low = until
        else:
            self._hold_all = until
            self._passes.pop(u.pa, None)
        self.ctx.db.record_run(JOB, p.name, started, status=s.status, error_text=f"{s.why} — resumes at {_iso(until)}")
        log.info(
            "port-call index: %s — %s paused until %s", s.why, "backfill/revisit" if s.scope == "low" else "index", _iso(until)
        )
        return 0.0 if s.scope == "low" else max(1.0, min(IDLE_S, (until - now).total_seconds()))

    def _fail_pa(self, u: Unit, started: datetime, status: str, why: str, got: _DayFetch | None) -> float:
        now = self._now()
        _until, n = self._backoff.get(u.pa, (now, 0))
        wait = FAIL_BACKOFF_S[min(n, len(FAIL_BACKOFF_S) - 1)]
        self._backoff[u.pa] = (now + timedelta(seconds=wait), n + 1)
        self._passes.pop(u.pa, None)
        self.counts["units_failed"] += 1
        self.ctx.db.record_run(
            JOB,
            "portmis",
            started,
            status=status,
            records_in=len(got.rows) if got else 0,
            error_text=f"{why} — retry in {wait} s",
        )
        log.warning("port-call index %s(%s) %s %s: %s — retry in %d s", u.pa, PA_NAMES[u.pa], u.kind, u.day, why, wait)
        return 0.0

    async def _fetch_day(self, p: PortCallIndexSource, u: Unit) -> _DayFetch:
        """하루의 모든 쪽 → 완전하면 _DayFetch, 아니면 _Stop."""
        headroom = TAIL_HEADROOM if u.kind in ("backfill", "revisit") else 0
        first = await self._fetch_page(p, u, 1, headroom)
        total = first.page.total
        pages = max(1, math.ceil(total / NUM_OF_ROWS))
        if pages > MAX_PAGES_PER_DAY:
            raise _Stop(
                "incomplete", f"{u.pa} {u.day}: totalCount {total} exceeds {MAX_PAGES_PER_DAY} pages — not indexed", scope="pa"
            )
        fetched = [first]
        for no in range(2, pages + 1):
            got = await self._fetch_page(p, u, no, headroom)
            if got.page.total != total:
                raise _Stop(
                    "incomplete", f"{u.pa} {u.day}: totalCount changed while paging ({total} → {got.page.total})", scope="pa"
                )
            fetched.append(got)
        items = sum(f.page.items for f in fetched)
        foreign = sum(f.page.foreign for f in fetched)
        unkeyed = sum(f.page.unkeyed for f in fetched)
        unmatchable = sum(f.page.unmatchable for f in fetched)
        rows: dict[tuple[str, str, str, str], PortCallRow] = {}
        for f in fetched:
            for r in f.page.rows:
                rows[r.key] = r
        if foreign:
            raise _Stop(
                "incomplete", f"{u.pa} {u.day}: {foreign} item(s) of another port authority — response not trusted", scope="pa"
            )
        if unkeyed:
            raise _Stop(
                "incomplete", f"{u.pa} {u.day}: {unkeyed} item(s) without etryptYear/etryptCo — cannot be indexed", scope="pa"
            )
        if items != total:
            raise _Stop("incomplete", f"{u.pa} {u.day}: {items} of totalCount {total} item(s) received", scope="pa")
        if len(rows) + unmatchable != items:
            raise _Stop(
                "incomplete", f"{u.pa} {u.day}: {items - len(rows) - unmatchable} duplicate item(s) across pages", scope="pa"
            )
        return _DayFetch(
            rows=list(rows.values()),
            total=total,
            pages=len(fetched),
            latency_ms=sum(f.latency_ms for f in fetched),
            fetched_at=max(f.fetched_at for f in fetched),
            unmatchable=unmatchable,
            date_mismatch=sum(f.page.date_mismatch for f in fetched),
        )

    async def _fetch_page(self, p: PortCallIndexSource, u: Unit, page_no: int, headroom: int) -> PageFetch:
        """요청 하나: 예산 예약(해양수산부 시간 창 → 하루 예산) → 속도 상한 → 보내기 직전 스위치 확인 → 파싱. 실패는 _Stop."""
        at = self._now()
        ok, used, hour = await self.ctx.budget.reserve_hour(
            p.name, MOF_HOURLY_CAP, p.cost, now=at, window=MOF_HOUR_WINDOW, headroom=headroom
        )
        if not ok:
            if used == UNKNOWN:
                raise _Stop(
                    "budget_unavailable",
                    "budget store unavailable (fail closed)",
                    scope="all",
                    until=at + timedelta(seconds=BUDGET_UNAVAILABLE_PAUSE_S),
                )
            why = f"MOF hourly window: {used} of {MOF_HOURLY_CAP} used in UTC hour {hour.rsplit(':', 1)[-1]}" + (
                f" ({headroom} kept for the tail refresh)" if headroom else ""
            )
            raise _Stop("budget_exhausted", why, scope="low" if headroom else "all", until=next_utc_hour(at))
        ok, used = await self.ctx.budget.reserve(p.name, p.cost)
        if not ok:
            await self.ctx.budget.release_key(hour, p.cost)
            if used == UNKNOWN:
                raise _Stop(
                    "budget_unavailable",
                    "budget store unavailable (fail closed)",
                    scope="all",
                    until=at + timedelta(seconds=BUDGET_UNAVAILABLE_PAUSE_S),
                )
            raise _Stop("budget_exhausted", f"daily budget exhausted (used={used})", scope="all", until=next_utc_day(at))
        sent = False

        async def give_back() -> None:
            """보내지 않은 요청: 두 예약(하루 · 시간 창)을 모두 되돌린다."""
            await self.ctx.budget.release(p.name, p.cost)
            await self.ctx.budget.release_key(hour, p.cost)

        async def before_send() -> bool:
            nonlocal sent
            if await self.ctx.status.is_disabled(p.name):
                return False
            sent = True
            return True

        http_status: int | None = None
        try:
            got = await p.fetch_day_page(
                port_authority=u.pa, day=u.day, page_no=page_no, wait_s=self._wait_s, before_send=before_send
            )
        except asyncio.CancelledError:  # 종료: 보내지 않았으면 예산을 되돌린다
            if not sent:
                await asyncio.shield(give_back())
            raise
        except Throttled as e:  # 속도 상한 대기 초과 · 429 쿨다운 — 보내지 않았다(이 항만청 탓이 아니다)
            await give_back()
            pause = max(THROTTLED_PAUSE_S, e.cooldown_s)
            raise _Stop(
                "error", f"rate limited ({e.reason})", scope="all", until=self._now() + timedelta(seconds=pause)
            ) from None
        except SendCancelled:  # 기다리는 사이 운영자가 껐다 — 보내지 않았다
            await give_back()
            raise _Stop("disabled", "provider disabled by operator", scope="off") from None
        except NOT_SENT_ERRORS as e:  # 허용 호스트 아님 · 연결 풀 대기 초과 · 연결 전 실패 — 보내지 않았다
            await give_back()
            why = describe_error(e)
            if isinstance(e, HostNotAllowed):
                raise _Stop("error", why, scope="all", until=self._now() + timedelta(seconds=FAIL_BACKOFF_S[-1])) from None
            await self._provider_failure(p, u, why, None)
            raise _Stop("error", why, scope="pa") from None
        except ProviderHttpError as e:
            self.counts["requests"] += 1
            why, http_status = describe_error(e), e.status
        except (
            PortCallApiError,
            PortCallParseError,
        ) as e:  # 보냈고 응답을 받았다 — resultCode ≠ 00 · 확인한 모양이 아니다(사유는 이미 가린 것)
            self.counts["requests"] += 1
            why = str(e)
        except (ResponseTooLarge, httpx.TransportError) as e:  # 본문 크기 상한 · 읽기 시간 초과 등(보낸 것으로 센다)
            self.counts["requests"] += 1
            why = describe_error(e)
        except Exception as e:  # noqa: BLE001 — 그 밖(보낸 것으로 센다)
            self.counts["requests"] += 1
            why = describe_error(e)
        else:
            self.counts["requests"] += 1
            if page_no == 1:
                u_used, lim = await self.ctx.budget.usage(p.name)
                await self.ctx.status.success(
                    p.name, at=got.fetched_at, latency_ms=got.latency_ms, records=got.page.items, used=u_used, limit=lim
                )
            return got
        await self._provider_failure(p, u, why, http_status)
        raise _Stop("error", f"prtAgCd {u.pa} {u.day} page {page_no}: {why}", scope="pa")

    async def _provider_failure(self, p: PortCallIndexSource, u: Unit, why: str, http_status: int | None) -> None:
        await self.ctx.status.failure(p.name, at=self._now(), error=f"prtAgCd {u.pa} {u.day}: {why}", http_status=http_status)

    def _record(self, u: Unit, started: datetime, status: str, got: _DayFetch | None, *, error: str) -> None:
        self.counts["units_failed"] += 1
        self.ctx.db.record_run(JOB, "portmis", started, status=status, records_in=len(got.rows) if got else 0, error_text=error)
        log.warning("port-call index %s(%s) %s %s: %s", u.pa, PA_NAMES[u.pa], u.kind, u.day, error)

    # ---- 상태 --------------------------------------------------------------------------------------------------------
    async def _set_state(self, state: str, now: datetime) -> None:
        """state 가 바뀌면 한 번 적고, heartbeat 는 HEARTBEAT_S 에 한 번(또는 state 가 바뀌면 곧바로)."""
        self.state = state
        changed = self._logged_state != state
        if changed:
            self._logged_state = state
            msg = {
                STATE_ACTIVE: f"indexing Korean port calls (PORT-MIS, 10 port authorities, last {WINDOW_DAYS} KST days)",
                STATE_NO_KEY: "DATA_GO_KR_SERVICE_KEY not set — Korean port-call index disabled",
                STATE_FIXTURE: "fixture mode — Korean port-call index disabled (no external calls)",
                STATE_OPERATOR_OFF: "provider portmis disabled by operator — port-call index paused",
                STATE_DB: "database unavailable — port-call index waits (nothing is fetched without a place to store it)",
            }[state]
            log.info("port-call index: %s", msg)
        mono = self._mono()
        if changed or mono - self._last_hb >= HEARTBEAT_S:
            self._last_hb = mono
            await self.ctx.status.heartbeat(
                self.job_name, lag_s=self._lag_s(now), fixture=self.ctx.fixture, extra=self._hb_fields(now)
            )

    def _lag_s(self, now: datetime) -> float | None:
        """색인의 나이 = 가장 오래된 항만청의 refreshed_at 부터(10곳 모두 있을 때만 — 모르면 None)."""
        ats = [
            c.refreshed_at
            for pa, _n in PORT_AUTHORITIES
            if (c := self.coverage.get(pa)) is not None and c.refreshed_at is not None
        ]
        if len(ats) < len(PORT_AUTHORITIES):
            return None
        return max(0.0, (now - min(ats)).total_seconds())

    def _hb_fields(self, now: datetime) -> dict[str, str]:
        floor = kst_date(now) - timedelta(days=WINDOW_DAYS)
        covered = sum(1 for pa, _n in PORT_AUTHORITIES if (c := self.coverage.get(pa)) is not None and c.covered_from <= floor)
        return {
            "portcalls_index_state": self.state,
            "portcalls_index_window_authorities": f"{covered}/{len(PORT_AUTHORITIES)}",  # 30일 창을 모두 덮은 항만청 수(갱신 나이는 lag_s)
        }

    def metrics(self) -> dict[str, str]:
        """portcall_requests = 실제로 보낸 PORT-MIS 요청 수(예산을 쓴 것)."""
        return {
            "portcall_requests": str(self.counts["requests"]),
            "portcall_index_units_ok": str(self.counts["units_ok"]),
            "portcall_index_units_failed": str(self.counts["units_failed"]),
            "portcall_index_rows_upserted": str(self.counts["rows_upserted"]),
            "portcall_index_rows_deleted": str(self.counts["rows_deleted"]),
        }
