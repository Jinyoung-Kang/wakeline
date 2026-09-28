"""외부 호출 전용 HTTP 클라이언트 — 허용 호스트 목록(SSRF 방지)·호출 속도 상한·타임아웃·리다이렉트 금지·응답 크기 상한.

모든 외부 호출은 여기를 지나며, 호출 직전에 RateLimiter 허가(수집기 전체 + 호스트별 버킷, 우선순위)를 받는다.
허가를 받은 뒤 보내기 직전에 호출자의 확인(before_send, 예: 운영자가 공급자를 껐는지)을 한 번 더 거친다 — 아니면 보내지 않는다(SendCancelled).
429 응답은 그 호스트를 잠시 막는다(모든 호출자 공통) — Retry-After 가 있으면 따른다.
"""

from __future__ import annotations

import time
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime
from urllib.parse import urlparse

import httpx

from wakeline_collector.config import settings
from wakeline_collector.ratelimit import PRIORITY_FIXED, RateLimiter, default_limiter

DEFAULT_WAIT_S = 10.0  # 속도 상한 대기 기본 상한(주기 작업). focus·hot·관심 지역은 호출자가 더 짧게 준다.

ALLOWED_HOSTS = frozenset(
    {
        "api.adsb.lol",
        "opendata.adsb.fi",
        "opensky-network.org",
        "auth.opensky-network.org",
        "aviationweather.gov",
        "api.rainviewer.com",
        "apihub.kma.go.kr",
        "api.adsbdb.com",  # 노선 조회(계약 v4 §A) — 선택한 항공기의 콜사인만
    }
)


class HostNotAllowed(RuntimeError):
    pass


class ResponseTooLarge(RuntimeError):
    pass


class SendCancelled(RuntimeError):
    """보내기 직전 확인(before_send)이 거절했다 — 요청을 보내지 않았다."""


class ProviderHttpError(RuntimeError):
    def __init__(self, status: int, body_head: str, headers: dict[str, str] | None = None, latency_ms: int | None = None):
        super().__init__(f"HTTP {status}: {body_head[:200]}")
        self.status = status
        self.body_head = body_head[:200]  # 오류 응답의 모양 판별용(예: adsbdb 404 "unknown callsign")
        self.headers = headers or {}
        self.latency_ms = latency_ms


# 요청을 보내기 전에 난 실패(보내지 않았다 → 호출자는 예산을 되돌린다). 쓰기·읽기 도중 실패는 보낸 것으로 친다(과대 집계는 안전 쪽).
NOT_SENT_ERRORS: tuple[type[Exception], ...] = (
    HostNotAllowed,
    SendCancelled,
    httpx.InvalidURL,
    httpx.UnsupportedProtocol,
    httpx.PoolTimeout,
    httpx.ProxyError,
    httpx.ConnectError,
    httpx.ConnectTimeout,
)

BeforeSend = Callable[[], Awaitable[bool]]


class FetchResponse:
    __slots__ = ("body", "status", "headers", "fetched_at", "latency_ms")

    def __init__(self, body: bytes, status: int, headers: dict[str, str], fetched_at: datetime, latency_ms: int):
        self.body, self.status, self.headers = body, status, headers
        self.fetched_at, self.latency_ms = fetched_at, latency_ms


def _retry_after_s(headers: dict[str, str]) -> float | None:
    v = headers.get("retry-after", "").strip()
    return float(v) if v.isdigit() else None  # HTTP-date 형식은 쓰지 않는다(기본 단계 백오프)


class HttpClient:
    def __init__(self, limiter: RateLimiter | None = None) -> None:
        self.limiter = limiter or default_limiter(settings.http_global_rps, settings.adsb_fi_rps, settings.adsbdb_rps)
        self._client = httpx.AsyncClient(
            timeout=httpx.Timeout(settings.http_timeout_s, connect=4.0),
            follow_redirects=False,
            headers={"User-Agent": settings.http_user_agent, "Accept": "application/json"},
            http2=False,
            limits=httpx.Limits(max_connections=8, max_keepalive_connections=4),
        )

    async def aclose(self) -> None:
        await self._client.aclose()

    async def get(
        self,
        url: str,
        *,
        headers: dict[str, str] | None = None,
        params: dict | None = None,
        priority: int = PRIORITY_FIXED,
        wait_s: float = DEFAULT_WAIT_S,
        before_send: BeforeSend | None = None,
    ) -> FetchResponse:
        return await self._request(
            "GET", url, priority=priority, wait_s=wait_s, before_send=before_send, headers=headers, params=params
        )

    async def post_form(self, url: str, data: dict[str, str]) -> FetchResponse:
        return await self._request("POST", url, priority=PRIORITY_FIXED, wait_s=DEFAULT_WAIT_S, data=data)

    async def _request(
        self, method: str, url: str, *, priority: int, wait_s: float, before_send: BeforeSend | None = None, **kw
    ) -> FetchResponse:
        host = urlparse(url).hostname or ""
        if host not in ALLOWED_HOSTS:
            raise HostNotAllowed(host)
        if not url.startswith("https://"):
            raise HostNotAllowed(f"insecure scheme for {host}")
        await self.limiter.acquire(host, priority=priority, wait_s=wait_s)  # Throttled 면 호출하지 않는다
        if before_send is not None and not await before_send():  # 기다리는 사이 사정이 바뀌었으면 보내지 않는다
            raise SendCancelled(host)
        t0 = time.perf_counter()
        async with self._client.stream(method, url, **kw) as resp:
            chunks: list[bytes] = []
            size = 0
            async for chunk in resp.aiter_bytes():
                size += len(chunk)
                if size > settings.http_max_bytes:
                    raise ResponseTooLarge(f"{size} bytes > {settings.http_max_bytes}")
                chunks.append(chunk)
            body = b"".join(chunks)
            latency = int((time.perf_counter() - t0) * 1000)
            headers = {k.lower(): v for k, v in resp.headers.items()}
            if resp.status_code == 429:
                self.limiter.penalize(host, _retry_after_s(headers))
            if resp.status_code >= 400:
                raise ProviderHttpError(resp.status_code, body[:200].decode("utf-8", "replace"), headers, latency)
            return FetchResponse(body, resp.status_code, headers, datetime.now(UTC), latency)
