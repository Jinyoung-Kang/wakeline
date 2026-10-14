"""런타임 설정 오버레이(FR-27): api 가 운영 API 로 바꾼 값을 Redis 해시 wakeline:settings 에 두고, 수집기는 매 주기 읽는다.

Redis 의 값은 운영 API 의 검사(SettingsService.validate)를 거치지 않았을 수 있다(미러 · 직접 고친 값). 그래서 읽을 때 다시 거른다:
주기는 운영 API 가 받는 범위로 자르고, 관심 지역은 api RegionSettings.parse 와 같은 글자 규칙으로 읽는다(QA-1221 — 전에는 파이썬 float · int 가
'nan' · 'inf' · '1_0' 을 받아 api 는 기본값, 수집기는 NaN 좌표로 외부를 불렀다).
"""

from __future__ import annotations

import logging
import math
import re
from typing import Any, cast

from redis.asyncio import Redis

from wakeline_collector.config import settings

KEY = "wakeline:settings"
log = logging.getLogger("settings")
# 운영 API(SettingsService.validate)가 받는 범위와 같다 — 그 밖의 값은 가장 가까운 끝으로 자른다
REGION_POLL_RANGE_S = (5, 120)
GLOBAL_POLL_RANGE_S = (60, 3600)
SIGMET_POLL_RANGE_S = (60, 3600)
RADAR_POLL_RANGE_S = (30, 3600)
METAR_POLL_RANGE_S = (300, 7200)
REGION_RADIUS_RANGE_NM = (50, 500)

# api 가 읽는 글자 규칙(Java Double.parseDouble 의 십진 표기 · Integer.parseInt) — 파이썬 float · int 만 받는 'nan' · 'inf' · 'infinity' · 밑줄 '1_0' ·
# 유니코드 공백은 받지 않는다. Java 의 16진 실수(0x1p3)는 운영 API 가 쓰지 않는 모양이라 받지 않는다(기본값)
_JAVA_DECIMAL = re.compile(r"[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?[fFdD]?")
_JAVA_INT = re.compile(r"[+-]?[0-9]+")
_JAVA_TRIM = "".join(chr(c) for c in range(0x21))  # String.trim() 이 지우는 글자(U+0000–U+0020)
_INT32 = (-(2**31), 2**31 - 1)


def _clamp(v: int, bounds: tuple[int, int]) -> int:
    lo, hi = bounds
    return max(lo, min(hi, v))


def parse_center(text: str) -> tuple[float, float] | None:
    """'lat,lon' → (lat, lon). api RegionSettings.parse 와 같은 해석 — 조각이 둘이 아니거나(Java split 처럼 끝의 빈 조각은 버린다) 해석할 수 없거나
    유한하지 않으면 None(부르는 쪽이 기본값). 범위(±85 · ±180)는 api 도 읽을 때 보지 않아 여기서도 보지 않는다."""
    parts = text.split(",")
    while parts and parts[-1] == "":
        parts.pop()
    if len(parts) != 2:
        return None
    out: list[float] = []
    for part in parts:
        p = part.strip(_JAVA_TRIM)
        if not _JAVA_DECIMAL.fullmatch(p):
            return None
        v = float(p.rstrip("fFdD"))
        if not math.isfinite(v):  # 1e400 처럼 넘쳐 무한이 된 값도(Java 와 같다)
            return None
        out.append(v)
    return out[0], out[1]


def parse_radius(text: str) -> int | None:
    """api 의 Integer.parseInt(radius.trim()) 와 같은 해석 — 해석할 수 없거나 int 범위 밖이면 None(부르는 쪽이 기본값)."""
    p = text.strip(_JAVA_TRIM)
    if not _JAVA_INT.fullmatch(p):
        return None
    v = int(p)
    return v if _INT32[0] <= v <= _INT32[1] else None


class RuntimeSettings:
    def __init__(self, redis: Redis):
        self._r = redis
        self._cache: dict[str, str] = {}

    async def refresh(self) -> None:
        try:
            self._cache = cast(dict[str, str], await self._r.hgetall(KEY)) or {}
        except Exception as e:  # noqa: BLE001 — Redis 장애 시 마지막 값 유지
            log.warning("settings refresh failed: %s", type(e).__name__)

    def _get(self, key: str, default: Any) -> Any:
        v = self._cache.get(key)
        if v is None or v == "":
            return default
        try:
            return type(default)(v) if not isinstance(default, bool) else v in ("1", "true", "True")
        except (TypeError, ValueError):
            return default

    @property
    def region_poll_s(self) -> int:
        return _clamp(int(self._get("region_poll_s", settings.region_poll_s)), REGION_POLL_RANGE_S)

    @property
    def global_poll_s(self) -> int:
        return _clamp(self._get("global_poll_s", settings.global_poll_s), GLOBAL_POLL_RANGE_S)

    @property
    def sigmet_poll_s(self) -> int:
        return _clamp(self._get("sigmet_poll_s", settings.sigmet_poll_s), SIGMET_POLL_RANGE_S)

    @property
    def radar_poll_s(self) -> int:
        return _clamp(self._get("radar_poll_s", settings.radar_poll_s), RADAR_POLL_RANGE_S)

    @property
    def metar_poll_s(self) -> int:
        return _clamp(self._get("metar_poll_s", settings.metar_poll_s), METAR_POLL_RANGE_S)

    @property
    def provider_order(self) -> list[str]:
        v = self._get("aircraft_providers", settings.aircraft_providers)
        return [p.strip() for p in v.split(",") if p.strip()]

    @property
    def region(self) -> tuple[float, float, int]:
        """(lat, lon, 반경 NM) — api RegionSettings.parse 와 같은 해석: 빈 값 · 해석 실패 · 유한하지 않은 중심은 .env 기본값, 반경은 [50, 500] 로 자른다."""
        center = self._cache.get("region_center") or ""
        lat, lon = parse_center(center) or (settings.region_lat, settings.region_lon)
        radius_text = self._cache.get("region_radius_nm") or ""
        radius = parse_radius(radius_text) if radius_text else None
        return lat, lon, _clamp(settings.region_radius_nm if radius is None else radius, REGION_RADIUS_RANGE_NM)

    @property
    def global_enabled(self) -> bool:
        return self._get("global_enabled", True)
