"""fixtures 스냅샷 도구 — 외부 호출 없이(respx) 파일이 쓰이는지만 본다."""

from __future__ import annotations

import httpx
import respx

from wakeline_collector.http import HttpClient
from wakeline_collector.ratelimit import RateLimiter
from wakeline_collector.tools import snapshot


async def test_snapshot_writes_every_fixture(tmp_path, monkeypatch):
    monkeypatch.setattr(snapshot, "OUT", tmp_path)
    monkeypatch.setattr(snapshot, "HttpClient", lambda: HttpClient(RateLimiter(100, 100)))  # 테스트 시간 단축(가짜 응답)
    with respx.mock:
        respx.get(url__regex=r"https://api\.adsb\.lol/.*").mock(return_value=httpx.Response(200, json={"ac": []}))
        respx.get(url__regex=r"https://opendata\.adsb\.fi/.*").mock(return_value=httpx.Response(200, json={"ac": []}))
        respx.get(url__regex=r"https://aviationweather\.gov/.*").mock(return_value=httpx.Response(200, json=[]))
        respx.get(url__regex=r"https://api\.rainviewer\.com/.*").mock(
            # 타일 host 는 공급자가 검사한다(보안 검토 L-6) — 실제 응답의 host
            return_value=httpx.Response(200, json={"host": "https://tilecache.rainviewer.com", "radar": {"past": []}})
        )
        await snapshot.main()
    assert sorted(p.name for p in tmp_path.iterdir()) == sorted(
        [
            "adsb_lol_region.json",
            "adsb_fi_region.json",
            "awc_isigmet.json",
            "awc_airsigmet.json",
            "awc_metar_region.json",
            "rainviewer_weather_maps.json",
        ]
    )
