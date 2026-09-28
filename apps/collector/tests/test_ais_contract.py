"""AIS 스키마 계약: ship_state·ship_static·봉투 $defs 가 코드 상수와 같고, Java 클래스패스 복사본과 바이트 단위로 같다."""

from __future__ import annotations

import filecmp
import json
import random

import pytest
from test_ais_helpers import ROOT, SCHEMAS, validator

from wakeline_collector.ais.bbox import MAX_BOXES, SCOPE_RE, format_bboxes, parse_bboxes, parse_shards
from wakeline_collector.ais.book import STATE_FIELDS
from wakeline_collector.ais.parse import POSITION_CLASS, POSITION_SOURCE, POSITION_SOURCE_EPFS, STATIC_FIELDS

COPY = ROOT / "apps" / "api" / "src" / "main" / "resources" / "schemas"


def _schema(name: str) -> dict:
    return json.loads((SCHEMAS / name).read_text())


@pytest.mark.parametrize("name", ["ship_state.v1.json", "ship_static.v1.json", "stream_envelope.v1.json"])
def test_schema_copies_are_byte_identical(name):
    assert filecmp.cmp(SCHEMAS / name, COPY / name, shallow=False)


def test_ship_state_schema_matches_code():
    s = _schema("ship_state.v1.json")
    assert s["$id"] == "https://wakeline.invalid/schemas/ship_state.v1.json"
    assert tuple(s["required"]) == STATE_FIELDS and set(s["properties"]) == set(STATE_FIELDS)
    p = s["properties"]
    # 계약 v3 §B: 수집기가 만드는 값 + null(모름) + 배포 전환 중에만 받는 레거시 "gnss"
    assert p["position_source"]["type"] == ["string", "null"]
    assert p["position_source"]["enum"] == [POSITION_SOURCE_EPFS, *POSITION_SOURCE.values(), "gnss", None]
    assert set(p["msg_type"]["enum"]) == set(POSITION_CLASS)
    assert set(p["class"]["enum"]) == set(POSITION_CLASS.values())
    assert set(p["provider"]["enum"]) == {"aisstream", "fixture"}


def test_ship_static_schema_matches_code():
    s = _schema("ship_static.v1.json")
    assert s["$id"] == "https://wakeline.invalid/schemas/ship_static.v1.json"
    assert set(s["required"]) == set(s["properties"]) == {"mmsi", *STATIC_FIELDS, "updated_at", "provider"}


GOOD_STATE = {
    "mmsi": "440091020",
    "lat": 37.4632,
    "lon": 126.594268,
    "sog_kn": 0.0,
    "cog_deg": 291.9,
    "heading_deg": 89,
    "nav_status": 0,
    "rot": 2,
    "position_source": "epfs",
    "seen_at": "2026-09-27T16:29:44.220Z",
    "provider": "aisstream",
    "msg_type": "PositionReport",
    "class": "A",
}


@pytest.mark.parametrize(
    ("patch", "ok"),
    [
        ({}, True),
        ({"sog_kn": None, "cog_deg": None, "heading_deg": None, "nav_status": None, "rot": None}, True),
        ({"heading_deg": 511}, False),
        ({"sog_kn": 102.3}, False),
        ({"cog_deg": 360}, False),
        ({"rot": -128}, False),
        ({"lat": 91}, False),
        ({"mmsi": "44009102"}, False),
        ({"position_source": "guess"}, False),
        ({"position_source": None}, True),  # Timestamp 60·없음·범위 밖 = 모름
        ({"position_source": "gnss"}, True),  # 레거시(배포 전환 중 스트림에 남은 옛 항목)
        ({"position_source": ""}, False),
        ({"seen_at": "yesterday"}, False),
        ({"extra": 1}, False),
    ],
)
def test_ship_state_schema_rejects_sentinels(patch, ok):
    v = validator("ship_state.v1.json")
    assert (not list(v.iter_errors({**GOOD_STATE, **patch}))) is ok


def test_ship_static_schema_rejects_sentinels():
    v = validator("ship_static.v1.json")
    base = {"mmsi": "431009876", **dict.fromkeys(STATIC_FIELDS), "updated_at": "2026-09-27T16:29:44.918Z", "provider": "fixture"}
    assert not list(v.iter_errors(base))  # 모두 null(모름)은 유효
    for patch in (
        {"imo": 0},
        {"ship_type": 0},
        {"draught_m": 0},
        {"eta_hour": 24},
        {"eta_minute": 60},
        {"eta_month": 0},
        {"name": ""},
    ):
        assert list(v.iter_errors({**base, **patch})), patch


