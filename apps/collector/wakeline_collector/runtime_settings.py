"""런타임 설정 오버레이(FR-27): api 가 운영 API 로 바꾼 값을 Redis 해시 wakeline:settings 에 두고, 수집기는 매 주기 읽는다."""

from __future__ import annotations

import logging

from redis.asyncio import Redis

from wakeline_collector.config import settings

KEY = "wakeline:settings"
log = logging.getLogger("settings")


class RuntimeSettings:
    def __init__(self, redis: Redis):
        self._r = redis
        self._cache: dict[str, str] = {}

    async def refresh(self) -> None:
        try:
            self._cache = await self._r.hgetall(KEY) or {}
        except Exception as e:  # noqa: BLE001 — Redis 장애 시 마지막 값 유지
            log.warning("settings refresh failed: %s", type(e).__name__)

    def _get(self, key: str, default):
        v = self._cache.get(key)
        if v is None or v == "":
            return default
        try:
            return type(default)(v) if not isinstance(default, bool) else v in ("1", "true", "True")
        except (TypeError, ValueError):
            return default

    @property
    def region_poll_s(self) -> int:
        return max(5, self._get("region_poll_s", settings.region_poll_s))

    @property
    def global_poll_s(self) -> int:
        return max(60, self._get("global_poll_s", settings.global_poll_s))

    @property
    def sigmet_poll_s(self) -> int:
        return max(60, self._get("sigmet_poll_s", settings.sigmet_poll_s))

    @property
    def radar_poll_s(self) -> int:
        return max(30, self._get("radar_poll_s", settings.radar_poll_s))

    @property
    def metar_poll_s(self) -> int:
        return max(300, self._get("metar_poll_s", settings.metar_poll_s))

    @property
    def provider_order(self) -> list[str]:
        v = self._get("aircraft_providers", settings.aircraft_providers)
        return [p.strip() for p in v.split(",") if p.strip()]

    @property
    def region(self) -> tuple[float, float, int]:
        center = self._get("region_center", settings.region_center)
        try:
            lat, lon = (float(x) for x in center.split(","))
        except ValueError:
            lat, lon = settings.region_lat, settings.region_lon
        radius = max(50, min(500, self._get("region_radius_nm", settings.region_radius_nm)))
        return lat, lon, radius

    @property
    def global_enabled(self) -> bool:
        return self._get("global_enabled", True)
