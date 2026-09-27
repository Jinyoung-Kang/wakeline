#!/usr/bin/env python3
"""REST 계약 검사(설계 14.1 — Java → Python 방향): Java api 가 만든 REST 응답이 웹·도구가 읽는 필드 계약(계약서 §1·§2)을 지키는지
JSON Schema(Draft 2020-12)로 확인한다. 한쪽만 고치면 이 검사가 깨진다.

두 가지 입력:
  --base-url URL  실행 중인 스택(예: http://localhost:8700)에서 직접 받는다. 데이터에 따라 달라지는 검사(상세·SIGMET 상세)는
                  앞 응답에서 id 를 골라 쓰고, 고를 것이 없으면 skip 으로 표시한다(실패 아님, --strict 면 실패).
  --dir DIR       api 통합 테스트(RestSamplesIT)가 남긴 응답 기록(apps/api/build/rest-samples/*.json)을 검사한다 — CI 용.

apps/collector 의 uv 환경에서 실행한다(jsonschema):
  cd apps/collector && uv run python ../../tools/rest_contract_check.py --base-url http://localhost:8700
  cd apps/collector && uv run python ../../tools/rest_contract_check.py --dir ../api/build/rest-samples
종료 코드: 0 통과, 1 계약 위반, 2 사용법·연결 오류.
"""

from __future__ import annotations

import argparse
import json
import sys
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import UTC, date, datetime
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator, FormatChecker

# ---------------------------------------------------------------- 형식(date-time 은 기본 FormatChecker 에서 검사되지 않는다)

FORMATS = FormatChecker()
Schema = dict[str, Any]  # JSON Schema 조각


@FORMATS.checks("date-time", raises=ValueError)
def _date_time(value: object) -> bool:
    if not isinstance(value, str):
        return True
    dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if dt.tzinfo is None:  # 시각은 모두 UTC ISO-8601(오프셋 포함)이어야 한다 — 시간대 없는 값은 해석이 갈린다
        raise ValueError("date-time without offset")
    return True


@FORMATS.checks("date", raises=ValueError)
def _date(value: object) -> bool:
    if isinstance(value, str):
        date.fromisoformat(value)
    return True


# ---------------------------------------------------------------- 공통 조각

TS: Schema = {"type": "string", "format": "date-time"}
HEX: Schema = {"type": "string", "pattern": "^[0-9a-f]{6}$"}
NUM: Schema = {"type": "number"}
INT: Schema = {"type": "integer"}
STR: Schema = {"type": "string"}
BOOL: Schema = {"type": "boolean"}
JS_SAFE_ID: Schema = {"type": "integer", "minimum": 1, "maximum": 9007199254740991}  # 알림 id 는 JS 안전 정수(epochMillis*1000+n)

SOURCE: Schema = {  # 계약 §1: 스코프별 출처·지연. 값을 모르면 키가 없다(null 을 채우지 않는다)
    "type": "object",
    "required": ["stale"],
    "additionalProperties": False,
    "properties": {"provider": STR, "fetched_at": TS, "lag_s": {"type": "number", "minimum": 0}, "stale": BOOL},
}
SOURCES: Schema = {
    "type": "object",
    "required": ["region", "global"],
    "additionalProperties": False,
    "properties": {"region": SOURCE, "global": {"oneOf": [{"type": "null"}, SOURCE]}},
}
META: Schema = {  # 9.1절: 모든 데이터 응답의 meta
    "type": "object",
    "required": ["stale", "generated_at", "request_id"],
    "properties": {
        "provider": STR,
        "fetched_at": TS,
        "lag_s": {"type": "number", "minimum": 0},
        "stale": BOOL,
        "generated_at": TS,
        "request_id": {"type": "string", "minLength": 8},
        "db_unavailable": {"const": True},
        "sources": SOURCES,
    },
}

