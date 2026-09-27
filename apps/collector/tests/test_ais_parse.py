"""AIS 파서: 실수신 fixture(484건, 5개 형식)와 합성 메시지로 형식별 매핑·'값 없음' 표기·검증 규칙을 확인한다."""

from __future__ import annotations

import json
from collections import Counter

import pytest
from test_ais_helpers import T0, T0_EPOCH, dumps, fixture_docs, position, static5, static24

from wakeline_collector.ais.parse import (
    POSITION_CLASS,
    STATIC_FIELDS,
    SUBSCRIBED_TYPES,
    clean_text,
    go_time,
    is_provider_error,
    iso_ms,
    parse_message,
    parse_time_utc,
)


def _body(doc):
    return doc["Message"][doc["MessageType"]]


def test_fixture_all_message_types_parse():
    docs = fixture_docs()
    types = Counter(d["MessageType"] for d in docs)
    assert set(types) == set(SUBSCRIBED_TYPES)  # fixture 에 5개 형식이 모두 있다
    positions = statics = 0
    rejects: Counter[str] = Counter()
    for d in docs:
        p = parse_message(dumps(d))
        if p.reject:
            rejects[p.reject] += 1
        positions += p.position is not None
        statics += p.static is not None
        if d["MessageType"] in POSITION_CLASS:
            assert p.position is not None, d
            assert p.position.cls == POSITION_CLASS[d["MessageType"]]
            assert p.position.msg_type == d["MessageType"]
            assert p.position.seen_at.endswith("Z") and len(p.position.mmsi) == 9
    assert not rejects, rejects  # fixture 는 모두 유효
    assert positions == types["PositionReport"] + types["StandardClassBPositionReport"] + types["ExtendedClassBPositionReport"]
    assert statics == types["ShipStaticData"] + types["StaticDataReport"] + types["ExtendedClassBPositionReport"]


def test_fixture_sentinels_become_null():
    heading_na = cog_na = rot_na = 0
    for d in fixture_docs():
        b = _body(d)
        p = parse_message(dumps(d))
        if p.position is None:
            continue
        if b.get("TrueHeading") == 511:
            heading_na += 1
            assert p.position.heading_deg is None
        else:
            assert p.position.heading_deg == b["TrueHeading"]
        if b.get("Cog") == 360:
            cog_na += 1
            assert p.position.cog_deg is None
        if b.get("RateOfTurn") == -128:
            rot_na += 1
            assert p.position.rot is None
        elif "RateOfTurn" in b:
            assert p.position.rot == b["RateOfTurn"]
        if d["MessageType"] != "PositionReport":
            assert p.position.nav_status is None and p.position.rot is None
    assert heading_na >= 100 and cog_na >= 20 and rot_na >= 100  # fixture 실측: 150 · 29 · 115


def test_fixture_static_sentinels_become_null():
    seen = Counter()
    for d in fixture_docs():
        if d["MessageType"] != "ShipStaticData":
            continue
        b = _body(d)
        s = parse_message(dumps(d)).static
        assert s is not None and set(s.fields) == set(STATIC_FIELDS)
        eta = b["Eta"]
        if eta["Month"] == 0:
            seen["eta_month"] += 1
            assert s.fields["eta_month"] is None
        if eta["Hour"] == 24:
            seen["eta_hour"] += 1
            assert s.fields["eta_hour"] is None and s.fields["eta_minute"] is None
        if b["ImoNumber"] == 0:
            seen["imo"] += 1
            assert s.fields["imo"] is None
        if b["Type"] == 0:
            seen["type"] += 1
            assert s.fields["ship_type"] is None
        if b["MaximumStaticDraught"] == 0:
            seen["draught"] += 1
            assert s.fields["draught_m"] is None
        if not b["Destination"].strip():
            seen["dest"] += 1
            assert s.fields["destination"] is None
        if b["CallSign"].strip():
            assert s.fields["call_sign"] == b["CallSign"].strip()
        else:
            assert s.fields["call_sign"] is None
    assert all(seen[k] > 0 for k in ("eta_month", "eta_hour", "imo", "type", "draught", "dest")), seen


