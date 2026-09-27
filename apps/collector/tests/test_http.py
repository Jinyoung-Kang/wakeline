"""외부 호출 클라이언트: 허용 호스트·https·크기 상한·속도 상한·429 쿨다운. 실제 네트워크는 쓰지 않는다(respx)."""

from __future__ import annotations

import httpx
import pytest
import respx

from wakeline_collector import http as httpmod
from wakeline_collector.http import HostNotAllowed, HttpClient, ProviderHttpError, ResponseTooLarge
from wakeline_collector.ratelimit import PRIORITY_HOT, RateLimiter, Throttled


def _client(**hosts: tuple[float, float]) -> HttpClient:
    return HttpClient(RateLimiter(100, 100, {h.replace("_", "."): v for h, v in hosts.items()}))


async def test_disallowed_host_and_plain_http_are_refused_before_any_call():
    c = _client()
    with respx.mock(assert_all_called=False) as m:
        route = m.get(url__regex=r".*").mock(return_value=httpx.Response(200))
        with pytest.raises(HostNotAllowed):
            await c.get("https://evil.example/x")
        with pytest.raises(HostNotAllowed):
            await c.get("http://api.adsb.lol/v2/point/1/2/3")
        assert route.call_count == 0 and c.limiter.granted == 0
    await c.aclose()


async def test_success_goes_through_limiter():
    c = _client()
    with respx.mock:
        respx.get("https://api.adsb.lol/v2/point/1/2/3").mock(return_value=httpx.Response(200, json={"ac": []}))
        r = await c.get("https://api.adsb.lol/v2/point/1/2/3")
    assert r.status == 200 and r.body == b'{"ac":[]}' and c.limiter.granted == 1
    await c.aclose()


async def test_429_penalizes_host_with_retry_after():
    c = _client(opendata_adsb_fi=(100.0, 5))
    with respx.mock:
        respx.get("https://opendata.adsb.fi/api/v2/icao/abcdef").mock(
            return_value=httpx.Response(429, headers={"Retry-After": "90"}, text="slow down")
        )
        with pytest.raises(ProviderHttpError) as ei:
            await c.get("https://opendata.adsb.fi/api/v2/icao/abcdef")
    assert ei.value.status == 429 and "slow down" in str(ei.value)
    assert c.limiter.cooldown_remaining("opendata.adsb.fi") > 80
    with pytest.raises(Throttled):  # 이후 호출은 보내지 않는다(모든 호출자 공통)
        await c.get("https://opendata.adsb.fi/api/v2/icao/abcdef", priority=PRIORITY_HOT, wait_s=1)
    await c.aclose()


async def test_http_error_without_penalty_and_retry_after_parse():
    assert httpmod._retry_after_s({"retry-after": "12"}) == 12.0
    assert httpmod._retry_after_s({"retry-after": "Wed, 21 Oct 2026 07:28:00 GMT"}) is None
    assert httpmod._retry_after_s({}) is None
    c = _client()
    with respx.mock:
        respx.get("https://aviationweather.gov/api/data/x").mock(return_value=httpx.Response(503, text="down"))
        with pytest.raises(ProviderHttpError) as ei:
            await c.get("https://aviationweather.gov/api/data/x")
    assert ei.value.status == 503 and c.limiter.cooldown_remaining("aviationweather.gov") == 0
    await c.aclose()


async def test_response_size_cap(monkeypatch):
    monkeypatch.setattr(httpmod.settings, "http_max_bytes", 10)
    c = _client()
    with respx.mock:
        respx.get("https://api.rainviewer.com/public/weather-maps.json").mock(
            return_value=httpx.Response(200, content=b"x" * 100)
        )
        with pytest.raises(ResponseTooLarge):
            await c.get("https://api.rainviewer.com/public/weather-maps.json")
    await c.aclose()


async def test_post_form_is_limited_too():
    c = _client()
    with respx.mock:
        route = respx.post("https://auth.opensky-network.org/token").mock(return_value=httpx.Response(200, json={}))
        r = await c.post_form("https://auth.opensky-network.org/token", {"grant_type": "client_credentials"})
    assert r.status == 200 and route.call_count == 1 and c.limiter.granted == 1
    await c.aclose()


async def test_default_client_uses_contract_limits():
    c = HttpClient()
    assert c.limiter.global_rps == 2.0 and c.limiter.host_rps("opendata.adsb.fi") == 0.8
    await c.aclose()