# 계약 §1 항공기 인코딩 — 나열된 키만(추가 키 금지), 값이 없으면 키가 없다. 'estimated' 는 서버 값이 아니다(브라우저 보간만).
LITE_PROPS: dict[str, Any] = {
    "hex": HEX,
    "callsign": STR,
    "lat": {"type": "number", "minimum": -90, "maximum": 90},
    "lon": {"type": "number", "minimum": -180, "maximum": 180},
    "alt_ft": INT,
    "gs_kt": {"type": "number", "minimum": 0},
    "track_deg": {"type": "number", "minimum": 0, "maximum": 360},
    "vrate_fpm": NUM,
    "on_ground": BOOL,
    "squawk": {"type": "string", "pattern": "^[0-7]{4}$"},
    "seen_at": TS,
    "provider": {"enum": ["adsb_lol", "adsb_fi", "opensky", "fixture"]},
    "quality": {"enum": [0, 1]},
}
AIRCRAFT_LITE: Schema = {
    "type": "object",
    "required": ["hex", "lat", "lon", "on_ground", "seen_at", "provider"],
    "additionalProperties": False,
    "properties": LITE_PROPS,
}
AIRCRAFT_FULL: Schema = {
    "type": "object",
    "required": ["hex", "lat", "lon", "on_ground", "seen_at", "provider", "fetched_at"],
    "additionalProperties": False,
    "properties": {**LITE_PROPS, "registration": STR, "type_code": STR, "category": STR, "fetched_at": TS},
}


def feature_collection(feature: dict[str, Any], media_meta: dict[str, Any]) -> dict[str, Any]:
    return {
        "type": "object",
        "required": ["type", "features", "meta"],
        "properties": {
            "type": {"const": "FeatureCollection"},
            "features": {"type": "array", "items": feature},
            "meta": media_meta,
        },
    }


def point_feature(props: dict[str, Any]) -> dict[str, Any]:
    return {
        "type": "object",
        "required": ["type", "id", "geometry", "properties"],
        "properties": {
            "type": {"const": "Feature"},
            "id": STR,
            "geometry": {
                "type": "object",
                "required": ["type", "coordinates"],
                "properties": {
                    "type": {"const": "Point"},
                    "coordinates": {"type": "array", "items": NUM, "minItems": 2, "maxItems": 3},
                },
            },
            "properties": props,
        },
    }


ALERT: Schema = {  # 계약 §1 Alert
    "type": "object",
    "required": ["id", "kind", "hex", "sigmet_id", "entered_at", "evidence", "estimated"],
    "properties": {
        "id": JS_SAFE_ID,
        "kind": {"enum": ["OBSERVED", "PREDICTED"]},
        "hex": HEX,
        "callsign": STR,
        "sigmet_id": STR,
        "fir_id": STR,
        "hazard": STR,
        "qualifier": STR,
        "entered_at": TS,
        "left_at": TS,
        "close_reason": {"enum": ["left", "signal_lost", "restart", "prediction_cleared"]},
        "eta_s": {"type": "integer", "minimum": 0},
        "eta_at": TS,
        "alt_ft": INT,
        "evidence": {"type": "object", "required": ["method"], "properties": {"method": STR}},
        "estimated": BOOL,
    },
    "allOf": [
        # 예측은 '추정' 으로 표시되고 절대 시각(eta_at)을 싣는다 — 관측은 추정이 아니다
        {"if": {"properties": {"kind": {"const": "PREDICTED"}}}, "then": {"properties": {"estimated": {"const": True}}}},
        {
            "if": {"properties": {"kind": {"const": "OBSERVED"}}},
            "then": {"properties": {"estimated": {"const": False}}, "not": {"required": ["eta_at"]}},
        },
        # 닫혔으면 사유가 있다
        {"if": {"required": ["close_reason"]}, "then": {"required": ["left_at"]}},
    ],
}
HISTORY_ALERT: Schema = {
    "type": "object",
    "required": ["id", "kind", "hex", "sigmet_id", "entered_at", "evidence"],
    "properties": {**ALERT["properties"], "alt_ft_at_entry": INT},
}

