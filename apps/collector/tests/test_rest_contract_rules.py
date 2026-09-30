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


def test_stats_days_are_kst_date_strings_with_an_aggregated_flag():
    """R-45: 통계 day 는 "YYYY-MM-DD" 만, 범위 응답은 날마다 aggregated, 행의 날은 그 범위 안.
    계약 v5 §G20: 그 날짜는 KST 날짜 — day_zone "Asia/Seoul" 이 늘 있고, 교통량의 시(dim)는 그 KST 날짜의 시 "00"–"23"(시마다 한 행)."""
    v = Draft202012Validator(rcc.SCHEMAS["stats_sigmet"], format_checker=rcc.FORMATS)
    ok = {
        "group": "fir",
        "day_zone": "Asia/Seoul",
        "items": [{"day": "2026-09-27", "dim": "RKRR", "value": 3}],
        "days": [{"day": "2026-09-26", "aggregated": False}, {"day": "2026-09-27", "aggregated": True}],
        "meta": META,
    }
    assert not list(v.iter_errors(ok))
    assert rcc._stats_days(ok) == []
    midnight = {**ok, "items": [{"day": "2026-09-27T00:00:00.000Z", "dim": "RKRR", "value": 3}]}
    assert list(v.iter_errors(midnight))  # 자정 시각 문자열(JVM 시간대 의존)은 날짜가 아니다
    assert list(v.iter_errors({**ok, "days": [{"day": "2026-09-27"}]}))  # aggregated 없음
    assert list(v.iter_errors({k: x for k, x in ok.items() if k != "day_zone"}))  # 어느 날짜인지 밝히지 않은 응답
    assert list(v.iter_errors({**ok, "day_zone": "UTC"}))  # UTC 날짜 집계는 계약 밖(보관 표에만)
    unordered = [{"day": "2026-09-27", "aggregated": True}, {"day": "2026-09-26", "aggregated": True}]
    assert rcc._stats_days({**ok, "days": unordered})
    holes = [{"day": "2026-09-25", "aggregated": True}, {"day": "2026-09-27", "aggregated": True}]
    assert rcc._stats_days({**ok, "days": holes})
    assert rcc._stats_days({**ok, "days": [{"day": "2026-09-26", "aggregated": True}]})  # 행의 날이 범위 밖
    a = Draft202012Validator(rcc.SCHEMAS["stats_alerts"], format_checker=rcc.FORMATS)
    alerts = {
        "day_zone": "Asia/Seoul",
        "items": [{"day": "2026-09-27", "metric": "alerts_by_kind", "dim": "OBSERVED", "value": 2}],
        "days": ok["days"],
        "meta": META,
    }
    assert not list(a.iter_errors(alerts))
    assert list(a.iter_errors({k: x for k, x in alerts.items() if k != "day_zone"}))
    t = Draft202012Validator(rcc.SCHEMAS["stats_traffic"], format_checker=rcc.FORMATS)
    traffic = {"day": "2026-09-28", "day_zone": "Asia/Seoul", "aggregated": False, "items": [], "meta": META}
    assert not list(t.iter_errors(traffic))
    assert list(t.iter_errors({k: x for k, x in traffic.items() if k != "aggregated"}))  # 집계 전인지 알 수 없다
    assert list(t.iter_errors({k: x for k, x in traffic.items() if k != "day_zone"}))
    assert rcc._stats_traffic({**traffic, "items": [{"day": "2026-09-27", "dim": "10", "value": 1}]})  # 다른 날의 행
    hours = [{"day": "2026-09-28", "dim": h, "value": 1} for h in ("00", "09", "23")]
    assert rcc._stats_traffic({**traffic, "items": hours}) == []
    assert rcc._stats_traffic({**traffic, "items": [{"day": "2026-09-28", "dim": "24", "value": 1}]})  # 하루에 없는 시
    assert rcc._stats_traffic({**traffic, "items": [{"day": "2026-09-28", "dim": "7", "value": 1}]})  # 두 자리가 아니다
    assert rcc._stats_traffic({**traffic, "items": hours + [hours[0]]})  # 같은 시가 두 번


