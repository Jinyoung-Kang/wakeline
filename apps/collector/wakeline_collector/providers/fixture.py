"""fixture 모드 공급자 — 외부 호출 없이 fixtures/ 를 재생한다(FR-12).

항공기는 기록된 위치에서 dead reckoning 으로 경과 시간만큼 이동시키고 provider='fixture' 로 표기한다.
focus·hot(계약 v2 §A2)도 같은 이동 결과에서 골라 준다 — 같은 hex 가 region·focus 에서 다른 곳에 나타나지 않도록
관심 지역 기준으로 한 번 움직인 뒤 요청한 hex / 셀 반경으로 거른다. 재생 자료는 한반도 주변뿐이라 멀리 있는 셀은 비어 있다(사실대로).
SIGMET 은 유효시간을 현재로 옮기고, 한반도 위에 합성 경보(fixture_sigmet_kr.json) 를 추가한다.
"""

from __future__ import annotations

import time
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import orjson

from wakeline_collector.config import settings
from wakeline_collector.geo import dead_reckon, haversine_nm
from wakeline_collector.models import ProviderResult


def _load(name: str) -> Any:
    return orjson.loads((Path(settings.fixtures_dir) / name).read_bytes())


# 경계에서 0.5 NM 안쪽까지만 간다(5자리 반올림으로 반경 밖에 찍히지 않게)
_EDGE_MARGIN_NM = 0.5


def _along(lat: float, lon: float, trk: float, x_nm: float) -> tuple[float, float]:
    """(lat, lon) 에서 방위 trk 로 부호 있는 거리 x_nm(음수면 반대 방위)만큼 간 곳. dead_reckon 은 속도(kt) × 시간(s)이라 x kt × 3600 s = x NM."""
    return dead_reckon(lat, lon, trk if x_nm >= 0 else (trk + 180) % 360, abs(x_nm), 3600.0)


def _to_edge(lat: float, lon: float, trk: float, clat: float, clon: float, radius_nm: float) -> float:
    """(lat, lon) 에서 방위 trk 로 가면 관심 지역(clat, clon 반경 radius_nm)을 벗어나기 전까지의 거리(NM, 경계 여유를 뺀 값). 시작이 밖이면 0.
    반경이 지구에 비해 작아 대원이 지역 안을 지나는 구간은 하나다 — 두 배씩 늘려 처음 밖인 곳을 찾고 그 사이를 이분한다."""

    def outside(x: float) -> bool:
        return haversine_nm(clat, clon, *_along(lat, lon, trk, x)) > radius_nm

    if outside(0.0):
        return 0.0
    lo, hi = 0.0, 5.0
    while not outside(hi):
        lo, hi = hi, hi * 2
    for _ in range(32):
        mid = (lo + hi) / 2
        lo, hi = (lo, mid) if outside(mid) else (mid, hi)
    return max(0.0, lo - _EDGE_MARGIN_NM)


class FixtureAircraftProvider:
    name = "fixture"
    supports_region = True
    supports_global = True
    region_cost = 0
    global_cost = 0
    configured = True

    def __init__(self) -> None:
        self._t0 = time.time()
        self._base = _load("adsb_lol_region.json")

    def _moved(self, lat: float, lon: float, radius_nm: int) -> dict[str, Any]:
        """관심 지역 안에서 왕복시킨다(데모가 비지 않도록): 항공기는 기록된 방위의 대원 위를 경계까지 가면 돌아서 반대편 경계까지 간다 — 위치는 끊기지 않고
        (position_jump 없음), 보고 방위(track)는 지금 움직이는 쪽이다. QA-210(QA 2026-10): 전에는 밖으로 나간 위치만 원래 자리에서 반대로 같은 거리를
        보내 시간이 지나면 그쪽도 반경 밖이 되었고(기동 55분 뒤 250 NM 안 127 → 52대), 방위는 그대로라 지도의 기체가 진행 방향과 반대를 가리켰다.
        시작이 이미 지역 밖이면(운영자가 지역을 좁힘) 기록된 위치에 둔다."""
        dt = time.time() - self._t0
        ac_out = []
        for ac in self._base.get("ac", []):
            if ac.get("lat") is None or ac.get("lon") is None:
                ac_out.append(ac)
                continue
            a = dict(ac)
            key = "track" if "track" in a else "calc_track"
            gs, trk = a.get("gs"), a.get(key)
            if a.get("alt_baro") != "ground" and gs and trk is not None:
                fwd = _to_edge(a["lat"], a["lon"], trk, lat, lon, radius_nm)
                back = _to_edge(a["lat"], a["lon"], (trk + 180) % 360, lat, lon, radius_nm)
                chord = fwd + back
                if chord > 0:
                    s = (back + gs * dt / 3600.0) % (2 * chord)  # 뒤쪽 경계에서 잰 왕복 위치
                    heading = trk
                    if s > chord:  # 앞쪽 경계에서 돌아오는 중
                        s, heading = 2 * chord - s, (trk + 180) % 360
                    la, lo = _along(a["lat"], a["lon"], trk, s - back)
                    a["lat"], a["lon"], a[key] = round(la, 5), round(lo, 5), round(heading, 2)
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


class FixtureDemandProvider:
    """focus·hot 재생 — 외부 호출 없음, 예산 0."""

    name = "fixture"
    cost = 0
    host = ""

    def __init__(self, base: FixtureAircraftProvider, region: Callable[[], tuple[float, float, int]]):
        self._base = base
        self._region = region

    def _result(self, ac: list[dict[str, Any]], ref: str) -> ProviderResult:
        data = {"ac": ac, "now": int(time.time() * 1000), "total": len(ac)}
        return ProviderResult(self.name, orjson.dumps(data), datetime.now(UTC), 200, 0, data=data, extra={"raw_ref": ref})

    async def fetch_icao(self, hexes: list[str], *, wait_s: float = 0.0) -> ProviderResult:
        want = set(hexes)
        moved = self._base._moved(*self._region())
        ac = [a for a in moved["ac"] if str(a.get("hex", "")).lower() in want]
        return self._result(ac, "fixture:adsb_lol_region.json#icao")

    async def fetch_point(self, lat: float, lon: float, radius_nm: int, *, wait_s: float = 0.0) -> ProviderResult:
        moved = self._base._moved(*self._region())
        ac = [
            a
            for a in moved["ac"]
            if a.get("lat") is not None and a.get("lon") is not None and haversine_nm(lat, lon, a["lat"], a["lon"]) <= radius_nm
        ]
        return self._result(ac, "fixture:adsb_lol_region.json#point")


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


__all__ = ["FixtureAircraftProvider", "FixtureAwcProvider", "FixtureDemandProvider", "FixtureRainViewerProvider", "timedelta"]
