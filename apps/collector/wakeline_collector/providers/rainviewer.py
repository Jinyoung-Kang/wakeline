"""RainViewer weather-maps.json — 과거 2시간 프레임 목록. 타일은 브라우저가 직접 받는다.

타일 host · path 는 api · 브라우저까지 그대로 가므로(radar_frame · /api/v1/radar/frames · WS radar → 웹이 `${host}${path}/512/{z}/{x}/{y}/…` 로 만든다)
받을 때 검사한다(보안 검토 L-6 — 전에는 웹 CSP 가 유일한 방어였다): host 는 정확히 TILE_HOST(웹 CSP img-src · connect-src 가 허용하는 유일한
타일 호스트), path 는 실제 응답의 모양(fixtures/rainviewer_weather_maps.json — /v2/radar/<소문자 16진수>)만. 어긋나면 응답 전체를 받지 않는다
(ValueError — 작업이 실행 'error' · 공급자 실패로 적고 아무것도 발행하지 않는다: api 는 앞서 받은 프레임을 그대로 쓴다).
"""

from __future__ import annotations

import re
from typing import Any

import orjson

from wakeline_collector.http import HttpClient
from wakeline_collector.models import ProviderResult

URL = "https://api.rainviewer.com/public/weather-maps.json"
TILE_HOST = "https://tilecache.rainviewer.com"
_TILE_PATH = re.compile(r"/v2/radar/[0-9a-f]+")


def check_tiles(data: dict[str, Any]) -> None:
    """타일 host · 프레임 path(작업이 싣는 프레임 — time 과 path 가 있는 것)를 검사한다. 어긋나면 ValueError(가린 앞부분만 싣는다)."""
    host = data.get("host")
    if host != TILE_HOST:
        raise ValueError(f"unexpected rainviewer tile host {str(host)[:80]!r} (only {TILE_HOST}) — response not used")
    radar = data.get("radar")
    past = radar.get("past", []) if isinstance(radar, dict) else []
    for f in past if isinstance(past, list) else []:
        if isinstance(f, dict) and "time" in f and "path" in f:
            path = f["path"]
            if not (isinstance(path, str) and _TILE_PATH.fullmatch(path)):
                raise ValueError(f"unexpected rainviewer tile path {str(path)[:80]!r} (only /v2/radar/<hex>) — response not used")


class RainViewerProvider:
    name = "rainviewer"

    def __init__(self, http: HttpClient):
        self._http = http

    async def frames(self) -> ProviderResult:
        resp = await self._http.get(URL)
        data = orjson.loads(resp.body)
        if not isinstance(data, dict) or "radar" not in data or "host" not in data:
            raise ValueError("unexpected rainviewer response shape")
        check_tiles(data)
        return ProviderResult(self.name, resp.body, resp.fetched_at, resp.status, resp.latency_ms, data=data)
