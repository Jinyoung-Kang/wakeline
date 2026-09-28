"""tools/rest_contract_check.py 의 계약 v4 교차 검사 규칙이 틀린 응답을 실제로 잡는지(리뷰 후속 — 규칙이 나중에 느슨해지지 않게).
합성 본문만 쓴다(네트워크 없음)."""

from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path

import pytest
from jsonschema import Draft202012Validator

ROOT = Path(__file__).resolve().parents[3]
_spec = importlib.util.spec_from_file_location("rest_contract_check", ROOT / "tools" / "rest_contract_check.py")
assert _spec and _spec.loader
rcc = importlib.util.module_from_spec(_spec)
sys.modules["rest_contract_check"] = rcc
_spec.loader.exec_module(rcc)


def place(**over):
    return {"text": "KR PUS", "locode": "KRPUS", "name": "Busan", "country": "KR", "ambiguous": False, **over}


def test_place_rules():
    assert rcc._place_errors(place()) == []
    assert rcc._place_errors(place(text="KRPUS", ambiguous=True)) == []  # 붙임형만 모호할 수 있다
    assert rcc._place_errors({"text": "ROTTERDAM", "ambiguous": False}) == []  # 풀이 없음
    assert any("country" in e for e in rcc._place_errors(place(country="JP")))
    assert any("yields" in e for e in rcc._place_errors(place(locode="NLRTM", country="NL")))  # 다른 항구를 붙임
    assert any("compact" in e for e in rcc._place_errors(place(ambiguous=True)))  # 공백형인데 모호
    # 스키마: 풀이가 없는데 subdivision 만 있으면 안 된다
    v = Draft202012Validator(rcc.PLACE)
    assert not list(v.iter_errors({"text": "X", "ambiguous": False}))
    assert list(v.iter_errors({"text": "X", "ambiguous": False, "subdivision": "11"}))


def state(callsign):
    return {"hex": "abc123", "callsign": callsign}


@pytest.mark.parametrize(
    ("callsign", "route", "ok"),
    [
        ("KAL017 ", {"status": "found", "callsign": "KAL017"}, True),
        ("KAL017", {"status": "no_callsign"}, False),  # 읽을 수 있는 콜사인을 '없음' 이라 하면 안 된다
        ("ıab12ſ", {"status": "no_callsign"}, True),  # ASCII 가 아니면 콜사인 없음
        ("ıab12ſ", {"status": "pending", "callsign": "IAB12S"}, False),
        ("KAL017", {"status": "found", "callsign": "KAL018"}, False),  # 다른 콜사인의 노선
        ("KAL017", {"status": "disabled", "callsign": "KAL017"}, True),
    ],
)
def test_aircraft_detail_route_follows_the_live_callsign(callsign, route, ok):
    errs = rcc._aircraft_detail({"state": state(callsign), "route": {"source": "adsbdb", **route}})
    assert (errs == []) is ok, errs


def test_recorded_status_needs_the_union_of_every_shard_but_live_status_may_be_a_subset():
    a, b = [[-90.0, -180.0, 90.0, 0.0]], [[-90.0, 45.0, 90.0, 180.0]]
    shards = [{"coverage": a, "connected": True}, {"coverage": b, "connected": False}]
    full = {"sources": {"ais": {"shards": shards, "coverage": a + b}}}
    part = {"sources": {"ais": {"shards": shards, "coverage": a}}}
    assert rcc._status_ais_recorded(full) == []
    assert rcc._status_ais_recorded(part)  # 기록된 표본은 모든 구역을 구독했다 — 빠뜨리면 실패
    assert rcc._status(part) == []  # 실서버는 구독 상태가 보이지 않으므로 부분 합 허용
    assert rcc._status({"sources": {"ais": {"shards": shards, "coverage": [[1.0, 1.0, 2.0, 2.0]]}}})  # 어떤 구역의 합도 아님


META = {"stale": False, "generated_at": "2026-09-28T00:00:00Z", "request_id": "abcdefgh"}


