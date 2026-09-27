"""fixture 모드 공급자 — 외부 호출 없이 fixtures/ 를 재생한다(FR-12).

항공기는 기록된 위치에서 dead reckoning 으로 경과 시간만큼 이동시키고 provider='fixture' 로 표기한다.
SIGMET 은 유효시간을 현재로 옮기고, 한반도 위에 합성 경보(fixture_sigmet_kr.json) 를 추가한다.
"""

from __future__ import annotations

import time
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import orjson

from skywx_collector.config import settings
from skywx_collector.geo import dead_reckon, haversine_nm
from skywx_collector.models import ProviderResult


def _load(name: str) -> Any:
    return orjson.loads((Path(settings.fixtures_dir) / name).read_bytes())


class FixtureAircraftProvider:
    name = "fixture"
    supports_region = True
    supports_global = True
    region_cost = 0
    global_cost = 0

    def __init__(self) -> None:
        self._t0 = time.time()
        self._base = _load("adsb_lol_region.json")

    def _moved(self, lat: float, lon: float, radius_nm: int) -> dict[str, Any]:
        dt = time.time() - self._t0
        ac_out = []
        for ac in self._base.get("ac", []):
            if ac.get("lat") is None or ac.get("lon") is None:
                ac_out.append(ac)
                continue
            a = dict(ac)
            gs, trk = a.get("gs"), a.get("track", a.get("calc_track"))
            if a.get("alt_baro") != "ground" and gs and trk is not None:
                # 관심 지역 밖으로 나가면 반대편에서 다시 들어오게 방위를 뒤집는다(데모가 비지 않도록)
                la, lo = dead_reckon(a["lat"], a["lon"], trk, gs, dt)
                if haversine_nm(lat, lon, la, lo) > radius_nm:
                    la, lo = dead_reckon(a["lat"], a["lon"], (trk + 180) % 360, gs, dt)
                a["lat"], a["lon"] = round(la, 5), round(lo, 5)
            a["seen_pos"] = 1.0
            ac_out.append(a)
        return {"ac": ac_out, "now": int(time.time() * 1000), "total": len(ac_out)}

    async def fetch_region(self, lat: float, lon: float, radius_nm: int) -> ProviderResult:
        data = self._moved(lat, lon, radius_nm)
        return ProviderResult(
            self.name, orjson.dumps(data), datetime.now(UTC), 200, 0, data=data, extra={"raw_ref": "fixture:adsb_lol_region.json"}
        )

    async def fetch_global(self) -> ProviderResult:
        data = {"time": int(time.time()), "states": []}
        return ProviderResult(
            self.name, orjson.dumps(data), datetime.now(UTC), 200, 0, data=data, extra={"raw_ref": "fixture:empty_global"}
        )


class FixtureAwcProvider:
    name = "fixture"

    def _shift(self, items: list[dict[str, Any]]) -> list[dict[str, Any]]:
        now = int(time.time())
        out = []
        for it in items:
            d = dict(it)
            span = max(int(it.get("validTimeTo", 0)) - int(it.get("validTimeFrom", 0)), 3600)
            d["validTimeFrom"], d["validTimeTo"] = now - 1800, now - 1800 + span
            out.append(d)
        return out

    async def isigmet(self) -> ProviderResult:
        items = self._shift(_load("awc_isigmet.json")) + self._shift(_load("fixture_sigmet_kr.json"))
        return ProviderResult(
            self.name,
            orjson.dumps(items),
            datetime.now(UTC),
            200,
            0,
            data=items,
            extra={"raw_ref": "fixture:awc_isigmet.json+fixture_sigmet_kr.json"},
        )

    async def airsigmet(self) -> ProviderResult:
        items = self._shift(_load("awc_airsigmet.json"))
        return ProviderResult(
            self.name, orjson.dumps(items), datetime.now(UTC), 200, 0, data=items, extra={"raw_ref": "fixture:awc_airsigmet.json"}
        )

    async def metar_bbox(self, lamin: float, lomin: float, lamax: float, lomax: float) -> ProviderResult:
        items = _load("awc_metar_region.json")
        now = datetime.now(UTC).replace(minute=0, second=0, microsecond=0)
        for it in items:
            it["obsTime"] = int(now.timestamp())
            it["reportTime"] = now.isoformat().replace("+00:00", "Z")
        return ProviderResult(
            self.name,
            orjson.dumps(items),
            datetime.now(UTC),
            200,
            0,
            data=items,
            extra={"raw_ref": "fixture:awc_metar_region.json"},
        )


class FixtureRainViewerProvider:
    name = "fixture"

    async def frames(self) -> ProviderResult:
        data = _load("rainviewer_weather_maps.json")
        now = int(time.time()) // 600 * 600
        past = data["radar"]["past"]
        for i, f in enumerate(past):
            f["time"] = now - (len(past) - 1 - i) * 600
        data["generated"] = now
        return ProviderResult(
            self.name,
            orjson.dumps(data),
            datetime.now(UTC),
            200,
            0,
            data=data,
            extra={"raw_ref": "fixture:rainviewer_weather_maps.json"},
        )


__all__ = ["FixtureAircraftProvider", "FixtureAwcProvider", "FixtureRainViewerProvider", "timedelta"]
