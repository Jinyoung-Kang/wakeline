"""선택한 항공기의 노선 조회(계약 v4 §A · ADR-016) — 집중 추적 결과의 콜사인을 adsbdb 에 묻고 Redis 에만 둔다.

- 계기: DemandTracker 가 focus 결과를 발행한 뒤 request(콜사인들)를 부른다. 조회는 별도 태스크라 focus·hot 발행을 기다리게 하지 않는다.
- 콜사인마다 진행 중 조회는 하나(대기 포함). 캐시(wakeline:route:{CALLSIGN})가 있으면 묻지 않고, 캐시를 확인할 수 없으면(Redis 오류) 묻지 않는다.
- 속도 상한 대기열에는 CONCURRENCY 개까지만 들어간다 — 우선순위가 가장 낮은 조회가 대기열 상한(MAX_WAITERS)을 채우지 않게.
- 운영자 스위치(wakeline:provider:adsbdb disabled=1)와 하루 예산(adsbdb, 예약·해제는 다른 공급자와 같은 규칙)을 지킨다.
- 결과는 SET EX: found·not_found 1,800 s, error 120 s. 부르지 못한 경우(꺼짐·예산·속도 상한)도 error 로 적는다 —
  캐시가 없으면 화면은 계속 "노선 조회 중" 이라 사실과 달라진다(2분 뒤 다시 묻는다).
  캐시에 쓰지 못하면(예: Redis noeviction 메모리 초과 — EXISTS 는 되는데 SET 은 실패) 그 콜사인은 같은 TTL 동안
  이 프로세스 안에서 다시 묻지 않는다(focus 5 s 마다 공급자를 다시 부르지 않게).
- 저장 금지(약관): DB·원천 보관에 쓰지 않는다. 로그·공급자 상태에는 콜사인·상태(오류면 HTTP 상태나 예외 이름)만 남긴다.
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import Callable, Iterable
from datetime import UTC, datetime
from functools import partial
from typing import Protocol

import httpx
from redis.asyncio import Redis

from wakeline_collector import route
from wakeline_collector.budget import UNKNOWN, Budget
from wakeline_collector.http import ProviderHttpError
from wakeline_collector.providers.adsbdb import ROUTE_WAIT_S, RouteFetch
from wakeline_collector.ratelimit import Throttled
from wakeline_collector.route import RouteValue, normalize_callsign, route_key
from wakeline_collector.status import ProviderStatus

log = logging.getLogger("job.route")

CONCURRENCY = 2  # 동시에 속도 상한을 기다리는 조회 수(= adsbdb 호스트 burst)
MAX_PENDING = 64  # 대기 중 조회 상한(focus 최대 50대). 넘친 콜사인은 다음 focus 주기에 다시 요청된다.
HOLD_PRUNE_AT = 1024  # 캐시 쓰기 실패로 잠시 묻지 않는 콜사인 목록이 이만큼 쌓이면 만료분을 지운다
DISABLED_MSG = "provider disabled by operator"


class RouteProvider(Protocol):
    name: str
    cost: int
    host: str

    async def lookup(self, callsign: str, *, wait_s: float) -> RouteFetch: ...


class RouteLookup:
    def __init__(
        self,
        redis: Redis,
        provider: RouteProvider,
        budget: Budget,
        status: ProviderStatus,
        *,
        concurrency: int = CONCURRENCY,
        max_pending: int = MAX_PENDING,
        wait_s: float = ROUTE_WAIT_S,
        clock: Callable[[], float] = time.monotonic,
    ):
        self._r, self.provider, self._budget, self._status = redis, provider, budget, status
        self._sem = asyncio.Semaphore(concurrency)
        self._max_pending = max_pending
        self._wait_s = wait_s
        self._clock = clock
        self._tasks: dict[str, asyncio.Task[None]] = {}
        self._hold: dict[str, float] = {}  # 캐시에 쓰지 못한 콜사인 → 다시 물어도 되는 시각(monotonic)
        self._last_log = 0.0
        self.counts = {"lookups": 0, "found": 0, "not_found": 0, "errors": 0, "dropped": 0}

    @property
    def inflight(self) -> int:
        return len(self._tasks)

    # ---- 요청 --------------------------------------------------------------------------------------------------------
    def request(self, callsigns: Iterable[object]) -> int:
        """콜사인들의 조회를 시작한다(기다리지 않는다). 형식이 틀린 콜사인·이미 진행 중인 콜사인은 건너뛴다. 새로 시작한 수."""
        started = 0
        now = self._clock()
        if len(self._hold) >= HOLD_PRUNE_AT:
            self._hold = {k: t for k, t in self._hold.items() if t > now}
        for raw in callsigns:
            cs = normalize_callsign(raw)
            if cs is None or cs in self._tasks or self._hold.get(cs, 0.0) > now:
                continue
            if len(self._tasks) >= self._max_pending:
                self.counts["dropped"] += 1
                continue
            task = asyncio.create_task(self._run(cs), name=f"route-{cs}")
            self._tasks[cs] = task
            task.add_done_callback(partial(self._done, cs))
            started += 1
        return started

    def _done(self, cs: str, task: asyncio.Task[None]) -> None:
        if self._tasks.get(cs) is task:
            del self._tasks[cs]

    async def aclose(self) -> None:
        """진행 중 조회를 취소한다(종료). 이미 보낸 호출의 예산은 쓴 것으로 둔다(과대 집계는 안전 쪽)."""
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
            log.warning("route %s: lookup failed unexpectedly (%s)", cs, type(e).__name__)

    async def _lookup(self, cs: str) -> None:
        key = route_key(cs)
        try:
            if await self._r.exists(key):
                return
        except Exception as e:  # noqa: BLE001 — 캐시를 확인할 수 없으면 묻지 않는다(다음 focus 주기에 다시)
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
        if why:
            log.info("route %s: %s (%s)", cs, value.status, why)
        else:
            log.info("route %s: %s", cs, value.status)

    async def _resolve(self, cs: str) -> tuple[RouteValue, str | None]:
        """(캐시 값, 오류 사유 | None). 사유는 고정 문구·HTTP 상태·예외 이름뿐이다(응답 내용 없음)."""
        p = self.provider
        if await self._status.is_disabled(p.name):
            return route.error(cs), DISABLED_MSG
        ok, used = await self._budget.reserve(p.name, p.cost)
        if not ok:
            return route.error(cs), "budget store unavailable" if used == UNKNOWN else f"daily budget exhausted (used={used})"
        started = datetime.now(UTC)
        http_status: int | None = None
        try:
            got = await p.lookup(cs, wait_s=self._wait_s)
        except Throttled as e:  # 속도 상한 대기 초과·429 쿨다운 — 보내지 않았다
            await self._budget.release(p.name, p.cost)
            return route.error(cs), e.reason
        except ProviderHttpError as e:  # 429 는 HttpClient 가 이미 호스트 벌점을 줬다(모든 호출자 공통)
            self.counts["lookups"] += 1
            why, http_status = f"HTTP {e.status}", e.status
        except (httpx.ConnectError, httpx.ConnectTimeout) as e:  # 연결 전 실패 — 보내지 않았다
            await self._budget.release(p.name, p.cost)
            why = type(e).__name__
        except Exception as e:  # noqa: BLE001 — 읽기 시간 초과·응답 모양 이상 등(보낸 것으로 센다)
            self.counts["lookups"] += 1
            why = type(e).__name__
        else:
            self.counts["lookups"] += 1
            if got.latency_ms is not None:
                await self._status.success(
                    p.name,
                    at=got.value.fetched_at,
                    latency_ms=got.latency_ms,
                    records=int(got.value.status == "found"),
                    used=None if used == UNKNOWN else used,
                    limit=self._budget.limit(p.name),
                )
            return got.value, None
        await self._status.failure(p.name, at=started, error=why, http_status=http_status)
        return route.error(cs, started), why

    def _warn(self, what: str, e: Exception) -> None:
        now = time.monotonic()
        if now - self._last_log > 60:
            self._last_log = now
            log.warning("route cache %s failed (%s) — skipping lookup", what, type(e).__name__)

    # ---- 지표 --------------------------------------------------------------------------------------------------------
    def metrics(self) -> dict[str, str]:
        """route_lookups = 실제로 보낸 adsbdb 호출 수(예산을 쓴 것)."""
        return {
            "route_lookups": str(self.counts["lookups"]),
            "route_errors": str(self.counts["errors"]),
            "route_inflight": str(self.inflight),
        }