def test_status_radar_kr_carries_only_validated_fields():
    """R-72: /status 의 radar_kr 는 허용 목록(available·status·latest_tm·fetched_at·checked_at)만."""
    v = Draft202012Validator(rcc.SCHEMAS["status"]["properties"]["radar_kr"], format_checker=rcc.FORMATS)
    ok = {"available": True, "status": "200", "latest_tm": "202609281210", "fetched_at": "2026-09-28T03:10:00Z"}
    assert not list(v.iter_errors(ok))
    assert not list(v.iter_errors({}))  # 수집기가 쓴 적 없음 — 모두 모름
    assert list(v.iter_errors({**ok, "grid": '{"nx":1}'}))  # 원본 해시 필드
    assert list(v.iter_errors({**ok, "available": "1"}))  # 문자열 그대로
    assert list(v.iter_errors({**ok, "latest_tm": "12:10"}))
    # ADR-021: 최신 프레임의 합성 지점 수 · 기준 · 부분 합성(코드 목록은 /radar/kr 에만)
    assert not list(v.iter_errors({**ok, "stations": 7, "stations_ref": 15, "partial": True}))
    assert list(v.iter_errors({**ok, "stations": "KSN,GDK"}))  # 옛 수집기의 코드 목록 그대로
    assert list(v.iter_errors({**ok, "stations": 49}))
    assert list(v.iter_errors({**ok, "station_ids": ["KSN"]}))
    assert list(v.iter_errors({**ok, "partial": "1"}))
    status = {"radar_kr": {**ok, "stations": 7, "stations_ref": 15}}
    assert not rcc._radar_kr_status(status)
    assert not rcc._radar_kr_status({"radar_kr": {**status["radar_kr"], "partial": True}})
    assert rcc._radar_kr_status({"radar_kr": {**status["radar_kr"], "partial": False}})  # 7 < 15 인데 완전하다고 한다
    assert rcc._radar_kr_status({"radar_kr": {"stations": 7, "partial": True}})  # 기준 없이 판정
    assert rcc._radar_kr_status({"radar_kr": {"stations": 16, "stations_ref": 15}})  # 기준이 자기 지점 수보다 작다


def kr_frame(**over):
    f = {
        "tm": "202609291440",
        "obs_tm": "202609291440",
        "fetched_at": "2026-09-29T05:43:44Z",
        "echo_cells": 8587,
        "url": "/api/v1/radar/kr/202609291440.png?v=1790142224000",
        "stations": 7,
        "station_ids": ["KSN", "GDK", "JNI", "MYN", "PSN", "GSN", "SSP"],
        "stations_ref": 15,
        "partial": True,
        "refetches": 0,
        "upgrades": 0,
        "refetch_until": "2026-09-29T06:10:00Z",
    }
    return {**f, **over}


def radar_kr(*frames, **over):
    last = frames[-1] if frames else {}
    top = {k: last[k] for k in ("stations", "station_ids", "stations_ref", "partial") if k in last}
    body = {
        "available": bool(frames),
        "georeferenced": bool(frames),
        "frames": list(frames),
        "time_zone": "KST(UTC+9) for tm; fetched_at is UTC",
        "attribution": "기상청",
        "meta": {
            "fetched_at": "2026-09-29T05:43:44Z",
            "stale": False,
            "generated_at": "2026-09-29T05:50:00Z",
            "request_id": "req-12345678",
        },
        **top,
    }
    return {**body, **over}


