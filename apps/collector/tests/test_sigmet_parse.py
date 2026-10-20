import json
from datetime import UTC, datetime

import pytest
from shapely.geometry import Point, shape

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


def _all_lons(geom):
    return [x for poly in geom["coordinates"] for ring in poly for x, _ in ring]


def test_ring_already_unwrapped_past_180_is_normalized_and_split():
    # 실수신(2026-09-29, UHMM Magadan FIR): AWC 가 날짜변경선을 넘는 링을 이어진 경도(179 → 184 → 191)로 보냈다.
    # 점 사이 점프가 180 을 넘지 않아 전에는 분할되지 않고 경도 > 180 그대로 나갔다 — api 판정(경도 −180..180 의 항공기)에서
    # 180° 동쪽 부분이 빠지고, 웹 WS 검증기가 이 경보를 통째로 버렸다.
    ring = [{"lon": 176, "lat": 60}, {"lon": 191, "lat": 60}, {"lon": 191, "lat": 66}, {"lon": 176, "lat": 66}]
    geom, reason = build_geometry({"geom": "AREA", "coords": ring})
    assert reason is None
    lons = _all_lons(geom)
    assert min(lons) >= -180 and max(lons) <= 180
    g = shape(geom)
    assert len(geom["coordinates"]) == 2 and abs(g.area - 90.0) < 1e-6
    assert g.contains(Point(-175, 63)) and g.contains(Point(178, 63))


def test_ring_entirely_past_180_or_below_minus_180_is_shifted_back():
    east, reason = build_geometry(
        {
            "geom": "AREA",
            "coords": [{"lon": 185, "lat": 10}, {"lon": 190, "lat": 10}, {"lon": 190, "lat": 20}, {"lon": 185, "lat": 20}],
        }
    )
    assert reason is None and shape(east).bounds == (-175.0, 10.0, -170.0, 20.0)
    west, reason = build_geometry(
        {
            "geom": "AREA",
            "coords": [{"lon": -185, "lat": 10}, {"lon": -175, "lat": 10}, {"lon": -175, "lat": 20}, {"lon": -185, "lat": 20}],
        }
    )
    assert reason is None
    lons = _all_lons(west)
    assert min(lons) >= -180 and max(lons) <= 180 and len(west["coordinates"]) == 2
    assert abs(shape(west).area - 100.0) < 1e-6 and shape(west).contains(Point(178, 15))


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
    # JSON 상한이 있으면 그 값을 쓴다 — 원문 값으로 바꾸지 않는다(원문이 같은 값의 'TOP ABV' 일 때만 출처가 하한, 아래 시험)
    s2 = parse_isigmet(_item(base=None, top=30000, rawSigmet=raw), NOW)
    assert (s2.top_ft, s2.top_source) == (30000, "json")


def test_json_top_equal_to_raw_abv_is_a_lower_bound():
    """IM-01: AWC 가 'TOP ABV FLnnn' 의 값을 JSON top 으로 그대로 주면 그 상한도 하한이다(DH-4 의 원래 재현 FIMM:A01).
    원문의 어느 'TOP ABV' 값이든 JSON 값과 같으면 하한(V4 SQL 은 첫 'TOP ABV' 값만 본다 — 이 규칙이 하한 쪽으로만 넓다).
    값이 하나인 이 경우는 MigrationDbTest 와 같다 — ABV_JSON → 하한, ABV_OTHER(값이 다름) · TOPS · TOP FLnnn → json 그대로."""
    abv = "EMBD TS OBS WI AREA TOP ABV FL390 MOV E 05KT NC="
    s = parse_isigmet(_item(base=None, top=39000, rawSigmet=abv), NOW)
    assert (s.top_ft, s.top_source, s.band_note) == (39000, "raw_text_lower_bound", None)
    s = parse_isigmet(_item(base=None, top=38000, rawSigmet="FRQ TS FCST TOP ABV\nFL380 STNR="), NOW)
    assert (s.top_ft, s.top_source) == (38000, "raw_text_lower_bound")
    # 값이 다르면 단정하지 않는다 — 발표된 JSON 상한 그대로
    s = parse_isigmet(_item(base=None, top=45000, rawSigmet="TS TOP ABV FL390="), NOW)
    assert (s.top_ft, s.top_source) == (45000, "json")
    s = parse_isigmet(_item(base=None, top=30000, rawSigmet="EMBD TS OBS TOP FL420 MOV W 04KT INTSF="), NOW)
    assert (s.top_ft, s.top_source) == (30000, "json")
    # 'TOP FLnnn'(ABV 없음)이 같은 값이면 발표된 상한 그대로
    s = parse_isigmet(_item(base=None, top=38000, rawSigmet="EMBD TS TOP FL380 MOV NE="), NOW)
    assert (s.top_ft, s.top_source) == (38000, "json")
    # 'TOPS ABV' 는 계약 정규식이 일부러 받지 않는다(미국 대류 SIGMET 형태는 따로 정한다)
    s = parse_isigmet(_item(base=None, top=45000, rawSigmet="SEV TURB TOPS ABV FL450 CB="), NOW)
    assert (s.top_ft, s.top_source) == (45000, "json")


