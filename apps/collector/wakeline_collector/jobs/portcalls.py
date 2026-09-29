"""선택한 선박의 한국 항만 입출항 조회(ADR-022) — AIS 호출부호로 PORT-MIS(해양수산부 선박운항정보)에 묻고 Redis 에만 둔다.

- 계기: api 가 쓰는 수요 임대 ZSET wakeline:demand:portcalls(member = 호출부호, score = 만료 epoch ms — 선박을 선택한 WS 세션이 있을 때).
  PortCallJob 이 2 s 마다 읽어(읽기 전용 ACL) PortCallLookup 에 넘긴다. 같은 호출부호는 30 s 에 한 번만 넘긴다(캐시 확인 EXISTS 를 줄인다).
  항공기 수요 추적(DemandTracker)과 따로 돈다 — 한쪽의 오류·지연이 다른 쪽을 막지 않는다(격벽).
- 조회 하나 = 항만청 10곳 × 쪽(numOfRows 50, totalCount 까지 · 항만청당 MAX_PAGES 쪽) — 최근 30일(KST 날짜), 입항일 기준(deGb=I).
  한 번에 조회 하나만(CONCURRENCY 1): 요청은 차례로 보내므로 속도 상한 대기열에는 이 작업의 대기자가 하나뿐이다.
- 캐시(wakeline:portcalls:{호출부호}, SET EX): ok·none 6 h, error 5분, disabled 2분. 캐시가 있으면 묻지 않고, 캐시를 확인할 수 없으면 묻지 않는다.
  캐시에 쓰지 못하면 그 호출부호는 같은 TTL 동안 이 프로세스 안에서 다시 묻지 않는다(공급자 보호 — route 와 같다).
- 한 요청이라도 실패하면(HTTP 오류 · resultCode ≠ 00 · 모양 이상 · 속도 상한 · 예산) 그 조회 전체를 error 로 적고 나머지 항만청은 묻지 않는다 —
  일부 항만청만 받은 결과를 "기록 없음" 처럼 보이지 않게.
- 꺼져 있으면 disabled: 키 없음(no_key) · fixture 모드(fixture) · 운영자 스위치(operator, wakeline:provider:portmis disabled=1 — 요청마다
  보내기 직전에 다시 본다).
- 하루 예산(portmis)은 요청마다 보내기 전에 예약하고, 보내지 않은 요청은 되돌린다. portcall_requests 는 실제로 보낸 요청만 센다.
- 비밀값: serviceKey 는 요청 쿼리에만 있다. 로그·공급자 상태·캐시에는 호출부호·상태·사유(가린 뒤)만 남는다.
"""

from __future__ import annotations

import asyncio
import logging
import math
import time
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from datetime import UTC, date, datetime
from functools import partial
from typing import Protocol

from redis.asyncio import Redis

from wakeline_collector import portcalls as pcv
from wakeline_collector.budget import UNKNOWN, Budget
from wakeline_collector.errors import describe_error
from wakeline_collector.http import NOT_SENT_ERRORS, BeforeSend, ProviderHttpError, SendCancelled
from wakeline_collector.portcalls import (
    DEMAND_KEY,
    PORT_AUTHORITIES,
    DisabledReason,
    PortCall,
    PortCallApiError,
    PortCallParseError,
    PortCallsValue,
    normalize_call_sign,
    portcalls_key,
    query_window,
)
from wakeline_collector.providers.portmis import NUM_OF_ROWS, PORTMIS_WAIT_S, PageFetch
from wakeline_collector.ratelimit import Throttled
from wakeline_collector.status import ProviderStatus

log = logging.getLogger("job.portcalls")

CONCURRENCY = 1
MAX_PENDING = 16  # 대기 중 조회 상한(api 임대 상한 20). 넘친 호출부호는 다음 읽기에 다시 요청된다.
MAX_PAGES = 6  # 항만청당 쪽 상한(= 300건 — 30일에 한 선박이 한 항만청에 이보다 많이 드나들면 incomplete)
HOLD_PRUNE_AT = 1024
POLL_S = 2.0
REASK_S = 30.0
DEMAND_READ_MAX = 64  # ZRANGEBYSCORE LIMIT — 임대가 비정상적으로 많아도 읽는 양은 고정
MAX_LEASES = 20  # api 상한과 같다(수집기가 다시 건다)
DISABLED_MSG = {
    "no_key": "DATA_GO_KR_SERVICE_KEY not set",
    "fixture": "fixture mode — no external calls",
    "operator": "provider disabled by operator",
}


