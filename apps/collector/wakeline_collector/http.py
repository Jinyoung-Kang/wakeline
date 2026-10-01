"""외부 호출 전용 HTTP 클라이언트 — 허용 호스트 목록(SSRF 방지)·호출 속도 상한·타임아웃·리다이렉트 금지·응답 크기 상한.

모든 외부 호출은 여기를 지나며, 호출 직전에 RateLimiter 허가(수집기 전체 + 호스트별 버킷, 우선순위)를 받는다.
허가를 받은 뒤 보내기 직전에 호출자의 확인(before_send, 예: 운영자가 공급자를 껐는지)을 한 번 더 거친다 — 아니면 보내지 않는다(SendCancelled).
429 응답은 그 호스트를 잠시 막는다(모든 호출자 공통) — Retry-After 가 있으면 따른다(초 · HTTP-date 둘 다, RFC 9110 §10.2.3). 막은 초는
ProviderHttpError.pause_s 로 호출자에게 알린다(로그 · 실행 기록에 적는다).
시간 상한: httpx Timeout(읽기 8 s · 연결 4 s — 호출자가 read_s 로 읽기 제한만 바꿀 수 있다)은 단계마다라서, 조금씩 계속 보내는 응답은 끝나지 않을 수 있다. 그래서 보내기부터
본문을 다 읽을 때까지 전체에 호출자별 상한(total_s, 기본 DEFAULT_TOTAL_S)을 건다. 넘으면 RequestTimedOut — 보낸 호출로 센다(R-67).
속도 상한 대기(wait_s)는 이 상한에 들어가지 않는다(그 자체로 상한이 있다).
크기 상한(http_max_bytes)은 푼 바이트로 잰다 — gzip · deflate 본문은 httpx 에 맡기지 않고 직접 풀며, 푸는 동안 상한 + 1 바이트에서 멈춘다(_Inflate).
실패의 종류(HostNotAllowed · ProviderHttpError · NOT_SENT_ERRORS …)는 순수 모듈 http_errors, 보내기 판정(classify_send)은 send_outcome 에 있고
여기서 같은 이름으로 다시 내보낸다.
"""

from __future__ import annotations

import asyncio
import time
import zlib
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime
from email.utils import parsedate_to_datetime
from urllib.parse import urlparse

import httpx

from wakeline_collector.config import Settings, settings
from wakeline_collector.http_errors import NOT_SENT_ERRORS as NOT_SENT_ERRORS
from wakeline_collector.http_errors import NOT_SENT_LOCAL as NOT_SENT_LOCAL
from wakeline_collector.http_errors import HostNotAllowed as HostNotAllowed
from wakeline_collector.http_errors import PreSendFailed as PreSendFailed
from wakeline_collector.http_errors import ProviderHttpError as ProviderHttpError
from wakeline_collector.http_errors import RequestTimedOut as RequestTimedOut
from wakeline_collector.http_errors import ResponseTooLarge as ResponseTooLarge
from wakeline_collector.http_errors import SendCancelled as SendCancelled
from wakeline_collector.ratelimit import PRIORITY_FIXED, RateLimiter, default_limiter
from wakeline_collector.send_outcome import SendOutcome as SendOutcome
from wakeline_collector.send_outcome import classify_send as classify_send

DEFAULT_WAIT_S = 10.0  # 속도 상한 대기 기본 상한(주기 작업). focus·hot·관심 지역은 호출자가 더 짧게 준다.
DEFAULT_TOTAL_S = 30.0  # 요청 전체(보내기 ~ 본문 끝) 기본 상한. 관심 지역·KMA 는 호출자가 따로 준다(R-67).
CONNECT_TIMEOUT_S = 4.0

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
        "apis.data.go.kr",  # 공공데이터포털 — 한국 항만 입출항 색인(ADR-022 PORT-MIS) · 연안 교통량(ADR-023). 호스트 버킷 하나를 나눠 쓴다
    }
)


# 받는 Content-Encoding — 상한 안에서 직접 푸는 것만 부른다(_Inflate). httpx 기본값과 같다(brotli · zstandard 가 없을 때) — 그것들이 깔려도
# 부르는 인코딩이 늘지 않게 적어 둔다
ACCEPT_ENCODING = "gzip, deflate"


BeforeSend = Callable[[], Awaitable[bool]]


