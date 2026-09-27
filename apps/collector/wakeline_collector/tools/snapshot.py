"""실응답 스냅샷을 fixtures/ 에 저장한다(키 없음 — 모든 소스가 무인증). 공급자 한도를 소모하므로 필요할 때만."""

from __future__ import annotations

import asyncio
from pathlib import Path

from wakeline_collector.geo import bbox_around
from wakeline_collector.http import HttpClient
from wakeline_collector.providers.awc import AwcProvider
from wakeline_collector.providers.rainviewer import RainViewerProvider
from wakeline_collector.providers.readsb import adsb_fi, adsb_lol

OUT = Path(__file__).resolve().parents[3] / "fixtures"


async def main() -> None:
    http = HttpClient()
    try:
        lat, lon, r = 36.5, 127.8, 250
        lamin, lomin, lamax, lomax = bbox_around(lat, lon, r)
        items = {
            "adsb_lol_region.json": adsb_lol(http).fetch_region(lat, lon, r),
            "adsb_fi_region.json": adsb_fi(http).fetch_region(lat, lon, r),
            "awc_isigmet.json": AwcProvider(http).isigmet(),
            "awc_airsigmet.json": AwcProvider(http).airsigmet(),
            "awc_metar_region.json": AwcProvider(http).metar_bbox(lamin, lomin, lamax, lomax),
            "rainviewer_weather_maps.json": RainViewerProvider(http).frames(),
        }
        for name, coro in items.items():
            res = await coro
            (OUT / name).write_bytes(res.raw)
            print(f"saved {name} ({len(res.raw)} B)")
    finally:
        await http.aclose()


if __name__ == "__main__":
    asyncio.run(main())