class PortCallProvider(Protocol):
    name: str
    cost: int
    host: str

    async def fetch_page(
        self,
        *,
        port_authority: str,
        call_sign: str,
        sde: date,
        ede: date,
        page_no: int,
        wait_s: float = ...,
        before_send: BeforeSend | None = None,
    ) -> PageFetch: ...


@dataclass
class _Failed:
    """요청 하나의 실패: 캐시에 적을 값(error 또는 disabled)과 로그 사유."""

    value: PortCallsValue
    why: str


class PortCallLookup:
    def __init__(
        self,
        redis: Redis,
        provider: PortCallProvider | None,
        budget: Budget,
        status: ProviderStatus,
        *,
        off_reason: DisabledReason = "fixture",
        max_pending: int = MAX_PENDING,
        wait_s: float = PORTMIS_WAIT_S,
        clock: Callable[[], float] = time.monotonic,
        now: Callable[[], datetime] = lambda: datetime.now(UTC),
    ):
        # provider None = 조회하지 않는다(off_reason: fixture 모드 또는 키 없음)
        self._r, self.provider, self._budget, self._status = redis, provider, budget, status
        self._off_reason: DisabledReason = off_reason
        self._sem = asyncio.Semaphore(CONCURRENCY)
        self._max_pending = max_pending
        self._wait_s = wait_s
        self._clock = clock
        self._now = now
        self._tasks: dict[str, asyncio.Task[None]] = {}
        self._hold: dict[str, float] = {}
        self._last_log = 0.0
        self.counts = {"lookups": 0, "requests": 0, "ok": 0, "none": 0, "errors": 0, "disabled": 0, "dropped": 0, "mismatched": 0}

    @property
    def inflight(self) -> int:
        return len(self._tasks)

    # ---- 요청 --------------------------------------------------------------------------------------------------------
    def request(self, call_signs: Iterable[object]) -> int:
        """호출부호들의 조회를 시작한다(기다리지 않는다). 형식이 틀리거나 이미 진행 중이면 건너뛴다. 새로 시작한 수."""
        started = 0
        now = self._clock()
        if len(self._hold) >= HOLD_PRUNE_AT:
            self._hold = {k: t for k, t in self._hold.items() if t > now}
        for raw in call_signs:
            cs = normalize_call_sign(raw)
            if cs is None or cs in self._tasks or self._hold.get(cs, 0.0) > now:
                continue
            if len(self._tasks) >= self._max_pending:
                self.counts["dropped"] += 1
                continue
            task = asyncio.create_task(self._run(cs), name=f"portcalls-{cs}")
            self._tasks[cs] = task
            task.add_done_callback(partial(self._done, cs))
            started += 1
        return started

    def _done(self, cs: str, task: asyncio.Task[None]) -> None:
        if self._tasks.get(cs) is task:
            del self._tasks[cs]

    async def aclose(self) -> None:
        """진행 중 조회를 취소한다(종료). 보내지 않은 요청의 예산은 되돌린다."""
        tasks = list(self._tasks.values())
        for t in tasks:
            t.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)

    # ---- 조회 --------------------------------------------------------------------------------------------------------
    async def _run(self, cs: str) -> None:
        try:
            await self._lookup(cs)
        except Exception as e:  # noqa: BLE001 — 태스크 예외가 추적 로그로 새지 않게(예외 이름만)
            self.counts["errors"] += 1
            log.warning("portcalls %s: lookup failed unexpectedly (%s)", cs, type(e).__name__)

    async def _lookup(self, cs: str) -> None:
        key = portcalls_key(cs)
        try:
            if await self._r.exists(key):
                return
        except Exception as e:  # noqa: BLE001 — 캐시를 확인할 수 없으면 묻지 않는다(다음 읽기에 다시)
            self._warn("exists", e)
            return
        async with self._sem:
            value, why = await self._resolve(cs)
        self.counts["errors" if value.status == "error" else value.status] += 1
        try:
            await self._r.set(key, value.to_json(), ex=value.ttl_s)
        except Exception as e:  # noqa: BLE001 — 쓰지 못한 값의 TTL 동안은 다시 묻지 않는다(공급자 보호)
            self._hold[cs] = self._clock() + value.ttl_s
            self._warn("set", e)
            return
        self._hold.pop(cs, None)
        extra = f", {len(value.items)} item(s)" if value.status == "ok" else ""
        log.info("portcalls %s: %s%s%s", cs, value.status, extra, f" ({why})" if why else "")

    async def _resolve(self, cs: str) -> tuple[PortCallsValue, str | None]:
        p = self.provider
        started = self._now()
        if p is None:
            return pcv.disabled(cs, self._off_reason, started), DISABLED_MSG[self._off_reason]
        if await self._status.is_disabled(p.name):
            return pcv.disabled(cs, "operator", started), DISABLED_MSG["operator"]
        self.counts["lookups"] += 1
        window = query_window(started)
        items: list[PortCall] = []
        incomplete = False
        latency_ms, used = 0, UNKNOWN
        for code, _name in PORT_AUTHORITIES:
            page_no = 1
            while True:
                got = await self._fetch(p, cs, code, window, page_no, started)
                if isinstance(got, _Failed):
                    return got.value, got.why
                page, u = got
                used = u if u != UNKNOWN else used
                latency_ms += page.latency_ms
                items += page.page.items
                self.counts["mismatched"] += page.page.mismatched
                if page_no * NUM_OF_ROWS >= page.page.total:
                    break
                if page_no >= MAX_PAGES:
                    incomplete = True
                    break
                page_no += 1
        value = pcv.build_value(cs, started, window, items, incomplete=incomplete)
        await self._status.success(
            p.name,
            at=self._now(),
            latency_ms=latency_ms,
            records=len(items),
            used=None if used == UNKNOWN else used,
            limit=self._budget.limit(p.name),
        )
        return value, None

    async def _fetch(
        self, p: PortCallProvider, cs: str, code: str, window: tuple[date, date], page_no: int, started: datetime
    ) -> tuple[PageFetch, int] | _Failed:
        """요청 하나: 예산 예약 → 속도 상한 → 보내기 직전 스위치 확인 → 파싱. 실패는 _Failed(이미 공급자 상태에 적었다)."""
        ok, used = await self._budget.reserve(p.name, p.cost)
        if not ok:
            why = "budget store unavailable" if used == UNKNOWN else f"daily budget exhausted (used={used})"
            return _Failed(pcv.error(cs, why, started), why)
        sent = False

        async def before_send() -> bool:
            """속도 상한 허가를 받은 뒤 보내기 직전: 기다리는 사이 운영자가 껐으면 보내지 않는다."""
            nonlocal sent
            if await self._status.is_disabled(p.name):
                return False
            sent = True
            return True

        http_status: int | None = None
        try:
            got = await p.fetch_page(
                port_authority=code,
                call_sign=cs,
                sde=window[0],
                ede=window[1],
                page_no=page_no,
                wait_s=self._wait_s,
                before_send=before_send,
            )
        except asyncio.CancelledError:  # 종료: 보내지 않았으면 예산을 되돌린다
            if not sent:
                await asyncio.shield(self._budget.release(p.name, p.cost))
            raise
        except Throttled as e:  # 속도 상한 대기 초과·429 쿨다운 — 보내지 않았다
            await self._budget.release(p.name, p.cost)
            return _Failed(pcv.error(cs, e.reason, started), e.reason)
        except SendCancelled:  # 기다리는 사이 운영자가 껐다 — 보내지 않았다
            await self._budget.release(p.name, p.cost)
            return _Failed(pcv.disabled(cs, "operator", started), DISABLED_MSG["operator"])
        except ProviderHttpError as e:
            self.counts["requests"] += 1
            why, http_status = describe_error(e), e.status
        except (
            PortCallApiError,
            PortCallParseError,
        ) as e:  # 보냈고 응답을 받았다 — 사유는 이미 가린 고정 문구 + 공급자 코드·문구
            self.counts["requests"] += 1
            why = str(e)
        except NOT_SENT_ERRORS as e:  # 허용 호스트 아님·연결 풀 대기 초과·연결 전 실패 — 보내지 않았다
            await self._budget.release(p.name, p.cost)
            why = describe_error(e)
        except Exception as e:  # noqa: BLE001 — 읽기 시간 초과 등(보낸 것으로 센다)
            self.counts["requests"] += 1
            why = describe_error(e)
        else:
            self.counts["requests"] += 1
            return got, used
        why = f"prtAgCd {code}: {why}"  # 어느 항만청 요청에서 멈췄는가
        await self._status.failure(p.name, at=self._now(), error=why, http_status=http_status)
        return _Failed(pcv.error(cs, why, started), why)

    def _warn(self, what: str, e: Exception) -> None:
        now = time.monotonic()
        if now - self._last_log > 60:
            self._last_log = now
            log.warning("portcalls cache %s failed (%s) — skipping lookup", what, type(e).__name__)

    # ---- 지표 --------------------------------------------------------------------------------------------------------
    def metrics(self) -> dict[str, str]:
        """portcall_requests = 실제로 보낸 PORT-MIS 요청 수(예산을 쓴 것)."""
        return {
            "portcall_lookups": str(self.counts["lookups"]),
            "portcall_requests": str(self.counts["requests"]),
            "portcall_errors": str(self.counts["errors"]),
            "portcall_inflight": str(self.inflight),
        }


