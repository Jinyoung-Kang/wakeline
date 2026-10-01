"""공급자 어댑터 — URL·파라미터·응답 형식 검사. 외부 호출 없음(respx 로 가로챈다). 응답 본문은 형식 확인용 합성값."""

from __future__ import annotations

import gzip
from pathlib import Path

import httpx
import orjson
import pytest
import respx

from wakeline_collector.http import HttpClient
from wakeline_collector.providers import fixture as fx
from wakeline_collector.providers.awc import AwcProvider
from wakeline_collector.providers.kma_radar import KmaRadarProvider
from wakeline_collector.providers.opensky import STATES_URL, TOKEN_URL, OpenSkyProvider
from wakeline_collector.providers.rainviewer import URL as RV_URL
from wakeline_collector.providers.rainviewer import RainViewerProvider
from wakeline_collector.providers.readsb import AdsbFiDemandProvider, adsb_fi, adsb_lol, validate_hexes, validate_point
from wakeline_collector.ratelimit import RateLimiter

ROOT = Path(__file__).resolve().parents[3]
AC = {"ac": [{"hex": "abcdef", "lat": 1, "lon": 2, "seen_pos": 1}], "msg": "No error", "now": 1, "total": 1}


@pytest.fixture
async def http():
    c = HttpClient(RateLimiter(100, 100, {"opendata.adsb.fi": (100.0, 10)}))
    yield c
    await c.aclose()


async def test_readsb_region_urls_and_shape(http):
    with respx.mock:
        lol = respx.get("https://api.adsb.lol/v2/point/36.5000/127.8000/250").mock(return_value=httpx.Response(200, json=AC))
        fi = respx.get("https://opendata.adsb.fi/api/v3/lat/36.5000/lon/127.8000/dist/250").mock(
            return_value=httpx.Response(200, json={"aircraft": AC["ac"]})
        )
        r1 = await adsb_lol(http).fetch_region(36.5, 127.8, 250)
        r2 = await adsb_fi(http).fetch_region(36.5, 127.8, 250)
    assert lol.called and fi.called
    assert r1.provider == "adsb_lol" and r1.data["ac"][0]["hex"] == "abcdef"
    assert r2.provider == "adsb_fi" and r2.data["ac"] == AC["ac"]  # 'aircraft' 키도 받는다
    with pytest.raises(NotImplementedError):
        await adsb_lol(http).fetch_global()


@pytest.mark.parametrize("body", [b"[]", b'{"msg": "x"}', b'{"ac": 5}'])
async def test_readsb_unexpected_shape_is_an_error_not_empty(http, body):
    with respx.mock:
        respx.get(url__regex=r"https://api\.adsb\.lol/.*").mock(return_value=httpx.Response(200, content=body))
        with pytest.raises(ValueError, match="unexpected readsb response shape"):
            await adsb_lol(http).fetch_region(1, 2, 3)


async def test_readsb_null_list_is_empty(http):
    with respx.mock:
        respx.get(url__regex=r"https://api\.adsb\.lol/.*").mock(return_value=httpx.Response(200, json={"ac": None}))
        assert (await adsb_lol(http).fetch_region(1, 2, 3)).data["ac"] == []


async def test_demand_provider_urls(http):
    p = AdsbFiDemandProvider(http)
    with respx.mock:
        icao = respx.get("https://opendata.adsb.fi/api/v2/icao/abcdef,71c0a1").mock(return_value=httpx.Response(200, json=AC))
        point = respx.get("https://opendata.adsb.fi/api/v3/lat/35.5000/lon/139.5000/dist/150").mock(
            return_value=httpx.Response(200, json=AC)
        )
        r = await p.fetch_icao(["abcdef", "71c0a1"], wait_s=1)
        r2 = await p.fetch_point(35.5, 139.5, 150, wait_s=1)
    assert icao.called and point.called and r.data["ac"][0]["hex"] == "abcdef" and r2.provider == "adsb_fi"


def test_demand_inputs_are_validated_before_building_urls():
    assert validate_hexes(["abcdef"]) == ["abcdef"]
    for bad in ([], ["ABCDEF"], ["abcdef/../x"], ["abc"], [f"{i:06x}" for i in range(51)]):
        with pytest.raises(ValueError):
            validate_hexes(bad)
    validate_point(35.5, 139.5, 150)
    for lat, lon, r in ((86, 0, 50), (0, 181, 50), (0, 0, 251), (0, 0, 0)):
        with pytest.raises(ValueError):
            validate_point(lat, lon, r)


