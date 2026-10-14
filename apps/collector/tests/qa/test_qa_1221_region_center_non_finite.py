"""QA-1221(AWS 출시 QA · 수집기 · 운영 설정): 수집기는 Redis 의 region_center 를 api 와 **다르게** 읽는다 — 'nan' · 'inf' · '1_0' 을 좌표로 받아
관심 지역 폴링이 NaN 좌표로 외부를 부르거나(실시간) 매 주기 예외로 실패한다(fixture).

api RegionSettings.parse(RegionSettings.java:107-129)는 "collector runtime_settings.region 과 같은 해석"이라며 해석에 실패하거나 **유한하지 않은** 값이면
.env 기본값을 쓴다(`Double.isFinite` 검사). 수집기 runtime_settings.py:63-71 은 `float(x)` 만 한다 — 파이썬 float 는 'nan' · 'inf' · 'infinity' · '1_0'(밑줄)을
받으므로 같은 Redis 값에서 두 프로세스의 관심 지역이 갈린다(api: 기본값 · 수집기: NaN). 수집기 쪽에는 위도 · 경도 범위 검사도 없다(api 는 쓰기 때만 ±85 · ±180).
운영 API 는 쓰기 때 이런 값을 거절하지만(SettingsService.validate), 미러(SettingsService.mirror — 검사 없이 app_setting → Redis)와 Redis · DB 를 직접 고친 값은
이 검사를 거치지 않는다 — 후보 7 '수집기 쪽 범위 검사가 일부만'의 재현.

기대: 유한하지 않은 값(과 api 가 해석하지 못하는 '1_0')은 api 와 같이 기본값으로 읽고, 관심 지역 호출에 'nan' 이 실리지 않는다(범위 밖 값의 처리는 api 도 읽을 때 검사하지 않아 이 시험에 넣지 않았다).
실행: cd apps/collector && uv run --offline pytest tests/qa/test_qa_1221_region_center_non_finite.py -q
"""

from __future__ import annotations

import math

import httpx
import pytest
import respx
from fakes import FakeRedis, make_ctx

from wakeline_collector.config import settings
from wakeline_collector.fallback import ProviderChain
from wakeline_collector.http import HttpClient
from wakeline_collector.jobs.aircraft import AircraftJob
from wakeline_collector.providers.readsb import adsb_lol
from wakeline_collector.ratelimit import RateLimiter
from wakeline_collector.runtime_settings import KEY, RuntimeSettings


async def _rt(value: str) -> RuntimeSettings:
    r = FakeRedis()
    await r.hset(KEY, "region_center", value)
    rt = RuntimeSettings(r)  # type: ignore[arg-type]
    await rt.refresh()
    return rt


@pytest.mark.parametrize("value", ["nan,nan", "inf,127.8", "36.5,-infinity", "1_0,127.8"])
async def test_qa_1221_a_center_the_api_reads_as_default_is_the_default_here_too(value):
    """api(RegionSettings.parse)는 이 값들을 기본값으로 읽는다 — Java Double.parseDouble 은 '1_0' 을 거절하고, NaN · Infinity 는 isFinite 로 거른다."""
    lat, lon, _ = (await _rt(value)).region
    assert (lat, lon) == (settings.region_lat, settings.region_lon), f"{value!r} → ({lat}, {lon}); api reads the default"


async def test_qa_1221_the_region_poll_never_sends_nan_coordinates_to_a_provider():
    r = FakeRedis()
    await r.hset(KEY, "region_center", "nan,nan")
    ctx = make_ctx(r, limits={"adsb_lol": 0})
    ctx.rt = RuntimeSettings(r)  # type: ignore[arg-type]
    await ctx.rt.refresh()
    assert math.isnan(ctx.rt.region[0])  # 수집기가 읽은 중심
    http = HttpClient(RateLimiter(100, 100, {"api.adsb.lol": (100.0, 100)}))
    try:
        with respx.mock:
            route = respx.get(url__regex=r"https://api\.adsb\.lol/.*").mock(return_value=httpx.Response(400, text="bad point"))
            job = AircraftJob("region", ProviderChain("region", {"adsb_lol": adsb_lol(http)}, ctx.status), ctx)
            await job.run_once()
            urls = [str(c.request.url) for c in route.calls]
    finally:
        await http.aclose()
    assert not [u for u in urls if "nan" in u.lower()], f"region poll sent {urls}"