def test_json_top_matching_any_raw_abv_value_is_a_lower_bound():
    """R8: 원문에 TOP 값이 여럿이어도(관측분 · 예보분) JSON top 이 그 가운데 어느 'TOP ABV FLnnn' 값과 같으면 하한이다.
    단일 값 조건을 여기에 쓰면 FL390 을 고정 상한으로 써서 폴리곤 안 FL390 위 항공기를 경보 밖으로 뺀다."""
    obs_abv = "EMBD TS OBS TOP ABV FL390 FCST TOP FL410"
    s = parse_isigmet(_item(base=None, top=39000, rawSigmet=obs_abv), NOW)
    assert (s.top_ft, s.top_source, s.band_note) == (39000, "raw_text_lower_bound", None)
    # JSON 값이 'TOP FLnnn'(ABV 없음) 쪽과 같으면 발표된 상한 그대로
    s = parse_isigmet(_item(base=None, top=41000, rawSigmet=obs_abv), NOW)
    assert (s.top_ft, s.top_source) == (41000, "json")
    # ABV 가 첫 TOP 이 아니어도 같다(V4 SQL 의 첫 'TOP ABV' 일치와도 같은 결과)
    s = parse_isigmet(_item(base=None, top=41000, rawSigmet="EMBD TS OBS TOP FL390 FCST TOP ABV FL410"), NOW)
    assert (s.top_ft, s.top_source) == (41000, "raw_text_lower_bound")
    # JSON 이 null 이면 원문에서 값을 정하는 규칙(하나의 값일 때만)은 그대로 — 여럿이면 추정하지 않는다
    s = parse_isigmet(_item(base=None, top=None, rawSigmet=obs_abv), NOW)
    assert (s.top_ft, s.top_source) == (None, "unknown")


def test_top_abv_and_whitespace_variants():
    s = parse_isigmet(_item(base=None, top=None, rawSigmet="EMBD TS FCST WI ... TOP ABV\nFL380 MOV NE 10KT NC="), NOW)
    assert (s.top_ft, s.top_source) == (38000, "raw_text_lower_bound")  # ABV: 발표값은 상한의 하한(DH-4)
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
    # 원문 'TOP ABV FLnnn' 과 같은 값을 JSON top 으로 준 네 건은 상한의 하한이다(IM-01 — 원문 TOP 값이 하나라 V4 와 같은 결과)
    abv = {
        "GVSC:1:1790480580": 40000,
        "MMID:L2:1790487720": 48000,
        "GOOO:A02:1790490600": 44000,
        "TTZP:2:1790491500": 42000,
    }
    assert {k: (parsed[k].top_ft, parsed[k].top_source) for k in abv} == {k: (v, "raw_text_lower_bound") for k, v in abv.items()}
    assert all(
        p.top_source == "json"
        for p in parsed.values()
        if p.top_ft is not None and p.id not in ("FCCC:B1:1790486220", "UTAA:1:1790491440", *abv)
    )


def test_real_fixture_json_top_equal_to_abv_is_lower_bound(fixtures_dir):
    """실응답 GVSC:1 — JSON top=40000 · 원문 'TOP ABV FL400'. 상한을 FL400 으로 쓰면 폴리곤 안 FL410 항공기가 경보 밖이 된다."""
    items = json.loads((fixtures_dir / "awc_isigmet.json").read_text())
    item = next(it for it in items if it.get("firId") == "GVSC" and it.get("seriesId") == "1")
    assert item["top"] == 40000 and "TOP ABV FL400" in item["rawSigmet"]
    s = parse_isigmet(item, NOW)
    assert (s.top_ft, s.top_source) == (40000, "raw_text_lower_bound")


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


