"""런타임 설정 오버레이: 운영 값 · 범위 제한 · 잘못된 값은 기본값 · Redis 장애 시 마지막 값."""

from __future__ import annotations

from fakes import FakeRedis

from wakeline_collector.config import settings
from wakeline_collector.runtime_settings import KEY, RuntimeSettings


async def test_overrides_and_clamps():
    r = FakeRedis()
    await r.hset(
        KEY,
        mapping={
            "region_poll_s": "300",  # 운영 API 범위(5–120) 밖 → 120
            "global_poll_s": "30",  # 최소 60
            "sigmet_poll_s": "600",
            "radar_poll_s": "10",
            "metar_poll_s": "900",
            "aircraft_providers": "adsb_fi, adsb_lol ,",
            "region_center": "35.0,129.0",
            "region_radius_nm": "900",
            "global_enabled": "false",
        },
    )
    rt = RuntimeSettings(r)  # type: ignore[arg-type]
    await rt.refresh()
    assert rt.region_poll_s == 120 and rt.global_poll_s == 60 and rt.sigmet_poll_s == 600
    assert rt.radar_poll_s == 30 and rt.metar_poll_s == 900
    assert rt.provider_order == ["adsb_fi", "adsb_lol"]
    assert rt.region == (35.0, 129.0, 500) and rt.global_enabled is False
    await r.hset(KEY, mapping={"region_poll_s": "1"})
    await rt.refresh()
    assert rt.region_poll_s == 5


async def test_defaults_and_garbage():
    r = FakeRedis()
    await r.hset(
        KEY, mapping={"region_poll_s": "fast", "region_center": "nowhere", "global_enabled": "", "region_radius_nm": "10"}
    )
    rt = RuntimeSettings(r)  # type: ignore[arg-type]
    await rt.refresh()
    assert rt.region_poll_s == settings.region_poll_s
    assert rt.region == (settings.region_lat, settings.region_lon, 50)
    assert rt.global_enabled is True


async def test_redis_failure_keeps_last_values():
    r = FakeRedis()
    await r.hset(KEY, mapping={"region_poll_s": "30"})
    rt = RuntimeSettings(r)  # type: ignore[arg-type]
    await rt.refresh()
    r.down = True
    await rt.refresh()
    assert rt.region_poll_s == 30


async def test_poll_values_above_the_ops_api_range_are_cut_to_its_top():
    """QA-1221: Redis 에 운영 API 를 거치지 않은 값(미러 · 직접 고침)이 있어도 주기는 운영 API 가 받는 범위 안이다."""
    r = FakeRedis()
    await r.hset(
        KEY,
        mapping={"global_poll_s": "999999999", "sigmet_poll_s": "4000", "radar_poll_s": "4000", "metar_poll_s": "9000"},
    )
    rt = RuntimeSettings(r)  # type: ignore[arg-type]
    await rt.refresh()
    assert (rt.global_poll_s, rt.sigmet_poll_s, rt.radar_poll_s, rt.metar_poll_s) == (3600, 3600, 3600, 7200)


async def test_region_reads_like_the_api_region_settings_parse():
    """QA-1221: api RegionSettings.parse(Double.parseDouble · Integer.parseInt + 유한 검사)와 같은 해석 — 파이썬만 받는 글자는 기본값."""
    default = (settings.region_lat, settings.region_lon)
    cases = {
        " 35.0 , 129.0 ": (35.0, 129.0),
        "35.0,129.0,": (35.0, 129.0),  # Java split 은 끝의 빈 조각을 버린다
        "+35,-129.5e0": (35.0, -129.5),
        "35.0d,129f": (35.0, 129.0),
        "35.0,129.0,1": default,
        ",35.0,129.0": default,
        "NaN,127.8": default,
        "36.5,Infinity": default,
        "1e400,127.8": default,  # 넘쳐 무한
        " 36.5,127.8": default,  # 유니코드 공백 — Java trim 은 지우지 않는다
        "٣٦,127.8": default,  # 아라비아-인도 숫자 — Double.parseDouble 은 받지 않는다
    }
    for center, want in cases.items():
        r = FakeRedis()
        await r.hset(KEY, "region_center", center)
        rt = RuntimeSettings(r)  # type: ignore[arg-type]
        await rt.refresh()
        assert rt.region[:2] == want, center
    radii = {"300": 300, " +300 ": 300, "1_0": settings.region_radius_nm, "99999999999": settings.region_radius_nm, "-5": 50}
    for radius, want_nm in radii.items():
        r = FakeRedis()
        await r.hset(KEY, "region_radius_nm", radius)
        rt = RuntimeSettings(r)  # type: ignore[arg-type]
        await rt.refresh()
        assert rt.region[2] == max(50, min(500, want_nm)), radius
