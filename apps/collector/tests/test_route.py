"""노선 캐시 값(계약 v4 §A) — adsbdb 응답 검증·정리. 합성 자료만 쓴다(tests/adsbdb_synthetic.py)."""

from __future__ import annotations

from datetime import UTC, datetime

import orjson
import pytest
from adsbdb_synthetic import AIRPORT_A, UNKNOWN, body, flightroute

from wakeline_collector import route
from wakeline_collector.route import (
    RouteParseError,
    clean_text,
    from_adsbdb,
    normalize_callsign,
    parse_airline,
    parse_airport,
    route_key,
)

AT = datetime(2026, 9, 28, 3, 21, 5, 123456, tzinfo=UTC)


@pytest.mark.parametrize(
    ("raw", "want"),
    [
        ("ZZX123", "ZZX123"),
        ("  zzx123 ", "ZZX123"),
        ("ABC", "ABC"),
        ("ABCDEFGH", "ABCDEFGH"),
        ("AB", None),  # 3자 미만
        ("ABCDEFGHI", None),  # 8자 초과
        ("ZZX-12", None),
        ("ZZX 12", None),
        ("", None),
        ("   ", None),
        (None, None),
        (123456, None),
        ("zzxı12", None),  # ASCII 가 아니면 대문자 변환으로 모양이 바뀌지 않게 거절
        ("ZZX12\n", "ZZX12"),  # 앞뒤 공백(개행 포함)은 trim
    ],
)
def test_normalize_callsign(raw, want):
    assert normalize_callsign(raw) == want


def test_route_key_only_for_valid_callsign():
    assert route_key("ZZX123") == "wakeline:route:ZZX123"
    for bad in ("zzx123", "ZZ", "ZZX:*", "ZZX123 "):
        with pytest.raises(ValueError):
            route_key(bad)


def test_clean_text_strips_control_and_format_chars_and_truncates():
    assert clean_text("Synthetic\x00 Field‮​  Alpha\t\n", 120) == "Synthetic Field Alpha"
    assert clean_text("x" * 200, 120) == "x" * 120
    assert clean_text("ab cd", 3) == "ab"  # 자른 뒤 끝 공백 제거
    assert clean_text("\x01\x02", 10) is None and clean_text(None, 10) is None and clean_text(5, 10) is None


def test_found_maps_documented_fields():
    v = from_adsbdb(200, body(flightroute("ZZX123", midpoint=True)), "ZZX123", AT)
    assert v.status == "found" and v.callsign == "ZZX123" and v.fetched_at == AT
    assert v.airline is not None and v.airline.model_dump() == {"name": "Synthetic Air", "icao": "ZZX", "iata": "Z9"}
    assert v.origin is not None and v.origin.model_dump() == {
        "icao": "ZZAA",
        "iata": "ZZA",
        "name": "Synthetic Field Alpha",
        "city": "Alpha Town",
        "country": "Testland",
        "country_iso": "ZZ",
        "lat": 10.5,
        "lon": 20.25,
    }
    assert v.destination is not None and v.destination.icao == "ZZBB" and v.destination.lon == 150.125
    assert v.midpoint is not None and v.midpoint.icao == "ZZCC"


def test_cache_value_json_shape():
    d = orjson.loads(from_adsbdb(200, body(flightroute()), "ZZX123", AT).to_json())
    assert list(d) == ["v", "status", "callsign", "fetched_at", "airline", "origin", "destination", "midpoint"]
    assert d["v"] == 1 and d["fetched_at"] == "2026-09-28T03:21:05.123Z" and d["midpoint"] is None
    assert set(d["origin"]) == {"icao", "iata", "name", "city", "country", "country_iso", "lat", "lon"}
    assert "elevation" not in d["origin"] and "country" not in d["airline"]  # 계약 밖 항목은 싣지 않는다
    e = orjson.loads(route.error("ZZX123", AT).to_json())
    assert e == {
        "v": 1,
        "status": "error",
        "callsign": "ZZX123",
        "fetched_at": "2026-09-28T03:21:05.123Z",
        "airline": None,
        "origin": None,
        "destination": None,
        "midpoint": None,
    }
    assert route.error("ZZX123").ttl_s == 120 and route.not_found("ZZX123", AT).ttl_s == 1800