class PortCallJob:
    """수요 임대(wakeline:demand:portcalls)를 읽어 조회에 넘긴다. 쓰기 명령은 쓰지 않는다(임대는 api 만 쓴다)."""

    def __init__(
        self,
        redis: Redis,
        lookup: PortCallLookup,
        *,
        poll_s: float = POLL_S,
        reask_s: float = REASK_S,
        now_ms: Callable[[], float] | None = None,
        clock: Callable[[], float] = time.monotonic,
    ):
        self._r = redis
        self.lookup = lookup
        self._poll_s = poll_s
        self._reask_s = reask_s
        self._now_ms = now_ms or (lambda: time.time() * 1000.0)
        self._clock = clock
        self._asked: dict[str, float] = {}
        self._last_log = 0.0
        self.errors = 0

    async def run(self, stop: asyncio.Event) -> None:
        log.info("port-call lookups started (provider=%s)", "portmis" if self.lookup.provider is not None else "off")
        while not stop.is_set():
            try:
                await self.tick()
            except Exception:  # noqa: BLE001 — 한 번의 오류가 작업을 멈추지 않게
                log.exception("port-call tick failed")
            try:
                await asyncio.wait_for(stop.wait(), timeout=self._poll_s)
            except TimeoutError:
                pass
        await self.lookup.aclose()

    async def wanted(self) -> list[str] | None:
        """살아 있는 임대의 호출부호(정규화 · 중복 제거 · 상한). Redis 를 못 읽으면 None."""
        try:
            rows = await self._r.zrangebyscore(DEMAND_KEY, self._now_ms(), "+inf", start=0, num=DEMAND_READ_MAX)
        except Exception as e:  # noqa: BLE001 — 임대를 못 읽으면 이번 차례는 건너뛴다
            self.errors += 1
            now = time.monotonic()
            if now - self._last_log > 60:
                self._last_log = now
                log.warning("port-call demand read failed (%s)", type(e).__name__)
            return None
        return sorted({cs for cs in (normalize_call_sign(m) for m in rows or []) if cs})[:MAX_LEASES]

    async def tick(self) -> int:
        wanted = await self.wanted()
        if wanted is None:
            return 0
        now = self._clock()
        keep = set(wanted)
        self._asked = {k: t for k, t in self._asked.items() if k in keep}
        due = [cs for cs in wanted if now - self._asked.get(cs, -math.inf) >= self._reask_s]
        if not due:
            return 0
        self._asked.update(dict.fromkeys(due, now))
        return self.lookup.request(due)