def test_top_abv_is_a_lower_bound_not_a_ceiling():
    from wakeline_collector.sigmet_parse import raw_text_top, resolve_band

    assert raw_text_top("EMBD TS TOP ABV FL390 MOV E") == (39000, True)
    assert raw_text_top("EMBD TS TOP FL390 MOV E") == (39000, False)
    assert raw_text_top("TOP FL380 ... TOP FL400") is None  # 서로 다른 값 — 추정하지 않는다
    _, _, top, src, _ = resolve_band(None, None, "SEV TURB TOP ABV FL390")
    assert (top, src) == (39000, "raw_text_lower_bound")
    _, _, top, src, _ = resolve_band(None, None, "SEV TURB TOP FL390")
    assert (top, src) == (39000, "raw_text")


# 실수신 2026-09-30 23:07 UTC(awc_isigmet). 원천 JSON 은 72 h 보관이 지나 없어, 로컬 DB 에 저장된 행(id NFFF:15:0)에서 되살렸다 — id 끝의
# 0 = int(valid_from.timestamp()) 이므로 AWC 가 validTimeFrom 을 0 으로 줬다. 원문은 30일에 내면서 9월에 없는 31일을 유효 시작으로 적었다.
NFFF_RAW = (
    "WSFJ03 NFFN 302100\n"
    "NFFF SIGMET 15 VALID 312345/010345 NFFN-\n"
    "NFFF NADI FIR SEV TURB FCST WI S1736 E16300 - S2106 E17154 - S2500\n"
    "E17954 - S2500 E17124 - S2324 E16600 - S2036 E16300 - S1736 E16300\n"
    "FL400/280 MOV E 15KT NC="
)
NFFF_FETCHED = datetime(2026, 9, 30, 23, 7, 38, tzinfo=UTC)


def _nfff(**kw):
    item = {
        "icaoId": "NFFN",
        "firId": "NFFF",
        "firName": "NFFF NADI",
        "validTimeFrom": 0,
        "validTimeTo": 1790826300,  # 2026-10-01 03:45 UTC = 원문 010345
        "seriesId": "15",
        "hazard": "TURB",
        "qualifier": "SEV",
        "base": 40000,
        "top": None,
        "geom": "AREA",
        "coords": [
            {"lon": 163, "lat": -17.6},
            {"lon": 171.9, "lat": -21.1},
            {"lon": 179.9, "lat": -25},
            {"lon": 171.4, "lat": -25},
            {"lon": 166, "lat": -23.4},
            {"lon": 163, "lat": -20.6},
            {"lon": 163, "lat": -17.6},
        ],
        "dir": "E",
        "spd": "15",
        "chng": "NC",
        "rawSigmet": NFFF_RAW,
    }
    item.update(kw)
    return item


def test_awc_zero_valid_from_is_rejected_not_stored_as_1970():
    """validTimeFrom 0 은 '시각 없음'이지 1970-01-01 이 아니다. 1970 으로 받으면 api 일 통계 따라잡기가 그날까지 거꾸로 센다(VERIFICATION #155)."""
    with pytest.raises(ValueError, match="validTimeFrom"):
        parse_isigmet(_nfff(), NFFF_FETCHED)


@pytest.mark.parametrize(
    ("vf", "vt", "why"),
    [
        (-60, 1790826300, "validTimeFrom"),  # 음수 = 1970 이전
        (1790826300, 0, "validTimeTo"),
        (1790826300 - 25 * 3600, 1790826300, "longer than"),  # 유효 25 h — 가장 긴 SIGMET(VA · TC 6 h)보다 훨씬 길다
        (1790826300, 1790826300, "not after"),
    ],
)
def test_implausible_validity_is_rejected_with_reason(vf, vt, why):
    with pytest.raises(ValueError, match=why):
        parse_isigmet(_nfff(validTimeFrom=vf, validTimeTo=vt), NFFF_FETCHED)


def test_validity_up_to_24h_and_missing_fields_keep_their_rules():
    s = parse_isigmet(_nfff(validTimeFrom=1790826300 - 24 * 3600), NFFF_FETCHED)
    assert s is not None and s.id == f"NFFF:15:{1790826300 - 24 * 3600}"
    assert parse_isigmet(_nfff(validTimeFrom=None), NFFF_FETCHED) is None  # 빠진 값은 전처럼 받지 않는다(조용히)
    assert parse_isigmet(_nfff(hazard=None), NFFF_FETCHED) is None


def test_airsigmet_zero_valid_from_is_rejected():
    item = {
        "icaoId": "KKCI",
        "seriesId": "12C",
        "hazard": "CONVECTIVE",
        "validTimeFrom": 0,
        "validTimeTo": 1790826300,
        "coords": [{"lon": -100, "lat": 35}, {"lon": -99, "lat": 35}, {"lon": -99, "lat": 36}],
        "rawAirSigmet": "RAW",
    }
    with pytest.raises(ValueError, match="validTimeFrom"):
        parse_airsigmet(item, NFFF_FETCHED)