def test_position_fields_mapping():
    p = parse_message(
        dumps(position(Sog=12.34, Cog=45.67, TrueHeading=44, NavigationalStatus=5, RateOfTurn=-127, Timestamp=10))
    ).position
    assert p is not None
    assert (p.mmsi, p.lat, p.lon, p.sog_kn, p.cog_deg, p.heading_deg, p.nav_status, p.rot) == (
        "440091020",
        37.4,
        126.5,
        12.3,
        45.7,
        44,
        5,
        -127,
    )
    assert p.position_source == "epfs" and p.cls == "A" and p.msg_type == "PositionReport"
    assert p.seen_at == "2026-09-27T16:29:43.949Z" and p.t == pytest.approx(T0_EPOCH, abs=1e-3)


@pytest.mark.parametrize(
    ("ts", "src"),
    [
        (0, "epfs"),
        (59, "epfs"),
        (30.0, "epfs"),
        (60, None),  # 값 없음(기본값) — 출처를 말하지 않는다
        (61, "manual"),
        (62, "estimated"),
        (63, "inoperative"),
        (None, None),  # 필드 없음
        (64, None),
        (-1, None),
        (30.5, None),
        ("30", None),
        (True, None),
    ],
)
def test_position_source_from_timestamp(ts, src):
    doc = position(Timestamp=ts)
    if ts is None:
        _body(doc).pop("Timestamp")
    assert parse_message(dumps(doc)).position.position_source == src


def test_fixture_timestamp_60_reports_have_no_position_source():
    """실수신 fixture 의 Timestamp 60(값 없음) 보고 10건은 null, 0–59 는 epfs(리뷰 #5 · 계약 v3 §B)."""
    got: Counter[bool] = Counter()
    for d in fixture_docs():
        if d["MessageType"] not in POSITION_CLASS:
            continue
        ts = _body(d)["Timestamp"]
        src = parse_message(dumps(d)).position.position_source
        assert src == ("epfs" if 0 <= ts <= 59 else None), (ts, src)
        got[ts == 60] += 1
    assert got[True] == 10 and got[False] == 418


@pytest.mark.parametrize(
    ("field", "value", "attr", "expected"),
    [
        ("Sog", 102.3, "sog_kn", None),
        ("Sog", 102.2, "sog_kn", 102.2),
        ("Sog", -1, "sog_kn", None),
        ("Sog", True, "sog_kn", None),  # bool 은 숫자로 보지 않는다
        ("Sog", "5", "sog_kn", None),
        ("Cog", 360, "cog_deg", None),
        ("Cog", 359.94, "cog_deg", 359.9),
        ("TrueHeading", 511, "heading_deg", None),
        ("TrueHeading", 360, "heading_deg", None),
        ("TrueHeading", 0, "heading_deg", 0),
        ("RateOfTurn", -128, "rot", None),
        ("RateOfTurn", 127, "rot", 127),
        ("NavigationalStatus", 15, "nav_status", 15),
        ("NavigationalStatus", 16, "nav_status", None),
    ],
)
def test_position_value_rules(field, value, attr, expected):
    assert getattr(parse_message(dumps(position(**{field: value}))).position, attr) == expected


def test_class_b_has_no_nav_status_or_rot():
    p = parse_message(dumps(position(mtype="StandardClassBPositionReport", NavigationalStatus=3, RateOfTurn=5))).position
    assert p.cls == "B" and p.nav_status is None and p.rot is None


@pytest.mark.parametrize(
    ("lat", "lon", "reject"),
    [
        (91, 126.5, "no_position"),
        (37.0, 181, "no_position"),
        (95.0, 126.5, "position_range"),
        (37.0, -181.5, "position_range"),
        (None, 1, "no_position"),
    ],
)
def test_position_missing_or_out_of_range(lat, lon, reject):
    p = parse_message(dumps(position(Latitude=lat, Longitude=lon)))
    assert p.position is None and p.reject == reject


def test_extended_class_b_without_position_keeps_static():
    doc = position(
        mtype="ExtendedClassBPositionReport",
        Latitude=91,
        Longitude=181,
        Name="MINLIANYU60295",
        Type=30,
        Dimension={"A": 35, "B": 15, "C": 4, "D": 3},
    )
    p = parse_message(dumps(doc))
    assert p.position is None and p.reject == "no_position"
    assert p.static.fields == {"name": "MINLIANYU60295", "ship_type": 30, "dim_a": 35, "dim_b": 15, "dim_c": 4, "dim_d": 3}


