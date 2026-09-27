from datetime import UTC, datetime

import pytest

from skywx_collector.flight_category import assess_ceiling, ceiling_from_clouds, flight_category, parse_visibility_sm
from skywx_collector.jobs.weather import metar_row


@pytest.mark.parametrize(
    "ceiling,vis,expected",
    [
        (3001, 5.1, "VFR"),  # 둘 다 VFR 초과 경계
        (3000, 10, "MVFR"),  # 실링 3,000 경계 → MVFR
        (10000, 5, "MVFR"),  # 시정 5 경계 → MVFR
        (1000, 10, "MVFR"),  # 실링 1,000 → MVFR 하한
        (999, 10, "IFR"),  # 실링 < 1,000 → IFR
        (10000, 2.99, "IFR"),  # 시정 < 3 → IFR
        (499, 10, "LIFR"),  # 실링 < 500 → LIFR
        (10000, 0.99, "LIFR"),  # 시정 < 1 → LIFR
    ],
)
def test_boundaries(ceiling, vis, expected):
    assert flight_category(ceiling, vis, "measured") == expected


def test_no_ceiling_uses_visibility_only():
    assert flight_category(None, 10, "none") == "VFR" and flight_category(None, 2, "none") == "IFR"


def test_unknown_inputs_give_no_category():
    # 모르는 값을 VFR 로 채우지 않는다(GAP-16)
    assert flight_category(None, None, "none") is None  # 시정 미상
    assert flight_category(None, 10, "unknown") is None  # 실링 미상
    assert flight_category(None, 10, "measured") is None  # 상태와 값이 모순
    assert flight_category(2000, None, "measured") is None


def test_ceiling_from_clouds_lowest_bkn_ovc():
    assert (
        ceiling_from_clouds([{"cover": "FEW", "base": 1500}, {"cover": "BKN", "base": 3000}, {"cover": "OVC", "base": 2000}])
        == 2000
    )
    assert ceiling_from_clouds([{"cover": "SCT", "base": 1500}]) is None


@pytest.mark.parametrize(
    "clouds,cover,expected",
    [
        ([{"cover": "FEW", "base": 800}, {"cover": "BKN", "base": 2500}], "BKN", (2500, "measured")),
        ([{"cover": "VV", "base": 200}], "VV", (200, "measured")),
        ([{"cover": "OVX", "base": 0}], "OVX", (0, "measured")),
        ([{"cover": "FEW", "base": 3000}, {"cover": "SCT", "base": 20000}], "SCT", (None, "none")),
        ([], "CLR", (None, "none")),  # AWC: CLR/NSC 는 층 목록이 비고 요약 cover 가 CLR
        ([], "CAVOK", (None, "none")),
        ([], None, (None, "unknown")),  # 구름 자료 없음
        (None, None, (None, "unknown")),
        ([], "BKN", (None, "unknown")),  # 요약만 있고 층이 없음 — 모순, 모른다
        # RJDC 실측: FEW008 SCT120 BKN/// — 실링층 높이 미상. '없음' 이 아니다
        (
            [{"cover": "FEW", "base": 800}, {"cover": "SCT", "base": 12000}, {"cover": "BKN", "base": None}],
            "BKN",
            (None, "unknown"),
        ),
        ([{"cover": "BKN", "base": 1200}, {"cover": "OVC"}], "OVC", (None, "unknown")),
        ([{"cover": "///", "base": 1500}], None, (None, "unknown")),  # 운량 미상
    ],
)
def test_assess_ceiling_tristate(clouds, cover, expected):
    assert assess_ceiling(clouds, cover) == expected


def test_visibility_parse():
    assert parse_visibility_sm("6+") == 6.0 and parse_visibility_sm(3.73) == 3.73 and parse_visibility_sm("x") is None
    assert parse_visibility_sm("nan") is None and parse_visibility_sm(-1) is None and parse_visibility_sm(True) is None


def _metar(**kw):
    base = {
        "icaoId": "RJDC",
        "obsTime": 1790485200,
        "lat": 33.9,
        "lon": 131.3,
        "elev": 3,
        "name": "Yamaguchi Ube, YA, JP",
        "visib": "6+",
        "cover": "BKN",
        "clouds": [{"cover": "FEW", "base": 800}, {"cover": "SCT", "base": 12000}, {"cover": "BKN", "base": None}],
        "fltCat": None,
        "rawOb": "METAR RJDC 270900Z 21005KT 9999 FEW008 SCT120 BKN/// 24/23 Q1006",
    }
    base.update(kw)
    return base


NOW = datetime(2026, 9, 27, 9, 5, tzinfo=UTC)


def test_metar_row_unknown_ceiling_and_no_awc_category_stores_null():
    _ap, obs = metar_row(_metar(), "awc", NOW)
    assert obs["ceiling_ft"] is None and obs["ceiling_state"] == "unknown"
    assert obs["flight_cat"] is None and obs["flight_cat_source"] is None


def test_metar_row_awc_category_kept_even_if_ceiling_unknown():
    _ap, obs = metar_row(_metar(fltCat="MVFR"), "awc", NOW)
    assert obs["flight_cat"] == "MVFR" and obs["flight_cat_source"] == "awc" and obs["ceiling_state"] == "unknown"


def test_metar_row_computed_only_when_inputs_known():
    _ap, obs = metar_row(_metar(clouds=[{"cover": "BKN", "base": 800}], cover="BKN", visib=10), "awc", NOW)
    assert (obs["ceiling_ft"], obs["ceiling_state"], obs["flight_cat"], obs["flight_cat_source"]) == (
        800,
        "measured",
        "IFR",
        "computed",
    )
    _ap, obs = metar_row(_metar(clouds=[], cover="CLR", visib="10+"), "awc", NOW)
    assert (obs["ceiling_state"], obs["flight_cat"], obs["flight_cat_source"]) == ("none", "VFR", "computed")
    _ap, obs = metar_row(_metar(clouds=[], cover="CLR", visib=None), "awc", NOW)
    assert obs["flight_cat"] is None and obs["flight_cat_source"] is None


def test_metar_row_invalid_awc_category_not_trusted():
    _ap, obs = metar_row(_metar(fltCat="UNK", clouds=[], cover="CLR", visib=10), "awc", NOW)
    assert obs["flight_cat"] == "VFR" and obs["flight_cat_source"] == "computed"


def test_real_fixture_metar(fixtures_dir):
    import json

    rows = [metar_row(it, "awc", NOW) for it in json.loads((fixtures_dir / "awc_metar_region.json").read_text())]
    states = {r[1]["icao"]: r[1]["ceiling_state"] for r in rows if r}
    assert states["RKSO"] == "none" and states["RJDB"] == "none"  # CLR/NSC
    assert states["RKPK"] == "measured" and states["RKSI"] == "none"  # FEW/SCT 뿐
    assert all(r[1]["flight_cat_source"] == "awc" for r in rows if r)
