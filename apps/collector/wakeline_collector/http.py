"""외부 호출 전용 HTTP 클라이언트 — 허용 호스트 목록(SSRF 방지)·타임아웃·리다이렉트 금지·응답 크기 상한."""

from __future__ import annotations

import time
from datetime import UTC, datetime
from urllib.parse import urlparse

import httpx

from wakeline_collector.config import settings

ALLOWED_HOSTS = frozenset(
    {
        "api.adsb.lol",
        "opendata.adsb.fi",
        "opensky-network.org",
        "auth.opensky-network.org",
        "aviationweather.gov",
        "api.rainviewer.com",
        "apihub.kma.go.kr",
    }
)


class HostNotAllowed(RuntimeError):
    pass


class ResponseTooLarge(RuntimeError):
    pass


class ProviderHttpError(RuntimeError):
    def __init__(self, status: int, body_head: str, headers: dict[str, str] | None = None):
        super().__init__(f"HTTP {status}: {body_head[:200]}")
        self.status = status
        self.headers = headers or {}


class FetchResponse:
    __slots__ = ("body", "status", "headers", "fetched_at", "latency_ms")

    def __init__(self, body: bytes, status: int, headers: dict[str, str], fetched_at: datetime, latency_ms: int):
        self.body, self.status, self.headers = body, status, headers
        self.fetched_at, self.latency_ms = fetched_at, latency_ms


class HttpClient:
    def __init__(self) -> None:
        self._client = httpx.AsyncClient(
            timeout=httpx.Timeout(settings.http_timeout_s, connect=4.0),
            follow_redirects=False,
            headers={"User-Agent": settings.http_user_agent, "Accept": "application/json"},
            http2=False,
            limits=httpx.Limits(max_connections=8, max_keepalive_connections=4),
        )

    async def aclose(self) -> None:
        await self._client.aclose()

    async def get(self, url: str, *, headers: dict[str, str] | None = None, params: dict | None = None) -> FetchResponse:
        return await self._request("GET", url, headers=headers, params=params)

    async def post_form(self, url: str, data: dict[str, str]) -> FetchResponse:
        return await self._request("POST", url, data=data)

    async def _request(self, method: str, url: str, **kw) -> FetchResponse:
        host = urlparse(url).hostname or ""
        if host not in ALLOWED_HOSTS:
            raise HostNotAllowed(host)
        if not url.startswith("https://"):
            raise HostNotAllowed(f"insecure scheme for {host}")
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
            if resp.status_code >= 400:
                raise ProviderHttpError(resp.status_code, body[:200].decode("utf-8", "replace"), headers)
            return FetchResponse(body, resp.status_code, headers, datetime.now(UTC), latency)