def test_radar_kr_frames_schema_and_cross_rules():
    """ADR-021: /radar/kr 의 프레임마다 합성 지점 수 · 코드 · 기준 · partial · 다시 받기 기록, 최상위는 최신 프레임의 값."""
    v = Draft202012Validator(rcc.SCHEMAS["radar_kr"], format_checker=rcc.FORMATS)
    full = kr_frame(tm="202609291445", obs_tm="202609291445", url="/api/v1/radar/kr/202609291445.png?v=1", stations=15,
                    station_ids=[f"K{i:02d}" for i in range(15)], partial=False)  # fmt: skip
    legacy = {k: kr_frame()[k] for k in ("tm", "obs_tm", "fetched_at", "echo_cells")} | {
        "url": "/api/v1/radar/kr/202609291440.png"
    }
    for body in (radar_kr(kr_frame(), full), radar_kr(legacy), radar_kr(), radar_kr(legacy, kr_frame())):
        assert not list(v.iter_errors(body)), list(v.iter_errors(body))[:2]
        assert rcc._radar_kr(body) == [], rcc._radar_kr(body)
    for bad in (
        kr_frame(stations=49),
        kr_frame(station_ids=["K S"] * 7),
        kr_frame(partial="1"),
        kr_frame(refetches=-1),
        kr_frame(refetch_until="soon"),
        kr_frame(url="/api/v1/radar/kr/202609291440.png?v=abc"),
        kr_frame(extra="x"),  # 목록 항목은 허용 목록만
    ):
        assert list(v.iter_errors(radar_kr(bad))), bad
    for bad in (
        kr_frame(partial=False),  # 7 < 15 인데 완전하다고 한다
        kr_frame(stations_ref=5),  # 기준이 자기 지점 수보다 작다
        kr_frame(station_ids=["KSN"]),  # 지점 수와 코드 수가 다르다
        kr_frame(url="/api/v1/radar/kr/202609291435.png"),  # 다른 tm 의 영상
        kr_frame(stations_ref=None, partial=True) | {"stations_ref": None},
    ):
        body = radar_kr({k: x for k, x in bad.items() if x is not None})
        assert rcc._radar_kr(body), bad
    # 최상위는 최신 프레임과 같아야 한다 — 이전 프레임 값으로 채우거나 다른 값을 싣지 않는다
    assert rcc._radar_kr(radar_kr(kr_frame(), full, stations=7))
    assert rcc._radar_kr(radar_kr(kr_frame(), legacy, stations=7))
    assert rcc._radar_kr(radar_kr(available=True))  # 프레임 없이 쓸 수 있다고 한다


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
        "last_seen_at": None,  # 계약 v5 §G4: 실시간이면 null(seen_at 이 마지막 수신)
    }
    return {**base, **over}