SIGMET_PROPS: Schema = {  # 계약 §1·§2 SIGMET feature properties
    "type": "object",
    "required": [
        "id",
        "fir_id",
        "hazard",
        "base_ft",
        "valid_from",
        "valid_to",
        "active",
        "expiring_soon",
        "top_source",
        "provider",
        "fetched_at",
    ],
    "properties": {
        "id": STR,
        "fir_id": STR,
        "fir_name": STR,
        "series_id": STR,
        "hazard": STR,
        "qualifier": STR,
        "base_ft": {"type": "integer", "minimum": 0},
        "top_ft": INT,
        "base_source": {"enum": ["json", "assumed_surface"]},  # 없으면 옛 형식(출처 모름) — 추정해 채우지 않는다
        "top_source": {"enum": ["json", "raw_text", "unknown"]},
        "valid_from": TS,
        "valid_to": TS,
        "active": BOOL,
        "expiring_soon": BOOL,
        "excluded_reason": STR,
        "raw_text": STR,
        "provider": STR,
        "fetched_at": TS,
    },
    "allOf": [
        # 상한 미발표(unknown)는 top_ft 가 없다 — '무제한' 을 발표값처럼 싣지 않는다
        {
            "if": {"properties": {"top_source": {"const": "unknown"}}, "required": ["top_source"]},
            "then": {"not": {"required": ["top_ft"]}},
        },
        {
            "if": {"properties": {"top_source": {"enum": ["json", "raw_text"]}}, "required": ["top_source"]},
            "then": {"required": ["top_ft"]},
        },
        {
            "if": {"properties": {"base_source": {"const": "assumed_surface"}}, "required": ["base_source"]},
            "then": {"properties": {"base_ft": {"const": 0}}},
        },
    ],
}
SIGMET_FEATURE: Schema = {  # RFC 7946 §3.2: Feature 는 geometry 멤버를 반드시 가진다(판정 제외 SIGMET 은 null)
    "type": "object",
    "required": ["type", "id", "geometry", "properties"],
    "properties": {
        "type": {"const": "Feature"},
        "id": STR,
        "geometry": {
            "oneOf": [
                {"type": "null"},
                {
                    "type": "object",
                    "required": ["type", "coordinates"],
                    "properties": {"type": {"const": "MultiPolygon"}, "coordinates": {"type": "array", "minItems": 1}},
                },
            ]
        },
        "properties": SIGMET_PROPS,
    },
}

PROBLEM: Schema = {  # RFC 9457 + 확장(code, request_id)
    "type": "object",
    "required": ["type", "title", "status", "detail", "instance", "code", "request_id"],
    "properties": {
        "type": {"type": "string", "pattern": "^https://wakeline\\.dev/problems/[a-z0-9-]+$"},
        "title": {"type": "string", "minLength": 1},
        "status": {"type": "integer", "minimum": 400, "maximum": 599},
        "detail": STR,
        "instance": {"type": "string", "pattern": "^/"},
        "code": {"type": "string", "pattern": "^[A-Z_]+$"},
        "request_id": {"type": "string", "minLength": 8},
    },
    "not": {"anyOf": [{"required": ["trace"]}, {"required": ["exception"]}, {"required": ["stackTrace"]}]},
}

