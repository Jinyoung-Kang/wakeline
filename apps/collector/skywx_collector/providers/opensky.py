"""OpenSky Network — OAuth2 client credentials(토큰 30분), 전세계 1회 4크레딧. 계정이 없으면 비활성."""

from __future__ import annotations

import time

import orjson

from skywx_collector.geo import bbox_around
from skywx_collector.http import HttpClient
from skywx_collector.models import BudgetInfo, ProviderResult

TOKEN_URL = "https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token"  # noqa: S105 — URL, not a secret
STATES_URL = "https://opensky-network.org/api/states/all"


class OpenSkyProvider:
    name = "opensky"
    supports_region = True
    supports_global = True
    region_cost = 4  # 보수적으로 최대 비용(면적 > 400 sq°)으로 계상
    global_cost = 4

    def __init__(self, http: HttpClient, client_id: str, client_secret: str):
        self._http = http
        self._id, self._secret = client_id, client_secret
        self._token: str | None = None
        self._token_exp = 0.0

    @property
    def configured(self) -> bool:
        return bool(self._id and self._secret)

    async def _bearer(self) -> str:
        if self._token and time.time() < self._token_exp - 60:
            return self._token
        resp = await self._http.post_form(
            TOKEN_URL, {"grant_type": "client_credentials", "client_id": self._id, "client_secret": self._secret}
        )
        tok = orjson.loads(resp.body)
        self._token = tok["access_token"]
        self._token_exp = time.time() + float(tok.get("expires_in", 1800))
        return self._token

    async def _states(self, params: dict | None) -> ProviderResult:
        token = await self._bearer()
        resp = await self._http.get(STATES_URL, headers={"Authorization": f"Bearer {token}"}, params=params)
        data = orjson.loads(resp.body)
        if not isinstance(data, dict) or "states" not in data:
            raise ValueError("unexpected opensky response shape")
        rem = resp.headers.get("x-rate-limit-remaining")
        budget = BudgetInfo(remaining=int(rem)) if rem and rem.isdigit() else None
        return ProviderResult(self.name, resp.body, resp.fetched_at, resp.status, resp.latency_ms, data=data, budget=budget)

    async def fetch_region(self, lat: float, lon: float, radius_nm: int) -> ProviderResult:
        lamin, lomin, lamax, lomax = bbox_around(lat, lon, radius_nm)
        return await self._states({"lamin": lamin, "lomin": lomin, "lamax": lamax, "lomax": lomax})

    async def fetch_global(self) -> ProviderResult:
        return await self._states(None)
