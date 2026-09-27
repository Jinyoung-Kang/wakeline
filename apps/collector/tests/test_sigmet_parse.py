import json
from datetime import UTC, datetime

from shapely.geometry import shape

from wakeline_collector.sigmet_parse import build_geometry, parse_airsigmet, parse_isigmet

NOW = datetime(2026, 9, 27, 7, 0, tzinfo=UTC)


def _item(**kw):
    base = {
        "icaoId": "RKSI",
        "firId": "RKRR",
        "firName": "RKRR INCHEON",
        "validTimeFrom": 1790481600,
        "validTimeTo": 1790496000,
        "seriesId": "F02",
        "hazard": "ICE",
        "qualifier": "SEV",
        "base": 14000,
        "top": 21000,
        "geom": "AREA",
        "coords": [{"lon": 126, "lat": 35}, {"lon": 128, "lat": 35}, {"lon": 128, "lat": 37}, {"lon": 126, "lat": 37}],
        "rawSigmet": "RAW",
    }
    base.update(kw)
    return base


def test_area_unclosed_ring_is_closed_and_keyed():
    s = parse_isigmet(_item(), NOW)
    assert s is not None and s.id == "RKRR:F02:1790481600" and s.geometry["type"] == "MultiPolygon"
    assert shape(s.geometry).is_valid and s.base_ft == 14000 and s.top_ft == 21000 and s.excluded_reason is None


def test_areas_multiple_rings_and_null_ring_dropped():
    coords = [
        [{"lon": 126, "lat": 35}, {"lon": 128, "lat": 35}, {"lon": 128, "lat": 37}],
        [{"lon": None, "lat": 11.35}],
        [{"lon": 130, "lat": 35}, {"lon": 131, "lat": 35}, {"lon": 131, "lat": 36}, {"lon": 130, "lat": 36}],
    ]
    s = parse_isigmet(_item(geom="AREAS", coords=coords), NOW)
    assert s is not None and s.geometry is not None
    assert len(s.geometry["coordinates"]) == 2


def test_missing_points_ring_excluded():
    s = parse_isigmet(_item(coords=[{"lon": 126, "lat": 35}, {"lon": 128, "lat": 35}]), NOW)
    assert s is not None and s.geometry is None and s.excluded_reason == "line_or_point_geometry"


def test_self_intersecting_ring_repaired():
    bow = [{"lon": 0, "lat": 0}, {"lon": 2, "lat": 2}, {"lon": 2, "lat": 0}, {"lon": 0, "lat": 2}]
    geom, reason = build_geometry({"geom": "AREA", "coords": bow})
    assert reason is None and shape(geom).is_valid and shape(geom).area > 0


def test_antimeridian_split_into_two_parts():
    ring = [{"lon": 175, "lat": 10}, {"lon": -175, "lat": 10}, {"lon": -175, "lat": 20}, {"lon": 175, "lat": 20}]
    geom, reason = build_geometry({"geom": "AREA", "coords": ring})
    assert reason is None
    g = shape(geom)
    assert g.bounds[0] >= -180 and g.bounds[2] <= 180 and len(geom["coordinates"]) == 2
    assert abs(g.area - 100.0) < 1e-6


def test_base_null_is_assumed_surface_and_top_null_is_unknown():
    # 계약 §4: 미발표 하한은 0 + assumed_surface(판정 가정), 미발표 상한은 null + unknown(∞ 로 발표된 것처럼 쓰지 않음)
    s = parse_isigmet(_item(base=None, top=None), NOW)
    assert s is not None and s.base_ft == 0 and s.base_source == "assumed_surface"
    assert s.top_ft is None and s.top_source == "unknown"
    d = s.model_dump(mode="json")
    assert d["base_source"] == "assumed_surface" and d["top_source"] == "unknown" and "band_note" not in d


def test_json_band_marked_json():
    s = parse_isigmet(_item(), NOW)
    assert (s.base_ft, s.base_source, s.top_ft, s.top_source) == (14000, "json", 21000, "json")


def test_top_from_raw_text_only_when_json_top_null():
    raw = "WSCG31 FCBB 270517 FCCC SIGMET B1 VALID ... EMBD TS OBS AT 0500Z WI N0341 E00724 - N0516 E00908 TOP FL420 MOV W 04KT INTSF="
    s = parse_isigmet(_item(base=None, top=None, rawSigmet=raw), NOW)
    assert (s.top_ft, s.top_source, s.base_source) == (42000, "raw_text", "assumed_surface")
    # JSON 상한이 있으면 원문은 보지 않는다
    s2 = parse_isigmet(_item(base=None, top=30000, rawSigmet=raw), NOW)
    assert (s2.top_ft, s2.top_source) == (30000, "json")


def test_top_abv_and_whitespace_variants():
    s = parse_isigmet(_item(base=None, top=None, rawSigmet="EMBD TS FCST WI ... TOP ABV\nFL380 MOV NE 10KT NC="), NOW)
    assert (s.top_ft, s.top_source) == (38000, "raw_text")  # ABV: 발표된 값(상한의 하한)을 그대로
    s = parse_isigmet(_item(base=None, top=None, rawSigmet="FRQ TS TOP  FL350\nSTNR NC="), NOW)
    assert (s.top_ft, s.top_source) == (35000, "raw_text")


