from datetime import UTC, datetime

from wakeline_collector.sigmet_parse import parse_isigmet

ITEM = {
    "icaoId": "RKSI",
    "firId": "RKRR",
    "validTimeFrom": 1790481600,
    "validTimeTo": 1790496000,
    "seriesId": "F02",
    "hazard": "ICE",
    "geom": "AREA",
    "coords": [{"lon": 126, "lat": 35}, {"lon": 128, "lat": 35}, {"lon": 128, "lat": 37}],
    "rawSigmet": "RAW",
}


def test_provider_defaults_to_awc_and_can_be_fixture():
    now = datetime(2026, 9, 27, tzinfo=UTC)
    assert parse_isigmet(ITEM, now).provider == "awc_isigmet"
    assert parse_isigmet(ITEM, now, "fixture").provider == "fixture"