def test_stats_days_are_utc_date_strings_with_an_aggregated_flag():
    """R-45: 통계 day 는 "YYYY-MM-DD" 만, 범위 응답은 날마다 aggregated, 행의 날은 그 범위 안."""
    v = Draft202012Validator(rcc.SCHEMAS["stats_sigmet"], format_checker=rcc.FORMATS)
    ok = {
        "group": "fir",
        "items": [{"day": "2026-09-27", "dim": "RKRR", "value": 3}],
        "days": [{"day": "2026-09-26", "aggregated": False}, {"day": "2026-09-27", "aggregated": True}],
        "meta": META,
    }
    assert not list(v.iter_errors(ok))
    assert rcc._stats_days(ok) == []
    midnight = {**ok, "items": [{"day": "2026-09-27T00:00:00.000Z", "dim": "RKRR", "value": 3}]}
    assert list(v.iter_errors(midnight))  # 자정 시각 문자열(JVM 시간대 의존)은 날짜가 아니다
    assert list(v.iter_errors({**ok, "days": [{"day": "2026-09-27"}]}))  # aggregated 없음
    unordered = [{"day": "2026-09-27", "aggregated": True}, {"day": "2026-09-26", "aggregated": True}]
    assert rcc._stats_days({**ok, "days": unordered})
    holes = [{"day": "2026-09-25", "aggregated": True}, {"day": "2026-09-27", "aggregated": True}]
    assert rcc._stats_days({**ok, "days": holes})
    assert rcc._stats_days({**ok, "days": [{"day": "2026-09-26", "aggregated": True}]})  # 행의 날이 범위 밖
    t = Draft202012Validator(rcc.SCHEMAS["stats_traffic"], format_checker=rcc.FORMATS)
    traffic = {"day": "2026-09-28", "aggregated": False, "items": [], "meta": META}
    assert not list(t.iter_errors(traffic))
    assert list(t.iter_errors({k: x for k, x in traffic.items() if k != "aggregated"}))  # 집계 전인지 알 수 없다
    assert rcc._stats_traffic({**traffic, "items": [{"day": "2026-09-27", "dim": "10", "value": 1}]})


def test_status_radar_kr_carries_only_validated_fields():
    """R-72: /status 의 radar_kr 는 허용 목록(available·status·latest_tm·fetched_at·checked_at)만."""
    v = Draft202012Validator(rcc.SCHEMAS["status"]["properties"]["radar_kr"], format_checker=rcc.FORMATS)
    ok = {"available": True, "status": "200", "latest_tm": "202609281210", "fetched_at": "2026-09-28T03:10:00Z"}
    assert not list(v.iter_errors(ok))
    assert not list(v.iter_errors({}))  # 수집기가 쓴 적 없음 — 모두 모름
    assert list(v.iter_errors({**ok, "grid": '{"nx":1}'}))  # 원본 해시 필드
    assert list(v.iter_errors({**ok, "available": "1"}))  # 문자열 그대로
    assert list(v.iter_errors({**ok, "latest_tm": "12:10"}))


def test_cursor_is_a_number_or_absent():
    """R-74: 다음 쪽이 없으면 next_cursor 는 없음(또는 null) — 빈 문자열은 안 된다."""
    v = Draft202012Validator(rcc.SCHEMAS["alerts_history"], format_checker=rcc.FORMATS)
    base = {"items": [], "meta": META}
    assert not list(v.iter_errors(base))
    assert not list(v.iter_errors({**base, "next_cursor": 1790577316107000}))
    assert not list(v.iter_errors({**base, "next_cursor": None}))
    assert list(v.iter_errors({**base, "next_cursor": ""}))
    assert list(v.iter_errors({**base, "next_cursor": "1790577316107000"}))


def test_aircraft_track_is_capped_and_says_so():
    """R-52: 점 수 상한 5,000 · truncated 필수 · 점 수와 좌표 수가 같다."""
    v = Draft202012Validator(rcc.SCHEMAS["aircraft_track"], format_checker=rcc.FORMATS)
    pts = [{"ts": f"2026-09-28T00:00:0{i}Z", "lat": 36.0, "lon": 127.0} for i in range(3)]
    props = {"hex": "abc123", "from": "2026-09-27T22:00:00Z", "to": "2026-09-28T00:00:00Z", "points": 3, "truncated": False}
    body = {
        "type": "Feature",
        "geometry": {"type": "LineString", "coordinates": [[127.0, 36.0]] * 3},
        "properties": props,
        "points": pts,
        "meta": META,
    }
    assert not list(v.iter_errors(body))
    assert rcc._aircraft_track(body) == []
    assert list(v.iter_errors({**body, "properties": {k: x for k, x in props.items() if k != "truncated"}}))
    assert rcc._aircraft_track({**body, "properties": {**props, "truncated": True}})  # 상한보다 적은데 잘렸다고 함
    assert rcc._aircraft_track({**body, "points": pts[:2]})  # 점 수 불일치
    assert rcc._aircraft_track({**body, "points": list(reversed(pts))})  # 시간순 아님


def test_ship_category_enum_follows_the_shared_order_vector():
    """계약 v5 §B2: 선종 분류 이름·순서의 원본은 schemas/vectors/ship-categories.v1.json(api ShipCategory · web SHIP_CATEGORIES 와 같은 파일)."""
    vector = json.loads((ROOT / "schemas" / "vectors" / "ship-categories.v1.json").read_text())
    assert vector["version"] == 1
    assert rcc.SHIP_CATEGORY["enum"] == vector["order"]