async def test_opensky_token_cached_and_credits_header(http):
    p = OpenSkyProvider(http, "id", "secret")
    assert p.configured and not OpenSkyProvider(http, "", "").configured
    with respx.mock:
        tok = respx.post(TOKEN_URL).mock(return_value=httpx.Response(200, json={"access_token": "t0k", "expires_in": 1800}))
        st = respx.get(STATES_URL).mock(
            return_value=httpx.Response(200, json={"time": 1, "states": []}, headers={"X-Rate-Limit-Remaining": "3996"})
        )
        r = await p.fetch_global()
        await p.fetch_global()
    assert tok.call_count == 1 and st.call_count == 2  # 토큰 재사용
    assert st.calls[0].request.headers["Authorization"] == "Bearer t0k"
    assert r.budget is not None and r.budget.remaining == 3996
    with pytest.raises(NotImplementedError):
        await p.fetch_region(1, 2, 3)
    with respx.mock:
        respx.get(STATES_URL).mock(return_value=httpx.Response(200, json=[]))
        with pytest.raises(ValueError):
            await p.fetch_global()


async def test_r66_opensky_401_drops_the_cached_token_so_the_next_run_refreshes_it(http):
    """리뷰 R-66: 401 뒤에도 캐시한 토큰을 만료(최대 약 29분)까지 다시 써서 전세계 수집이 계속 실패할 수 있었다."""
    from wakeline_collector.http import ProviderHttpError

    p = OpenSkyProvider(http, "id", "secret")
    with respx.mock:
        tok = respx.post(TOKEN_URL).mock(
            side_effect=[
                httpx.Response(200, json={"access_token": "old", "expires_in": 1800}),
                httpx.Response(200, json={"access_token": "new", "expires_in": 1800}),
            ]
        )
        st = respx.get(STATES_URL).mock(
            side_effect=[httpx.Response(401, text="token revoked"), httpx.Response(200, json={"time": 1, "states": []})]
        )
        with pytest.raises(ProviderHttpError) as e:
            await p.fetch_global()
        assert e.value.status == 401
        await p.fetch_global()
    assert tok.call_count == 2  # 401 뒤 다음 실행은 새 토큰을 받는다
    assert [c.request.headers["Authorization"] for c in st.calls] == ["Bearer old", "Bearer new"]


async def test_awc_endpoints(http):
    p = AwcProvider(http)
    with respx.mock:
        isig = respx.get("https://aviationweather.gov/api/data/isigmet", params={"format": "json"}).mock(
            return_value=httpx.Response(200, json=[])
        )
        air = respx.get("https://aviationweather.gov/api/data/airsigmet").mock(return_value=httpx.Response(200, content=b" "))
        met = respx.get(
            "https://aviationweather.gov/api/data/metar", params={"bbox": "33.00,124.00,40.00,131.00", "taf": "true"}
        ).mock(return_value=httpx.Response(200, json=[{"icaoId": "RKSI"}]))
        assert (await p.isigmet()).data == [] and isig.called
        assert (await p.airsigmet()).data == [] and air.called  # 빈 본문 = 경보 없음
        assert (await p.metar_bbox(33, 124, 40, 131)).data == [{"icaoId": "RKSI"}] and met.called
    with respx.mock:
        respx.get("https://aviationweather.gov/api/data/isigmet").mock(return_value=httpx.Response(200, json={"error": 1}))
        with pytest.raises(ValueError):
            await p.isigmet()


async def test_rainviewer_shape(http):
    p = RainViewerProvider(http)
    with respx.mock:
        respx.get(RV_URL).mock(return_value=httpx.Response(200, json={"host": "https://tilecache.rainviewer.com", "radar": {}}))
        assert (await p.frames()).data["host"].startswith("https://")
    with respx.mock:
        respx.get(RV_URL).mock(return_value=httpx.Response(200, json={"radar": {}}))
        with pytest.raises(ValueError):
            await p.frames()


RV_OK = orjson.loads((ROOT / "fixtures" / "rainviewer_weather_maps.json").read_bytes())


def _rv(host: object = "https://tilecache.rainviewer.com", path: object = "/v2/radar/08cf9db57b5d") -> dict:
    return {
        "version": "2.0",
        "generated": 1,
        "host": host,
        "radar": {"past": [{"time": 1790487000, "path": path}], "nowcast": []},
    }


async def test_rainviewer_real_response_shape_passes_the_tile_checks(http):
    with respx.mock:
        respx.get(RV_URL).mock(return_value=httpx.Response(200, json=RV_OK))
        assert (await RainViewerProvider(http).frames()).data == RV_OK


