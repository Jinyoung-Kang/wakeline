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