@pytest.mark.parametrize(
    "doc",
    [
        position(mmsi=12345678),  # 8자리
        position(mmsi=1234567890),  # 10자리
        position(meta_mmsi=440091021),  # MetaData 와 본문 불일치
        position(mmsi=True),
    ],
)
def test_mmsi_must_be_nine_digits_and_consistent(doc):
    assert parse_message(dumps(doc)).reject == "mmsi"


@pytest.mark.parametrize(
    ("raw", "reject"),
    [
        (b"{not json", "json"),
        (b"[1,2]", "shape"),
        (json.dumps({"MessageType": "PositionReport", "MetaData": {}, "Message": []}).encode(), "shape"),
        (json.dumps({"MessageType": "PositionReport", "MetaData": {}, "Message": {"Other": {}}}).encode(), "shape"),
        (json.dumps({"MessageType": "BaseStationReport", "MetaData": {}, "Message": {"BaseStationReport": {}}}).encode(), "type"),
        (dumps(position(Valid=False)), "invalid_flag"),
        (dumps(position(time_utc="yesterday")), "time"),
        (dumps(position(time_utc="2026-09-27 16:29:43")), "time"),  # 시간대 없음 → 추측하지 않는다
    ],
)
def test_rejects(raw, reject):
    p = parse_message(raw)
    assert p.position is None and p.static is None and p.reject == reject


def test_provider_error_message():
    p = parse_message(b'{"error": "Api Key Is Not Valid"}')
    assert p.reject == "provider_error" and p.error_text == "Api Key Is Not Valid"


def test_static5_mapping_and_cleanup():
    s = parse_message(dumps(static5())).static
    assert s.fields == {
        "name": "HIMAWARI8",
        "call_sign": "JD4188",
        "imo": 9810836,
        "ship_type": 70,
        "dim_a": 47,
        "dim_b": 120,
        "dim_c": 13,
        "dim_d": 14,
        "draught_m": 7.3,
        "destination": "JP TMK E",
        "eta_month": 9,
        "eta_day": 30,
        "eta_hour": 6,
        "eta_minute": 0,
    }
    assert s.mmsi == "431009876" and s.seen_at == "2026-09-27T16:29:43.949Z"


@pytest.mark.parametrize(
    ("body", "field", "expected"),
    [
        ({"Name": "@@@@@@@@@@@@@@@@@@@@"}, "name", None),
        ({"Name": "SEA STAR@@@@@"}, "name", "SEA STAR"),
        ({"Name": "X" * 21}, "name", None),
        ({"CallSign": "@@@@@@@"}, "call_sign", None),
        ({"Destination": "BUSAN\x00\x07"}, "destination", "BUSAN"),
        ({"ImoNumber": 999_999}, "imo", None),  # NAVCEN: 1–999,999 사용 안 함
        ({"ImoNumber": 1_000_000}, "imo", 1_000_000),
        ({"ImoNumber": 10_000_000}, "imo", 10_000_000),  # 기국 공식 번호 범위 — 보고값 그대로
        ({"Type": 100}, "ship_type", None),
        ({"MaximumStaticDraught": 25.6}, "draught_m", None),
        ({"MaximumStaticDraught": 25.5}, "draught_m", 25.5),
        ({"Eta": {"Month": 13, "Day": 0, "Hour": 23, "Minute": 60}}, "eta_month", None),
        ({"Eta": {"Month": 13, "Day": 0, "Hour": 23, "Minute": 60}}, "eta_hour", 23),
        ({"Eta": "x"}, "eta_day", None),
    ],
)
def test_static_value_rules(body, field, expected):
    assert parse_message(dumps(static5(**body))).static.fields[field] == expected


def test_dimensions_all_zero_is_unknown_but_single_zero_is_kept():
    zero = parse_message(dumps(static5(Dimension={"A": 0, "B": 0, "C": 0, "D": 0}))).static.fields
    assert [zero[k] for k in ("dim_a", "dim_b", "dim_c", "dim_d")] == [None] * 4
    part = parse_message(dumps(static5(Dimension={"A": 16, "B": 12, "C": 0, "D": 8}))).static.fields
    assert [part[k] for k in ("dim_a", "dim_b", "dim_c", "dim_d")] == [16, 12, 0, 8]
    bad = parse_message(dumps(static5(Dimension={"A": 600, "B": 12, "C": 1, "D": 8}))).static.fields
    assert bad["dim_a"] is None and bad["dim_b"] == 12
    assert parse_message(dumps(static5(Dimension=None))).static.fields["dim_a"] is None


