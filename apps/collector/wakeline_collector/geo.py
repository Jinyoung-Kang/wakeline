"""구면 거리·dead reckoning (10.1절 공식). 1 NM = 1,852 m."""

from __future__ import annotations

import math

R_M = 6_371_000.0
NM_M = 1852.0


def haversine_nm(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * R_M * math.asin(math.sqrt(a)) / NM_M


def wrap180(lon: float) -> float:
    return ((lon + 180.0) % 360.0) - 180.0


def dead_reckon(lat: float, lon: float, track_deg: float, gs_kt: float, dt_s: float) -> tuple[float, float]:
    d = gs_kt * NM_M * dt_s / 3600.0
    delta = d / R_M
    th = math.radians(track_deg)
    p1, l1 = math.radians(lat), math.radians(lon)
    p2 = math.asin(math.sin(p1) * math.cos(delta) + math.cos(p1) * math.sin(delta) * math.cos(th))
    l2 = l1 + math.atan2(math.sin(th) * math.sin(delta) * math.cos(p1), math.cos(delta) - math.sin(p1) * math.sin(p2))
    return math.degrees(p2), wrap180(math.degrees(l2))


def bbox_around(lat: float, lon: float, radius_nm: float) -> tuple[float, float, float, float]:
    """(lamin, lomin, lamax, lomax) — 반경을 감싸는 위경도 상자(극지방 제외).
    날짜변경선을 넘으면 lomin > lomax 가 된다 — 조회에는 boxes_around 를 쓴다."""
    dlat = radius_nm / 60.0
    dlon = radius_nm / (60.0 * max(math.cos(math.radians(lat)), 0.1))
    return (max(lat - dlat, -90), wrap180(lon - dlon), min(lat + dlat, 90), wrap180(lon + dlon))


def boxes_around(lat: float, lon: float, radius_nm: float) -> list[tuple[float, float, float, float]]:
    """bbox_around 를 lomin ≤ lomax 인 상자들로. 날짜변경선을 넘으면 [lomin, 180] · [-180, lomax] 두 개(R-68)."""
    lamin, lomin, lamax, lomax = bbox_around(lat, lon, radius_nm)
    if lomin <= lomax:
        return [(lamin, lomin, lamax, lomax)]
    return [(lamin, lomin, lamax, 180.0), (lamin, -180.0, lamax, lomax)]
