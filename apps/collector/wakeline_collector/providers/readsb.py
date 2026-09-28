"""readsb v2 호환 공급자 — adsb.lol(1순위) · adsb.fi(2순위, 공개 한도 초당 1회).

호출 속도는 공급자가 아니라 HttpClient 의 RateLimiter 가 정한다(adsb.fi 호스트 버킷 0.8 req/s 를 관심 지역 폴백·focus·hot 이
함께 쓴다, 계약 v2 §A2). 관심 지역은 우선순위 0 으로 기다린다.

AdsbFiDemandProvider(ADR-013): 수요 기반 정밀 추적 전용.
- focus: GET /api/v2/icao/{hex,hex,...} (한 요청 ≤ 50 hex)
- hot:   GET /api/v3/lat/{lat}/lon/{lon}/dist/{nm} (≤ 250 NM)
URL 에 들어가는 값은 모두 여기서 다시 검증한다(hex 6자리 16진, 좌표·반경 범위) — 임대(lease)는 api 가 쓰지만 믿지 않는다.
"""

from __future__ import annotations

import re
from typing import Any

import orjson

from wakeline_collector.http import FetchResponse, HttpClient
from wakeline_collector.models import ProviderResult
from wakeline_collector.ratelimit import PRIORITY_FIXED, PRIORITY_FOCUS, PRIORITY_HOT

REGION_WAIT_S = 5.0  # 관심 지역(10 s 주기) 호출이 속도 상한을 기다리는 최대 시간
REGION_TOTAL_S = 15.0  # 관심 지역 요청 전체 상한(R-67) — 넘으면 실패로 세고 폴백이 맡는다
FOCUS_BATCH_MAX = 50
HOT_RADIUS_MAX_NM = 250
_HEX_RE = re.compile(r"^[0-9a-f]{6}$")

ADSB_FI_HOST = "opendata.adsb.fi"
ADSB_FI_ICAO_URL = "https://opendata.adsb.fi/api/v2/icao/{hexes}"
ADSB_FI_POINT_URL = "https://opendata.adsb.fi/api/v3/lat/{lat}/lon/{lon}/dist/{radius}"


def _aircraft_list(body: bytes) -> dict[str, Any]:
    """readsb 계열 응답 → {"ac": [...]}. 목록 키가 없거나 형식이 다르면 ValueError(추측해 채우지 않는다)."""
    data = orjson.loads(body)
    if not isinstance(data, dict):
        raise ValueError("unexpected readsb response shape (not an object)")
    for key in ("ac", "aircraft"):
        if key in data:
            ac = data[key] if data[key] is not None else []
            if not isinstance(ac, list):
                raise ValueError(f"unexpected readsb response shape ({key} is not a list)")
            return {**data, "ac": ac}
    raise ValueError("unexpected readsb response shape (no aircraft list)")


def _result(name: str, resp: FetchResponse) -> ProviderResult:
    return ProviderResult(name, resp.body, resp.fetched_at, resp.status, resp.latency_ms, data=_aircraft_list(resp.body))


class ReadsbProvider:
    supports_region = True
    supports_global = False
    region_cost = 1
    global_cost = 0
    configured = True

    def __init__(self, name: str, url_template: str, http: HttpClient):
        self.name = name
        self._tpl = url_template
        self._http = http

    async def fetch_region(self, lat: float, lon: float, radius_nm: int) -> ProviderResult:
        url = self._tpl.format(lat=f"{lat:.4f}", lon=f"{lon:.4f}", radius=int(radius_nm))
        resp = await self._http.get(url, priority=PRIORITY_FIXED, wait_s=REGION_WAIT_S, total_s=REGION_TOTAL_S)
        return _result(self.name, resp)

    async def fetch_global(self) -> ProviderResult:
        raise NotImplementedError(f"{self.name} has no global endpoint")


def adsb_lol(http: HttpClient) -> ReadsbProvider:
    return ReadsbProvider("adsb_lol", "https://api.adsb.lol/v2/point/{lat}/{lon}/{radius}", http)


def adsb_fi(http: HttpClient) -> ReadsbProvider:
    return ReadsbProvider("adsb_fi", "https://opendata.adsb.fi/api/v3/lat/{lat}/lon/{lon}/dist/{radius}", http)


def validate_hexes(hexes: list[str]) -> list[str]:
    if not 1 <= len(hexes) <= FOCUS_BATCH_MAX:
        raise ValueError(f"focus batch must have 1..{FOCUS_BATCH_MAX} hexes (got {len(hexes)})")
    bad = [h for h in hexes if not isinstance(h, str) or not _HEX_RE.fullmatch(h)]
    if bad:
        raise ValueError(f"invalid hex in focus batch: {bad[:3]!r}")
    return hexes


def validate_point(lat: float, lon: float, radius_nm: int) -> None:
    if not (-85.0 <= lat <= 85.0 and -180.0 <= lon <= 180.0 and 1 <= radius_nm <= HOT_RADIUS_MAX_NM):
        raise ValueError(f"invalid hot cell {lat},{lon},{radius_nm}")


class AdsbFiDemandProvider:
    """adsb.fi opendata — focus(hex 묶음)·hot(점 반경) 조회. 호출 1회 = 예산 1."""

    name = "adsb_fi"
    cost = 1
    host = ADSB_FI_HOST

    def __init__(self, http: HttpClient):
        self._http = http

    async def fetch_icao(self, hexes: list[str], *, wait_s: float) -> ProviderResult:
        validate_hexes(hexes)
        resp = await self._http.get(ADSB_FI_ICAO_URL.format(hexes=",".join(hexes)), priority=PRIORITY_FOCUS, wait_s=wait_s)
        return _result(self.name, resp)

    async def fetch_point(self, lat: float, lon: float, radius_nm: int, *, wait_s: float) -> ProviderResult:
        validate_point(lat, lon, radius_nm)
        url = ADSB_FI_POINT_URL.format(lat=f"{lat:.4f}", lon=f"{lon:.4f}", radius=int(radius_nm))
        resp = await self._http.get(url, priority=PRIORITY_HOT, wait_s=wait_s)
        return _result(self.name, resp)
