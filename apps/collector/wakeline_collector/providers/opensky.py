"""OpenSky Network — OAuth2 client credentials(토큰 30분), 전세계 1회 4크레딧. 계정이 없으면 비활성.

전세계(global) 전용이다. 관심 지역 폴백에 쓰면 10 s 주기 × 4크레딧으로 일일 한도를 몇 시간 만에 소진해
전세계 화면이 하루 종일 죽는다(GAP-5/REL-14). 관심 지역은 adsb_fi → adsb_lol(기본 순서 — 계약 v5 §G25) 만 쓰고, 둘 다 안 되면 stale 로 둔다(FR-19).
"""

from __future__ import annotations

import time
from datetime import datetime

import orjson

from wakeline_collector.http import HttpClient, ProviderHttpError
from wakeline_collector.models import BudgetInfo, ProviderResult

TOKEN_URL = "https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token"  # noqa: S105 — URL, not a secret
STATES_URL = "https://opensky-network.org/api/states/all"


class OpenSkyProvider:
    name = "opensky"
    supports_region = False  # 크레딧 보호: 관심 지역 폴백 체인에서 제외
    supports_global = True
    region_cost = 0
    global_cost = 4

    def __init__(self, http: HttpClient, client_id: str, client_secret: str):
        self._http = http
        self._id, self._secret = client_id, client_secret
        self._token: str | None = None
        self._token_exp = 0.0
        # 남은 크레딧 < 예비분이면 이 시각(UTC)까지 호출하지 않는다. ProviderChain.pick 이 모든 체인에서 확인한다.
        self.paused_until: datetime | None = None

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
        try:
            resp = await self._http.get(STATES_URL, headers={"Authorization": f"Bearer {token}"}, params=params)
        except ProviderHttpError as e:
            if e.status == 401:  # 토큰이 폐기·교체됨 — 만료까지 기다리지 않고 다음 실행에서 새로 받는다(R-66)
                self._token, self._token_exp = None, 0.0
            raise
        data = orjson.loads(resp.body)
        if not isinstance(data, dict) or "states" not in data:
            raise ValueError("unexpected opensky response shape")
        rem = resp.headers.get("x-rate-limit-remaining")
        budget = BudgetInfo(remaining=int(rem)) if rem and rem.isdigit() else None
        return ProviderResult(self.name, resp.body, resp.fetched_at, resp.status, resp.latency_ms, data=data, budget=budget)

    async def fetch_region(self, lat: float, lon: float, radius_nm: int) -> ProviderResult:
        raise NotImplementedError("opensky is global-only (region fallback disabled to protect the credit budget)")

    async def fetch_global(self) -> ProviderResult:
        return await self._states(None)
