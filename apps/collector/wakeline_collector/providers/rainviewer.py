"""RainViewer weather-maps.json — 과거 2시간 프레임 목록. 타일은 브라우저가 직접 받는다."""

from __future__ import annotations

import orjson

from wakeline_collector.http import HttpClient
from wakeline_collector.models import ProviderResult

URL = "https://api.rainviewer.com/public/weather-maps.json"


class RainViewerProvider:
    name = "rainviewer"

    def __init__(self, http: HttpClient):
        self._http = http

    async def frames(self) -> ProviderResult:
        resp = await self._http.get(URL)
        data = orjson.loads(resp.body)
        if not isinstance(data, dict) or "radar" not in data or "host" not in data:
            raise ValueError("unexpected rainviewer response shape")
        return ProviderResult(self.name, resp.body, resp.fetched_at, resp.status, resp.latency_ms, data=data)
