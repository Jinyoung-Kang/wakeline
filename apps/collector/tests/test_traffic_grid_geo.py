"""연안 교통량(ADR-023): EPSG:5179 역변환(순수 Python) · 0.025° 격자 맞춤 검사 · 격자4단계 WFS(GML 3.1.1) 해석.

기준값: 2026-09-29 사용자 키로 받은 GR4_F2K41_C3 의 posList(fixtures/mof_grid4_wfs_GR4_F2K41_C3.xml) — 모서리가 정확히
37.450/37.475 N · 126.600/126.625 E 로 풀려야 한다. pyproj(이미 의존성 — kma_grid)는 대조용으로만 쓴다.
"""

from __future__ import annotations

import math
from pathlib import Path

import pytest
from pyproj import Transformer

from wakeline_collector.marine_grid import (
    CELL_DEG,
    Cell,
    OffGrid,
    WfsError,
    cell_from_ring,
    parse_wfs,
    snap,
    tm5179_to_wgs84,
    wgs84_to_tm5179,
)

FIX = Path(__file__).resolve().parents[3] / "fixtures" / "mof_grid4_wfs_GR4_F2K41_C3.xml"
SAMPLE_RING = [
    (920421.56066741, 1942133.04361461),
    (922632.11858739, 1942112.20913241),
    (922606.35270926, 1939338.57576189),
    (920395.05845389, 1939359.4053201),
    (920421.56066741, 1942133.04361461),
]


# ---- 투영 ------------------------------------------------------------------------------------------------------------


def test_the_fixture_is_the_real_response_and_its_srs_name_is_accepted():
    """fixtures/mof_grid4_wfs_GR4_F2K41_C3.xml 은 2026-09-29 실제 응답 그대로다(docs/review/evidence/public-data-apis-2026-09-29.txt).
    처음 구현은 짐작한 srsName="EPSG:5179" 를 기대해, 배포 뒤 모든 기하 조회가 'unexpected srsName' 으로 실패했다."""
    text = FIX.read_text()
    assert 'srsName="http://www.opengis.net/gml/srs/epsg.xml#5179"' in text
    assert 'srsName="EPSG:5179"' not in text
    assert "<!--" not in text  # 만든 자료가 아니다


def test_projection_origin_maps_to_38n_127_5e():
    lat, lon = tm5179_to_wgs84(1_000_000.0, 2_000_000.0)
    assert lat == pytest.approx(38.0, abs=1e-12)
    assert lon == pytest.approx(127.5, abs=1e-12)


@pytest.mark.parametrize(
    ("xy", "want"),
    [
        (SAMPLE_RING[0], (37.475, 126.600)),
        (SAMPLE_RING[1], (37.475, 126.625)),
        (SAMPLE_RING[2], (37.450, 126.625)),
        (SAMPLE_RING[3], (37.450, 126.600)),
    ],
)
def test_verified_sample_corners_land_exactly_on_the_lattice(xy, want):
    lat, lon = tm5179_to_wgs84(*xy)
    assert lat == pytest.approx(want[0], abs=1e-9)
    assert lon == pytest.approx(want[1], abs=1e-9)


def test_inverse_agrees_with_pyproj_across_korean_waters():
    t = Transformer.from_crs("EPSG:4326", "EPSG:5179", always_xy=True)
    worst = 0.0
    for lat in [32.0 + 0.5 * i for i in range(16)]:  # 32–39.5 N
        for lon in [123.0 + 0.75 * j for j in range(13)]:  # 123–132 E
            x, y = t.transform(lon, lat)
            la, lo = tm5179_to_wgs84(x, y)
            worst = max(worst, abs(la - lat), abs(lo - lon))
    assert worst < 1e-9, worst


def test_forward_and_inverse_round_trip():
    for lat, lon in [(33.1, 124.2), (35.0, 129.0), (37.475, 126.6), (39.9, 131.9), (38.0, 127.5)]:
        x, y = wgs84_to_tm5179(lat, lon)
        la, lo = tm5179_to_wgs84(x, y)
        assert (la, lo) == (pytest.approx(lat, abs=1e-11), pytest.approx(lon, abs=1e-11))


