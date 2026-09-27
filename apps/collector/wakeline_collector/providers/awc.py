"""AviationWeather.gov — 국제 SIGMET · 미국 SIGMET/AIRMET · METAR(+TAF). 분당 20회 자체 상한."""

from __future__ import annotations

import orjson

from wakeline_collector.http import HttpClient
from wakeline_collector.models import ProviderResult

BASE = "https://aviationweather.gov/api/data"


class AwcProvider:
    name = "awc"

    def __init__(self, http: HttpClient):
        self._http = http

    async def _get_json(self, path: str, params: dict) -> ProviderResult:
        resp = await self._http.get(f"{BASE}/{path}", params=params)
        data = orjson.loads(resp.body) if resp.body.strip() else []
        if not isinstance(data, list):
            raise ValueError(f"unexpected awc {path} response shape")
        return ProviderResult(self.name, resp.body, resp.fetched_at, resp.status, resp.latency_ms, data=data)

    async def isigmet(self) -> ProviderResult:
        return await self._get_json("isigmet", {"format": "json"})

    async def airsigmet(self) -> ProviderResult:
        return await self._get_json("airsigmet", {"format": "json"})

    async def metar_bbox(self, lamin: float, lomin: float, lamax: float, lomax: float) -> ProviderResult:
        bbox = f"{lamin:.2f},{lomin:.2f},{lamax:.2f},{lomax:.2f}"
        return await self._get_json("metar", {"bbox": bbox, "format": "json", "taf": "true"})
