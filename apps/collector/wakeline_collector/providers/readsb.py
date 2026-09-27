"""readsb v2 호환 공급자 — adsb.lol(1순위) · adsb.fi(2순위, 초당 1회)."""

from __future__ import annotations

import asyncio
import time

import orjson

from wakeline_collector.http import HttpClient
from wakeline_collector.models import ProviderResult


class ReadsbProvider:
    supports_region = True
    supports_global = False
    region_cost = 1
    global_cost = 0

    def __init__(self, name: str, url_template: str, http: HttpClient, min_interval_s: float = 0.0):
        self.name = name
        self._tpl = url_template
        self._http = http
        self._min_interval = min_interval_s
        self._last_call = 0.0
        self._lock = asyncio.Lock()

    async def fetch_region(self, lat: float, lon: float, radius_nm: int) -> ProviderResult:
        url = self._tpl.format(lat=f"{lat:.4f}", lon=f"{lon:.4f}", radius=int(radius_nm))
        async with self._lock:  # adsb.fi: 초당 1회 상한을 토큰 버킷(최소 간격)으로 고정
            wait = self._min_interval - (time.monotonic() - self._last_call)
            if wait > 0:
                await asyncio.sleep(wait)
            resp = await self._http.get(url)
            self._last_call = time.monotonic()
        data = orjson.loads(resp.body)
        if not isinstance(data, dict) or "ac" not in data:
            raise ValueError("unexpected readsb response shape")
        return ProviderResult(self.name, resp.body, resp.fetched_at, resp.status, resp.latency_ms, data=data)

    async def fetch_global(self) -> ProviderResult:
        raise NotImplementedError(f"{self.name} has no global endpoint")


def adsb_lol(http: HttpClient) -> ReadsbProvider:
    return ReadsbProvider("adsb_lol", "https://api.adsb.lol/v2/point/{lat}/{lon}/{radius}", http)


def adsb_fi(http: HttpClient) -> ReadsbProvider:
    return ReadsbProvider(
        "adsb_fi", "https://opendata.adsb.fi/api/v3/lat/{lat}/lon/{lon}/dist/{radius}", http, min_interval_s=1.05
    )