def test_static_data_report_parts():
    a = parse_message(dumps(static24(part_b=False, name="BLUE HOLE@@@"))).static
    assert a.fields == {"name": "BLUE HOLE"}
    b = parse_message(dumps(static24(part_b=True, CallSign="  ", ShipType=0, Dimension={"A": 8, "B": 3, "C": 2, "D": 1}))).static
    assert b.fields == {"call_sign": None, "ship_type": None, "dim_a": 8, "dim_b": 3, "dim_c": 2, "dim_d": 1}
    invalid = static24(part_b=True)
    invalid["Message"]["StaticDataReport"]["ReportB"]["Valid"] = False
    p = parse_message(dumps(invalid))
    assert p.static is None and p.reject == "part"


def test_static_data_report_b_from_auxiliary_craft_has_no_dimensions():
    """보조 선박(MMSI 98MIDxxxx)의 24B 는 크기 자리(30 bit)에 모선 MMSI 를 싣는다 — 크기로 내보내지 않는다(리뷰 #7).
    예: 모선 440123456 을 9/9/6/6 bit 로 나누면 209/444/1/0 이 되어 크기처럼 보인다."""
    aux = static24(984401234, part_b=True, CallSign="TENDER1", ShipType=50, Dimension={"A": 209, "B": 444, "C": 1, "D": 0})
    f = parse_message(dumps(aux)).static.fields
    assert f == {"call_sign": "TENDER1", "ship_type": 50, "dim_a": None, "dim_b": None, "dim_c": None, "dim_d": None}
    # 보조 선박이 아니면(98 로 시작하지 않음) 그대로 크기다
    ship = static24(440123456, part_b=True, Dimension={"A": 209, "B": 44, "C": 1, "D": 0})
    assert parse_message(dumps(ship)).static.fields["dim_a"] == 209
    # 24A(선명)는 보조 선박이어도 그대로
    assert parse_message(dumps(static24(984401234, part_b=False, name="TENDER"))).static.fields == {"name": "TENDER"}


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        (b'{"error": "Api Key Is Not Valid"}', True),
        ('{"error":"quota"}', True),
        (b'{"error": null}', True),
        (b'  {"error": 1, "detail": "x"}', True),
        (b'{"error": "x", "Message": {}}', False),  # parse_message 와 같은 규칙: Message 가 있으면 데이터
        (b'["error"]', False),
        (b'{"error"', False),  # 깨진 JSON 은 오류 프레임이 아니다(정리 태스크가 json 으로 센다)
        (b"", False),
    ],
)
def test_is_provider_error(raw, expected):
    assert is_provider_error(raw) is expected
    if expected:
        assert parse_message(raw).reject == "provider_error"


def test_is_provider_error_false_for_every_fixture_message():
    assert not [d for d in fixture_docs() if is_provider_error(dumps(d))]


def test_time_parsing_variants():
    iso, t = parse_time_utc(T0)
    assert iso == "2026-09-27T16:29:43.949Z" and t == pytest.approx(T0_EPOCH, abs=1e-3)
    assert parse_time_utc("2026-09-27 16:29:47.60659028 +0000 UTC")[0] == "2026-09-27T16:29:47.606Z"
    assert parse_time_utc("2026-09-27 16:29:47 +0000 UTC")[0] == "2026-09-27T16:29:47.000Z"
    assert parse_time_utc("2026-09-28T01:29:43.949+09:00")[0] == "2026-09-27T16:29:43.949Z"
    assert parse_time_utc("2026-09-27T06:29:43-10:00")[0] == "2026-09-27T16:29:43.000Z"
    assert parse_time_utc("2026-09-27T16:29:43.949Z")[0] == "2026-09-27T16:29:43.949Z"
    for bad in ("2026-02-30 00:00:00 +0000 UTC", "", None, 123, "x" * 100, "2026-09-27 16:29:43"):
        assert parse_time_utc(bad) is None


def test_time_format_roundtrip():
    assert parse_time_utc(go_time(T0_EPOCH))[1] == pytest.approx(T0_EPOCH, abs=1e-6)
    assert iso_ms(0) == "1970-01-01T00:00:00.000Z"


def test_clean_text():
    assert clean_text(" ABC @@ ", 20) == "ABC"
    assert clean_text(5, 20) is None
    assert clean_text("", 20) is None