STORED = {  # DB 에만 있는 선박: 위치·속력·보고 시각은 null, 마지막 저장 시각과 마지막 수신 기록(§G4)
    "mmsi": "440123457",
    "name": "HANJIN OLD",
    "live": False,
    "lat": None,
    "lon": None,
    "sog_kn": None,
    "seen_at": None,
    "last_position_at": "2026-09-28T00:00:00Z",
    "last_seen_at": "2026-09-28T00:05:00Z",
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


def test_v5_g4_stored_only_items_carry_last_seen_at():
    """계약 v5 §G4: 저장만 된 선박은 last_seen_at(마지막 수신 기록 — ship.last_seen, 저장 위치가 더 늦으면 그 시각)이 늘 있고,
    실시간 선박은 null. 위치 보존(72 h)이 지나 last_position_at 이 null 이어도 last_seen_at 은 있다. 저장 위치보다 이를 수 없다."""
    v = Draft202012Validator(rcc.SCHEMAS["ship_search"], format_checker=rcc.FORMATS)
    beyond = search_item(**{**STORED, "last_position_at": None, "last_seen_at": "2026-09-24T00:00:00Z"})
    assert not list(v.iter_errors(ship_search("HANJIN", search_item(), search_item(**STORED), beyond)))
    assert rcc._ship_search(ship_search("HANJIN", search_item(), beyond)) == []
    assert list(v.iter_errors(ship_search("HANJIN", search_item(**{**STORED, "last_seen_at": None}))))  # 저장 행이 있으면 안다
    assert list(v.iter_errors(ship_search("HANJIN", search_item(last_seen_at="2026-09-29T00:00:00Z"))))  # 실시간이면 null
    no_key = search_item(**STORED)
    del no_key["last_seen_at"]
    assert list(v.iter_errors(ship_search("HANJIN", no_key)))  # 키는 늘 있다
    early = search_item(**{**STORED, "last_seen_at": "2026-09-27T23:59:00Z"})  # 저장 위치(00:00)보다 이르다 — 넓히지 않은 값
    assert rcc._ship_search(ship_search("HANJIN", early))


def ship_detail(**over):
    base = {"mmsi": "440123457", "category": "unknown", "meta": META, "first_recorded_at": "2026-09-20T00:00:00Z"}
    return {**base, **over}


def test_v5_g4_ship_detail_last_seen_at_only_when_not_live():
    """상세도 같은 값: 실시간 목록에 없고 저장 기록이 있을 때만 last_seen_at(저장 위치보다 이르지 않다). 실시간이면 state.seen_at 이 마지막 수신."""
    v = Draft202012Validator(rcc.SCHEMAS["ship_detail"], format_checker=rcc.FORMATS)
    stored = ship_detail(last_position_at="2026-09-28T00:00:00Z", last_seen_at="2026-09-28T00:05:00Z")
    assert not list(v.iter_errors(stored)) and rcc._ship_detail(stored) == []
    assert rcc._ship_detail(ship_detail(last_position_at="2026-09-28T00:00:00Z", last_seen_at="2026-09-27T00:00:00Z"))
    no_record = {k: val for k, val in stored.items() if k != "first_recorded_at"}
    assert rcc._ship_detail(no_record)  # 저장 기록(ship 행)이 없으면 마지막 수신 기록도 없다
    live = ship_detail(
        state={"mmsi": "440123457", "lat": 35.0, "lon": 129.0, "seen_at": "2026-09-29T00:00:00Z"},
        last_seen_at="2026-09-28T00:05:00Z",
    )
    assert rcc._ship_detail(live)  # 실시간이면 싣지 않는다


def test_v5_g17_ship_detail_names_the_static_source():
    """계약 v5 §G17: 정적 정보가 있으면 출처(live · stored)를 밝히고, 저장값만 저장 행의 updated_at(= static.updated_at)을 싣는다."""
    v = Draft202012Validator(rcc.SCHEMAS["ship_detail"], format_checker=rcc.FORMATS)
    st = {"mmsi": "440123457", "call_sign": "V7A3884", "updated_at": "2026-09-29T03:00:00.123Z", "provider": "aisstream"}
    stored = ship_detail(static=st, static_source="stored", static_updated_at="2026-09-29T03:00:00.123000Z")
    live = ship_detail(static=st, static_source="live")
    for ok in (stored, live, ship_detail()):
        assert not list(v.iter_errors(ok)) and rcc._ship_detail(ok) == [], ok
    assert list(v.iter_errors(ship_detail(static=st, static_source="guessed")))
    assert rcc._ship_detail(ship_detail(static=st))  # 출처를 밝히지 않은 정적 정보
    assert rcc._ship_detail(ship_detail(static_source="live"))  # 정적 정보 없는 출처
    assert rcc._ship_detail(ship_detail(static=st, static_source="stored"))  # 저장값인데 시각 없음
    assert rcc._ship_detail(
        ship_detail(static=st, static_source="live", static_updated_at="2026-09-29T03:00:00.123Z")
    )  # 실시간에 저장 시각
    assert rcc._ship_detail(ship_detail(static=st, static_source="stored", static_updated_at="2026-09-29T04:00:00Z"))  # 다른 시각
    assert rcc._ship_detail(ship_detail(static=st, static_source="stored", static_updated_at="soon"))


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


# ---- ADR-023: 연안 교통량 /traffic/grid ----------------------------------------------------------------------------------


def traffic(**over):
    body = {
        "available": True,
        "status": "ok",
        "reg_dt_kst": "2026-09-29T18:05:05+09:00",
        "reg_dt_utc": "2026-09-29T09:05:05Z",
        "fetched_at": "2026-09-29T09:06:01.250Z",
        "age_s": 70,
        "stale_after_s": 900,
        "total": 4,
        "total_count": 4,
        "partial": False,
        "rejected": 0,
        "resolved": 2,
        "unresolved": 2,
        "pending": 0,
        "not_found": 1,
        "off_grid": 0,
        "failed": 1,
        "invalid_cells": 0,
        "cell_deg": 0.025,
        "cells": [["GR4_F2K41_C3", 37.45, 126.6, 12, 34.0], ["GR4_F2K41_D3", 37.425, 126.6, 102, 100.0]],
        "source": {
            "provider": "한국해양교통안전공단 MTIS 실시간 해양교통정보",
            "grid": "해양수산부 해양격자 4단계",
            "note": "5분 집계 — 격자별 선박 척수(개별 위치 아님)",
        },
        "time_zone": "x",
        "meta": {"stale": False, "generated_at": "2026-09-29T09:06:10Z", "request_id": "abcdefgh12"},
    }
    return {**body, **over}


EMPTY_KEYS = (
    "reg_dt_kst",
    "reg_dt_utc",
    "fetched_at",
    "age_s",
    "total",
    "total_count",
    "partial",
    "rejected",
    "resolved",
    "unresolved",
) + ("pending", "not_found", "off_grid", "failed", "invalid_cells", "disabled_reason")


def traffic_empty(**over):
    """스냅샷이 없는 상태 — 모르는 값은 키가 없다(api Jackson non_null)."""
    return {k: v for k, v in traffic(cells=[], available=False, **over).items() if k not in EMPTY_KEYS or k in over}


def test_traffic_grid_schema_and_rules_accept_every_honest_state():
    v = Draft202012Validator(rcc.SCHEMAS["traffic_grid"], format_checker=rcc.FORMATS)
    stale = traffic(status="stale", available=False, cells=[], age_s=1000)
    bodies = [
        traffic(),
        stale,
        traffic_empty(status="disabled", disabled_reason="no_key"),
        traffic_empty(status="no_data"),
        traffic_empty(status="invalid"),
    ]
    for b in bodies:
        assert not list(v.iter_errors(b)), (b["status"], [e.message for e in v.iter_errors(b)])
        assert rcc._traffic_grid(b) == [], (b["status"], rcc._traffic_grid(b))


@pytest.mark.parametrize(
    "over",
    [
        {"cells": [["GR4 BAD", 37.45, 126.6, 1, 1]]},
        {"cells": [["GR4_A", 37.45, 126.6, -1, 1]]},
        {"cells": [["GR4_A", 37.45, 126.6, 1, 100.5]]},
        {"cells": [["GR4_A", 37.45, 126.6, 1]]},
        {"cells": [["GR4_A", 37.45, 126.6, 1, 1, "extra"]]},
        {"cell_deg": 0.05},
        {"status": "fresh"},
        {"reg_dt_kst": "2026-09-29T09:05:05Z"},
        {"source": {"provider": "x", "grid": "y", "note": "z"}},
        {"secret_like": 1},
        {"total": None},  # 모르는 값은 null 이 아니라 키가 없다
        {"disabled_reason": None},
        {"failed": -1},
    ],
)
def test_traffic_grid_schema_rejects(over):
    v = Draft202012Validator(rcc.SCHEMAS["traffic_grid"], format_checker=rcc.FORMATS)
    assert list(v.iter_errors(traffic(**over))), over


@pytest.mark.parametrize(
    "over",
    [
        {"available": False},  # ok 인데 쓸 수 없다고 한다
        {"status": "stale", "available": False},  # 오래됐는데 칸을 싣는다
        {"status": "stale", "available": False, "cells": [], "age_s": 70},  # 나이가 상태와 다르다
        {"disabled_reason": "no_key"},  # ok 인데 꺼짐 이유
        {"reg_dt_kst": "2026-09-29T18:05:06+09:00"},  # 다른 순간
        {"reg_dt_kst": None},  # 한쪽만(키가 없다 = None)
        {"resolved": 3, "unresolved": 1, "total": 4, "cells": [["GR4_F2K41_C3", 37.45, 126.6, 12, 34.0]] * 1},
        {"pending": 1},  # 기다림 + 없음 + 격자 밖 + 조회 실패 != 미해석
        {"failed": 0},  # 조회 실패 칸을 빼먹었다
        # 응답 시각보다 120 s 넘게 미래인 regDt 가 ok
        {"reg_dt_utc": "2026-09-29T09:10:05Z", "reg_dt_kst": "2026-09-29T18:10:05+09:00"},
        {"cells": [["GR4_F2K41_C3", 37.4512, 126.6, 12, 34.0], ["GR4_F2K41_D3", 37.425, 126.6, 102, 100.0]]},  # 격자점 아님
        {"cells": [["GR4_F2K41_C3", 37.45, 126.6, 12, 34.0], ["GR4_F2K41_C3", 37.425, 126.6, 102, 100.0]]},  # 같은 칸 두 번
        {"status": "no_data", "available": False, "cells": [], "disabled_reason": None},  # 스냅샷이 없다면서 값을 싣는다
    ],
)
def test_traffic_grid_cross_rules_catch(over):
    assert rcc._traffic_grid(traffic(**over)), over


def test_radar_kr_missing_file_streak_rules():
    """기상청 내려받기 '파일 없음' 연속(2026-09-30): /status radar_kr · /radar/kr 의 missing — 핵심 값 넷은 늘 함께, 파일 이름 · 목록 종류는 있을 때만,
    tm 순서(since ≤ 파일의 tm ≤ last)는 교차 검사. 기록 표본 radar_kr_missing · status_ais 는 missing 을 싣는다."""
    m = {
        "since_tm": "202609300815",
        "last_tm": "202609300950",
        "tms": 20,
        "checked_at": "2026-09-30T00:50:31Z",
        "file": "RDR_CMP_HSR_PUB_202609300950.bin.gz",
        "listed": ["EXT"],
    }
    for schema in (rcc.SCHEMAS["status"]["properties"]["radar_kr"], rcc.SCHEMAS["radar_kr"]["properties"]):
        v = Draft202012Validator(schema if "properties" in schema else {"properties": schema}, format_checker=rcc.FORMATS)
        assert not list(v.iter_errors({"missing": m}))
        assert not list(v.iter_errors({"missing": {k: x for k, x in m.items() if k not in ("file", "listed")}}))
        for bad in (
            {"tms": 0},
            {"since_tm": "08:15"},
            {"checked_at": "2026-09-30T00:50:31"},
            {"file": "<html>"},
            {"listed": ["ext"]},
            {"listed": []},
            {"note": "x"},
        ):
            assert list(v.iter_errors({"missing": {**m, **bad}})), bad
        assert list(v.iter_errors({"missing": {k: x for k, x in m.items() if k != "last_tm"}}))
    assert not rcc._radar_kr_status({"radar_kr": {"missing": m}})
    assert rcc._radar_kr_status({"radar_kr": {"missing": {**m, "last_tm": "202609300810"}}})  # 첫 tm 보다 이르다
    assert rcc._radar_kr_status(
        {"radar_kr": {"missing": {**m, "file": "RDR_CMP_HSR_PUB_202609301000.bin.gz"}}}
    )  # 범위 밖 tm 의 파일
    assert rcc._radar_kr({"available": False, "frames": [], "missing": {**m, "last_tm": "202609300810"}})
    assert any(c.name == "radar_kr_missing" and c.recorded_only for c in rcc.CHECKS)
    assert list(Draft202012Validator(rcc.SCHEMAS["radar_kr_missing"]).iter_errors({}))  # required missing
    assert "missing" in str(rcc.SCHEMAS["status_ais"]["allOf"])


# ---- 관측 수신 범위(계약 v5 §G27 · ADR-027) — GET /api/v1/ships/coverage ----


def coverage(**over):
    """부트스트랩이 끝난 뒤의 정직한 응답(창 전체를 덮음). 시각은 UTC ISO — 마지막 수신은 초로 내린 값."""
    body = {
        "cell_deg": 0.5,
        "window": {"hours": 24, "bucket_s": 3600, "from": "2026-09-29T09:00:00Z", "to": "2026-09-30T09:40:12.345Z"},
        "since": "2026-09-29T09:00:00Z",
        "covered": "full",
        "api_started_at": "2026-09-30T09:37:25.500Z",
        "live_from": "2026-09-30T09:37:00Z",
        "bootstrap": {
            "state": "done",
            "hours_loaded": 25,
            "hours_total": 25,
            "rows": 1234,
            "loaded_from": "2026-09-29T09:00:00Z",
            "finished_at": "2026-09-30T09:38:10.100Z",
        },
        "generated_at": "2026-09-30T09:40:12.345Z",
        "cells": [
            [139.5, 35.0, 0.5, 12, 40, "2026-09-30T08:59:59Z"],
            [126.0, 37.0, 0.5, 304, 5120, "2026-09-30T09:40:01Z"],
        ],
        "cell_count": 2,
        "positions": 5160,
        "truncated": False,
        "dropped_positions": 0,
        "limits": {"max_cells": 16000, "max_ship_cells": 200000},
        "sampling": "first_fix_per_60s",
        "note": "관측 수신 — 이 서비스가 받은 AIS 위치의 칸별 집계(구독 범위 아님 · 수신국이 없는 해역은 비어 있다)",
        "time_zone": "all times are UTC ISO-8601",
        "meta": {
            "provider": "aisstream",
            "fetched_at": "2026-09-30T09:40:01Z",
            "lag_s": 11.3,
            "stale": False,
            "generated_at": "2026-09-30T09:40:12.400Z",
            "request_id": "abcdef0123456789",
        },
    }
    body.update(over)
    return body


def coverage_since_start(**over):
    """부트스트랩 전(api 시작 뒤 셈만) — since = 셈 시작."""
    b = coverage(
        since="2026-09-30T09:37:00Z",
        covered="since_api_start",
        bootstrap={"state": "pending", "hours_loaded": 0, "hours_total": 0, "rows": 0, "loaded_from": "2026-09-30T09:37:00Z"},
        cells=[[126.0, 37.0, 0.5, 3, 3, "2026-09-30T09:40:01Z"]],
        cell_count=1,
        positions=3,
    )
    b.update(over)
    return b


def coverage_partial(**over):
    """부트스트랩이 세 시(지금 시 + 앞 두 시)만 읽고 문장 상한에 멈춤 — since = 이어 읽은 가장 오래된 시."""
    b = coverage(
        since="2026-09-30T07:00:00Z",
        covered="partial",
        bootstrap={
            "state": "failed",
            "hours_loaded": 3,
            "hours_total": 25,
            "rows": 40,
            "loaded_from": "2026-09-30T07:00:00Z",
            "error": "statement_timeout",
            "finished_at": "2026-09-30T09:38:10Z",
        },
    )
    b.update(over)
    return b


def test_ship_coverage_schema_and_rules_accept_every_honest_state():
    v = Draft202012Validator(rcc.SCHEMAS["ship_coverage"], format_checker=rcc.FORMATS)
    empty = coverage_since_start(
        cells=[],
        cell_count=0,
        positions=0,
        meta={k: x for k, x in coverage()["meta"].items() if k not in ("fetched_at", "lag_s")},
    )
    empty["meta"]["stale"] = True
    capped = coverage(truncated=True, dropped_positions=7)
    for b in (coverage(), coverage_since_start(), coverage_partial(), empty, capped):
        assert not list(v.iter_errors(b)), (b["covered"], [e.message for e in v.iter_errors(b)])
        assert rcc._ship_coverage(b) == [], (b["covered"], rcc._ship_coverage(b))
    assert any(c.name == "ship_coverage" and not c.recorded_only for c in rcc.CHECKS)


@pytest.mark.parametrize(
    "over",
    [
        {"cell_deg": 1.0},
        {"window": {"hours": 12, "bucket_s": 3600, "from": "2026-09-29T09:00:00Z", "to": "2026-09-30T09:40:12.345Z"}},
        {"covered": "complete"},
        {"cells": [[126.0, 37.0, 0.5, 0, 3, "2026-09-30T09:40:01Z"]]},  # 선박 0척인 칸은 싣지 않는다
        {"cells": [[126.0, 37.0, 0.5, 3, 3]]},  # 마지막 수신이 없다
        {"cells": [[126.0, 37.0, 0.5, 3, 3, "2026-09-30T09:40:01"]]},  # 시간대 없는 시각
        {"cells": [[180.0, 37.0, 0.5, 3, 3, "2026-09-30T09:40:01Z"]]},  # 180 은 칸의 시작이 될 수 없다
        {
            "bootstrap": {
                "state": "failed",
                "hours_loaded": 0,
                "hours_total": 0,
                "rows": 0,
                "loaded_from": "2026-09-30T09:37:00Z",
            }
        },  # 실패인데 종류가 없다
        {
            "bootstrap": {
                "state": "done",
                "hours_loaded": 25,
                "hours_total": 25,
                "rows": 1,
                "loaded_from": "2026-09-29T09:00:00Z",
                "error": "x",
            }
        },
        {"sampling": "all_reports"},
        {"limits": {"max_cells": 16000}},
        {"extra": 1},
    ],
)
def test_ship_coverage_schema_rejects(over):
    v = Draft202012Validator(rcc.SCHEMAS["ship_coverage"], format_checker=rcc.FORMATS)
    assert list(v.iter_errors(coverage(**over))), over


@pytest.mark.parametrize(
    "body",
    [
        coverage(covered="partial"),  # since 가 창의 시작인데 전체가 아니라고 한다
        coverage(since="2026-09-30T07:00:00Z"),  # 창 전체를 덮지 않았는데 full
        coverage_since_start(covered="full"),
        coverage_since_start(since="2026-09-30T09:00:00Z"),  # 셈 시작보다 앞선 since(부트스트랩이 읽지 않았다)
        coverage_partial(since="2026-09-30T08:00:00Z"),  # 부트스트랩이 이어 읽은 곳과 다른 since
        coverage(
            window={"hours": 24, "bucket_s": 3600, "from": "2026-09-29T10:00:00Z", "to": "2026-09-30T09:40:12.345Z"}
        ),  # 창의 시작 ≠ 지금 시 − 24 h
        coverage(
            window={"hours": 24, "bucket_s": 3600, "from": "2026-09-29T09:00:00Z", "to": "2026-09-30T09:41:00Z"}
        ),  # to ≠ generated_at
        coverage(live_from="2026-09-30T09:37:30Z"),  # 셈 시작이 분 경계가 아니다
        coverage(live_from="2026-09-30T09:35:00Z"),  # 셈 시작이 api 시작 분보다 이르다
        coverage(cells=[[126.25, 37.0, 0.5, 3, 3, "2026-09-30T09:40:01Z"]], cell_count=1, positions=3),  # 0.5° 격자점 아님
        coverage(cells=[[126.0, 37.0, 0.5, 4, 3, "2026-09-30T09:40:01Z"]], cell_count=1, positions=3),  # 선박 > 위치
        coverage(cells=[[126.0, 37.0, 0.5, 3, 3, "2026-09-29T08:59:59Z"]], cell_count=1, positions=3),  # 창 밖의 마지막 수신
        coverage(cells=[[126.0, 37.0, 0.5, 3, 3, "2026-09-30T09:50:01Z"]], cell_count=1, positions=3),  # 응답보다 5분 넘게 미래
        coverage(cells=[[126.0, 37.0, 0.5, 3, 3, "2026-09-30T09:40:01.500Z"]], cell_count=1, positions=3),  # 초로 내리지 않았다
        coverage(
            cells=[[126.0, 37.0, 0.5, 304, 5120, "2026-09-30T09:40:01Z"], [139.5, 35.0, 0.5, 12, 40, "2026-09-30T08:59:59Z"]]
        ),  # 남 → 북이 아님
        coverage(cells=[[126.0, 37.0, 0.5, 3, 3, "2026-09-30T09:40:01Z"]] * 2, cell_count=2, positions=6),  # 같은 칸 두 번
        coverage(cell_count=3),
        coverage(positions=5161),
        coverage(truncated=True),  # 빠진 위치가 없는데 잘렸다고 한다
        coverage(dropped_positions=3),  # 빠진 위치가 있는데 잘리지 않았다고 한다
        coverage(limits={"max_cells": 1, "max_ship_cells": 200000}),  # 상한보다 많은 칸
        coverage(bootstrap={**coverage()["bootstrap"], "hours_loaded": 24}),  # done 인데 다 읽지 않았다
        coverage(bootstrap={**coverage()["bootstrap"], "loaded_from": "2026-09-30T09:38:00Z"}),  # 셈 시작보다 늦은 loaded_from
        coverage(meta={**coverage()["meta"], "fetched_at": "2026-09-30T09:39:00Z"}),  # 가장 늦은 마지막 수신이 아니다
    ],
)
def test_ship_coverage_cross_rules_catch(body):
    assert rcc._ship_coverage(body), body


def test_ship_coverage_fetched_at_is_clamped_to_generated_at_when_a_report_is_ahead_of_the_api_clock():
    """리뷰(2026-09-30): 수집기 시계가 빨라 마지막 수신이 응답 시각보다 미래면(5분까지 센다) api 는 meta.fetched_at 을 generated_at 으로 내린다 —
    Meta 가 음수 지연을 stale 로 보지 않게. 규칙: fetched_at = min(가장 늦은 마지막 수신, generated_at). 수정 전(= 가장 늦은 마지막 수신만 허용) 실패."""
    ahead = "2026-09-30T09:42:00Z"  # generated_at 09:40:12.345 보다 2분 미래
    cells = [[126.0, 37.0, 0.5, 3, 3, ahead]]
    meta = {**coverage()["meta"], "fetched_at": "2026-09-30T09:40:12.345Z"}
    body = coverage(cells=cells, cell_count=1, positions=3, meta=meta)
    assert rcc._ship_coverage(body) == [], rcc._ship_coverage(body)
    # 미래 값 그대로는 틀렸다(api 가 내리지 않았다)
    raw = coverage(cells=cells, cell_count=1, positions=3, meta={**meta, "fetched_at": ahead})
    assert rcc._ship_coverage(raw)
