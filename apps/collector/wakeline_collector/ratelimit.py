"""외부 호출 속도 상한 — 프로세스 안 토큰 버킷(수집기는 단일 인스턴스, ADR-013 §3 · 계약 v2 §A2).

- 모든 외부 HTTP 호출은 수집기 전체 버킷(기본 2.0 req/s, burst 2)을, 호스트 버킷이 정의된 호스트는 그것도(adsb.fi 0.8 req/s,
  burst 1 — 공식 초당 1회의 80 % · adsbdb 0.5 req/s, burst 2 — 계약 v4 §A) 함께 통과해야 한다. HttpClient 가 호출 직전에 받으므로 새 코드도 우회할 수 없다.
- 기다리는 호출은 우선순위(0 고정 관심 지역·기타 주기 작업 > 1 focus > 2 hot > 3 노선 조회 > 4 격자 기하 채우기) · 도착 순으로 줄 선다.
  앞선 대기자가 막혀 있는 버킷은 뒤 대기자도 쓰지 않는다 → 낮은 우선순위가 높은 우선순위의 토큰을 가로채지 못한다.
  단 429 쿨다운 중인 대기자는 자기 호스트만 막는다(공용 버킷을 잡아 두지 않는다 — 다른 호스트 호출이 그 뒤에 서지 않게).
- 대기 상한(wait_s) 안에 토큰을 못 받으면 Throttled. 호출하지 않았으므로 공급자 쪽 사용량도 없다(예산은 호출자가 되돌린다).
- 429 를 받으면 그 호스트를 잠시 막는다(penalize: Retry-After 우선, 없으면 30 → 60 → 120 → 300 s). 모든 호출자에 공통.
- 대기열은 상한(MAX_WAITERS)이 있다. 넘치면 기다리지 않고 Throttled.
"""

from __future__ import annotations

import asyncio
import bisect
import itertools
import math
import time
from collections import deque
from collections.abc import Callable
from dataclasses import dataclass, field

PRIORITY_FIXED = 0  # 고정 관심 지역·전세계·기상 등 주기 작업
PRIORITY_FOCUS = 1  # 선택 항공기 집중 추적
PRIORITY_HOT = 2  # 뷰포트 핫 리전
PRIORITY_ROUTE = 3  # 선택 항공기 노선 조회(adsbdb, 계약 v4 §A) — 핫 리전보다 낮다
PRIORITY_BACKFILL = 4  # 연안 교통량 격자 기하 채우기(ADR-023 — 모르는 칸마다 WFS 한 번) — 가장 낮다

GLOBAL = "*"
MAX_WAITERS = 64
RATE_WINDOW_S = 60.0
PENALTY_STEPS_S = (30.0, 60.0, 120.0, 300.0)
PENALTY_RESET_S = 900.0  # 마지막 429 로부터 이만큼 조용하면 단계 초기화
PENALTY_MAX_S = 600.0  # Retry-After 가 이상하게 길어도 이 이상 막지 않는다


class Throttled(RuntimeError):
    """대기 상한 안에 호출 허가를 받지 못함(호출하지 않았다)."""

    def __init__(self, host: str, reason: str, *, cooldown_s: float = 0.0):
        super().__init__(f"throttled {host}: {reason}")
        self.host = host
        self.reason = reason
        self.cooldown_s = cooldown_s  # 429 쿨다운 때문이면 남은 초(그 밖은 0)


class TokenBucket:
    __slots__ = ("rate", "burst", "tokens", "stamp")

    def __init__(self, rate: float, burst: float, now: float):
        if not (rate > 0 and burst >= 1):
            raise ValueError(f"invalid bucket rate={rate} burst={burst}")
        self.rate, self.burst = float(rate), float(burst)
        self.tokens = float(burst)
        self.stamp = now

    def _refill(self, now: float) -> None:
        if now > self.stamp:
            self.tokens = min(self.burst, self.tokens + (now - self.stamp) * self.rate)
            self.stamp = now

    def wait_s(self, now: float) -> float:
        """토큰 1개를 쓸 수 있을 때까지 남은 초(0 = 지금)."""
        self._refill(now)
        return 0.0 if self.tokens >= 1.0 else (1.0 - self.tokens) / self.rate

    def take(self, now: float) -> None:
        self._refill(now)
        self.tokens -= 1.0


