#!/usr/bin/env python3
"""REST 계약 검사(설계 14.1 — Java → Python 방향): Java api 가 만든 REST 응답이 웹·도구가 읽는 필드 계약(계약서 §1·§2,
계약 v2 §A3 수요·§B3 선박, 계약 v5 §B1 선박 검색, ADR-023 연안 교통량, 계약 v5 §G27 관측 수신 범위)을 지키는지 JSON Schema(Draft 2020-12)와 몇 가지 교차 검사(스키마로 못 쓰는 값 사이 관계)로 확인한다.
한쪽만 고치면 이 검사가 깨진다.

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
import itertools
import json
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
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

# 기상청 합성 레이더(ADR-021): 헤더 STN_LIST 는 48 자리 — 합성 지점 수 · 기준은 0–48, 코드는 영숫자 1–6자
KR_SITES: Schema = {"type": "integer", "minimum": 0, "maximum": 48}
KR_STATION_IDS: Schema = {"type": "array", "maxItems": 48, "items": {"type": "string", "pattern": "^[A-Za-z0-9]{1,6}$"}}
KR_FRAME: Schema = {  # /radar/kr frames[] — 허용 목록만. 지점 필드가 없는 옛 항목은 모름(키 없음)
    "type": "object",
    "additionalProperties": False,
    "required": ["tm", "obs_tm", "fetched_at", "echo_cells", "url"],
    "properties": {
        "tm": {"type": "string", "pattern": "^[0-9]{12}$"},
        "obs_tm": STR,
        "fetched_at": STR,
        "echo_cells": {"type": "integer", "minimum": 0},
        "url": {"type": "string", "pattern": r"^/api/v1/radar/kr/[0-9]{12}\.png(\?v=[0-9]+)?$"},
        "stations": KR_SITES,
        "station_ids": KR_STATION_IDS,
        "stations_ref": KR_SITES,
        "partial": BOOL,
        "refetches": {"type": "integer", "minimum": 0},
        "upgrades": {"type": "integer", "minimum": 0},
        "refetched_at": TS,
        "refetch_until": TS,
    },
}

# 기상청 내려받기 '파일 없음' 연속(2026-09-30 — 목록은 EXT 로 싣는데 내려받기가 RDR_CMP_HSR_PUB_<tm>.bin.gz 없음): 핵심 값 넷은 늘 함께(api 는
# 하나라도 틀리면 연속 전체를 뺀다), 파일 이름 · 목록 종류는 기상청 글자 그대로일 때만. tm 순서는 교차 검사(_kr_missing_errors)
KR_MISSING: Schema = {
    "type": "object",
    "additionalProperties": False,
    "required": ["since_tm", "last_tm", "tms", "checked_at"],
    "properties": {
        "since_tm": {"type": "string", "pattern": "^[0-9]{12}$"},
        "last_tm": {"type": "string", "pattern": "^[0-9]{12}$"},
        "tms": {"type": "integer", "minimum": 1},
        "checked_at": TS,
        "file": {"type": "string", "pattern": r"^RDR_CMP_[A-Z]+_[A-Z]+_[0-9]{12}\.bin\.gz$"},
        "listed": {"type": "array", "minItems": 1, "maxItems": 8, "items": {"type": "string", "pattern": "^[A-Z]{1,8}$"}},
        # 계약 v5 §G26: 수집기의 지금 확인 간격(초 — 5분마다면 주기, 긴 연속에서 늦춘 15분). 옛 수집기면 없다
        "probe_every_s": {"type": "integer", "minimum": 1, "maximum": 86400},
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

# 계약 v4 §A 등록 노선(adsbdb, 콜사인 기준) — 값이 없으면 키가 없다. 공항은 icao·name·좌표가 반드시 있다.
ROUTE_AIRPORT: Schema = {
    "type": "object",
    "required": ["icao", "name", "lat", "lon"],
    "additionalProperties": False,
    "properties": {
        "icao": {"type": "string", "pattern": "^[A-Z0-9]{4}$"},
        "iata": {"type": "string", "pattern": "^[A-Z0-9]{3}$"},
        "name": {"type": "string", "minLength": 1, "maxLength": 120},
        "city": {"type": "string", "minLength": 1, "maxLength": 80},
        "country": {"type": "string", "minLength": 1, "maxLength": 80},
        "country_iso": {"type": "string", "pattern": "^[A-Z]{2}$"},
        "lat": {"type": "number", "minimum": -90, "maximum": 90},
        "lon": {"type": "number", "minimum": -180, "maximum": 180},
    },
}
ROUTE: Schema = {
    "type": "object",
    "required": ["status", "source"],
    "additionalProperties": False,
    "properties": {
        "status": {"enum": ["found", "not_found", "pending", "unavailable", "no_callsign", "disabled"]},
        "callsign": {"type": "string", "pattern": "^[A-Z0-9]{3,8}$"},
        "airline": {
            "type": "object",
            "minProperties": 1,
            "additionalProperties": False,
            "properties": {
                "name": {"type": "string", "minLength": 1, "maxLength": 120},
                "icao": {"type": "string", "pattern": "^[A-Z0-9]{3}$"},
                "iata": {"type": "string", "pattern": "^[A-Z0-9]{2}$"},
            },
        },
        "origin": ROUTE_AIRPORT,
        "destination": ROUTE_AIRPORT,
        "midpoint": ROUTE_AIRPORT,
        "fetched_at": TS,
        "source": {"const": "adsbdb"},
    },
    "allOf": [
        # 콜사인이 없으면 조회하지 않는다 — 그 밖의 상태는 어느 콜사인의 결과인지 밝힌다
        {
            "if": {"properties": {"status": {"const": "no_callsign"}}},
            "then": {"not": {"required": ["callsign"]}},
            "else": {"required": ["callsign"]},
        },
        # 찾음은 출발·도착 중 하나 이상, 그 밖에는 노선 내용이 없다(추정해 채우지 않는다)
        {
            "if": {"properties": {"status": {"const": "found"}}},
            "then": {"anyOf": [{"required": ["origin"]}, {"required": ["destination"]}]},
            "else": {
                "not": {
                    "anyOf": [
                        {"required": ["airline"]},
                        {"required": ["origin"]},
                        {"required": ["destination"]},
                        {"required": ["midpoint"]},
                    ]
                }
            },
        },
        # 조회 시각은 조회 결과(찾음·없음)에만 — disabled(계약 v4 §G A-2: 운영 설정으로 묻지 않음)는 조회 결과가 아니다
        {
            "if": {"properties": {"status": {"enum": ["pending", "unavailable", "no_callsign", "disabled"]}}},
            "then": {"not": {"required": ["fetched_at"]}},
        },
    ],
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
        # sigmet_ended(DH-6): SIGMET 만료·철회로 닫힘 — 이탈이 아니다(V4 CHECK 와 같은 목록)
        "close_reason": {"enum": ["left", "signal_lost", "restart", "sigmet_ended", "prediction_cleared"]},
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
        # raw_text_lower_bound(DH-4): 'TOP ABV FLnnn' — top_ft 는 하한(판정은 상한 무제한 가정, 증거에 표시)
        "top_source": {"enum": ["json", "raw_text", "raw_text_lower_bound", "unknown"]},
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
            "if": {
                "properties": {"top_source": {"enum": ["json", "raw_text", "raw_text_lower_bound"]}},
                "required": ["top_source"],
            },
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
        # 문제 유형 URI 는 해석되지 않는 예약 도메인(RFC 6761 .invalid) — 남의 도메인을 가리키지 않는다
        "type": {"type": "string", "pattern": "^https://wakeline\\.invalid/problems/[a-z0-9-]+$"},
        "title": {"type": "string", "minLength": 1},
        "status": {"type": "integer", "minimum": 400, "maximum": 599},
        "detail": STR,
        "instance": {"type": "string", "pattern": "^/"},
        "code": {"type": "string", "pattern": "^[A-Z_]+$"},
        "request_id": {"type": "string", "minLength": 8},
    },
    "not": {"anyOf": [{"required": ["trace"]}, {"required": ["exception"]}, {"required": ["stackTrace"]}]},
}

# ---------------------------------------------------------------- 선박(계약 v2 §B2·§B3) — 값이 없으면 키가 없다(null 을 싣지 않는다)

MMSI: Schema = {"type": "string", "pattern": "^[0-9]{9}$"}
SHIP_CATEGORY: Schema = {  # api ShipCategory · web lib/ships.ts 한 표(USCG AIS 표에서 결정적으로)
    "enum": ["cargo", "tanker", "passenger", "fishing", "tug", "pleasure", "hsc", "special", "military", "other", "unknown"]
}
# 계약 v3 §B: Timestamp 0~59 = epfs, 61·62·63 = manual·estimated·inoperative, 그 밖(60·누락)은 모름 → 키 없음.
# 레거시 "gnss" 는 api 가 받자마자 모름으로 바꾸므로 REST 에 나오면 안 된다.
POSITION_SOURCE: Schema = {"enum": ["epfs", "manual", "estimated", "inoperative"]}
SHIP_PROVIDER: Schema = {"enum": ["aisstream", "fixture"]}
LAT_NUM: Schema = {"type": "number", "minimum": -90, "maximum": 90}
LON_NUM: Schema = {"type": "number", "minimum": -180, "maximum": 180}
SHIP_KINEMATICS: dict[str, Any] = {
    "lat": LAT_NUM,
    "lon": LON_NUM,
    "sog_kn": {"type": "number", "minimum": 0, "maximum": 102.2},  # 102.3 = 값 없음 → 키 없음
    "cog_deg": {"type": "number", "minimum": 0, "exclusiveMaximum": 360},  # 360 = 값 없음
    "heading_deg": {"type": "integer", "minimum": 0, "maximum": 359},  # 511 = 값 없음
    "nav_status": {"type": "integer", "minimum": 0, "maximum": 15},
    "position_source": POSITION_SOURCE,
    "seen_at": TS,
}
SHIP_LITE: Schema = {  # ShipLite(목록·WS 점) — 나열된 키만. position_source 는 모르면 키 없음(계약 v3 §B)
    "type": "object",
    "required": ["mmsi", "lat", "lon", "seen_at"],
    "additionalProperties": False,
    "properties": {
        "mmsi": MMSI,
        **SHIP_KINEMATICS,
        "ship_type": {"type": "integer", "minimum": 1, "maximum": 99},  # 0 = 값 없음
        "name": {"type": "string", "minLength": 1, "maxLength": 20},
    },
}
SHIP_STATE: Schema = {  # ship_state.v1 그대로(null 키는 빠진다)
    "type": "object",
    "required": ["mmsi", "lat", "lon", "seen_at", "provider", "msg_type", "class"],
    "additionalProperties": False,
    "properties": {
        "mmsi": MMSI,
        **SHIP_KINEMATICS,
        "rot": {"type": "integer", "minimum": -127, "maximum": 127},
        "provider": SHIP_PROVIDER,
        "msg_type": {"enum": ["PositionReport", "StandardClassBPositionReport", "ExtendedClassBPositionReport"]},
        "class": {"enum": ["A", "B"]},
    },
}
SHIP_STATIC: Schema = {  # ship_static.v1 그대로(선원 입력값 — ETA 는 연도 없음)
    "type": "object",
    "required": ["mmsi", "provider"],
    "additionalProperties": False,
    "properties": {
        "mmsi": MMSI,
        "name": {"type": "string", "minLength": 1, "maxLength": 20},
        "call_sign": {"type": "string", "minLength": 1, "maxLength": 7},
        "imo": {"type": "integer", "minimum": 1000000, "maximum": 1073741823},
        "ship_type": {"type": "integer", "minimum": 1, "maximum": 99},
        **{k: {"type": "integer", "minimum": 0, "maximum": 511} for k in ("dim_a", "dim_b", "dim_c", "dim_d")},
        "draught_m": {"type": "number", "exclusiveMinimum": 0, "maximum": 25.5},
        "destination": {"type": "string", "minLength": 1, "maxLength": 20},
        "eta_month": {"type": "integer", "minimum": 1, "maximum": 12},
        "eta_day": {"type": "integer", "minimum": 1, "maximum": 31},
        "eta_hour": {"type": "integer", "minimum": 0, "maximum": 23},
        "eta_minute": {"type": "integer", "minimum": 0, "maximum": 59},
        "updated_at": TS,
        "provider": SHIP_PROVIDER,
    },
}
# 계약 v4 §B: 보고 목적지의 결정적 풀이 — 항구 표(UN/LOCODE)에서 찾은 조각만 locode·name·country 가 있다
PLACE: Schema = {
    "type": "object",
    "required": ["text", "ambiguous"],
    "additionalProperties": False,
    "properties": {
        "text": {"type": "string", "minLength": 1, "maxLength": 20},
        "locode": {"type": "string", "pattern": "^[A-Z]{2}[A-Z0-9]{3}$"},
        "name": {"type": "string", "minLength": 1, "maxLength": 120},
        "country": {"type": "string", "pattern": "^[A-Z]{2}$"},
        "subdivision": {"type": "string", "pattern": "^[A-Z0-9]{1,3}$"},
        "ambiguous": BOOL,
    },
    "allOf": [
        {"if": {"required": ["locode"]}, "then": {"required": ["name", "country"]}},
        {
            "if": {"not": {"required": ["locode"]}},
            "then": {"not": {"anyOf": [{"required": ["name"]}, {"required": ["country"]}, {"required": ["subdivision"]}]}},
        },
        # 코드로도 지명으로도 읽히는 것은 코드로 푼 경우뿐
        {"if": {"properties": {"ambiguous": {"const": True}}}, "then": {"required": ["locode"]}},
    ],
}
DESTINATION_INFO: Schema = {
    "type": "object",
    "required": ["raw", "kind", "places"],
    "additionalProperties": False,
    "properties": {
        "raw": {"type": "string", "minLength": 1, "maxLength": 20},
        "kind": {"enum": ["between", "from_to", "to", "text"]},
        "from": PLACE,
        "to": PLACE,
        "places": {"type": "array", "minItems": 1, "maxItems": 2, "items": PLACE},
    },
    "allOf": [
        # AIS 에는 출발지 항목이 없다 — 출발(보고)은 'A>B' 의 A 뿐
        {
            "if": {"properties": {"kind": {"const": "from_to"}}},
            "then": {"required": ["from", "to"]},
            "else": {"not": {"required": ["from"]}},
        },
        {
            "if": {"properties": {"kind": {"const": "between"}}},
            "then": {"not": {"required": ["to"]}},
            "else": {"required": ["to"]},
        },
        {
            "if": {"properties": {"kind": {"enum": ["between", "from_to"]}}},
            "then": {"properties": {"places": {"minItems": 2}}},
            "else": {"properties": {"places": {"maxItems": 1}}},
        },
    ],
}
AIS_SCOPE: Schema = {  # 계약 v4 §D: 구역 하나의 상자 문자열('|' 없음) — 규칙 전체는 교차 검사(_scope_errors)
    "type": "string",
    "minLength": 1,
    "maxLength": 1024,
    "pattern": "^[^|]+$",
}
GAP: Schema = {  # AIS 수신 공백(끝난 공백은 ended_at, 열린 공백은 키 없음, 구역 공백은 scope — 구역 없는 옛 기록은 키 없음)
    "type": "object",
    "required": ["started_at", "reason"],
    "properties": {
        "started_at": TS,
        "ended_at": TS,
        "reason": {"type": "string", "minLength": 1},
        "provider": STR,
        "scope": AIS_SCOPE,
    },
}
AIS_BOX: Schema = {  # [lat1, lon1, lat2, lon2]
    "type": "array",
    "minItems": 4,
    "maxItems": 4,
    "prefixItems": [LAT_NUM, LON_NUM, LAT_NUM, LON_NUM],
    "items": False,
}
AIS_STATES: Schema = {
    "enum": ["starting", "connecting", "subscribed", "receiving", "backoff", "replaying", "disabled", "stopped"]
}
AIS_SHARD: Schema = {  # 계약 v4 §D status.sources.ais.shards[] — 구역 하나(연결 하나)의 범위·상태
    "type": "object",
    "required": ["coverage"],
    "additionalProperties": False,
    "properties": {
        "coverage": {"type": "array", "minItems": 1, "maxItems": 16, "items": AIS_BOX},
        "state": AIS_STATES,
        "connected": BOOL,
        "gap_open_since": TS,
    },
}
AIS_SOURCE: Schema = {  # status.sources.ais · ships meta.ais — 수집기 heartbeat 가 오래되면 connected·msgs_per_s 는 키 없음(모름)
    "type": "object",
    "required": ["heartbeat_stale", "ships"],
    "additionalProperties": False,  # 수집기 내부 오류 문구 등이 새지 않게 나열된 키만
    "properties": {
        "connected": BOOL,
        "lag_s": {"type": "number", "minimum": 0},
        "msgs_per_s": {"type": "number", "minimum": 0},
        "gap_open_since": TS,
        "last_gap": {
            "type": "object",
            "required": ["started_at", "ended_at"],
            "additionalProperties": False,
            # 계약 v4 G: 구역 공백이면 scope(구역 하나의 상자 문자열), 구역 없는 공백은 키 없음
            "properties": {"started_at": TS, "ended_at": TS, "reason": STR, "scope": AIS_SCOPE},
        },
        "provider": SHIP_PROVIDER,
        "last_msg_at": TS,
        "ships": {"type": "integer", "minimum": 0},
        # 계약 v3 §A: 수집기 상태 이름(그 밖이면 키 없음) · 지금 구독한 상자 [[lat1, lon1, lat2, lon2], ...]
        # 계약 v4 §D·§G D-2: 구역(최대 3, 구역마다 상자 1~16)이 있으면 coverage 는 구독한 구역 상자의 합 — 최대 48개
        "state": AIS_STATES,
        "coverage": {"type": "array", "minItems": 1, "maxItems": 48, "items": AIS_BOX},
        "shards": {"type": "array", "minItems": 1, "maxItems": 3, "items": AIS_SHARD},
        "heartbeat_stale": BOOL,
    },
    # 오래된 heartbeat 로 '연결됨'·수신량·상태·수신 범위·구역 상태를 말하지 않는다
    "if": {"properties": {"heartbeat_stale": {"const": True}}, "required": ["heartbeat_stale"]},
    "then": {
        "not": {
            "anyOf": [
                {"required": ["connected"]},
                {"required": ["msgs_per_s"]},
                {"required": ["state"]},
                {"required": ["coverage"]},
                {"required": ["shards"]},
            ]
        }
    },
}
DEMAND_COUNTS: Schema = {  # /status demand — 수만(hex·셀 키를 공개하지 않는다)
    "type": "object",
    "required": ["hot_active", "focus_active"],
    "additionalProperties": False,
    "properties": {
        "hot_active": {"type": "integer", "minimum": 0, "maximum": 6},
        "focus_active": {"type": "integer", "minimum": 0, "maximum": 50},
        "adsb_fi_rps_1m": {"type": "number", "minimum": 0},
    },
}

# R-45: 통계의 날짜는 날짜 문자열 "YYYY-MM-DD" 만(자정 시각 문자열 "…T00:00:00.000Z" 는 JVM 시간대에 따라 하루 밀렸다).
# 계약 v5 §G20: 그 날짜는 KST 날짜 — 응답이 day_zone "Asia/Seoul" 로 밝힌다(V16 전의 UTC 날짜 집계는 보관 표에만 있고 내지 않는다).
STATS_DAY: Schema = {"type": "string", "format": "date", "pattern": "^[0-9]{4}-[0-9]{2}-[0-9]{2}$"}
STATS_DAY_ZONE: Schema = {"const": "Asia/Seoul"}
STATS_ROW: Schema = {
    "type": "object",
    "required": ["day", "dim", "value"],
    "additionalProperties": False,
    "properties": {"day": STATS_DAY, "dim": STR, "value": NUM},
}
# 범위의 날마다 집계를 마쳤는가 — 행이 없는 날이 '자료 없음'(true)인지 '집계 전'(false)인지
STATS_DAYS: Schema = {
    "type": "array",
    "items": {
        "type": "object",
        "required": ["day", "aggregated"],
        "additionalProperties": False,
        "properties": {"day": STATS_DAY, "aggregated": BOOL},
    },
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


# 계약 v5 §B1 선박 검색 — 다른 선박 응답과 달리 항목의 키 13개(§B1 12개 + §G4 last_seen_at)가 늘 있고 모르는 값은 null
# (실시간이 아니면 위치·속력·보고 시각이 null, 실시간이면 last_seen_at 이 null — seen_at 이 마지막 수신)
def nullable(schema: Schema) -> Schema:
    return {"anyOf": [{"type": "null"}, schema]}


SHIP_SEARCH_ITEM: Schema = {
    "type": "object",
    "required": [
        "mmsi",
        "name",
        "call_sign",
        "imo",
        "ship_type",
        "category",
        "live",
        "lat",
        "lon",
        "sog_kn",
        "seen_at",
        "last_position_at",
        "last_seen_at",
    ],
    "additionalProperties": False,
    "properties": {
        "mmsi": MMSI,
        **{k: nullable(SHIP_STATIC["properties"][k]) for k in ("name", "call_sign", "imo", "ship_type")},
        "category": SHIP_CATEGORY,
        "live": BOOL,
        "lat": nullable(LAT_NUM),
        "lon": nullable(LON_NUM),
        "sog_kn": nullable(SHIP_KINEMATICS["sog_kn"]),
        "seen_at": nullable(TS),
        "last_position_at": nullable(TS),  # DB 의 마지막 저장 위치 시각(보존 72 h 안) — 없으면 null
        # §G4: 저장만 된 선박의 마지막 수신 기록 — ship.last_seen(어떤 AIS 메시지든), 저장 위치가 더 늦으면 그 시각. 보존 밖이어도 있다
        "last_seen_at": nullable(TS),
    },
    "allOf": [
        # 실시간이 아니면 위치를 지어내지 않는다(null) — 마지막 수신 기록은 저장 행(ship.last_seen NOT NULL)에서 늘 안다.
        # 실시간이면 위치와 보고 시각이 있고 last_seen_at 은 null(10분 단위 DB 값을 seen_at 과 겹쳐 싣지 않는다)
        {
            "if": {"properties": {"live": {"const": False}}},
            "then": {"properties": {**{k: {"type": "null"} for k in ("lat", "lon", "sog_kn", "seen_at")}, "last_seen_at": TS}},
            "else": {"properties": {"lat": LAT_NUM, "lon": LON_NUM, "seen_at": TS, "last_seen_at": {"type": "null"}}},
        },
        # 분류는 선종 코드의 결정적 변환 — 코드가 없으면 unknown, 코드(1–99)가 있으면 unknown 이 아니다
        {
            "if": {"properties": {"ship_type": {"type": "null"}}},
            "then": {"properties": {"category": {"const": "unknown"}}},
            "else": {"properties": {"category": {"not": {"const": "unknown"}}}},
        },
    ],
}
SHIP_SEARCH_Q: Schema = {"type": "string", "pattern": "^[A-Z0-9 .\\-/]{2,40}$"}  # 정규화(trim · 대문자)한 검색어

COVERAGE_CELL_DEG = 0.5  # api CoverageGrid.CELL_DEG

SCHEMAS: dict[str, dict[str, Any]] = {
    "status": {
        "type": "object",
        # demand(계약 v2 §A3)·sources(§B3)는 값이 없어도 객체가 있다(수를 모르면 키가 빠질 뿐)
        "required": [
            "server_time",
            "snapshot_version",
            "fixture_mode",
            "region",
            "global",
            "sigmet",
            "radar",
            "engine",
            "demand",
            "sources",
            "meta",
        ],
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
            "demand": DEMAND_COUNTS,
            "sources": {"type": "object", "additionalProperties": False, "properties": {"ais": AIS_SOURCE}},
            # R-72: 수집기 해시를 통째로 내보내지 않는다 — 검증한 필드만(모르면 키 없음)
            "radar_kr": {
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    "available": BOOL,
                    "status": {"type": "string", "pattern": "^[1-5][0-9]{2}$"},
                    "latest_tm": {"type": "string", "pattern": "^[0-9]{12}$"},
                    "fetched_at": TS,
                    "checked_at": TS,
                    # ADR-021: 최신 프레임의 합성 지점 수 · 기준 · 부분 합성(코드 목록은 /radar/kr 에만)
                    "stations": KR_SITES,
                    "stations_ref": KR_SITES,
                    "partial": BOOL,
                    "missing": KR_MISSING,
                },
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
            "route": ROUTE,
            "active_alerts": {"type": "array", "items": ALERT},
            "inside_sigmets": {"type": "array", "items": STR},
            "emergency": BOOL,
            "meta": META,
        },
        "allOf": [
            # DB 가 없으면 static 이 없고 meta 가 그렇다고 말한다(계약 §2)
            {"if": {"not": {"required": ["static"]}}, "then": {"properties": {"meta": {"required": ["db_unavailable"]}}}},
            # 노선은 실시간 상태의 콜사인에서만 나온다(계약 v4 §A) — 상태가 없으면 route 도 없고, 있으면 route 가 반드시 있다
            {"if": {"not": {"required": ["state"]}}, "then": {"not": {"required": ["route"]}}},
            {"if": {"required": ["state"]}, "then": {"required": ["route"]}},
        ],
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
                # R-52: 점 수 상한 5,000(선박 항적과 같다) — 넘으면 앞에서부터(시간순) 자르고 truncated = true
                "required": ["hex", "from", "to", "points", "truncated"],
                "properties": {
                    "hex": HEX,
                    "from": TS,
                    "to": TS,
                    "points": {"type": "integer", "minimum": 0, "maximum": 5000},
                    "truncated": BOOL,
                },
            },
            "points": {
                "type": "array",
                "maxItems": 5000,
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
        # R-74: 커서 페이지의 next_cursor 는 숫자(다음 쪽 있음) 또는 없음/null — 빈 문자열 등 다른 형은 안 된다
        "properties": {
            "items": {"type": "array", "items": HISTORY_ALERT},
            "next_cursor": {"type": ["integer", "null"], "minimum": 1},
            "meta": META,
        },
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
    "radar_kr": {  # FR-31 · ADR-012 · ADR-021: 기상청 합성 레이더 — 최상위 지점 필드는 최신 프레임의 값(교차 검사 _radar_kr)
        "type": "object",
        "required": ["available", "georeferenced", "frames", "time_zone", "attribution", "meta"],
        "properties": {
            "available": BOOL,
            "georeferenced": BOOL,
            "latest_tm": STR,
            "coordinates": {
                "type": "array",
                "minItems": 4,
                "maxItems": 4,
                "items": {"type": "array", "minItems": 2, "maxItems": 2, "items": NUM},
            },
            "image_size": {"type": "array", "minItems": 2, "maxItems": 2, "items": {"type": "integer", "minimum": 1}},
            "frames": {"type": "array", "maxItems": 12, "items": KR_FRAME},
            "stations": KR_SITES,
            "station_ids": KR_STATION_IDS,
            "stations_ref": KR_SITES,
            "partial": BOOL,
            "missing": KR_MISSING,
            "time_zone": STR,
            "attribution": STR,
            "meta": META,
        },
    },
    "traffic_grid": {  # ADR-023: 연안 교통량 — 5분 집계 격자별 선박 척수(개별 위치 아님). 모르는 값은 키가 없다(non_null). 교차 검사 _traffic_grid
        "type": "object",
        "additionalProperties": False,
        "required": ["available", "status", "stale_after_s", "cell_deg", "cells", "source", "time_zone", "meta"],
        "properties": {
            "available": BOOL,
            "status": {"enum": ["ok", "stale", "disabled", "no_data", "invalid"]},
            "disabled_reason": {"enum": ["no_key", "fixture", "operator_off"]},
            "reg_dt_kst": {"type": "string", "format": "date-time", "pattern": r"\+09:00$"},
            "reg_dt_utc": TS,
            "fetched_at": TS,
            "age_s": {"type": "integer", "minimum": 0},
            "stale_after_s": {"const": 900},
            **{
                k: {"type": "integer", "minimum": 0}
                for k in (
                    "total",
                    "total_count",
                    "rejected",
                    "resolved",
                    "unresolved",
                    "pending",
                    "not_found",
                    "off_grid",
                    "failed",
                    "invalid_cells",
                )
            },
            "partial": BOOL,
            "cell_deg": {"const": 0.025},
            "cells": {
                "type": "array",
                "maxItems": 20000,
                "items": {  # [grid_no, lat_min, lon_min, 척수, 밀집도 %]
                    "type": "array",
                    "prefixItems": [
                        {"type": "string", "pattern": "^[A-Za-z0-9_]{1,32}$"},
                        {"type": "number", "minimum": -90, "maximum": 89.975},
                        {"type": "number", "minimum": -180, "maximum": 179.975},
                        {"type": "integer", "minimum": 0},
                        {"type": "number", "minimum": 0, "maximum": 100},
                    ],
                    "items": False,
                    "minItems": 5,
                },
            },
            "source": {
                "type": "object",
                "additionalProperties": False,
                "required": ["provider", "grid", "note"],
                "properties": {
                    "provider": {"const": "한국해양교통안전공단 MTIS 실시간 해양교통정보"},
                    "grid": {"const": "해양수산부 해양격자 4단계"},
                    "note": {"const": "5분 집계 — 격자별 선박 척수(개별 위치 아님)"},
                },
            },
            "time_zone": STR,
            "meta": META,
        },
    },
    # 계약 v5 §G27 · ADR-027: 관측 수신 범위 — 이 서비스가 받은 AIS 위치의 0.5° 칸별 집계(최근 24 h, 구독 범위 아님). 교차 검사 _ship_coverage
    "ship_coverage": {
        "type": "object",
        "additionalProperties": False,
        "required": [
            "cell_deg",
            "window",
            "since",
            "covered",
            "api_started_at",
            "live_from",
            "bootstrap",
            "generated_at",
            "cells",
            "cell_count",
            "positions",
            "truncated",
            "dropped_positions",
            "limits",
            "sampling",
            "note",
            "time_zone",
            "meta",
        ],
        "properties": {
            "cell_deg": {"const": COVERAGE_CELL_DEG},
            "window": {
                "type": "object",
                "additionalProperties": False,
                "required": ["hours", "bucket_s", "from", "to"],
                "properties": {"hours": {"const": 24}, "bucket_s": {"const": 3600}, "from": TS, "to": TS},
            },
            "since": TS,
            "covered": {"enum": ["full", "partial", "since_api_start"]},
            "api_started_at": TS,
            "live_from": TS,
            "bootstrap": {
                "type": "object",
                "additionalProperties": False,
                "required": ["state", "hours_loaded", "hours_total", "rows", "loaded_from"],
                "properties": {
                    "state": {"enum": ["pending", "running", "done", "failed"]},
                    "hours_loaded": {"type": "integer", "minimum": 0, "maximum": 25},
                    "hours_total": {"type": "integer", "minimum": 0, "maximum": 25},
                    "rows": {"type": "integer", "minimum": 0},
                    "loaded_from": TS,
                    "error": {"enum": ["statement_timeout", "connection", "read_timeout", "deadline", "stopped", "error"]},
                    "finished_at": TS,
                },
                "allOf": [
                    # 실패만 종류를 싣고(서버 글자 없이), 끝난 상태만 끝난 시각을 싣는다
                    {
                        "if": {"properties": {"state": {"const": "failed"}}},
                        "then": {"required": ["error", "finished_at"]},
                        "else": {"not": {"required": ["error"]}},
                    },
                    {
                        "if": {"properties": {"state": {"enum": ["pending", "running"]}}},
                        "then": {"not": {"required": ["finished_at"]}},
                        "else": {"required": ["finished_at"]},
                    },
                ],
            },
            "generated_at": TS,
            "cells": {
                "type": "array",
                "maxItems": 16000,
                "items": {  # [lon0, lat0, 크기, 선박 수, 위치 수, 마지막 수신]
                    "type": "array",
                    "prefixItems": [
                        {"type": "number", "minimum": -180, "maximum": 179.5},
                        {"type": "number", "minimum": -90, "maximum": 89.5},
                        {"const": COVERAGE_CELL_DEG},
                        {"type": "integer", "minimum": 1},
                        {"type": "integer", "minimum": 1},
                        TS,
                    ],
                    "items": False,
                    "minItems": 6,
                },
            },
            "cell_count": {"type": "integer", "minimum": 0},
            "positions": {"type": "integer", "minimum": 0},
            "truncated": BOOL,
            "dropped_positions": {"type": "integer", "minimum": 0},
            "limits": {
                "type": "object",
                "additionalProperties": False,
                "required": ["max_cells", "max_ship_cells"],
                "properties": {
                    "max_cells": {"type": "integer", "minimum": 1},
                    "max_ship_cells": {"type": "integer", "minimum": 1},
                },
            },
            "sampling": {"const": "first_fix_per_60s"},
            "note": STR,
            "time_zone": STR,
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
                    "vis_sm": {"type": "number", "minimum": 0},
                    "vis_raw": {"type": "string", "minLength": 1},  # 원문(예: '6+' = 6 SM 이상 — 하한)
                },
            },
            "history": {  # DH-7: 이력에도 시정 원문(vis_raw) — 하한값이 정확한 값처럼 보이지 않게
                "type": "array",
                "items": {
                    "type": "object",
                    "required": ["obs_time"],
                    "properties": {
                        "obs_time": TS,
                        "flight_cat": {"enum": ["VFR", "MVFR", "IFR", "LIFR"]},
                        "flight_cat_source": {"enum": ["awc", "computed"]},
                        "ceiling_state": {"enum": ["measured", "none", "unknown"]},
                        "vis_sm": {"type": "number", "minimum": 0},
                        "vis_raw": {"type": "string", "minLength": 1},
                        "wind_dir": INT,
                        "wind_kt": NUM,
                        "ceiling_ft": INT,
                        "temp_c": NUM,
                    },
                    "if": {"required": ["flight_cat"]},
                    "then": {"required": ["flight_cat_source"]},
                },
            },
            "meta": META,
        },
    },
    "replay": {
        "type": "object",
        "required": ["at", "aircraft", "sigmets", "source", "meta"],
        "properties": {
            "at": TS,
            "aircraft": {  # DH-11: 1분 요약 행은 averaged = true · samples, 방위·지상 여부 없음(0·false 로 채우지 않는다)
                "type": "array",
                "items": {
                    "type": "object",
                    "required": ["hex", "ts", "lat", "lon", "averaged"],
                    "properties": {
                        "hex": HEX,
                        "ts": TS,
                        "lat": NUM,
                        "lon": NUM,
                        "alt_ft": INT,
                        "gs_kt": NUM,
                        "track_deg": NUM,
                        "on_ground": BOOL,
                        "provider": STR,
                        "averaged": BOOL,
                        "samples": {"type": "integer", "minimum": 1},
                    },
                    "if": {"properties": {"averaged": {"const": True}}, "required": ["averaged"]},
                    "then": {
                        "required": ["samples"],
                        "not": {"anyOf": [{"required": ["track_deg"]}, {"required": ["on_ground"]}]},
                    },
                    "else": {"not": {"required": ["samples"]}},
                },
            },
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
        # R-45: aggregated = 그날 집계를 마쳤는가(false 면 빈 items 는 '0 대' 가 아니라 '집계 전')
        "required": ["day", "day_zone", "aggregated", "items", "meta"],
        "properties": {
            "day": STATS_DAY,
            "day_zone": STATS_DAY_ZONE,
            "aggregated": BOOL,
            "scope": {"const": "region"},
            "region": {  # DH-10: 그날 집계가 센 지역과 실제로 쓴 사각형 — 모르면(옛 집계) scope·region 모두 없음
                "type": "object",
                "required": ["center", "radius_nm", "bbox"],
                "properties": {
                    "center": {"type": "array", "items": NUM, "minItems": 2, "maxItems": 2},
                    "radius_nm": {"type": "number", "exclusiveMinimum": 0},
                    "bbox": {"type": "array", "items": NUM, "minItems": 4, "maxItems": 4},
                },
            },
            "items": {"type": "array", "items": STATS_ROW},
            "meta": META,
        },
        "dependentRequired": {"scope": ["region"], "region": ["scope"]},
    },
    "stats_alerts": {
        "type": "object",
        "required": ["items", "days", "day_zone", "meta"],
        "properties": {
            "day_zone": STATS_DAY_ZONE,
            "items": {
                "type": "array",
                "items": {
                    **STATS_ROW,
                    "required": [*STATS_ROW["required"], "metric"],
                    "properties": {**STATS_ROW["properties"], "metric": {"enum": ["alerts_by_kind", "alert_dwell_avg_s"]}},
                },
            },
            "days": STATS_DAYS,
            "meta": META,
        },
    },
    "stats_sigmet": {
        "type": "object",
        "required": ["items", "group", "days", "day_zone", "meta"],
        "properties": {
            "day_zone": STATS_DAY_ZONE,
            "items": {"type": "array", "items": STATS_ROW},
            "group": {"enum": ["fir", "hazard"]},
            "days": STATS_DAYS,
            "meta": META,
        },
    },
    "ships": feature_collection(
        {
            **point_feature(SHIP_LITE),
            "properties": {**point_feature(SHIP_LITE)["properties"], "id": MMSI},
        },
        {
            **META,
            "required": [*META["required"], "count", "total_in_bbox", "capped"],
            "properties": {
                **META["properties"],
                "count": {"type": "integer", "minimum": 0, "maximum": 5000},
                "total_in_bbox": {"type": "integer", "minimum": 0},
                "capped": BOOL,
                "ais": AIS_SOURCE,
            },
        },
    ),
    "ship_detail": {
        "type": "object",
        "required": ["mmsi", "category", "meta"],
        "additionalProperties": False,
        "properties": {
            "mmsi": MMSI,
            "state": SHIP_STATE,
            "static": SHIP_STATIC,
            # 계약 v5 §G17 — static 의 출처: 메모리(live) · DB 의 마지막 저장 정적 보고(stored). stored 이면 저장 행의 updated_at(= static.updated_at)
            "static_source": {"enum": ["live", "stored"]},
            "static_updated_at": TS,
            "destination_info": DESTINATION_INFO,
            "category": SHIP_CATEGORY,
            "first_recorded_at": TS,
            "last_position_at": TS,
            "last_seen_at": TS,  # 계약 v5 §G4 — 실시간 목록에 없을 때만(검색과 같은 값)
            "meta": META,
        },
        # 분류는 정적 정보의 선종에서만 나온다 — 정적 정보가 없으면 unknown(추정하지 않는다). 목적지 풀이도 정적 정보에서만.
        "if": {"not": {"required": ["static"]}},
        "then": {"properties": {"category": {"const": "unknown"}}, "not": {"required": ["destination_info"]}},
    },
    "ship_track": {
        "type": "object",
        "required": ["type", "geometry", "properties", "points", "gaps", "meta"],
        "properties": {
            "type": {"const": "Feature"},
            "geometry": {
                "type": "object",
                "required": ["type", "coordinates"],
                "properties": {
                    "type": {"const": "MultiLineString"},
                    "coordinates": {  # RFC 7946: LineString 은 2점 이상 — 한 점 구간은 points 에만
                        "type": "array",
                        "items": {
                            "type": "array",
                            "minItems": 2,
                            "items": {"type": "array", "items": NUM, "minItems": 2, "maxItems": 2},
                        },
                    },
                },
            },
            "properties": {
                "type": "object",
                "required": [
                    "mmsi",
                    "from",
                    "to",
                    "points",
                    "truncated",
                    "sampling",
                    "gap_break_min_s",
                    "gaps_truncated",
                    "segments",
                ],
                "properties": {
                    "mmsi": MMSI,
                    "from": TS,
                    "to": TS,
                    "points": {"type": "integer", "minimum": 0, "maximum": 5000},
                    "truncated": BOOL,
                    "sampling": {"const": "first_fix_per_60s"},  # 저장은 60 s 창의 첫 보고 — 화면이 '표본' 임을 밝힌다
                    # 계약 v3 §D: 60 s 이상 끝난 공백·열린 공백만 선을 끊는다 · gaps 는 최신 200개(더 있으면 gaps_truncated)
                    "gap_break_min_s": {"const": 60},
                    "gaps_truncated": BOOL,
                    "segments": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "required": ["start", "end", "points"],
                            "properties": {"start": TS, "end": TS, "points": {"type": "integer", "minimum": 2}},
                        },
                    },
                },
            },
            "points": {
                "type": "array",
                "items": {
                    "type": "object",
                    "required": ["ts", "lat", "lon"],
                    "additionalProperties": False,
                    "properties": {
                        "ts": TS,
                        **{k: v for k, v in SHIP_KINEMATICS.items() if k != "seen_at"},
                    },
                },
            },
            "gaps": {"type": "array", "maxItems": 200, "items": GAP},
            "meta": META,
        },
    },
    "ais_gaps": {
        "type": "object",
        "required": ["from", "to", "items", "truncated", "meta"],
        "properties": {
            "from": TS,
            "to": TS,
            "items": {"type": "array", "maxItems": 500, "items": {**GAP, "required": ["started_at", "ended_at", "reason"]}},
            "truncated": BOOL,
            "open": {"type": "object", "required": ["started_at"], "properties": {"started_at": TS, "reason": STR}},
            "meta": META,
        },
    },
    "ship_search": {
        "type": "object",
        "required": ["items", "meta"],
        "additionalProperties": False,
        "properties": {
            "items": {"type": "array", "maxItems": 20, "items": SHIP_SEARCH_ITEM},
            "meta": {
                **META,
                "required": [*META["required"], "q", "count"],
                "properties": {
                    **META["properties"],
                    "q": SHIP_SEARCH_Q,
                    "count": {"type": "integer", "minimum": 0, "maximum": 20},
                },
            },
        },
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
    Check("radar_kr", "radar_kr", 200, "application/json", True),
    # 기록: 기상청 내려받기 '파일 없음' 연속 중(저장된 프레임은 그대로 · missing 이 까닭을 말한다)
    Check("radar_kr_missing", "radar_kr_missing", 200, "application/json", True, recorded_only=True),
    Check("traffic_grid", "traffic_grid", 200, "application/json", True),
    Check("airports", "airports", 200, "application/geo+json", True),
    Check("airport_wx", "airport_wx", 200, "application/json", True),
    Check("replay", "replay", 200, "application/json", True),
    Check("stats_traffic", "stats_traffic", 200, "application/json", True),
    # 기록: stats_traffic 은 끝난 KST 날짜를 실제로 집계한 응답(행이 있다 — 리뷰 2026-09-30), 이것은 오늘(KST — 집계 전, aggregated false)
    Check("stats_traffic_today", "stats_traffic", 200, "application/json", True, recorded_only=True),
    Check("stats_alerts", "stats_alerts", 200, "application/json", True),
    Check("stats_sigmet", "stats_sigmet", 200, "application/json", True),
    Check("problem_400", "problem", 400, "application/problem+json", False),
    Check("problem_404", "problem", 404, "application/problem+json", False),
    Check("ships", "ships", 200, "application/geo+json", True),
    Check("ship_detail", "ship_detail", 200, "application/json", True),
    Check("ship_track", "ship_track", 200, "application/geo+json", True),
    Check("ais_gaps", "ais_gaps", 200, "application/json", True),
    Check("problem_bad_mmsi", "problem", 400, "application/problem+json", False),
    # 기록에만: 정적 정보 없는 선박(분류 unknown), 수집기 heartbeat 가 있는 /status(sources.ais · demand.adsb_fi_rps_1m)
    Check("ship_detail_nostatic", "ship_detail", 200, "application/json", True, recorded_only=True),
    # 선박 검색(계약 v5 §B1): 실행 중 스택은 목록의 첫 선박 MMSI 로, 기록은 선명 앞부분(실시간) · DB 에만 있는 선박(live=false)
    Check("ship_search", "ship_search", 200, "application/json", True),
    Check("ship_search_db", "ship_search", 200, "application/json", True, recorded_only=True),
    # 실시간 아닌 선박의 상세 — 마지막 수신 기록 last_seen_at(계약 v5 §G4)
    Check("ship_detail_stored", "ship_detail", 200, "application/json", True, recorded_only=True),
    Check("problem_bad_ship_query", "problem", 400, "application/problem+json", False),
    # 관측 수신 범위(계약 v5 §G27) — 실행 중 스택도 같은 경로
    Check("ship_coverage", "ship_coverage", 200, "application/json", True),
    Check("status_ais", "status_ais", 200, "application/json", True, recorded_only=True),
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
        "radar_kr": "/api/v1/radar/kr",
        "traffic_grid": "/api/v1/traffic/grid",
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
    # 선박(계약 v2 §B3): 동아시아 기본 구독 범위 안(≤ 2,500 sq°)에서 한 척을 골라 상세·항적
    ships_path = "/api/v1/ships?bbox=118,20,150,46"
    paths["ships"] = ships_path
    paths["ais_gaps"] = "/api/v1/ais/gaps"
    paths["problem_bad_mmsi"] = "/api/v1/ships/12345"
    sh = (fetch(base, ships_path).body or {}).get("features") or []
    mmsi = sh[0]["id"] if sh else None
    paths["ship_detail"] = f"/api/v1/ships/{mmsi}" if mmsi else None
    paths["ship_track"] = f"/api/v1/ships/{mmsi}/track" if mmsi else None
    paths["ship_search"] = f"/api/v1/ships/search?q={mmsi}" if mmsi else None
    paths["problem_bad_ship_query"] = "/api/v1/ships/search?q=a"
    paths["ship_coverage"] = "/api/v1/ships/coverage"
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
    if isinstance(r.body, dict) and not errs:
        errs.extend(CROSS_CHECKS.get(c.schema, lambda _b: [])(r.body))
    return errs


# ---------------------------------------------------------------- 교차 검사(JSON Schema 로 쓸 수 없는 값 사이의 관계)


def _ships(body: dict[str, Any]) -> list[str]:
    errs: list[str] = []
    feats = body.get("features") or []
    meta = body.get("meta") or {}
    if meta.get("count") != len(feats):
        errs.append(f"meta.count {meta.get('count')} != {len(feats)} features")
    total = meta.get("total_in_bbox", 0)
    if total < len(feats):
        errs.append("meta.total_in_bbox is smaller than the features returned")
    if meta.get("capped") != (total > len(feats)):
        errs.append("meta.capped must say exactly whether features were cut off")
    errs.extend(_ais_source_errors("meta.ais", meta.get("ais")))
    for i, f in enumerate(feats):
        p = f.get("properties") or {}
        if f.get("id") != p.get("mmsi"):
            errs.append(f"features[{i}].id != properties.mmsi")
        if (f.get("geometry") or {}).get("coordinates") != [p.get("lon"), p.get("lat")]:
            errs.append(f"features[{i}] geometry is not [lon, lat] of its properties")
    return errs


def _ship_detail(body: dict[str, Any]) -> list[str]:
    errs: list[str] = []
    for part in ("state", "static"):
        if part in body and body[part].get("mmsi") != body.get("mmsi"):
            errs.append(f"{part}.mmsi != mmsi")
    if "state" not in body and "static" not in body and "first_recorded_at" not in body:
        errs.append("a ship with no live state, no static info and no stored record must be a 404")
    # 계약 v5 §G17: 정적 정보가 있으면 늘 출처를 밝히고, 저장값(stored)만 저장 행의 시각을 싣는다 — 그 시각은 static.updated_at 과 같다
    if ("static" in body) != ("static_source" in body):
        errs.append("static_source must be present exactly when static is")
    if ("static_updated_at" in body) != (body.get("static_source") == "stored"):
        errs.append("static_updated_at must be present exactly for a stored static")
    elif "static_updated_at" in body and not _same_instant(
        body["static_updated_at"], (body.get("static") or {}).get("updated_at")
    ):
        errs.append("static_updated_at is not the stored row's updated_at (static.updated_at)")
    # 계약 v5 §G4: 마지막 수신 기록은 실시간 목록에 없고 저장 기록(ship 행)이 있을 때만
    if "last_seen_at" in body and "state" in body:
        errs.append("last_seen_at on a live ship (state.seen_at is the last reception)")
    if "last_seen_at" in body and "first_recorded_at" not in body:
        errs.append("last_seen_at without a stored record (first_recorded_at)")
    errs.extend(_last_seen_errors(body))
    dest = body.get("destination_info")
    reported = (body.get("static") or {}).get("destination")
    if dest is not None and dest.get("raw") != reported:
        errs.append("destination_info.raw is not the reported static.destination")
    if dest is None and reported is not None and reported.strip():
        errs.append("static.destination is reported but destination_info is missing")
    if dest is not None:
        places = dest.get("places") or []
        for key, idx in (("from", 0), ("to", -1)):
            if key in dest and places and dest[key] != places[idx]:
                errs.append(f"destination_info.{key} is not places[{idx}]")
        for i, place in enumerate(places):
            errs.extend(f"destination_info.places[{i}]: {e}" for e in _place_errors(place))
    return errs


# 계약 v4 §B: 조각의 UN/LOCODE 는 공백형(뒤에 선석 등 문구 허용) 또는 붙임형(정확히 5자)으로만 읽는다 — 코드 = 두 글자 + 세 글자
_LOCODE_SPACED = re.compile(r"^([A-Z]{2}) ([A-Z0-9]{3})(?: .*)?$")
_LOCODE_COMPACT = re.compile(r"^([A-Z]{2})([A-Z0-9]{3})$")


def _place_errors(place: dict[str, Any]) -> list[str]:
    """풀이한 조각의 locode 는 그 조각 글자가 규칙으로 내는 코드여야 하고(다른 항구를 붙이지 않는다), country 는 코드의 앞 두 글자,
    ambiguous 는 붙임형으로 푼 것뿐이다."""
    locode = place.get("locode")
    if locode is None:
        return []
    text = place.get("text") or ""
    spaced, compact = _LOCODE_SPACED.fullmatch(text), _LOCODE_COMPACT.fullmatch(text)
    m = spaced or compact
    errs: list[str] = []
    if m is None or m.group(1) + m.group(2) != locode:
        errs.append(f"locode {locode!r} is not the code the text {text!r} yields")
    if place.get("country") != locode[:2]:
        errs.append(f"country {place.get('country')!r} is not the first two letters of locode {locode!r}")
    if place.get("ambiguous") and compact is None:
        errs.append("ambiguous is only for the compact 5-letter form")
    return errs


_ROUTE_CALLSIGN = re.compile(r"^[A-Z0-9]{3,8}$")


def _route_callsign(raw: object) -> str | None:
    """api RouteReader.normalizeCallsign 과 같은 규칙(계약 v4 §G A-1): 앞뒤 공백 제거 → ASCII 가 아니면 없음 → 대문자 → ^[A-Z0-9]{3,8}$."""
    if not isinstance(raw, str):
        return None
    s = raw.strip()
    if not s.isascii():
        return None
    cs = s.upper()
    return cs if _ROUTE_CALLSIGN.fullmatch(cs) else None


def _aircraft_detail(body: dict[str, Any]) -> list[str]:
    errs: list[str] = []
    route = body.get("route")
    if route is None:
        return errs
    # 노선은 실시간 상태의 콜사인(정규화)에서만 — 다른 콜사인의 노선을 붙이지 않고, 읽을 수 있는 콜사인을 '콜사인 없음' 이라 하지 않는다
    cs = _route_callsign((body.get("state") or {}).get("callsign"))
    if route.get("status") == "no_callsign":
        if cs is not None:
            errs.append(f"route.status is no_callsign but the live callsign {cs!r} is valid")
    elif cs is None:
        errs.append(f"route.status {route.get('status')!r} but the live callsign is missing or invalid (expected no_callsign)")
    elif route.get("callsign") != cs:
        errs.append(f"route.callsign {route.get('callsign')!r} is not the live callsign {cs!r}")
    return errs


def _ts(v: str) -> datetime:
    return datetime.fromisoformat(v.replace("Z", "+00:00"))


def _same_instant(a: object, b: object) -> bool:
    """두 ISO-8601 시각이 같은 순간인가(표기 · 소수 자리가 달라도). 시각이 아니면 False."""
    if not isinstance(a, str) or not isinstance(b, str):
        return False
    try:
        return _ts(a) == _ts(b)
    except ValueError:
        return False


_SCOPE_NUM = re.compile(r"^-?\d{1,3}(\.\d{1,6})?$")


def _scope_errors(text: str) -> str | None:
    """구역 하나(계약 v4 §D, api AisBboxes.parse 와 같은 규칙): 상자 1~16, 숫자 소수 6자리까지, |lat| ≤ 90, |lon| ≤ 180, 넓이 0 금지."""
    boxes = 0
    for raw in text.split(";"):
        part = raw.strip()
        if not part:
            continue
        nums = [t.strip() for t in part.split(",")]
        if len(nums) != 4 or not all(_SCOPE_NUM.match(t) for t in nums):
            return "each box needs 4 decimal numbers lat1,lon1,lat2,lon2"
        lat1, lon1, lat2, lon2 = (float(t) for t in nums)
        if abs(lat1) > 90 or abs(lat2) > 90 or abs(lon1) > 180 or abs(lon2) > 180:
            return "box out of range"
        if lat1 == lat2 or lon1 == lon2:
            return "box has zero area"
        boxes += 1
    if not 1 <= boxes <= 16:
        return f"{boxes} boxes (1 to 16 per shard)"
    return None


def _gap_scope_errors(where: str, gaps: list[Any]) -> list[str]:
    errs: list[str] = []
    for i, g in enumerate(gaps):
        if isinstance(g, dict) and isinstance(g.get("scope"), str) and (e := _scope_errors(g["scope"])):
            errs.append(f"{where}[{i}].scope: {e}")
    return errs


def _ais_source_errors(where: str, ais: Any) -> list[str]:
    """계약 v4 §D·§G D-2: 구역 상태가 있으면 coverage 는 실제로 구독한 구역(shards 중 일부, 구역 순서 그대로)의 상자 합 —
    구독한 구역이 없으면(비활성·구독 전) coverage 가 없다. 구독 여부는 공개 응답에 없으므로 '어떤 구역들의 합' 인지만 본다."""
    if not isinstance(ais, dict) or "shards" not in ais or ais.get("coverage") is None:
        return []
    parts = [sh.get("coverage", []) for sh in ais["shards"]]
    unions = (
        [box for part in chosen for box in part] for n in range(1, len(parts) + 1) for chosen in itertools.combinations(parts, n)
    )
    if ais["coverage"] not in unions:
        return [f"{where}.coverage is not the union of (subscribed) shards[].coverage"]
    return []


def _status_ais_recorded(body: dict[str, Any]) -> list[str]:
    """기록된 status_ais 표본: 통합 시험(RestSamplesIT)은 모든 구역을 구독한 상태 해시를 쓰므로 coverage 는 모든 구역의 합이어야 한다
    (부분 합 허용은 구독 상태가 보이지 않는 실서버·다른 표본에만 — 구독한 구역을 빠뜨리는 회귀를 여기서 잡는다)."""
    errors = _status(body)
    ais = ((body.get("sources") or {}).get("ais")) if isinstance(body, dict) else None
    if isinstance(ais, dict) and isinstance(ais.get("shards"), list) and ais.get("coverage") is not None:
        full = [box for sh in ais["shards"] for box in sh.get("coverage", [])]
        if ais["coverage"] != full:
            errors.append("status_ais.coverage is not the union of every shard (the recorded hash subscribes all shards)")
    return errors


def _status(body: dict[str, Any]) -> list[str]:
    return _ais_source_errors("sources.ais", (body.get("sources") or {}).get("ais")) + _radar_kr_status(body)


def _kr_site_errors(where: str, f: dict[str, Any]) -> list[str]:
    """합성 지점 수 · 기준 · partial 사이(ADR-021): 기준 ≥ 지점 수, partial 은 두 수를 알 때만 stations < stations_ref 와 같게, 코드 수 = 지점 수."""
    errs: list[str] = []
    n, ref, partial, ids = f.get("stations"), f.get("stations_ref"), f.get("partial"), f.get("station_ids")
    if isinstance(n, int) and isinstance(ref, int) and ref < n:
        errs.append(f"{where}: stations_ref {ref} < stations {n} — the reference includes the frame itself")
    if partial is not None:
        if not (isinstance(n, int) and isinstance(ref, int)):
            errs.append(f"{where}: partial without both site counts — nothing backs the flag")
        elif partial != (n < ref):
            errs.append(f"{where}: partial={partial} but stations {n} / reference {ref}")
    if isinstance(ids, list) and isinstance(n, int) and len(ids) != n:
        errs.append(f"{where}: {len(ids)} station_ids for {n} stations")
    return errs


def _kr_missing_errors(where: str, m: object) -> list[str]:
    """'파일 없음' 연속: since_tm ≤ last_tm, 파일 이름의 tm 은 그 사이(마지막으로 확인한 tm 의 답)."""
    if not isinstance(m, dict):
        return []
    since, last, file = m.get("since_tm"), m.get("last_tm"), m.get("file")
    errs: list[str] = []
    if isinstance(since, str) and isinstance(last, str) and last < since:
        errs.append(f"{where}.missing: last_tm {last} is before since_tm {since}")
    tm = re.search(r"_(\d{12})\.bin\.gz$", file) if isinstance(file, str) else None
    if tm and isinstance(since, str) and isinstance(last, str) and not since <= tm.group(1) <= last:
        errs.append(f"{where}.missing: file {file} is outside tm {since}–{last}")
    return errs


def _radar_kr_status(body: dict[str, Any]) -> list[str]:
    kr = body.get("radar_kr") or {}
    return _kr_site_errors("radar_kr", kr) + _kr_missing_errors("radar_kr", kr.get("missing"))


KR_LATEST = ("stations", "station_ids", "stations_ref", "partial")


def _radar_kr(body: dict[str, Any]) -> list[str]:
    """/radar/kr: 프레임마다 지점 필드가 서로 맞고 영상 URL 이 그 tm 의 것, 최상위 지점 필드 = 최신(마지막) 프레임의 값, 쓸 수 있으면 프레임이 있다."""
    errs: list[str] = []
    frames = body.get("frames") or []
    if body.get("available") and not frames:
        errs.append("available without frames")
    for i, f in enumerate(frames):
        errs.extend(_kr_site_errors(f"frames[{i}]", f))
        if not str(f.get("url", "")).startswith(f"/api/v1/radar/kr/{f.get('tm')}.png"):
            errs.append(f"frames[{i}].url is not the image of tm {f.get('tm')}")
    last = frames[-1] if frames else {}
    for k in KR_LATEST:
        if body.get(k) != last.get(k) or (k in body) != (k in last):
            errs.append(f"top-level {k} {body.get(k)!r} is not the latest frame's {last.get(k)!r}")
    return errs + _kr_missing_errors("radar_kr", body.get("missing"))


def _ship_track(body: dict[str, Any]) -> list[str]:
    errs: list[str] = []
    props = body.get("properties") or {}
    pts = body.get("points") or []
    lines = (body.get("geometry") or {}).get("coordinates") or []
    segs = props.get("segments") or []
    if props.get("points") != len(pts):
        errs.append(f"properties.points {props.get('points')} != {len(pts)} points")
    if len(segs) != len(lines):
        errs.append(f"{len(segs)} segments but {len(lines)} lines — segments[i] must describe geometry line i")
    for i, (seg, line) in enumerate(zip(segs, lines, strict=False)):
        if seg.get("points") != len(line):
            errs.append(f"segments[{i}].points != length of line {i}")
    ts = [_ts(p["ts"]) for p in pts]
    if ts != sorted(ts):
        errs.append("points are not in time order")
    if ts and not (_ts(props["from"]) <= ts[0] and ts[-1] <= _ts(props["to"])):
        errs.append("points outside [from, to]")
    starts = [_ts(g["started_at"]) for g in body.get("gaps") or []]
    if starts != sorted(starts):
        errs.append("gaps are not oldest first (the newest 200 are listed in time order)")
    errs.extend(_gap_scope_errors("gaps", body.get("gaps") or []))
    return errs


def _ais_gaps(body: dict[str, Any]) -> list[str]:
    errs: list[str] = []
    starts = []
    for i, g in enumerate(body.get("items") or []):
        if _ts(g["ended_at"]) <= _ts(g["started_at"]):
            errs.append(f"items[{i}] ends before it starts")
        starts.append(_ts(g["started_at"]))
    if starts != sorted(starts):
        errs.append("items are not oldest first")
    errs.extend(_gap_scope_errors("items", body.get("items") or []))
    if (body.get("meta") or {}).get("stale"):
        errs.append("meta.stale on a DB listing (it is current as of the request)")
    return errs


def _stats_days(body: dict[str, Any]) -> list[str]:
    """R-45: days 는 날짜순·중복 없는 연속 범위이고, 행이 있는 날은 모두 그 범위 안에 있다."""
    errs: list[str] = []
    days = [date.fromisoformat(d["day"]) for d in body.get("days") or []]
    if days != sorted(set(days)):
        errs.append("days are not in date order without duplicates")
    if days and (days[-1] - days[0]).days + 1 != len(days):
        errs.append("days do not cover every date of the range")
    listed = set(days)
    for i, row in enumerate(body.get("items") or []):
        if date.fromisoformat(row["day"]) not in listed:
            errs.append(f"items[{i}].day {row['day']} is outside days")
    return errs


def _aircraft_track(body: dict[str, Any]) -> list[str]:
    """R-52: properties.points = 점 수 = 선의 좌표 수, 시간순. 5,000점 미만인데 truncated 면 틀렸다."""
    errs: list[str] = []
    props = body.get("properties") or {}
    pts = body.get("points") or []
    coords = (body.get("geometry") or {}).get("coordinates") or []
    if not (props.get("points") == len(pts) == len(coords)):
        errs.append(f"properties.points {props.get('points')}, {len(pts)} points and {len(coords)} coordinates differ")
    ts = [_ts(p["ts"]) for p in pts]
    if ts != sorted(ts):
        errs.append("points are not in time order")
    if props.get("truncated") and len(pts) < 5000:
        errs.append(f"truncated with only {len(pts)} points (the cap is 5,000)")
    return errs


_DIGITS = re.compile(r"^[0-9]+$")
_IMO_QUERY = re.compile(r"^IMO ?([0-9]{7})$")


def ship_search_matches(q: str, item: dict[str, Any]) -> bool:
    """계약 v5 §B1 일치 규칙(api ShipQuery 와 따로 쓴 같은 규칙): 9자리 MMSI 정확 · 7자리 MMSI 앞부분 또는 IMO 정확 · 3–8자리 MMSI 앞부분 ·
    IMO 접두 + 7자리 IMO 정확 · 그 밖 선명 또는 호출부호 앞부분(대소문자 무시)."""
    mmsi, imo = str(item.get("mmsi") or ""), item.get("imo")
    if _DIGITS.match(q) and len(q) == 9:
        return mmsi == q
    if _DIGITS.match(q) and len(q) == 7:
        return mmsi.startswith(q) or imo == int(q)
    if _DIGITS.match(q) and 3 <= len(q) <= 8:
        return mmsi.startswith(q)
    if m := _IMO_QUERY.match(q):
        return imo == int(m.group(1))
    return any(isinstance(v, str) and v.upper().startswith(q) for v in (item.get("name"), item.get("call_sign")))


def _ship_search(body: dict[str, Any]) -> list[str]:
    errs: list[str] = []
    items = body.get("items") or []
    meta = body.get("meta") or {}
    q = str(meta.get("q") or "")
    if meta.get("count") != len(items):
        errs.append(f"meta.count {meta.get('count')} != {len(items)} items")
    mmsis = [it.get("mmsi") for it in items]
    if len(set(mmsis)) != len(mmsis):
        errs.append("an MMSI appears more than once")
    live = [bool(it.get("live")) for it in items]
    if live != sorted(live, reverse=True):
        errs.append("live results must come before stored-only ones")
    for i, it in enumerate(items):
        if not ship_search_matches(q, it):
            errs.append(f"items[{i}] ({it.get('mmsi')}) does not match q={q!r} under the contract rules")
        # 저장 위치는 같은 보고 흐름의 60 s 창 첫 점 — 지금 보고(seen_at)보다 새로울 수 없다
        if it.get("seen_at") and it.get("last_position_at") and _ts(it["last_position_at"]) > _ts(it["seen_at"]):
            errs.append(f"items[{i}].last_position_at is later than its live seen_at")
        errs.extend(f"items[{i}].{e}" for e in _last_seen_errors(it))
    return errs


def _last_seen_errors(body: dict[str, Any]) -> list[str]:
    """계약 v5 §G4: 마지막 수신 기록은 ship.last_seen 과 저장 위치 중 늦은 것 — 저장 위치보다 이를 수 없다."""
    seen, pos = body.get("last_seen_at"), body.get("last_position_at")
    if seen and pos and _ts(seen) < _ts(pos):
        return ["last_seen_at is earlier than last_position_at (it must be widened by the stored position)"]
    return []


_HOUR_DIM = re.compile(r"^(?:[01][0-9]|2[0-3])$")


def _stats_traffic(body: dict[str, Any]) -> list[str]:
    """그날(KST 날짜)의 행만, 시(dim)는 그 KST 날짜의 시 "00"–"23" 이고 시마다 한 행(계약 v5 §G20)."""
    rows = body.get("items") or []
    days = {row["day"] for row in rows}
    errs = [] if days <= {body.get("day")} else [f"items carry other days than {body.get('day')}: {sorted(days)}"]
    dims = [row.get("dim") for row in rows]
    errs += [f"items dim {d!r} is not a KST hour 00-23" for d in dims if not isinstance(d, str) or not _HOUR_DIM.match(d)]
    if len(set(dims)) != len(dims):
        errs.append("an hour appears more than once")
    return errs


TRAFFIC_COUNTS = ("total", "rejected", "resolved", "unresolved", "pending", "not_found", "off_grid", "failed", "invalid_cells")
TRAFFIC_FUTURE_SKEW_S = 120  # api TrafficGridReader.FUTURE_SKEW_S


def _on_lattice(v: object) -> bool:
    return isinstance(v, int | float) and not isinstance(v, bool) and abs(v - round(v / 0.025) * 0.025) <= 1e-6


def _traffic_grid(body: dict[str, Any]) -> list[str]:
    """ADR-023 /traffic/grid: 쓸 수 있음 ⇔ ok, 쓸 수 없으면 칸 없음, 꺼짐 이유는 disabled 일 때만, 시각 둘이 같은 순간(KST +09:00),
    수가 맞음(해석 = 칸 + 버린 칸, 해석 + 미해석 = 전체, 미해석 = 기다림 + 없음 + 격자 밖 + 조회 실패), 칸은 0.025° 격자점,
    오래됨 ⇔ age_s > 900, regDt 가 응답 시각(meta.generated_at)보다 120 s 넘게 미래면 ok · stale 이 아니다."""
    errs: list[str] = []
    st, cells = body.get("status"), body.get("cells") or []
    if bool(body.get("available")) != (st == "ok"):
        errs.append(f"available {body.get('available')!r} with status {st!r}")
    if st != "ok" and cells:
        errs.append(f"{len(cells)} cells served with status {st!r}")
    if (body.get("disabled_reason") is not None) != (st == "disabled"):
        errs.append(f"disabled_reason {body.get('disabled_reason')!r} with status {st!r}")
    kst, utc = body.get("reg_dt_kst"), body.get("reg_dt_utc")
    if (kst is None) != (utc is None):
        errs.append("reg_dt_kst and reg_dt_utc must both be present or both absent")
    elif kst is not None and utc is not None:
        if datetime.fromisoformat(kst) != datetime.fromisoformat(utc.replace("Z", "+00:00")):
            errs.append(f"reg_dt_kst {kst} is not the instant reg_dt_utc {utc}")
    if st in ("ok", "stale"):
        c = {k: body.get(k) for k in TRAFFIC_COUNTS}
        if any(v is None for v in c.values()) or utc is None:
            errs.append(f"status {st} needs every count and the regDt")
        else:
            if c["resolved"] + c["unresolved"] != c["total"]:
                errs.append(f"resolved {c['resolved']} + unresolved {c['unresolved']} != total {c['total']}")
            if c["pending"] + c["not_found"] + c["off_grid"] + c["failed"] != c["unresolved"]:
                errs.append("pending + not_found + off_grid + failed != unresolved")
            gen = (body.get("meta") or {}).get("generated_at")
            if isinstance(gen, str):
                ahead = (
                    datetime.fromisoformat(utc.replace("Z", "+00:00")) - datetime.fromisoformat(gen.replace("Z", "+00:00"))
                ).total_seconds()
                if ahead > TRAFFIC_FUTURE_SKEW_S:
                    errs.append(f"reg_dt_utc {utc} is {ahead:.0f} s ahead of meta.generated_at {gen} with status {st}")
            if st == "ok" and len(cells) + c["invalid_cells"] != c["resolved"]:
                errs.append(f"{len(cells)} cells + {c['invalid_cells']} invalid != resolved {c['resolved']}")
        age = body.get("age_s")
        if isinstance(age, int) and (age > body.get("stale_after_s", 900)) != (st == "stale"):
            errs.append(f"age_s {age} does not match status {st}")
    elif any(body.get(k) is not None for k in ("reg_dt_utc", "total", "resolved")):
        errs.append(f"status {st} carries snapshot fields")
    for i, cell in enumerate(cells):
        if not (_on_lattice(cell[1]) and _on_lattice(cell[2])):
            errs.append(f"cells[{i}] corner {cell[1]},{cell[2]} is off the 0.025° lattice")
            break
    if len({cell[0] for cell in cells}) != len(cells):
        errs.append("duplicate grid_no in cells")
    return errs


COVERAGE_FUTURE_SKEW_S = 300  # api ShipCoverage.FUTURE_SKEW_MS — 수집기 시계가 조금 빠른 보고의 마지막 수신


def _utc(v: str) -> datetime:
    return datetime.fromisoformat(v.replace("Z", "+00:00"))


def _ship_coverage(body: dict[str, Any]) -> list[str]:
    """계약 v5 §G27 /ships/coverage: 창 = 지금 시의 시작 − 24 h ~ generated_at, since = max(창의 시작, min(부트스트랩이 이어 읽은 곳, 셈 시작)) —
    covered 는 그것으로 정해진다(full ⇔ since = 창의 시작), 셈 시작 = api 시작을 분으로 내린 것, 칸은 0.5° 격자점 · 남 → 북 · 서 → 동 · 한 번씩 ·
    선박 ≤ 위치 · 마지막 수신은 초로 내린 값이고 창 안(수집기 시계 5분까지 앞선 값 허용), 합계 · 잘림 · 상한이 칸과 맞다,
    meta.fetched_at = min(가장 늦은 마지막 수신, generated_at)."""
    errs: list[str] = []
    w = body.get("window") or {}
    to, gen = _utc(w["to"]), _utc(body["generated_at"])
    if to != gen:
        errs.append(f"window.to {w['to']} != generated_at {body['generated_at']}")
    frm = _utc(w["from"])
    expected_from = gen.replace(minute=0, second=0, microsecond=0) - timedelta(hours=24)
    if frm != expected_from:
        errs.append(f"window.from {w['from']} is not the start of the generated hour minus 24 h ({expected_from.isoformat()})")
    live, started = _utc(body["live_from"]), _utc(body["api_started_at"])
    if live.second or live.microsecond or not (live <= started < live + timedelta(seconds=60)):
        errs.append(f"live_from {body['live_from']} is not api_started_at {body['api_started_at']} floored to the minute")
    b = body.get("bootstrap") or {}
    loaded = _utc(b["loaded_from"])
    if loaded > live:
        errs.append(f"bootstrap.loaded_from {b['loaded_from']} is after live_from")
    if b.get("hours_loaded", 0) > b.get("hours_total", 0):
        errs.append("bootstrap.hours_loaded > hours_total")
    if b.get("state") == "done" and b.get("hours_loaded") != b.get("hours_total"):
        errs.append("bootstrap done without every hour loaded")
    since = _utc(body["since"])
    want = max(frm, min(loaded, live))
    if since != want:
        errs.append(f"since {body['since']} != max(window.from, min(loaded_from, live_from)) = {want.isoformat()}")
    covered = "full" if since == frm else "partial" if min(loaded, live) < live else "since_api_start"
    if body.get("covered") != covered:
        errs.append(f"covered {body.get('covered')!r} but since/window/bootstrap say {covered!r}")
    cells = body.get("cells") or []
    keys: list[tuple[float, float]] = []
    newest: datetime | None = None
    for i, c in enumerate(cells):
        lon0, lat0, ships, positions, last = c[0], c[1], c[3], c[4], c[5]
        if abs(lon0 * 2 - round(lon0 * 2)) > 1e-9 or abs(lat0 * 2 - round(lat0 * 2)) > 1e-9:
            errs.append(f"cells[{i}] corner {lon0},{lat0} is off the 0.5° lattice")
        if ships > positions:
            errs.append(f"cells[{i}] has {ships} ships but only {positions} positions")
        t = _utc(last)
        if t.microsecond:
            errs.append(f"cells[{i}] last_seen {last} is not floored to the second")
        if t < frm or t > gen + timedelta(seconds=COVERAGE_FUTURE_SKEW_S):
            errs.append(f"cells[{i}] last_seen {last} is outside the window")
        newest = t if newest is None or t > newest else newest
        keys.append((lat0, lon0))
    if keys != sorted(keys):
        errs.append("cells are not ordered south→north, then west→east")
    if len(set(keys)) != len(keys):
        errs.append("duplicate cell")
    if body.get("cell_count") != len(cells):
        errs.append(f"cell_count {body.get('cell_count')} != {len(cells)} cells")
    if body.get("positions") != sum(c[4] for c in cells):
        errs.append("positions is not the sum of the cells")
    if bool(body.get("truncated")) != (body.get("dropped_positions", 0) > 0):
        errs.append("truncated must be true exactly when dropped_positions > 0")
    if len(cells) > (body.get("limits") or {}).get("max_cells", 0):
        errs.append("more cells than limits.max_cells")
    fetched = (body.get("meta") or {}).get("fetched_at")
    if newest is None and fetched is not None:
        errs.append("meta.fetched_at without any cell")
    # 수집기 시계가 빨라 가장 늦은 마지막 수신이 응답보다 미래면 api 는 generated_at 으로 내린다(음수 지연을 stale 로 보지 않게)
    want_fetched = None if newest is None else min(newest, gen)
    if want_fetched is not None and (fetched is None or _utc(fetched) != want_fetched):
        errs.append(f"meta.fetched_at {fetched} != min(newest last_seen, generated_at) {want_fetched.isoformat()}")
    return errs


SCHEMAS["status_ais"] = {
    **SCHEMAS["status"],
    "allOf": [
        {"required": ["sources", "demand"]},
        {"properties": {"sources": {"required": ["ais"]}, "demand": {"required": ["adsb_fi_rps_1m"]}}},
        # 기록은 기상청 내려받기 '파일 없음' 연속 중인 수집기 해시 — radar_kr.missing 이 실려야 한다
        {"properties": {"radar_kr": {"required": ["missing"]}}},
        # 기록(RestSamplesIT)은 구역 둘로 나눈 수집기 상태(계약 v4 §D) — 구역 상태와 그 합의 수신 범위가 실려야 한다
        {"properties": {"sources": {"properties": {"ais": {"required": ["shards", "coverage"]}}}}},
    ],
}

# 기록: 기상청 내려받기 '파일 없음' 연속 중인 /radar/kr — missing 이 실려야 한다
SCHEMAS["radar_kr_missing"] = {**SCHEMAS["radar_kr"], "allOf": [{"required": ["missing"]}]}

CROSS_CHECKS = {
    "status": _status,
    "radar_kr": _radar_kr,
    "radar_kr_missing": _radar_kr,
    "traffic_grid": _traffic_grid,
    "ship_coverage": _ship_coverage,
    "status_ais": _status_ais_recorded,
    "ships": _ships,
    "ship_detail": _ship_detail,
    "ship_track": _ship_track,
    "ship_search": _ship_search,
    "ais_gaps": _ais_gaps,
    "aircraft_detail": _aircraft_detail,
    "stats_sigmet": _stats_days,
    "stats_alerts": _stats_days,
    "stats_traffic": _stats_traffic,
    "aircraft_track": _aircraft_track,
}


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
