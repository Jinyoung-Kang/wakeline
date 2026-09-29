"""일시 오류 한 번 다시 부르기 — KMA 레이더(jobs/kma_radar.py)에서 시작해 기상 작업(jobs/weather.py: AWC METAR/TAF · SIGMET,
RainViewer)도 같은 규칙을 쓴다.

- 다시 부르는 오류(RETRY_ERRORS): 시간 초과(httpx.TimeoutException — 요청 전체 상한 RequestTimedOut 포함) · 연결 실패(ConnectError) ·
  프로토콜 오류(RemoteProtocolError). 그 밖 — HTTP 오류(ProviderHttpError, 4xx · 5xx) · 속도 상한(Throttled) · 응답 모양 오류(ValueError)
  등 — 은 다시 부르지 않는다.
- 실패한 호출마다 한 번, RETRY_DELAY_S 뒤. 그 전에 예산 1 을 따로 예약한다(reserve) — 예약하지 못하면 다시 부르지 않는다(INFO 한 줄).
- 다시 부른 호출도 공급자 → HttpClient 를 지나므로 속도 상한(RateLimiter) 허가를 받는다(우회하지 않는다). 허가를 못 받으면 Throttled 로
  끝나고, 그것은 다시 부르지 않는다.
- 로그: 다시 부르기 전 INFO 한 줄(단계 · 오류 · 걸린 시간). 최종 실패의 WARN 은 호출자가 한 번 남긴다 — CallFailed.log_text() 가 단계 ·
  오류(describe_error) · 걸린 시간 · 첫 시도를 담고, CallFailed.detail() 이 같은 내용을 상태 last_error · 실행 기록 error_text 용으로 담는다.
- 5 s · 한 번은 선택값이다 — 공급자 응답 시간을 재서 정한 값이 아니다.
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import Awaitable, Callable

import httpx

from wakeline_collector.budget import UNKNOWN
from wakeline_collector.errors import LIMIT, describe_error

RETRY_DELAY_S = 5.0  # 일시 오류 뒤 다시 부르기 전 기다림(선택값). 다시 부르기는 실패한 호출마다 한 번
# 다시 불러 볼 만한 일시 오류. RequestTimedOut(전체 상한 초과)은 httpx.TimeoutException 하위라 여기 든다.
RETRY_ERRORS: tuple[type[Exception], ...] = (httpx.TimeoutException, httpx.ConnectError, httpx.RemoteProtocolError)

Reserve = Callable[[], Awaitable[tuple[bool, int]]]  # (허용 여부, 예약 후 사용량 | budget.UNKNOWN)
Sleep = Callable[[float], Awaitable[None]]


class CallFailed(Exception):
    """한 단계 호출의 실패. error = 마지막 시도의 예외, elapsed_s = 그 시도에 걸린 시간(모르면 None),
    first = 다시 불렀다면 첫 시도의 (예외, 걸린 시간)."""

    def __init__(
        self, step: str, error: BaseException, elapsed_s: float | None, first: tuple[BaseException, float] | None = None
    ) -> None:
        super().__init__(f"{step}: {type(error).__name__}")
        self.step, self.error, self.elapsed_s, self.first = step, error, elapsed_s, first

    def detail(self, *, limit: int = LIMIT) -> str:
        """상태 last_error · 실행 기록 error_text: '<오류> · <단계> · N s 경과 · 5 s 뒤 1회 재시도(첫 시도 <종류> · N s)'."""
        took = f" · {self.elapsed_s:.1f} s 경과" if self.elapsed_s is not None else ""
        retried = ""
        if self.first is not None:
            first_e, first_s = self.first
            retried = f" · {RETRY_DELAY_S:.0f} s 뒤 1회 재시도(첫 시도 {type(first_e).__name__} · {first_s:.1f} s)"
        return f"{describe_error(self.error, limit=limit)} · {self.step}{took}{retried}"

    def log_text(self) -> str:
        """경고 로그: '<단계> — <오류> after N s; retried once after 5 s (first attempt: <종류> after N s)'."""
        after = f" after {self.elapsed_s:.1f} s" if self.elapsed_s is not None else ""
        again = ""
        if self.first is not None:
            first_e, first_s = self.first
            again = f"; retried once after {RETRY_DELAY_S:.0f} s (first attempt: {type(first_e).__name__} after {first_s:.1f} s)"
        return f"{self.step} — {describe_error(self.error)}{after}{again}"


async def call_retry_once[T](
    step: str,
    fn: Callable[[], Awaitable[T]],
    *,
    reserve: Reserve,
    log: logging.Logger,
    label: str,
    sleep: Sleep = asyncio.sleep,
) -> T:
    """step 호출. 실패는 모두 CallFailed(단계 · 걸린 시간)로 올린다. 일시 오류(RETRY_ERRORS)면 reserve() 로 예산 1 을 예약할 수 있을 때
    RETRY_DELAY_S 뒤 한 번 다시 부른다. label 은 로그 앞머리(예: 'kma radar' · 'sigmet/awc')."""
    t0 = time.monotonic()
    try:
        return await fn()
    except RETRY_ERRORS as e:
        first, first_s = e, time.monotonic() - t0
    except Exception as e:  # noqa: BLE001 — 호출자가 종류별로 나눈다(해석 불가 · 아직 없음 · 실패)
        raise CallFailed(step, e, time.monotonic() - t0) from e
    ok, used = await reserve()
    if not ok:
        log.info(
            "%s: %s — %s after %.1f s; not retried (budget %s)",
            label,
            step,
            describe_error(first),
            first_s,
            "unavailable" if used == UNKNOWN else f"exhausted (used={used})",
        )
        raise CallFailed(step, first, first_s) from first
    log.info("%s: %s — %s after %.1f s — retrying once in %.0f s", label, step, describe_error(first), first_s, RETRY_DELAY_S)
    await sleep(RETRY_DELAY_S)
    t1 = time.monotonic()
    try:
        return await fn()
    except Exception as e:  # noqa: BLE001
        raise CallFailed(step, e, time.monotonic() - t1, first=(first, first_s)) from e