def test_gap_payload_schema():
    v = validator("stream_envelope.v1.json", "/$defs/ais_gap_payload")
    good = {"started_at": "2026-09-27T16:29:44.000Z", "ended_at": "2026-09-27T16:31:00.000Z", "reason": "server closed (1006)"}
    assert not list(v.iter_errors(good))
    assert list(v.iter_errors({**good, "reason": ""})) and list(v.iter_errors({**good, "x": 1}))


@pytest.mark.parametrize(
    ("scope", "ok"),
    [
        ("-90,-180,90,0", True),
        ("-90,45,90,180;18,105,46,150", True),
        (None, True),  # 구역 없음(api 는 null 도 받는다)
        # 형식은 스키마가 아니라 api 가 검사한다(계약 v4 G D-1) — 틀린 scope 도 공백 자체는 버리지 않는다(구역 없음 + 카운터)
        ("", True),
        ("-90,-180,90,0|-90,45,90,180", True),
        ("1e-6,1,2,2", True),
        ("x" * 1024, True),
        ("x" * 1025, False),  # 길이 상한만 스키마
        (5, False),
        (["1,1,2,2"], False),
    ],
)
def test_gap_payload_scope_schema(scope, ok):
    """계약 v4 G D-1: ais_gap_payload.scope = {"type": ["string", "null"], "maxLength": 1024}(선택 필드)."""
    v = validator("stream_envelope.v1.json", "/$defs/ais_gap_payload")
    good = {"started_at": "2026-09-27T16:29:44.000Z", "ended_at": "2026-09-27T16:31:00.000Z", "reason": "server closed (1006)"}
    assert (not list(v.iter_errors({**good, "scope": scope}))) is ok
    s = _schema("stream_envelope.v1.json")["$defs"]["ais_gap_payload"]
    assert "scope" not in s["required"]
    assert {k: s["properties"]["scope"][k] for k in ("type", "maxLength")} == {"type": ["string", "null"], "maxLength": 1024}


@pytest.mark.parametrize(
    ("scope", "ok"),
    [
        ("-90,-180,90,0", True),
        ("-90,45,90,180;18,105,46,150", True),
        ("0.000001,-179.999999,1.5,2", True),
        (";".join(["1,1,2,2"] * 16), True),
        (";".join(["1,1,2,2"] * 17), False),  # 구역 하나는 상자 16개까지
        ("-90,-180,90,0|-90,45,90,180", False),  # 구역 하나의 문자열 — '|' 없음
        ("", False),
        ("1,1,2", False),
        ("1e-6,1,2,2", False),
        ("1.1234567,1,2,2", False),
        ("fixture:ais_east_asia_90s.jsonl", False),
        ("1,1,2,2 ", False),
        ("\u0661,1,2,2", False),
    ],
)
def test_one_shard_scope_grammar(scope, ok):
    """수집기 자신의 약속: 공백 scope 는 늘 구역 하나의 정규화한 문자열(SCOPE_RE) — 스키마는 넓어졌어도(G D-1) 수집기는 좁게 만든다."""
    assert bool(SCOPE_RE.fullmatch(scope)) is ok


def test_every_normalized_shard_string_matches_the_one_shard_grammar():
    """수집기가 만드는 scope(format_bboxes)는 어떤 유효한 설정이든 구역 하나의 문법(SCOPE_RE)·스키마를 통과하고 되읽으면 같다."""
    v = validator("stream_envelope.v1.json", "/$defs/ais_gap_payload")
    base = {"started_at": "2026-09-27T16:29:44.000Z", "ended_at": "2026-09-27T16:31:00.000Z", "reason": "r"}
    rng = random.Random(20260928)

    def num(lo: float, hi: float) -> str:
        return f"{rng.uniform(lo, hi):.{rng.randint(0, 6)}f}"

    checked = 0
    for _ in range(300):
        boxes = []
        for _ in range(rng.randint(1, MAX_BOXES)):
            lats = [num(-90, 90) for _ in range(2)] + [rng.choice(["-90", "90", "-0", "0.000001"])]
            lons = [num(-180, 180) for _ in range(2)] + [rng.choice(["-180", "180", "-0.000000", "1"])]
            (lat1, lat2), (lon1, lon2) = rng.sample(lats, 2), rng.sample(lons, 2)
            boxes.append(f" {lat1},{lon1} , {lat2},{lon2}")
        try:
            shards = parse_shards(";".join(boxes))
        except ValueError:  # 넓이 0 인 상자가 나온 경우
            continue
        for shard in shards:
            scope = format_bboxes(shard)
            assert SCOPE_RE.fullmatch(scope), scope
            assert not list(v.iter_errors({**base, "scope": scope})), scope
            assert parse_bboxes(scope) == shard and len(scope) <= 767
            checked += 1
    assert checked > 200
