"""QA-210(QA 2026-10 기능 · fixture 모드): FixtureAircraftProvider._moved 는 "관심 지역 밖으로 나가면 반대편에서 다시 들어오게 방위를 뒤집는다(데모가 비지 않도록)"
라고 하지만, 뒤집은 위치도 원래 자리에서 경과 시간만큼 반대로 간 곳이라 시간이 지나면 그쪽도 반경 밖이 된다 — 항공기가 지역을 영영 떠나고, 뒤집힌 항공기는 보고 방위
(track)와 반대로 움직인다(track 을 바꾸지 않는다). 격리 스택 A(fixture, 기동 55분 뒤): 250 NM 안 항공기 127 → 53, 가장 먼 것 644 NM, 780de6 은 track 249.98(서남서)인데 동북동으로 움직였다.
make demo · E2E · QA 스택이 쓰는 경로다.
"""

from __future__ import annotations

import math
import time

from wakeline_collector.geo import haversine_nm
from wakeline_collector.providers import fixture as fx

CENTER = (36.5, 127.8)
RADIUS_NM = 250


def _bearing(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    p1, p2, dl = math.radians(lat1), math.radians(lat2), math.radians(lon2 - lon1)
    y = math.sin(dl) * math.cos(p2)
    x = math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dl)
    return (math.degrees(math.atan2(y, x)) + 360) % 360


def test_fixture_aircraft_stay_inside_the_region_after_an_hour() -> None:
    p = fx.FixtureAircraftProvider()
    p._t0 = time.time() - 3600  # 기동 1시간 뒤
    moved = p._moved(*CENTER, RADIUS_NM)["ac"]
    outside = [
        (a["hex"], round(haversine_nm(*CENTER, a["lat"], a["lon"])))
        for a in moved
        if a.get("lat") is not None and haversine_nm(*CENTER, a["lat"], a["lon"]) > RADIUS_NM
    ]
    assert not outside, (
        f"{len(outside)}/{len(moved)} fixture aircraft are outside the {RADIUS_NM} NM region after 1 h (farthest {sorted(outside, key=lambda x: -x[1])[:3]})"
    )


def test_a_flipped_fixture_aircraft_moves_along_its_reported_track() -> None:
    p = fx.FixtureAircraftProvider()
    p._t0 = time.time() - 600
    a0 = p._moved(*CENTER, RADIUS_NM)["ac"]
    p._t0 -= 60  # 1분 더 흐른 뒤
    a1 = {a["hex"]: a for a in p._moved(*CENTER, RADIUS_NM)["ac"]}
    wrong = []
    for a in a0:
        b = a1.get(a["hex"])
        trk = a.get("track", a.get("calc_track"))
        if (
            not b
            or trk is None
            or not a.get("gs")
            or a.get("alt_baro") == "ground"
            or (a["lat"], a["lon"]) == (b["lat"], b["lon"])
        ):
            continue
        moved_dir = _bearing(a["lat"], a["lon"], b["lat"], b["lon"])
        if abs((moved_dir - trk + 180) % 360 - 180) > 90:
            wrong.append((a["hex"], trk, round(moved_dir)))
    assert not wrong, f"{len(wrong)} fixture aircraft move opposite to their reported track (hex, track, moved): {wrong[:3]}"