class _Inflate:
    """gzip · deflate 본문을 한 번에 max_out 바이트까지만 푼다(보안 검토 L-7: httpx 는 받은 청크(최대 64 KiB)를 한 번에 풀어, 작은 압축 본문이
    수십 MiB 로 다 펼쳐진 뒤에야 크기 상한을 쟀다). deflate 는 httpx 와 같게 zlib 머리가 있는 것을 먼저, 첫 청크에서 틀리면 머리 없는 것으로."""

    def __init__(self, coding: str) -> None:
        self.coding = coding
        self._z = zlib.decompressobj(zlib.MAX_WBITS | 16 if coding == "gzip" else zlib.MAX_WBITS)
        self._first = True

    def decode(self, data: bytes, max_out: int) -> bytes:
        first, self._first = self._first, False
        try:
            return self._z.decompress(data, max_out)
        except zlib.error as e:
            if first and self.coding == "deflate":
                self._z = zlib.decompressobj(-zlib.MAX_WBITS)
                return self.decode(data, max_out)
            raise httpx.DecodingError(str(e)) from e

    def flush(self) -> bytes:
        try:
            return self._z.flush()
        except zlib.error as e:
            raise httpx.DecodingError(str(e)) from e


def _inflater(headers: httpx.Headers) -> _Inflate | None:
    """응답의 Content-Encoding → 푸는 것(gzip · deflate 하나), 아니면 None(identity · 모르는 인코딩 — httpx 처럼 받은 그대로 둔다). 둘 이상 겹친
    인코딩은 부르지 않았다(ACCEPT_ENCODING) — 풀지 않고 DecodingError."""
    codings = [v.strip().lower() for v in headers.get_list("content-encoding", split_commas=True)]
    known = [c for c in codings if c in ("gzip", "deflate")]
    if len(known) > 1:
        raise httpx.DecodingError(f"stacked Content-Encoding {', '.join(codings)[:60]!r} — not decoded")
    return _Inflate(known[0]) if known else None


class FetchResponse:
    __slots__ = ("body", "status", "headers", "fetched_at", "latency_ms")

    def __init__(self, body: bytes, status: int, headers: dict[str, str], fetched_at: datetime, latency_ms: int):
        self.body, self.status, self.headers = body, status, headers
        self.fetched_at, self.latency_ms = fetched_at, latency_ms


def _retry_after_s(headers: dict[str, str], now: datetime | None = None) -> float | None:
    """Retry-After(RFC 9110 §10.2.3) → 초. 초(delay-seconds) 또는 HTTP-date. 없거나 · 틀린 모양 · 이미 지난 날짜면 None(단계 백오프).
    고치기 전에는 날짜 모양을 버렸다(기상청 429 대응 — 2026-09-30)."""
    v = headers.get("retry-after", "").strip()
    if v.isdigit():
        return float(v)
    try:
        at = parsedate_to_datetime(v)
    except (TypeError, ValueError, IndexError):
        return None
    if at is None or at.tzinfo is None:  # 시간대 없는 날짜는 HTTP-date 가 아니다(GMT 가 붙어야 한다)
        return None
    left = (at - (now or datetime.now(UTC))).total_seconds()
    return left if left > 0 else None


def _redirect_target(location: str, host: str) -> str:
    """3xx 오류 글자에 싣는 Location 의 호스트 — 경로 · 쿼리는 싣지 않는다(키가 있을 수 있다). 상대 Location(스킴 · 호스트 없음)은 요청 URI 에 맞춰
    풀리므로(RFC 9110 §10.2.2) 요청 호스트와 '상대'라고 적는다 — 전에는 hostname 이 None 이라 '(no Location)' 으로 적혀 Location 이 있었다는 것을
    숨겼다(CTO 리뷰 2026-10). '//host/…'(호스트가 있는 상대 참조)는 그 호스트."""
    loc = location.strip()
    if not loc:
        return "(no Location)"
    p = urlparse(loc)
    if p.hostname:
        return p.hostname
    if not p.scheme and not p.netloc:
        return f"{host} (relative Location — same host)"
    return "(Location without a host)"  # 스킴은 있는데 호스트가 없다(예: 'https:///…') — 같은 호스트라고 하지 않는다


def build_limiter(s: Settings) -> RateLimiter:
    """설정의 속도 상한(수집기 전체 · 호스트 버킷)으로 만든 RateLimiter — 수집기 main() 과 HttpClient() 의 기본값이 같은 함수를 쓴다
    (리뷰 2026-09-30: main.py 가 kma_apihub_rps 를 넘기지 않아 설정을 바꿔도 기본 0.5 였다)."""
    return default_limiter(s.http_global_rps, s.adsb_fi_rps, s.adsbdb_rps, s.data_go_kr_rps, s.kma_apihub_rps)