@pytest.mark.parametrize(
    "data",
    [
        _rv(host="https://evil.example"),
        _rv(host="http://tilecache.rainviewer.com"),
        _rv(host="https://tilecache.rainviewer.com.evil.example"),
        _rv(host="https://tilecache.rainviewer.com/"),
        _rv(host="https://user@tilecache.rainviewer.com"),
        _rv(host=None),
        _rv(path="/v2/radar/../../x"),
        _rv(path="/v2/radar/08cf9db57b5d?x=1"),
        _rv(path="/v2/radar/08CF9DB57B5D"),
        _rv(path="//evil.example/v2/radar/08cf9db57b5d"),
        _rv(path="/v2/radar/"),
        _rv(path="/v2/radar/08cf9db57b5d\n"),
        _rv(path=1790487000),
    ],
)
async def test_rainviewer_tile_host_and_paths_outside_the_allow_list_are_refused(http, data):
    """보안 검토 L-6(2026-10-01): 공급자가 준 타일 host · path 를 검사 없이 api · 브라우저까지 넘겼다(CSP 가 유일한 방어). host 는 정확히
    https://tilecache.rainviewer.com, path 는 /v2/radar/<소문자 16진수>(실제 응답 fixtures/rainviewer_weather_maps.json 의 모양)만 받는다."""
    with respx.mock:
        respx.get(RV_URL).mock(return_value=httpx.Response(200, json=data))
        with pytest.raises(ValueError, match="rainviewer tile"):
            await RainViewerProvider(http).frames()


async def test_kma_list_and_binary(http):
    p = KmaRadarProvider(http, "k3y", "HSR")
    assert p.configured and not KmaRadarProvider(http, "").configured
    with respx.mock:
        respx.get("https://apihub.kma.go.kr/api/typ01/url/rdr_cmp_file_list.php").mock(
            return_value=httpx.Response(
                200, content=b"RDR_CMP_HSR_EXT_202609270005.bin.gz,=\nRDR_CMP_HSR_EXT_202609270000.bin.gz,=\n"
            )
        )
        binr = respx.get("https://apihub.kma.go.kr/api/typ04/url/rdr_cmp_file.php").mock(
            return_value=httpx.Response(200, content=gzip.compress(b"x"))
        )
        lst = await p.file_list("20260927")
        b = await p.binary("202609270005")
    assert lst.data == ["202609270000", "202609270005"] and b.data["tm"] == "202609270005"
    assert binr.calls[0].request.url.params["authKey"] == "k3y"
    with respx.mock:
        respx.get("https://apihub.kma.go.kr/api/typ01/url/rdr_cmp_file_list.php").mock(
            return_value=httpx.Response(200, content=b'{"result": "auth error"}')
        )
        respx.get("https://apihub.kma.go.kr/api/typ04/url/rdr_cmp_file.php").mock(
            return_value=httpx.Response(200, content=b"file not exist")
        )
        with pytest.raises(ValueError):
            await p.file_list("20260927")
        with pytest.raises(ValueError, match="not gzip"):
            await p.binary("202609270005")


# ---- fixture 공급자(외부 호출 없음) ------------------------------------------------------------------------------------
async def test_fixture_providers_shift_times_to_now():
    import time

    ac = fx.FixtureAircraftProvider()
    reg = await ac.fetch_region(36.5, 127.8, 250)
    assert reg.provider == "fixture" and len(reg.data["ac"]) > 50 and all(a.get("seen_pos") == 1.0 for a in reg.data["ac"])
    glob = await ac.fetch_global()
    assert glob.data["states"] == [] and glob.extra["raw_ref"] == "fixture:empty_global"
    awc = fx.FixtureAwcProvider()
    isig = await awc.isigmet()
    now = int(time.time())
    assert isig.data and all(now - 1900 <= it["validTimeFrom"] <= now for it in isig.data)
    assert any("SYNTHETIC" in (it.get("rawSigmet") or "") for it in isig.data)  # 합성 경보는 원문에 표시
    assert (await awc.airsigmet()).provider == "fixture"
    met = await awc.metar_bbox(33, 124, 40, 131)
    assert met.data and all(it["obsTime"] <= now for it in met.data)
    rv = await fx.FixtureRainViewerProvider().frames()
    past = rv.data["radar"]["past"]
    assert past[-1]["time"] == now // 600 * 600 and orjson.loads(rv.raw)["generated"] == rv.data["generated"]