# 원문 고도대 "A/B" 가 JSON 고도대보다 넓은 실수신(2026-09-27–10-20 로컬 DB 12,209행 중 11행, VERIFICATION #156). 원천 JSON 은 72 h 보관이
# 지나 없어 저장된 행에서 되살렸다(JSON base/top = 저장값 — 출처가 json 인 쪽만 JSON 값을 안다). AWC 는 오류 없이 좁은 값을 줬고, 그 사이의
# 항공기가 경보 밖이었다. fixtures/awc_isigmet.json 의 고도대 50건은 모두 원문과 같다.
UAAA_RAW = "WSKZ31 UAAA 291524\nUAAA SIGMET 1 VALID 291524/291630 UAAA-\nUAAA ALMATY FIR SEV TURB OBS S OF N44 SFC/10000FT MOV NE 40KMH NC="
SKED_RAW = (
    "WVCO31 SKBO 291530\nSKED SIGMET 3 VALID 291530/292115 SKBO-\nSKED BOGOTA FIR VA MT VOLCAN PURACE PSN N0219 W07624 POSS VA CLD OBS\n"
    "AT 1458Z WI N0219 W07641 - N0219 W07623 - N0218 W07623 - N0211 W07640\n- N0219 W07641 SFC/17000FT MOV W 10KT="
)
SPIM_RAW = (
    "WSPR31 SPIM 291541\nSPIM SIGMET A8 VALID 291541/291900 SPJC-\nSPIM LIMA FIR SEV ICE FCST S OF LINE S1801 W07258 -\n"
    "S1457 W07411 - S1303 W07044 - S1419 W06923\nTOP FL230/250 STNR NC="
)
WAAF_RAW = (
    "WVID21 WAAA 282240\nWAAF SIGMET 14 VALID 282240/290440 WAAA-\nWAAF UJUNG PANDANG  FIR VA\n"
    "ERUPTION MT DUKONO PSN N0142 E12754 VA CLD OBS AT 2220Z WI N0135\n"
    "E12752 - N0148 E12747 - N0203 E12751 - N0200 E12812 - N0137 E12815 -\n"
    "N0135 E12752 SFC/FL070 MOV NE 05KT NC AND OBS AT 2220Z WI N0144\n"
    "E12755 - N0140 E12755 - N0138 E12742 - N0146 E12742 - N0144 E12755\nSFC/FL120 MOV W 10KT NC="
)
UDDD_RAW = "WSAY31 UDYZ 182031\nUDDD SIGMET 1 VALID 182040/182340 UDYZ-\nUDDD YEREVAN FIR SEV TURB FCST N OF N3945 TOP FL320/370\nSTNR NC="
SGFA_RAW = (
    "WSPY31 SGAS 191210\nSGFA SIGMET 01 VALID 191210/191510 SGAS-\n"
    "SGFA ASUNCION FIR SEV TURB FCST AT 1200Z S OF S2522 TOP FL240/300 MOV\n E 05KT NC="
)
LPPO_RAW = (
    "WSAZ31 LPMG 272144\nLPPO SIGMET U07 VALID 272200/280200 LPPT-\n"
    "LPPO SANTA MARIA OCEANIC FIR SEV TURB FCST WI N3832 W01930 - N45\n"
    "W02413 - N45 W01858 - N4459 W01737 - N3938 W01556 - N3832 W01930\nFL450/250 MOV ENE 20KT WKN="
)
SCEZ_RAW = (
    "WSCH31 SCEL 030404\nSCEZ SIGMET C1 VALID 030404/030804 SCEL-\n"
    "SCEZ SANTIAGO FIR SEV TURB OBS AT 0314Z E OF LINE S3430 W07040 - \nS3545 W07045 FL360/300 STNR NC="
)


@pytest.mark.parametrize(
    ("base", "top", "raw", "want_top"),
    [
        (0, 100, UAAA_RAW, 10000),  # 5자리 ft 를 AWC 가 100 배 작게 — 판정은 0–100 ft 였다
        (0, 170, SKED_RAW, 17000),  # 화산재
        (None, 23000, SPIM_RAW, 25000),  # 'TOP FL230/250' 의 앞 값만
        # 구역 둘 · 고도대 둘(SFC/FL070 · SFC/FL120) 중 첫째만 — 경보는 구역 둘을 한 다각형으로 판정한다
        (0, 7000, WAAF_RAW, 12000),
    ],
)
def test_json_top_below_raw_band_is_widened_to_the_raw_value(base, top, raw, want_top):
    """원문에 고도대가 적혀 있고 그 상한이 JSON 상한보다 높으면 원문 값으로 넓힌다(출처 raw_text · 품질 기록). 좁히지는 않는다."""
    s = parse_isigmet(_item(base=base, top=top, rawSigmet=raw), NOW)
    assert (s.top_ft, s.top_source, s.band_note) == (want_top, "raw_text", "top_below_raw_band")
    assert s.base_ft == (base or 0)