def test_forward_matches_pyproj():
    t = Transformer.from_crs("EPSG:4326", "EPSG:5179", always_xy=True)
    for lat, lon in [(34.0, 125.0), (37.45, 126.6), (36.0, 130.5)]:
        x, y = wgs84_to_tm5179(lat, lon)
        px, py = t.transform(lon, lat)
        assert abs(x - px) < 1e-4 and abs(y - py) < 1e-4  # 0.1 mm


def test_projection_rejects_non_finite():
    with pytest.raises(ValueError):
        tm5179_to_wgs84(float("nan"), 2e6)
    with pytest.raises(ValueError):
        tm5179_to_wgs84(1e6, math.inf)


# ---- 격자 맞춤 --------------------------------------------------------------------------------------------------------


def test_snap_accepts_values_within_one_micro_degree():
    assert CELL_DEG == 0.025
    assert snap(37.4750000004) == 37.475
    assert snap(126.5999999996) == 126.6
    assert snap(-12.3499999999) == -12.35
    assert snap(0.0) == 0.0


def test_snap_rejects_values_off_the_lattice():
    assert snap(37.4755) is None  # 0.0005° = 약 55 m
    assert snap(37.475002) is None  # 2e-6° > 1e-6°
    assert snap(math.nan) is None
    assert snap(math.inf) is None


def test_cell_from_verified_ring():
    c = cell_from_ring("GR4_F2K41_C3", 7, SAMPLE_RING)
    assert c == Cell("GR4_F2K41_C3", 37.45, 126.6, 37.475, 126.625, 7)
    assert c.lat_max - c.lat_min == pytest.approx(CELL_DEG) and c.lon_max - c.lon_min == pytest.approx(CELL_DEG)


def test_ring_shifted_off_the_lattice_is_rejected():
    shifted = [(x + 50.0, y) for x, y in SAMPLE_RING]  # 50 m 동쪽 — 모서리가 격자에 없다
    with pytest.raises(OffGrid, match="off the 0.025"):
        cell_from_ring("GR4_X", None, shifted)


def test_ring_spanning_two_cells_is_rejected():
    lat0, lon0 = 37.45, 126.6
    corners = [(lat0 + 0.05, lon0), (lat0 + 0.05, lon0 + 0.025), (lat0, lon0 + 0.025), (lat0, lon0), (lat0 + 0.05, lon0)]
    ring = [wgs84_to_tm5179(la, lo) for la, lo in corners]
    with pytest.raises(OffGrid, match="not one 0.025"):
        cell_from_ring("GR4_X", None, ring)


def test_ring_with_wrong_point_count_or_open_ring_is_rejected():
    with pytest.raises(OffGrid, match="5 points"):
        cell_from_ring("GR4_X", None, SAMPLE_RING[:4])
    open_ring = [*SAMPLE_RING[:4], (SAMPLE_RING[0][0] + 1.0, SAMPLE_RING[0][1])]
    with pytest.raises(OffGrid, match="not closed"):
        cell_from_ring("GR4_X", None, open_ring)


def test_ring_with_repeated_corner_is_rejected():
    ring = [SAMPLE_RING[0], SAMPLE_RING[0], SAMPLE_RING[2], SAMPLE_RING[3], SAMPLE_RING[0]]
    with pytest.raises(OffGrid, match="corners"):
        cell_from_ring("GR4_X", None, ring)


def test_ring_far_outside_korea_is_rejected():
    # 축 순서가 바뀐 좌표(북거 · 동거)는 한반도 밖으로 풀린다 — 격자 검사가 막는다
    swapped = [(y, x) for x, y in SAMPLE_RING]
    with pytest.raises(OffGrid):
        cell_from_ring("GR4_X", None, swapped)


# ---- WFS(GML) 해석 ---------------------------------------------------------------------------------------------------