def test_top_not_guessed_when_ambiguous_or_absent():
    two = "AREA 1 TOP FL350 ... AREA 2 TOP FL400="
    s = parse_isigmet(_item(base=None, top=None, rawSigmet=two), NOW)
    assert (s.top_ft, s.top_source) == (None, "unknown")  # 서로 다른 값 → 결정할 수 없다
    s = parse_isigmet(_item(base=None, top=None, rawSigmet="SEV TURB FCST ... TOPS ABV FL450 CB="), NOW)
    assert (s.top_ft, s.top_source) == (None, "unknown")  # TOPS 는 계약 정규식이 아니다
    s = parse_isigmet(_item(base=None, top=None, rawSigmet="RAW"), NOW)
    assert (s.top_ft, s.top_source) == (None, "unknown")


def test_invalid_json_top_is_not_widened_or_used():
    s = parse_isigmet(_item(base=25000, top=10000, rawSigmet="RAW"), NOW)
    assert (s.base_ft, s.top_ft, s.top_source, s.band_note) == (25000, None, "unknown", "invalid_top")
    # 원문이 base 이상의 상한을 명시하면 그 값
    s = parse_isigmet(_item(base=25000, top=10000, rawSigmet="SEV ICE FL250/FL300 TOP FL300="), NOW)
    assert (s.top_ft, s.top_source, s.band_note) == (30000, "raw_text", "invalid_top")
    # 원문 상한이 base 보다 낮으면 쓰지 않는다
    s = parse_isigmet(_item(base=25000, top=None, rawSigmet="TOP FL200="), NOW)
    assert (s.top_ft, s.top_source) == (None, "unknown")


def test_ring_over_2000_points_rejected_not_truncated():
    ring = [{"lon": 120 + i * 0.001, "lat": 30 + (i % 2) * 0.01} for i in range(2001)]
    s = parse_isigmet(_item(coords=ring), NOW)
    assert s.geometry is None and s.excluded_reason == "too_many_points"
    ok = [{"lon": 126, "lat": 35}, *[{"lon": 126 + i * 0.001, "lat": 36} for i in range(1, 1999)], {"lon": 126, "lat": 37}]
    assert len(ok) == 2000
    geom, reason = build_geometry({"geom": "AREA", "coords": ok})
    assert reason is None and geom is not None


def test_ring_count_and_total_points_capped():
    sq = [{"lon": 1, "lat": 1}, {"lon": 1.1, "lat": 1}, {"lon": 1.1, "lat": 1.1}]
    geom, reason = build_geometry({"geom": "AREAS", "coords": [sq] * 51})
    assert geom is None and reason == "too_many_rings"
    big = [{"lon": 120 + i * 0.0001, "lat": 30 + (i % 3) * 0.001} for i in range(1500)]
    geom, reason = build_geometry({"geom": "AREAS", "coords": [big] * 7})  # 10,500 점
    assert geom is None and reason == "too_many_points"


def test_airsigmet_band_sources(fixtures_dir):
    items = json.loads((fixtures_dir / "awc_airsigmet.json").read_text())
    s = parse_airsigmet(items[0], NOW)
    assert (s.base_ft, s.base_source, s.top_ft, s.top_source) == (0, "assumed_surface", 45000, "json")


def test_real_fixture_top_null_filled_from_official_text(fixtures_dir):
    items = json.loads((fixtures_dir / "awc_isigmet.json").read_text())
    parsed = {p.id: p for p in (parse_isigmet(it, NOW) for it in items) if p is not None}
    # 실응답 두 건은 JSON top=null 이지만 원문에 TOP FL420 / TOP FL380 이 있다
    assert (parsed["FCCC:B1:1790486220"].top_ft, parsed["FCCC:B1:1790486220"].top_source) == (42000, "raw_text")
    assert (parsed["UTAA:1:1790491440"].top_ft, parsed["UTAA:1:1790491440"].top_source) == (38000, "raw_text")
    assert all(
        p.top_source == "json"
        for p in parsed.values()
        if p.top_ft is not None and p.id not in ("FCCC:B1:1790486220", "UTAA:1:1790491440")
    )


def test_real_fixture_parses(fixtures_dir):
    items = json.loads((fixtures_dir / "awc_isigmet.json").read_text())
    parsed = [parse_isigmet(it, NOW) for it in items]
    ok = [p for p in parsed if p is not None]
    assert len(ok) >= len(items) * 0.95
    with_geom = [p for p in ok if p.geometry is not None]
    assert len(with_geom) >= len(ok) * 0.9
    assert all(shape(p.geometry).is_valid for p in with_geom)


def test_airsigmet_parses(fixtures_dir):
    items = json.loads((fixtures_dir / "awc_airsigmet.json").read_text())
    parsed = [parse_airsigmet(it, NOW) for it in items]
    assert all(p is not None for p in parsed) and parsed[0].provider == "awc_airsigmet"