@pytest.mark.parametrize(("raw", "want_top"), [(UDDD_RAW, 37000), (SGFA_RAW, 30000)])
def test_raw_top_range_is_not_read_as_its_first_value(raw, want_top):
    """'TOP FL320/370' 은 상한이 FL320–370 — 앞 값(FL320)만 읽으면 FL320–370 항공기를 뺀다(예전 _TOP_RE 는 '/' 앞에서 멈췄다)."""
    from wakeline_collector.sigmet_parse import raw_text_top

    assert raw_text_top(raw) == (want_top, False)
    s = parse_isigmet(_item(base=None, top=None, rawSigmet=raw), NOW)
    assert (s.base_ft, s.base_source, s.top_ft, s.top_source, s.band_note) == (0, "assumed_surface", want_top, "raw_text", None)


def test_raw_band_never_narrows_or_guesses():
    # 원문 자체가 'SFC/190FT'(실수신 SKED:4:1790886600 — 오타로 보이지만) — JSON 이 원문과 같으면 그대로(고치는 값을 짐작하지 않는다)
    sked4 = "VA CLD OBS AT 2020Z WI N0216 W07623 - N0219 W07622 SFC/190FT MOV WNW 15KT="
    s = parse_isigmet(_item(base=0, top=190, rawSigmet=sked4), NOW)
    assert (s.top_ft, s.top_source, s.band_note) == (190, "json", None)
    # JSON 이 원문보다 넓으면 그대로(좁히지 않는다)
    s = parse_isigmet(_item(base=20000, top=45000, rawSigmet="SEV TURB FCST FL250/350 STNR NC="), NOW)
    assert (s.base_ft, s.base_source, s.top_ft, s.top_source, s.band_note) == (20000, "json", 45000, "json", None)
    # JSON 상한이 없으면(무제한 가정) 고도대 상한으로 채우지 않는다 — 판정을 좁히는 쪽이다
    s = parse_isigmet(_item(base=25000, top=None, rawSigmet="SEV TURB FCST FL250/350 STNR NC="), NOW)
    assert (s.top_ft, s.top_source, s.band_note) == (None, "unknown", None)
    # 'TOP ABV FLnnn' 하한(무제한 가정)도 그대로
    s = parse_isigmet(_item(base=0, top=39000, rawSigmet="EMBD TS SFC/FL300 ... TOP ABV FL390="), NOW)
    assert (s.top_ft, s.top_source) == (39000, "raw_text_lower_bound")
    # 고도대가 아닌 '/'(유효 시간 · 좌표)는 고도대가 아니다
    s = parse_isigmet(_item(base=14000, top=21000, rawSigmet="RKRR SIGMET F02 VALID 270800/271200 RKSI- FL140/210 MOV E="), NOW)
    assert (s.top_ft, s.top_source, s.band_note) == (21000, "json", None)


@pytest.mark.xfail(
    strict=True,
    reason="하한 출처 값이 정해지지 않음 — base_source 'raw_text' 추가(계약 변경) 또는 0 + assumed_surface, 사용자 결정 대기(VERIFICATION #156)",
)
@pytest.mark.parametrize(
    ("base", "raw", "lo", "hi"),
    [(40000, NFFF_RAW, 28000, 40000), (45000, LPPO_RAW, 25000, 45000), (36000, SCEZ_RAW, 30000, 36000)],
)
def test_reversed_raw_band_does_not_drop_aircraft_below_the_json_base(base, raw, lo, hi):
    """원문 'FL400/280'(상한/하한 역순) 에 AWC 가 base=40000 · top=null 을 줬다 — 판정이 FL400 이상만이라 FL280–400 항공기를 경보 밖으로 뺐다.
    어느 하한 출처로 고치든 원문 고도대 전체가 판정 안에 들어야 한다."""
    s = parse_isigmet(_item(base=base, top=None, rawSigmet=raw), NOW)
    assert s.base_ft <= lo and (s.top_ft is None or s.top_ft >= hi) and s.band_note is not None