def test_parse_verified_feature():
    r = parse_wfs(FIX.read_bytes(), "GR4_F2K41_C3")
    assert r.kind == "found"
    assert r.cell == Cell("GR4_F2K41_C3", 37.45, 126.6, 37.475, 126.625, 167305)  # 실제 응답의 gid


def test_zero_features_is_not_found():
    body = (
        b'<?xml version="1.0" encoding="UTF-8"?><wfs:FeatureCollection xmlns:wfs="http://www.opengis.net/wfs" '
        b'xmlns:gml="http://www.opengis.net/gml" numberOfFeatures="0"></wfs:FeatureCollection>'
    )
    r = parse_wfs(body, "GR4_NOPE")
    assert r.kind == "not_found" and r.cell is None


def test_feature_for_another_grid_is_an_error_not_a_cell():
    with pytest.raises(WfsError, match="grid_no mismatch"):
        parse_wfs(FIX.read_bytes(), "GR4_F2K41_C4")


def test_off_grid_geometry_is_quarantined():
    text = FIX.read_text().replace("920421.56066741 1942133.04361461 922632", "920471.56066741 1942133.04361461 922632")
    text = text.replace("920395.05845389 1939359.4053201 920421.56066741", "920395.05845389 1939359.4053201 920471.56066741")
    r = parse_wfs(text.encode(), "GR4_F2K41_C3")
    assert r.kind == "off_grid" and r.cell is None and "off the 0.025" in (r.detail or "")


def test_unexpected_srs_name_is_an_error():
    body = (
        FIX.read_text()
        .replace('srsName="http://www.opengis.net/gml/srs/epsg.xml#5179"', 'srsName="urn:ogc:def:crs:EPSG::5179"')
        .encode()
    )
    with pytest.raises(WfsError, match="srsName"):
        parse_wfs(body, "GR4_F2K41_C3")


def test_missing_srs_name_is_an_error():
    body = FIX.read_text().replace(' srsName="http://www.opengis.net/gml/srs/epsg.xml#5179"', "").encode()
    with pytest.raises(WfsError, match="srsName"):
        parse_wfs(body, "GR4_F2K41_C3")


def test_two_polygons_are_quarantined():
    text = FIX.read_text()
    member = text[text.index("<gml:surfaceMember>") : text.index("</gml:surfaceMember>") + len("</gml:surfaceMember>")]
    r = parse_wfs(text.replace(member, member + member).encode(), "GR4_F2K41_C3")
    assert r.kind == "off_grid" and "polygon" in (r.detail or "")


def test_odd_or_non_numeric_pos_list_is_an_error():
    for bad in ("920421.56066741 1942133.04361461 922632.11858739", "920421.5 abc 1 2 3 4 5 6 7 8"):
        text = FIX.read_text()
        start = text.index("<gml:posList>") + len("<gml:posList>")
        end = text.index("</gml:posList>")
        with pytest.raises(WfsError, match="posList"):
            parse_wfs((text[:start] + bad + text[end:]).encode(), "GR4_F2K41_C3")


def test_service_exception_report_is_an_error_with_its_text():
    body = (
        b'<?xml version="1.0" ?><ServiceExceptionReport version="1.2.0"><ServiceException code="InvalidParameterValue">'
        b"Illegal property name</ServiceException></ServiceExceptionReport>"
    )
    with pytest.raises(WfsError, match="InvalidParameterValue.*Illegal property name"):
        parse_wfs(body, "GR4_F2K41_C3")


def test_ows_exception_report_is_an_error():
    body = (
        b'<ows:ExceptionReport xmlns:ows="http://www.opengis.net/ows"><ows:Exception exceptionCode="NoApplicableCode">'
        b"<ows:ExceptionText>boom</ows:ExceptionText></ows:Exception></ows:ExceptionReport>"
    )
    with pytest.raises(WfsError, match="NoApplicableCode.*boom"):
        parse_wfs(body, "GR4_F2K41_C3")


