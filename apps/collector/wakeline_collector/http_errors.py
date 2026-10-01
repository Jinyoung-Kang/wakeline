"""외부 호출 실패의 종류 — 순수 규칙(입출력 없음 · 설정을 읽지 않는다). HttpClient(http.py)가 올리고, 오류 문구(errors) · 다시 부르기(retry) ·
보내기 판정(send_outcome)이 읽는다. http 가 같은 이름으로 다시 내보낸다(옛 import 경로 — 시험 · 작업 · 공급자).

보내지 않은 실패(NOT_SENT_ERRORS)는 호출자가 예산을 돌려준다. 쓰기 · 읽기 도중 실패는 보낸 것으로 친다(과대 집계는 안전 쪽).
"""

from __future__ import annotations

import httpx


class HostNotAllowed(RuntimeError):
    pass


class ResponseTooLarge(RuntimeError):
    pass


class SendCancelled(RuntimeError):
    """보내기 직전 확인(before_send)이 거절했다 — 요청을 보내지 않았다."""


class RequestTimedOut(httpx.TimeoutException):
    """요청 전체 시간 상한(total_s)을 넘었다. 보낸 뒤일 수 있으므로 보낸 호출로 센다(NOT_SENT_ERRORS 에 넣지 않는다)."""


class ProviderHttpError(RuntimeError):
    def __init__(
        self,
        status: int,
        body_head: str,
        headers: dict[str, str] | None = None,
        latency_ms: int | None = None,
        pause_s: float | None = None,
    ):
        super().__init__(f"HTTP {status}: {body_head[:200]}")
        self.status = status
        self.body_head = body_head[:200]  # 오류 응답의 모양 판별용(예: adsbdb 404 "unknown callsign")
        self.headers = headers or {}
        self.latency_ms = latency_ms
        self.pause_s = pause_s  # 429 로 그 호스트를 막은 초(RateLimiter.penalize 의 반환값). 429 가 아니면 None


class PreSendFailed(RuntimeError):
    """요금이 드는 요청 앞의 준비 호출(OpenSky 토큰 발급)이 실패해 그 요청을 보내지 않았다 — 예산은 돌려주고, 공급자 실패로는 센다(classify_send).
    status = 준비 호출의 HTTP 상태(있으면 — 호출자가 429 · 401 을 그대로 다룬다)."""

    def __init__(self, step: str, error: BaseException) -> None:
        super().__init__(f"{step} failed: {type(error).__name__}: {error}")
        self.step, self.error = step, error
        self.status = error.status if isinstance(error, ProviderHttpError) else None


# 우리 쪽 까닭으로 보내지 않았다(허용 호스트 아님 · 보내기 직전 취소 · URL · 연결 풀 대기 초과 · 프록시) — 공급자 실패가 아니다(classify_send)
NOT_SENT_LOCAL: tuple[type[Exception], ...] = (
    HostNotAllowed,
    SendCancelled,
    httpx.InvalidURL,
    httpx.UnsupportedProtocol,
    httpx.PoolTimeout,
    httpx.ProxyError,
)
# 요청을 보내기 전에 난 실패(보내지 않았다 → 호출자는 예산을 되돌린다). 쓰기·읽기 도중 실패는 보낸 것으로 친다(과대 집계는 안전 쪽).
NOT_SENT_ERRORS: tuple[type[Exception], ...] = (*NOT_SENT_LOCAL, httpx.ConnectError, httpx.ConnectTimeout, PreSendFailed)
