import pytest

from skywx_collector.flight_category import ceiling_from_clouds, flight_category, parse_visibility_sm


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
    assert flight_category(ceiling, vis) == expected


def test_no_ceiling_uses_visibility_only():
    assert flight_category(None, 10) == "VFR" and flight_category(None, 2) == "IFR"


def test_ceiling_from_clouds_lowest_bkn_ovc():
    assert (
        ceiling_from_clouds([{"cover": "FEW", "base": 1500}, {"cover": "BKN", "base": 3000}, {"cover": "OVC", "base": 2000}])
        == 2000
    )
    assert ceiling_from_clouds([{"cover": "SCT", "base": 1500}]) is None


def test_visibility_parse():
    assert parse_visibility_sm("6+") == 6.0 and parse_visibility_sm(3.73) == 3.73 and parse_visibility_sm("x") is None
