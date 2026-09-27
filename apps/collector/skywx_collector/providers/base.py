"""공급자 어댑터 계약(3.2절)."""

from __future__ import annotations

from typing import Protocol

from skywx_collector.models import ProviderResult


class AircraftProvider(Protocol):
    name: str
    supports_region: bool
    supports_global: bool
    region_cost: int
    global_cost: int

    async def fetch_region(self, lat: float, lon: float, radius_nm: int) -> ProviderResult: ...

    async def fetch_global(self) -> ProviderResult: ...
