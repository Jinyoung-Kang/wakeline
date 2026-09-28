"""adsbdb 노선 공급자(계약 v4 §A · ADR-016) — GET https://api.adsbdb.com/v0/callsign/{CALLSIGN}.

호출 속도는 HttpClient 의 RateLimiter 가 정한다: 호스트 api.adsbdb.com 0.5 req/s(burst 2) + 수집기 전체 버킷, 우선순위는 핫 리전보다 낮다.
URL 에 들어가는 콜사인은 여기서 다시 검증한다(`^[A-Z0-9]{3,8}$`). 404 "unknown callsign" 은 실패가 아니라 not_found 다.
응답 본문은 돌려주지 않는다 — 검증한 캐시 값(RouteValue)만 돌려준다(원천 보관·로그로 새지 않게).
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime

from wakeline_collector.config import settings
from wakeline_collector.http import HttpClient, ProviderHttpError
from wakeline_collector.ratelimit import PRIORITY_ROUTE
from wakeline_collector.route import CALLSIGN_RE, RouteValue, from_adsbdb, is_unknown_callsign_body, not_found

ADSBDB_HOST = "api.adsbdb.com"
ROUTE_WAIT_S = 10.0  # 속도 상한 대기 상한(계약 v4 §A)


@dataclass(frozen=True)
class RouteFetch:
    value: RouteValue
    http_status: int
    latency_ms: int | None


class AdsbdbProvider:
    """콜사인 → 등록 노선. 호출 1회 = 예산 1."""

    name = "adsbdb"
    cost = 1
    host = ADSBDB_HOST

    def __init__(self, http: HttpClient, base_url: str | None = None):
        self._http = http
        self._base = (base_url or settings.adsbdb_base_url).rstrip("/")

    def url(self, callsign: str) -> str:
        if not isinstance(callsign, str) or not CALLSIGN_RE.fullmatch(callsign):
            raise ValueError("invalid callsign")
        return f"{self._base}/v0/callsign/{callsign}"

    async def lookup(self, callsign: str, *, wait_s: float = ROUTE_WAIT_S) -> RouteFetch:
        """found · not_found. 실패는 예외 그대로(Throttled · ProviderHttpError · httpx 오류 · RouteParseError)."""
        url = self.url(callsign)
        try:
            resp = await self._http.get(url, priority=PRIORITY_ROUTE, wait_s=wait_s)
        except ProviderHttpError as e:
            if e.status == 404 and is_unknown_callsign_body(e.body_head):
                return RouteFetch(not_found(callsign, datetime.now(UTC)), 404, e.latency_ms)
            raise
        return RouteFetch(from_adsbdb(resp.status, resp.body, callsign, resp.fetched_at), resp.status, resp.latency_ms)