@dataclass(order=True)
class _Waiter:
    priority: int
    seq: int
    host: str = field(compare=False)
    fut: asyncio.Future[None] = field(compare=False)


class RateLimiter:
    def __init__(
        self,
        global_rps: float,
        global_burst: float,
        hosts: dict[str, tuple[float, float]] | None = None,
        *,
        clock: Callable[[], float] = time.monotonic,
    ):
        now = clock()
        self._clock = clock
        self._global = TokenBucket(global_rps, global_burst, now)
        self._hosts = {h: TokenBucket(r, b, now) for h, (r, b) in (hosts or {}).items()}
        self._blocked_until: dict[str, float] = {}
        self._penalty_step: dict[str, int] = {}
        self._last_penalty: dict[str, float] = {}
        self._waiters: list[_Waiter] = []
        self._seq = itertools.count()
        self._timer: asyncio.TimerHandle | None = None
        self._sent: dict[str, deque[float]] = {}
        self.granted = 0
        self.throttled = 0

    # ---- 조회 ------------------------------------------------------------------------------------------------------
    def host_rps(self, host: str) -> float | None:
        b = self._hosts.get(host)
        return b.rate if b else None

    @property
    def global_rps(self) -> float:
        return self._global.rate

    def cooldown_remaining(self, host: str) -> float:
        return max(0.0, self._blocked_until.get(host, 0.0) - self._clock())

    def rate_1m(self, host: str = GLOBAL) -> float:
        """최근 60 s 동안 실제로 허가한 호출 수 / 60 (host='*' 는 전체)."""
        dq = self._sent.get(host)
        if not dq:
            return 0.0
        self._trim(dq, self._clock())
        return len(dq) / RATE_WINDOW_S

    @property
    def waiting(self) -> int:
        return len(self._waiters)

    # ---- 429 -------------------------------------------------------------------------------------------------------
    def penalize(self, host: str, retry_after_s: float | None = None) -> float:
        """호스트를 잠시 막는다. 반환값은 막는 시간(초)."""
        now = self._clock()
        if now - self._last_penalty.get(host, -math.inf) > PENALTY_RESET_S:
            self._penalty_step[host] = 0
        step = self._penalty_step.get(host, 0)
        self._penalty_step[host] = step + 1
        self._last_penalty[host] = now
        wait = PENALTY_STEPS_S[min(step, len(PENALTY_STEPS_S) - 1)]
        if retry_after_s is not None and retry_after_s > 0:
            wait = max(wait, retry_after_s)
        wait = min(wait, PENALTY_MAX_S)
        self._blocked_until[host] = max(self._blocked_until.get(host, 0.0), now + wait)
        return wait

    # ---- 허가 ------------------------------------------------------------------------------------------------------
    async def acquire(self, host: str, *, priority: int = PRIORITY_FIXED, wait_s: float = 10.0) -> float:
        """호출 허가를 받는다(최대 wait_s 초 대기). 반환값은 기다린 초. 못 받으면 Throttled."""
        t0 = self._clock()
        blocked = self.cooldown_remaining(host)
        if blocked > wait_s:
            self.throttled += 1
            raise Throttled(host, f"cooling down {blocked:.0f} s after HTTP 429", cooldown_s=blocked)
        if len(self._waiters) >= MAX_WAITERS:
            self.throttled += 1
            raise Throttled(host, f"{len(self._waiters)} calls already waiting")
        loop = asyncio.get_running_loop()
        w = _Waiter(priority, next(self._seq), host, loop.create_future())
        bisect.insort(self._waiters, w)
        self._pump()
        try:
            await asyncio.wait_for(asyncio.shield(w.fut), timeout=max(0.0, wait_s))
        except TimeoutError:
            if w.fut.done() and not w.fut.cancelled():  # 시간 초과와 허가가 같은 순간에 겹친 경우 — 허가를 쓴다
                return self._clock() - t0
            self._drop(w)
            self.throttled += 1
            raise Throttled(host, f"no slot within {wait_s:.1f} s") from None
        except asyncio.CancelledError:
            self._drop(w)
            raise
        return self._clock() - t0

    def _drop(self, w: _Waiter) -> None:
        if not w.fut.done():
            w.fut.cancel()
        try:
            self._waiters.remove(w)
        except ValueError:
            pass
        self._pump()  # 막고 있던 대기자가 빠졌으니 뒤 대기자를 다시 본다

    def _buckets(self, host: str) -> tuple[TokenBucket, ...]:
        hb = self._hosts.get(host)
        return (self._global, hb) if hb is not None else (self._global,)

    def _pump(self) -> None:
        if self._timer is not None:
            self._timer.cancel()
            self._timer = None
        now = self._clock()
        blocked: set[int] = set()  # 앞선 대기자가 기다리는 버킷(id). 뒤 대기자는 이 버킷을 쓰지 않는다.
        blocked_hosts: set[str] = set()
        next_wake = math.inf
        keep: list[_Waiter] = []
        for w in self._waiters:
            if w.fut.done():
                continue
            buckets = self._buckets(w.host)
            if w.host in blocked_hosts or any(id(b) in blocked for b in buckets):
                keep.append(w)
                continue
            cool = self._blocked_until.get(w.host, 0.0) - now
            if cool > 0:  # 429 쿨다운: 그 호스트만 막는다. 공용 버킷은 잡아 두지 않는다(쿨다운이 끝나면 다시 줄 선다).
                blocked_hosts.add(w.host)
                next_wake = min(next_wake, cool)
                keep.append(w)
                continue
            waits = [b.wait_s(now) for b in buckets]
            short = [s for s in waits if s > 0]
            if not short:
                for b in buckets:
                    b.take(now)
                self._record(w.host, now)
                w.fut.set_result(None)
                continue
            for b, s in zip(buckets, waits, strict=True):
                if s > 0:
                    blocked.add(id(b))
            # 가장 먼저 차는 버킷 시각에 다시 본다 — 그 버킷을 기다리던 뒤 대기자가 토큰이 돌아오는 즉시 풀린다
            next_wake = min(next_wake, min(short))
            keep.append(w)
        self._waiters = keep
        if keep and next_wake < math.inf:
            self._timer = asyncio.get_running_loop().call_later(max(next_wake, 0.001), self._pump)

    def _record(self, host: str, now: float) -> None:
        self.granted += 1
        for k in (host, GLOBAL):
            dq = self._sent.setdefault(k, deque())
            dq.append(now)
            self._trim(dq, now)

    @staticmethod
    def _trim(dq: deque[float], now: float) -> None:
        while dq and now - dq[0] > RATE_WINDOW_S:
            dq.popleft()


ADSBDB_BURST = 2
DATA_GO_KR_BURST = 2


def default_limiter(global_rps: float, adsb_fi_rps: float, adsbdb_rps: float = 0.5, data_go_kr_rps: float = 1.0) -> RateLimiter:
    """계약 v2 §A2: 수집기 전체 2.0 req/s(burst 2) · opendata.adsb.fi 0.8 req/s(burst 1).
    계약 v4 §A: api.adsbdb.com 0.5 req/s(burst 2) — 공급자 문서에 한도가 없어 보수적으로 둔다.
    ADR-023: apis.data.go.kr 1.0 req/s(burst 2) — 두 서비스(해양교통 · 해양격자)가 나눠 쓴다. 선택값(포털의 초당 한도를 재지 않았다)."""
    return RateLimiter(
        global_rps,
        2,
        {
            "opendata.adsb.fi": (adsb_fi_rps, 1),
            "api.adsbdb.com": (adsbdb_rps, ADSBDB_BURST),
            "apis.data.go.kr": (data_go_kr_rps, DATA_GO_KR_BURST),
        },
    )