FEED: Schema = {
    "type": "object",
    "required": ["stale"],
    "properties": {
        "provider": STR,
        "aircraft": {"type": "integer", "minimum": 0},
        "lag_s": {"type": "number", "minimum": 0},
        "stale": BOOL,
        "fetched_at": TS,
    },
}
SCHEMAS: dict[str, dict[str, Any]] = {
    "status": {
        "type": "object",
        "required": ["server_time", "snapshot_version", "fixture_mode", "region", "global", "sigmet", "radar", "engine", "meta"],
        "properties": {
            "server_time": TS,
            "snapshot_version": INT,
            "fixture_mode": BOOL,
            "collector_mode_known": BOOL,
            "region": {
                **FEED,
                "required": ["center", "radius_nm", "aircraft", "stale"],
                "properties": {
                    **FEED["properties"],
                    "center": {"type": "array", "items": NUM, "minItems": 2, "maxItems": 2},
                    "radius_nm": {"type": "number", "exclusiveMinimum": 0},
                },
            },
            "global": {**FEED, "required": ["aircraft", "stale"]},
            "sigmet": {
                "type": "object",
                "required": ["count", "active", "stale"],
                "properties": {"count": INT, "active": INT, "stale": BOOL, "fetched_at": TS, "provider": STR},
            },
            "radar": {"type": "object", "required": ["frames", "stale"], "properties": {"frames": INT, "stale": BOOL}},
            "engine": {
                "type": "object",
                "required": ["index_polygons"],
                "properties": {"index_polygons": INT, "last_cycle_ms": NUM},
            },
            "meta": META,
        },
    },
    "aircraft": feature_collection(point_feature(AIRCRAFT_LITE), {**META, "required": [*META["required"], "sources"]}),
    "aircraft_full": feature_collection(point_feature(AIRCRAFT_FULL), {**META, "required": [*META["required"], "sources"]}),
    "aircraft_detail": {
        "type": "object",
        "required": ["hex", "active_alerts", "inside_sigmets", "emergency", "meta"],
        "properties": {
            "hex": HEX,
            "state": AIRCRAFT_FULL,
            "static": {
                "type": "object",
                "required": ["hex"],
                "properties": {"hex": HEX, "registration": STR, "type_code": STR, "first_seen": TS, "last_seen": TS},
            },
            "active_alerts": {"type": "array", "items": ALERT},
            "inside_sigmets": {"type": "array", "items": STR},
            "emergency": BOOL,
            "meta": META,
        },
        # DB 가 없으면 static 이 없고 meta 가 그렇다고 말한다(계약 §2)
        "if": {"not": {"required": ["static"]}},
        "then": {"properties": {"meta": {"required": ["db_unavailable"]}}},
    },
    "aircraft_search": {
        "type": "object",
        "required": ["items", "meta"],
        "properties": {
            "items": {
                "type": "array",
                "maxItems": 20,
                "items": {
                    "oneOf": [
                        {
                            **AIRCRAFT_LITE,
                            "required": [*AIRCRAFT_LITE["required"], "live"],
                            "properties": {**LITE_PROPS, "live": {"const": True}},
                        },
                        {
                            "type": "object",
                            "required": ["hex", "live"],
                            "additionalProperties": False,
                            "properties": {
                                "hex": HEX,
                                "registration": STR,
                                "type_code": STR,
                                "last_seen": TS,
                                "live": {"const": False},
                            },
                        },
                    ]
                },
            },
            "meta": META,
        },
    },
    "aircraft_track": {
        "type": "object",
        "required": ["type", "geometry", "properties", "points", "meta"],
        "properties": {
            "type": {"const": "Feature"},
            "geometry": {"type": "object", "required": ["type", "coordinates"], "properties": {"type": {"const": "LineString"}}},
            "properties": {
                "type": "object",
                "required": ["hex", "from", "to", "points"],
                "properties": {"hex": HEX, "from": TS, "to": TS, "points": INT},
            },
            "points": {
                "type": "array",
                "items": {
                    "type": "object",
                    "required": ["ts", "lat", "lon"],
                    "properties": {"ts": TS, "lat": NUM, "lon": NUM, "alt_ft": INT, "provider": STR},
                },
            },
            "meta": META,
        },
    },
    "sigmets": feature_collection(SIGMET_FEATURE, META),
    "sigmet_detail": {
        **SIGMET_FEATURE,
        "required": [*SIGMET_FEATURE["required"], "aircraft_inside", "meta"],
        "properties": {**SIGMET_FEATURE["properties"], "aircraft_inside": {"type": "array", "items": HEX}, "meta": META},
    },
    "alerts": {
        "type": "object",
        "required": ["items", "meta"],
        "properties": {"items": {"type": "array", "items": ALERT}, "meta": META},
    },
    "alerts_history": {
        "type": "object",
        "required": ["items", "meta"],
        "properties": {"items": {"type": "array", "items": HISTORY_ALERT}, "next_cursor": INT, "meta": META},
    },
    "radar_frames": {
        "type": "object",
        "required": ["host", "generated", "past", "tile_template", "meta"],
        "properties": {
            "host": {"type": "string", "pattern": "^https://"},
            "generated": INT,
            "past": {
                "type": "array",
                "items": {"type": "object", "required": ["time", "path"], "properties": {"time": INT, "path": STR}},
            },
            "tile_template": STR,
            "attribution": STR,
            "meta": META,
        },
    },
    "airports": feature_collection(
        point_feature(
            {
                "type": "object",
                "required": ["icao", "watched"],
                "properties": {
                    "icao": {"type": "string", "pattern": "^[A-Z0-9]{4}$"},
                    "watched": BOOL,
                    "obs_time": TS,
                    "flight_cat": {"enum": ["VFR", "MVFR", "IFR", "LIFR"]},  # 모르면 키가 없다
                    "flight_cat_source": {"enum": ["awc", "computed"]},
                    "ceiling_state": {"enum": ["measured", "none", "unknown"]},
                    "obs_age_s": {"type": "number", "minimum": 0},
                    "stale": BOOL,
                },
                "allOf": [
                    {"if": {"required": ["obs_time"]}, "then": {"required": ["obs_age_s", "stale"]}},
                    {"if": {"required": ["flight_cat"]}, "then": {"required": ["flight_cat_source"]}},
                ],
            }
        ),
        META,
    ),
    "airport_wx": {
        "type": "object",
        "required": ["airport", "meta"],
        "properties": {
            "airport": {
                "type": "object",
                "required": ["icao", "lat", "lon"],
                "properties": {"icao": STR, "lat": NUM, "lon": NUM},
            },
            "latest": {
                "type": "object",
                "required": ["obs_time", "raw", "obs_age_s", "stale"],
                "properties": {
                    "obs_time": TS,
                    "raw": STR,
                    "obs_age_s": {"type": "number", "minimum": 0},
                    "stale": BOOL,
                    "ceiling_state": {"enum": ["measured", "none", "unknown"]},
                    "flight_cat": {"enum": ["VFR", "MVFR", "IFR", "LIFR"]},
                    "flight_cat_source": {"enum": ["awc", "computed"]},
                },
            },
            "history": {"type": "array"},
            "meta": META,
        },
    },
    "replay": {
        "type": "object",
        "required": ["at", "aircraft", "sigmets", "source", "meta"],
        "properties": {
            "at": TS,
            "aircraft": {"type": "array"},
            "sigmets": {"type": "array"},
            "source": {"enum": ["track_point", "track_point_1m", "none"]},
            "radar": {
                "type": "object",
                "required": ["host", "path", "time"],
                "properties": {"host": STR, "path": STR, "time": INT},
            },
            "meta": META,
        },
    },
    "stats_traffic": {
        "type": "object",
        "required": ["day", "items", "meta"],
        "properties": {
            "day": {"type": "string", "format": "date"},
            "scope": {"const": "region"},
            "items": {"type": "array"},
            "meta": META,
        },
    },
    "stats_alerts": {"type": "object", "required": ["items", "meta"], "properties": {"items": {"type": "array"}, "meta": META}},
    "stats_sigmet": {
        "type": "object",
        "required": ["items", "group", "meta"],
        "properties": {"items": {"type": "array"}, "group": {"enum": ["fir", "hazard"]}, "meta": META},
    },
    "problem": PROBLEM,
}