def test_portal_gateway_error_is_an_error_with_reason_code():
    body = (
        b"<OpenAPI_ServiceResponse><cmmMsgHeader><errMsg>SERVICE ERROR</errMsg>"
        b"<returnAuthMsg>SERVICE_KEY_IS_NOT_REGISTERED_ERROR</returnAuthMsg><returnReasonCode>30</returnReasonCode>"
        b"</cmmMsgHeader></OpenAPI_ServiceResponse>"
    )
    with pytest.raises(WfsError, match="SERVICE_KEY_IS_NOT_REGISTERED_ERROR.*30"):
        parse_wfs(body, "GR4_F2K41_C3")


@pytest.mark.parametrize(
    "body",
    [b"", b"   ", b"<html><head><title>404 Not Found</title></head></html>", b'{"error":"x"}', b"not xml at all", b"<a><b></a>"],
)
def test_empty_or_non_gml_bodies_are_errors(body):
    with pytest.raises(WfsError):
        parse_wfs(body, "GR4_F2K41_C3")


def test_doctype_and_entities_are_refused_before_parsing():
    body = b'<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "aaaa">]><wfs:FeatureCollection numberOfFeatures="0"/>'
    with pytest.raises(WfsError, match="DOCTYPE"):
        parse_wfs(body, "GR4_F2K41_C3")


def test_oversized_body_is_refused():
    with pytest.raises(WfsError, match="too large"):
        parse_wfs(b"<a>" + b" " * (300 * 1024) + b"</a>", "GR4_F2K41_C3")


def test_bad_gid_is_unknown_not_invented():
    body = FIX.read_text().replace("<ofbd-DB:gid>167305</ofbd-DB:gid>", "<ofbd-DB:gid>x1</ofbd-DB:gid>").encode()
    r = parse_wfs(body, "GR4_F2K41_C3")
    assert r.kind == "found" and r.cell is not None and r.cell.gid is None


# ---- 아는 칸 지도의 메모리(ADR-023 2026-10-01 bbox 개정) -------------------------------------------------------------------------
# bbox 타일은 한 번에 수백 칸을 준다 — 아는 칸이 스냅샷 크기(수천)가 아니라 연안 전체(시뮬레이션 약 10만)로 는다. 수집기 한도는 512 MiB 다.


def test_snapped_lattice_values_are_shared_objects():
    """같은 격자점은 같은 float 객체 하나 — 칸 10만 개가 위도 · 경도 값 수백 개를 나눠 쓴다(칸마다 float 넷을 새로 만들지 않는다)."""
    a, b = snap(37.45), snap(37.4500000004)
    assert a == b == 37.45 and a is b
    assert snap(126.6) is snap(126.5999999996)


def test_the_known_cell_map_stays_compact_at_100k_cells():
    """잰 값(tracemalloc, 이 시험의 합성 칸): 고치기 전 약 254 B/칸(10만 칸 25 MB) — Cell 이 __dict__ 를 갖고 칸마다 float 넷을 새로 만들었다.
    slots + 격자점 float 공유로 약 120 B/칸. 상한 160 B/칸은 그 사이에 둔다(파이썬 판 차이 여유)."""
    import gc
    import tracemalloc

    from wakeline_collector.jobs.traffic_grid import GridGeometry

    rows = []
    for i in range(20_000):
        la, lo = 32.0 + (i // 250) * 0.025, 124.0 + (i % 250) * 0.025
        rows.append((f"GR4_S{i:06d}", la, lo, la + 0.025, lo + 0.025, 100_000 + i))
    gc.collect()
    tracemalloc.start()
    try:
        g = GridGeometry()
        ok, bad = g.load_cells(rows)
        used, _peak = tracemalloc.get_traced_memory()
    finally:
        tracemalloc.stop()
    assert (ok, bad) == (20_000, 0)
    assert used / ok < 160, f"{used / ok:.0f} B per known cell"
    c = g.cells["GR4_S000000"]
    assert not hasattr(c, "__dict__")
    assert c.lat_max is g.cells["GR4_S000250"].lat_min  # 이웃 칸의 경계 값도 같은 객체