class HttpClient:
    def __init__(self, limiter: RateLimiter | None = None) -> None:
        self.limiter = limiter or build_limiter(settings)
        self._client = httpx.AsyncClient(
            timeout=httpx.Timeout(settings.http_timeout_s, connect=CONNECT_TIMEOUT_S),
            follow_redirects=False,
            headers={"User-Agent": settings.http_user_agent, "Accept": "application/json", "Accept-Encoding": ACCEPT_ENCODING},
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
        total_s: float = DEFAULT_TOTAL_S,
        read_s: float | None = None,
    ) -> FetchResponse:
        """read_s: 이 요청만의 읽기 제한(청크 사이, 초). 없으면 기본(settings.http_timeout_s). 연결 제한·전체 상한(total_s)은 그대로."""
        kw: dict = {"headers": headers, "params": params}
        if read_s is not None:
            kw["timeout"] = httpx.Timeout(settings.http_timeout_s, connect=CONNECT_TIMEOUT_S, read=read_s)
        return await self._request("GET", url, priority=priority, wait_s=wait_s, before_send=before_send, total_s=total_s, **kw)

    async def post_form(self, url: str, data: dict[str, str]) -> FetchResponse:
        return await self._request(
            "POST", url, priority=PRIORITY_FIXED, wait_s=DEFAULT_WAIT_S, total_s=DEFAULT_TOTAL_S, data=data
        )

    async def _request(
        self,
        method: str,
        url: str,
        *,
        priority: int,
        wait_s: float,
        total_s: float,
        before_send: BeforeSend | None = None,
        **kw,
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
        try:
            async with asyncio.timeout(total_s):
                body, status, headers = await self._send(method, url, **kw)
        except TimeoutError:
            raise RequestTimedOut(f"{host}: no complete response within {total_s:.0f} s") from None
        latency = int((time.perf_counter() - t0) * 1000)
        pause = self.limiter.penalize(host, _retry_after_s(headers)) if status == 429 else None
        if 300 <= status < 400:
            # 리다이렉트는 따라가지 않는다(허용 호스트 — 위). 성공으로 해석기에 넘기면 'JSON 아님' · '모양 이상'으로 적혀 까닭을 숨겼다(F11) — HTTP 오류로.
            # 본문 대신 Location 의 호스트만 싣는다(경로 · 쿼리에 키가 있을 수 있다 — _redirect_target)
            target = _redirect_target(headers.get("location", ""), host)
            raise ProviderHttpError(status, f"redirect to {target} — not followed", headers, latency)
        if status >= 400:
            raise ProviderHttpError(status, body[:200].decode("utf-8", "replace"), headers, latency, pause)
        return FetchResponse(body, status, headers, datetime.now(UTC), latency)

    async def _send(self, method: str, url: str, **kw) -> tuple[bytes, int, dict[str, str]]:
        """본문을 받는다 — 크기 상한은 푼 바이트로 잰다. 압축 본문은 받은 청크(aiter_raw)를 직접 풀되 한 번에 '남은 상한 + 1' 바이트까지만 —
        넘는 순간 ResponseTooLarge(펼친 것 전체를 메모리에 만들지 않는다)."""
        limit = settings.http_max_bytes
        async with self._client.stream(method, url, **kw) as resp:
            inflate = _inflater(resp.headers)
            chunks: list[bytes] = []
            size = 0
            async for raw in resp.aiter_raw():
                chunk = raw if inflate is None else inflate.decode(raw, limit - size + 1)
                size += len(chunk)
                if size > limit:
                    raise ResponseTooLarge(_too_large(size, limit, inflate))
                chunks.append(chunk)
            if inflate is not None:
                tail = inflate.flush()
                size += len(tail)
                if size > limit:
                    raise ResponseTooLarge(_too_large(size, limit, inflate))
                chunks.append(tail)
            return b"".join(chunks), resp.status_code, {k.lower(): v for k, v in resp.headers.items()}


def _too_large(size: int, limit: int, inflate: _Inflate | None) -> str:
    if inflate is None:
        return f"{size} bytes > {limit}"
    return f"more than {limit} bytes once {inflate.coding}-decoded — stopped inflating"