@pytest.mark.parametrize("status", [200, 404])
def test_unknown_callsign_is_not_found(status):
    v = from_adsbdb(status, body(UNKNOWN), "ZZX123", AT)
    assert v.status == "not_found" and v.origin is None and v.destination is None and v.airline is None
    assert from_adsbdb(status, body({"response": " Unknown Callsign "}), "ZZX123", AT).status == "not_found"


@pytest.mark.parametrize(
    "patch",
    [
        {"icao_code": "ZZ"},  # ICAO 4자 아님
        {"icao_code": None},
        {"icao_code": "ZZ-A"},
        {"name": None},
        {"name": "\x00\x01"},  # 정리하면 빈 문자열
        {"latitude": 91.0},
        {"longitude": -180.5},
        {"latitude": "10.5"},  # 문자열 좌표는 읽지 않는다
        {"latitude": True},
        {"longitude": None},
    ],
)
def test_invalid_airport_is_null(patch):
    assert parse_airport({**AIRPORT_A, **patch}) is None
    v = from_adsbdb(200, body(flightroute(origin={**AIRPORT_A, **patch})), "ZZX123", AT)
    assert v.status == "found" and v.origin is None and v.destination is not None  # 한쪽만 있어도 found


def test_non_finite_coordinate_is_null():
    assert parse_airport({**AIRPORT_A, "latitude": float("nan")}) is None
    assert parse_airport({**AIRPORT_A, "longitude": float("inf")}) is None
    assert parse_airport("ZZAA") is None and parse_airport(None) is None


def test_invalid_optional_airport_fields_become_null_only_that_field():
    a = parse_airport(
        {
            **AIRPORT_A,
            "iata_code": "ZZAB",  # 3자 아님
            "country_iso_name": "ZZZ",  # 2자 아님
            "municipality": "",
            "country_name": None,
            "icao_code": " zzaa ",  # trim·대문자
            "name": "N" * 300,
            "latitude": 10,  # 정수 좌표도 숫자
        }
    )
    assert a is not None
    assert (a.icao, a.iata, a.country_iso, a.city, a.country, len(a.name), a.lat) == ("ZZAA", None, None, None, None, 120, 10.0)
    b = parse_airport({**AIRPORT_A, "municipality": "M" * 200, "country_name": "C" * 200, "iata_code": "zza"})
    assert b is not None and len(b.city or "") == 80 and len(b.country or "") == 80 and b.iata == "ZZA"


def test_neither_origin_nor_destination_is_not_found():
    doc = flightroute(origin={**AIRPORT_A, "icao_code": "X"}, destination=None, midpoint=None)
    doc["response"]["flightroute"]["midpoint"] = AIRPORT_A  # 경유만 있어도 노선이 아니다
    v = from_adsbdb(200, body(doc), "ZZX123", AT)
    assert v.status == "not_found" and v.airline is None and v.midpoint is None


def test_airline_rules():
    assert parse_airline(None) is None and parse_airline("Synthetic Air") is None
    assert parse_airline({"name": None, "icao": "ZZX", "iata": "Z9"}) is None  # 이름 없이 코드로 채우지 않는다
    a = parse_airline({"name": " Synthetic\u0007 Air ", "icao": "zzxx", "iata": "Z99"})
    assert a is not None and a.model_dump() == {"name": "Synthetic Air", "icao": None, "iata": None}
    v = from_adsbdb(200, body(flightroute(airline=None)), "ZZX123", AT)
    assert v.status == "found" and v.airline is None


@pytest.mark.parametrize(
    ("status", "raw"),
    [
        (200, b"<html>Synthetic Field Alpha</html>"),  # JSON 아님
        (200, body({"response": {"flightroute": "Synthetic Field Alpha"}})),
        (200, body({"response": {}})),
        (200, body(["Synthetic Field Alpha"])),
        (200, body({"response": "something else"})),
        (500, body(flightroute())),  # 200 이 아닌데 노선 모양
    ],
)
def test_unexpected_shape_is_error_without_content_in_message(status, raw):
    with pytest.raises(RouteParseError) as ei:
        from_adsbdb(status, raw, "ZZX123", AT)
    assert "Synthetic" not in str(ei.value)  # 예외(→ 로그)에 응답 내용이 없다


def test_is_unknown_callsign_body():
    assert route.is_unknown_callsign_body(b'{"response":"unknown callsign"}')
    assert not route.is_unknown_callsign_body('{"response":"unknown callsign"')  # 잘린 본문
    assert not route.is_unknown_callsign_body(b'{"response":"not found"}') and not route.is_unknown_callsign(None)