@dataclass(frozen=True)
class Check:
    name: str
    schema: str
    status: int
    media: str  # Content-Type 접두
    public_cache: bool  # 계약 §2: 캐시 가능한 공개 GET 은 Cache-Control: public
    recorded_only: bool = False  # 기록(--dir)에만 있는 경우(예: DB 에만 있는 항공기 검색) — 실행 중 스택에서는 고를 수 없다


CHECKS = [
    Check("status", "status", 200, "application/json", True),
    Check("aircraft", "aircraft", 200, "application/geo+json", True),
    Check("aircraft_full", "aircraft_full", 200, "application/geo+json", True),
    Check("aircraft_detail", "aircraft_detail", 200, "application/json", True),
    Check("aircraft_search", "aircraft_search", 200, "application/json", True),
    Check("aircraft_search_db", "aircraft_search", 200, "application/json", True, recorded_only=True),
    Check("aircraft_track", "aircraft_track", 200, "application/geo+json", True),
    Check("sigmets", "sigmets", 200, "application/geo+json", True),
    Check("sigmet_detail", "sigmet_detail", 200, "application/json", True),
    Check("alerts", "alerts", 200, "application/json", True),
    Check("alerts_history", "alerts_history", 200, "application/json", True),
    Check("radar_frames", "radar_frames", 200, "application/json", True),
    Check("airports", "airports", 200, "application/geo+json", True),
    Check("airport_wx", "airport_wx", 200, "application/json", True),
    Check("replay", "replay", 200, "application/json", True),
    Check("stats_traffic", "stats_traffic", 200, "application/json", True),
    Check("stats_alerts", "stats_alerts", 200, "application/json", True),
    Check("stats_sigmet", "stats_sigmet", 200, "application/json", True),
    Check("problem_400", "problem", 400, "application/problem+json", False),
    Check("problem_404", "problem", 404, "application/problem+json", False),
]


