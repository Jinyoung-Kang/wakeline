import json
from datetime import UTC, datetime

from shapely.geometry import shape

from skywx_collector.sigmet_parse import build_geometry, parse_airsigmet, parse_isigmet

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


def test_base_null_is_surface_top_null_is_unbounded():
    s = parse_isigmet(_item(base=None, top=None), NOW)
    assert s is not None and s.base_ft == 0 and s.top_ft is None


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