# ---- 선박 검색(계약 v5 §B1) ----


def search_item(**over):
    base = {
        "mmsi": "440123456",
        "name": "HANJIN BUSAN",
        "call_sign": "D7AB",
        "imo": 9321483,
        "ship_type": 70,
        "category": "cargo",
        "live": True,
        "lat": 35.1,
        "lon": 129.1,
        "sog_kn": 12.3,
        "seen_at": "2026-09-29T00:00:10Z",
        "last_position_at": "2026-09-29T00:00:00Z",
    }
    return {**base, **over}


STORED = {  # DB 에만 있는 선박: 위치·속력·보고 시각은 null, 마지막 저장 시각만
    "mmsi": "440123457",
    "name": "HANJIN OLD",
    "live": False,
    "lat": None,
    "lon": None,
    "sog_kn": None,
    "seen_at": None,
    "last_position_at": "2026-09-28T00:00:00Z",
}


def ship_search(q, *items):
    return {"items": list(items), "meta": {**META, "q": q, "count": len(items)}}


def test_ship_search_shape_live_and_stored_items():
    v = Draft202012Validator(rcc.SCHEMAS["ship_search"], format_checker=rcc.FORMATS)
    ok = ship_search("HANJIN", search_item(), search_item(**STORED))
    assert not list(v.iter_errors(ok))
    assert rcc._ship_search(ok) == []
    assert list(v.iter_errors(ship_search("HANJIN", search_item(**{**STORED, "lat": 35.0}))))  # 실시간 아님인데 위치
    assert list(v.iter_errors(ship_search("HANJIN", search_item(**{**STORED, "seen_at": "2026-09-28T00:00:00Z"}))))
    assert list(v.iter_errors(ship_search("HANJIN", search_item(lat=None))))  # 실시간인데 위치 없음
    no_key = search_item()
    del no_key["call_sign"]
    assert list(v.iter_errors(ship_search("HANJIN", no_key)))  # 키는 늘 있다(모르면 null)
    # 분류는 선종 코드에서만: 코드가 없으면 unknown, 있으면 unknown 이 아니다
    assert list(v.iter_errors(ship_search("HANJIN", search_item(ship_type=None))))
    assert not list(v.iter_errors(ship_search("HANJIN", search_item(ship_type=None, category="unknown"))))
    assert list(v.iter_errors(ship_search("HANJIN", search_item(category="unknown"))))
    assert list(v.iter_errors(ship_search("hanjin", search_item())))  # meta.q 는 정규화(대문자)한 값
    assert list(v.iter_errors({**ok, "items": [search_item()] * 21}))  # limit 상한 20


def test_ship_search_cross_rules():
    ok = ship_search("HANJIN", search_item(), search_item(**STORED))
    assert rcc._ship_search(ship_search("HANJIN", search_item(**STORED), search_item()))  # 실시간이 먼저
    assert rcc._ship_search(ship_search("HANJIN", search_item(), search_item()))  # 같은 MMSI 두 번
    assert rcc._ship_search({**ok, "meta": {**ok["meta"], "count": 5}})
    assert rcc._ship_search(ship_search("BUSAN", search_item()))  # 앞부분이 아니라 중간 — 규칙 밖 결과
    # 마지막 저장 위치가 지금 보고보다 새로울 수 없다(저장은 같은 보고의 60 s 창 첫 점)
    assert rcc._ship_search(ship_search("HANJIN", search_item(last_position_at="2026-09-29T00:00:20Z")))
    assert rcc._ship_search(ship_search("HANJIN", search_item(last_position_at=None))) == []  # 저장 전·보존 밖은 모름


@pytest.mark.parametrize(
    ("q", "over", "ok"),
    [
        ("440123456", {}, True),  # 9자리: MMSI 정확
        ("440123457", {}, False),
        ("4401", {}, True),  # 3–8자리: MMSI 앞부분
        ("4402", {}, False),
        ("9321483", {}, True),  # 7자리: IMO 정확
        ("4401234", {}, True),  # 7자리: MMSI 앞부분이기도
        ("9321484", {}, False),
        ("IMO 9321483", {}, True),
        ("IMO9321483", {"imo": None}, False),
        ("D7", {}, True),  # 호출부호 앞부분
        ("44", {}, False),  # 두 자리 숫자는 선명·호출부호 규칙
        ("HANJIN BUSAN", {"name": "hanjin busan"}, True),  # 대소문자 무시
        ("HANJIN", {"name": None, "call_sign": None}, False),
    ],
)
def test_ship_search_match_rules(q, over, ok):
    assert rcc.ship_search_matches(q, search_item(**over)) is ok