@dataclass
class Response:
    path: str
    status: int
    content_type: str
    cache_control: str
    body: Any


# ---------------------------------------------------------------- 입력


def fetch(base: str, path: str) -> Response:
    # base 는 main() 에서 http/https 만 허용한다(file: 등 다른 스킴 차단)
    req = urllib.request.Request(base.rstrip("/") + path, headers={"Accept": "*/*", "User-Agent": "wakeline-rest-contract-check"})  # noqa: S310
    try:
        with urllib.request.urlopen(req, timeout=15) as r:  # noqa: S310 — 사용자가 지정한 스택 URL
            status, headers, raw = r.status, r.headers, r.read()
    except urllib.error.HTTPError as e:
        status, headers, raw = e.code, e.headers, e.read()
    body = json.loads(raw) if raw else None
    return Response(path, status, headers.get("Content-Type", ""), headers.get("Cache-Control", ""), body)


def live_paths(base: str) -> dict[str, str | None]:
    """실행 중인 스택: 데이터에 따라 달라지는 경로는 앞 응답에서 id 를 고른다."""
    bbox = "124,33,132,39"
    aircraft_path = f"/api/v1/aircraft?bbox={bbox}"
    sigmets_path = "/api/v1/sigmets"
    airports_path = "/api/v1/airports"
    paths: dict[str, str | None] = {
        "status": "/api/v1/status",
        "aircraft": aircraft_path,
        "aircraft_full": f"/api/v1/aircraft?bbox={bbox}&detail=full",
        "sigmets": sigmets_path,
        "alerts": "/api/v1/alerts",
        "alerts_history": "/api/v1/alerts/history",
        "radar_frames": "/api/v1/radar/frames",
        "airports": airports_path,
        "replay": "/api/v1/replay?"
        + urllib.parse.urlencode({"at": datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ"), "bbox": bbox}, safe=","),
        "stats_traffic": "/api/v1/stats/traffic",
        "stats_alerts": "/api/v1/stats/alerts",
        "stats_sigmet": "/api/v1/stats/sigmet",
        "problem_400": "/api/v1/aircraft?bbox=1,2,3",
        "problem_404": "/api/v1/ops/providers",
    }
    ac = fetch(base, aircraft_path).body or {}
    feats = ac.get("features") or []
    hex_ = feats[0]["id"] if feats else None
    paths["aircraft_detail"] = f"/api/v1/aircraft/{hex_}" if hex_ else None
    paths["aircraft_track"] = f"/api/v1/aircraft/{hex_}/track" if hex_ else None
    cs = (feats[0].get("properties", {}).get("callsign") or "").strip() if feats else ""
    paths["aircraft_search"] = (
        f"/api/v1/aircraft/search?q={urllib.parse.quote(cs[:4] if len(cs) >= 2 else hex_ or '')}" if hex_ else None
    )
    sg = (fetch(base, sigmets_path).body or {}).get("features") or []
    paths["sigmet_detail"] = "/api/v1/sigmets/" + urllib.parse.quote(sg[0]["id"], safe="") if sg else None
    ap = (fetch(base, airports_path).body or {}).get("features") or []
    paths["airport_wx"] = f"/api/v1/airports/{ap[0]['id']}/wx" if ap else None
    return paths


def load_dir(d: Path) -> dict[str, Response]:
    out: dict[str, Response] = {}
    for f in sorted(d.glob("*.json")):
        if f.name == "index.json":
            continue
        s = json.loads(f.read_text())
        out[s["name"]] = Response(s["path"], s["status"], s.get("content_type") or "", s.get("cache_control") or "", s["body"])
    return out


# ---------------------------------------------------------------- 검사


def check(c: Check, r: Response) -> list[str]:
    errs: list[str] = []
    if r.status != c.status:
        errs.append(f"status {r.status} != {c.status}")
    if not r.content_type.startswith(c.media):
        errs.append(f"Content-Type {r.content_type!r} is not {c.media}")
    if c.public_cache and "public" not in r.cache_control:
        errs.append(f"Cache-Control {r.cache_control!r} lacks 'public'")
    v = Draft202012Validator(SCHEMAS[c.schema], format_checker=FORMATS)
    for e in sorted(v.iter_errors(r.body), key=lambda e: list(e.absolute_path)):
        errs.append(f"{e.json_path}: {e.message[:160]}")
    if c.schema == "problem" and isinstance(r.body, dict):
        if r.body.get("status") != r.status:
            errs.append("problem.status differs from the HTTP status")
        if r.body.get("instance") != r.path.split("?")[0]:
            errs.append("problem.instance is not the request path")
    return errs


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    src = ap.add_mutually_exclusive_group(required=True)
    src.add_argument("--base-url", help="running stack, e.g. http://localhost:8700")
    src.add_argument("--dir", type=Path, help="recorded responses from RestSamplesIT (apps/api/build/rest-samples)")
    ap.add_argument("--strict", action="store_true", help="treat skipped (no data) checks as failures")
    a = ap.parse_args(argv)
    if a.base_url and urllib.parse.urlsplit(a.base_url).scheme not in ("http", "https"):
        ap.error("--base-url must be an http(s) URL")

    responses: dict[str, Response | None] = {}
    try:
        if a.dir:
            if not a.dir.is_dir():
                print(f"no such directory: {a.dir} (run the api tests first: cd apps/api && ./gradlew test)")
                return 2
            responses.update(load_dir(a.dir))
        else:
            for name, path in live_paths(a.base_url).items():
                responses[name] = fetch(a.base_url, path) if path else None
    except (urllib.error.URLError, OSError, json.JSONDecodeError) as e:
        print(f"cannot read responses: {e}")
        return 2

    checks = [c for c in CHECKS if a.dir or not c.recorded_only]
    failures = skipped = 0
    for c in checks:
        r = responses.get(c.name)
        if r is None:
            print(f"skip {c.name}: no data to derive the request from")
            skipped += 1
            continue
        errs = check(c, r)
        print(f"{'FAIL' if errs else 'ok  '} {c.name:16} {r.path}")
        for msg in errs[:8]:
            print("      ", msg)
        failures += bool(errs)
    passed = len(checks) - failures - skipped
    print(
        f"rest contract check: {passed} passed, {failures} failed, {skipped} skipped —",
        "FAILED" if failures or (a.strict and skipped) else "PASSED",
    )
    return 1 if failures or (a.strict and skipped) else 0


if __name__ == "__main__":
    sys.exit(main())
