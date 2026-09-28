"""항공기 노선 캐시 값(계약 v4 §A · ADR-016) — adsbdb `/v0/callsign/{CALLSIGN}` 응답 → Redis 값.

약관: adsbdb 노선 자료는 저장하지 않는다. 이 값은 Redis `wakeline:route:{CALLSIGN}` 에 TTL 로만 둔다
(PostgreSQL·파일·원천 보관·로그에 쓰지 않는다 — 로그에는 콜사인·상태만).
값: {"v":1,"status":"found"|"not_found"|"error","callsign","fetched_at","airline","origin","destination","midpoint"}.
- 검증을 통과하지 못한 공항은 null, 출발·도착 둘 다 없으면 not_found. 선택 항목(IATA·도시·국가 등)이 형식에 맞지 않으면 그 항목만 null.
- 문자열은 제어·서식 문자를 지우고 공백을 하나로 모은 뒤 길이를 자른다. 코드는 대문자로만 맞춘다. 추측해 채우지 않는다.
- 예외 메시지에는 응답 내용을 싣지 않는다(로그로 새지 않게).
"""

from __future__ import annotations

import math
import re
import unicodedata
from datetime import UTC, datetime
from typing import Any, Literal

import orjson
from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_serializer

ROUTE_KEY_PREFIX = "wakeline:route:"
TTL_FOUND_S = 1800  # found · not_found
TTL_ERROR_S = 120

CALLSIGN_RE = re.compile(r"^[A-Z0-9]{3,8}$")
_ICAO_AIRPORT_RE = re.compile(r"^[A-Z0-9]{4}$")
_IATA_AIRPORT_RE = re.compile(r"^[A-Z0-9]{3}$")
_ISO2_RE = re.compile(r"^[A-Z]{2}$")
_ICAO_AIRLINE_RE = re.compile(r"^[A-Z0-9]{3}$")
_IATA_AIRLINE_RE = re.compile(r"^[A-Z0-9]{2}$")
NAME_MAX = 120
PLACE_MAX = 80
UNKNOWN_CALLSIGN = "unknown callsign"

Status = Literal["found", "not_found", "error"]


class RouteParseError(ValueError):
    """응답 모양이 계약과 다름. 메시지는 고정 문구뿐이다(응답 내용을 싣지 않는다)."""


def normalize_callsign(raw: object) -> str | None:
    """공급자 콜사인 → trim·대문자, `^[A-Z0-9]{3,8}$` 일 때만. ASCII 가 아니면 None(대문자 변환으로 모양이 바뀌지 않게)."""
    if not isinstance(raw, str) or not raw.isascii():
        return None
    cs = raw.strip().upper()
    return cs if CALLSIGN_RE.fullmatch(cs) else None


def route_key(callsign: str) -> str:
    if not CALLSIGN_RE.fullmatch(callsign):
        raise ValueError("invalid callsign")
    return ROUTE_KEY_PREFIX + callsign


def clean_text(v: object, limit: int) -> str | None:
    """제어·서식·서로게이트·미지정 문자(유니코드 C*)를 지우고 공백을 하나로 모은 뒤 limit 자로 자른다. 비면 None."""
    if not isinstance(v, str):
        return None
    s = "".join(ch for ch in v if not unicodedata.category(ch).startswith("C"))
    s = " ".join(s.split())[:limit].strip()
    return s or None


def _code(v: object, pattern: re.Pattern[str]) -> str | None:
    if not isinstance(v, str) or not v.isascii():
        return None
    s = v.strip().upper()
    return s if pattern.fullmatch(s) else None


def _coord(v: object, lo: float, hi: float) -> float | None:
    """숫자(JSON number)만 받는다 — 문자열·bool 은 좌표로 읽지 않는다."""
    if isinstance(v, bool) or not isinstance(v, int | float):
        return None
    f = float(v)
    return f if math.isfinite(f) and lo <= f <= hi else None


class Airport(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    icao: str = Field(pattern=r"^[A-Z0-9]{4}$")
    iata: str | None = Field(default=None, pattern=r"^[A-Z0-9]{3}$")
    name: str = Field(min_length=1, max_length=NAME_MAX)
    city: str | None = Field(default=None, max_length=PLACE_MAX)
    country: str | None = Field(default=None, max_length=PLACE_MAX)
    country_iso: str | None = Field(default=None, pattern=r"^[A-Z]{2}$")
    lat: float = Field(ge=-90, le=90, allow_inf_nan=False)
    lon: float = Field(ge=-180, le=180, allow_inf_nan=False)


class Airline(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    name: str = Field(min_length=1, max_length=NAME_MAX)
    icao: str | None = Field(default=None, pattern=r"^[A-Z0-9]{3}$")
    iata: str | None = Field(default=None, pattern=r"^[A-Z0-9]{2}$")


class RouteValue(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    v: Literal[1] = 1
    status: Status
    callsign: str = Field(pattern=r"^[A-Z0-9]{3,8}$")
    fetched_at: datetime
    airline: Airline | None = None
    origin: Airport | None = None
    destination: Airport | None = None
    midpoint: Airport | None = None

    @field_serializer("fetched_at")
    def _iso(self, dt: datetime) -> str:
        return dt.astimezone(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")

    def to_json(self) -> bytes:
        return orjson.dumps(self.model_dump(mode="json"))

    @property
    def ttl_s(self) -> int:
        return TTL_ERROR_S if self.status == "error" else TTL_FOUND_S


def parse_airport(raw: object) -> Airport | None:
    """adsbdb 공항 객체 → Airport. 필수(ICAO·이름·좌표)가 없거나 형식이 틀리면 None."""
    if not isinstance(raw, dict):
        return None
    data: dict[str, Any] = {
        "icao": _code(raw.get("icao_code"), _ICAO_AIRPORT_RE),
        "iata": _code(raw.get("iata_code"), _IATA_AIRPORT_RE),
        "name": clean_text(raw.get("name"), NAME_MAX),
        "city": clean_text(raw.get("municipality"), PLACE_MAX),
        "country": clean_text(raw.get("country_name"), PLACE_MAX),
        "country_iso": _code(raw.get("country_iso_name"), _ISO2_RE),
        "lat": _coord(raw.get("latitude"), -90.0, 90.0),
        "lon": _coord(raw.get("longitude"), -180.0, 180.0),
    }
    if data["icao"] is None or data["name"] is None or data["lat"] is None or data["lon"] is None:
        return None
    try:
        return Airport(**data)
    except ValidationError:  # 위에서 걸렀으므로 오지 않는다 — 와도 공항만 버린다(내용은 기록하지 않는다)
        return None


def parse_airline(raw: object) -> Airline | None:
    """adsbdb 항공사 객체 → Airline. 이름이 없으면 None(코드만으로 이름을 채우지 않는다)."""
    if not isinstance(raw, dict):
        return None
    name = clean_text(raw.get("name"), NAME_MAX)
    if name is None:
        return None
    try:
        return Airline(name=name, icao=_code(raw.get("icao"), _ICAO_AIRLINE_RE), iata=_code(raw.get("iata"), _IATA_AIRLINE_RE))
    except ValidationError:
        return None


def not_found(callsign: str, fetched_at: datetime) -> RouteValue:
    return RouteValue(status="not_found", callsign=callsign, fetched_at=fetched_at)


def error(callsign: str, fetched_at: datetime | None = None) -> RouteValue:
    return RouteValue(status="error", callsign=callsign, fetched_at=fetched_at or datetime.now(UTC))


def is_unknown_callsign(doc: object) -> bool:
    """adsbdb 의 '모르는 콜사인' 응답({"response":"unknown callsign"})인가."""
    if not isinstance(doc, dict):
        return False
    r = doc.get("response")
    return isinstance(r, str) and r.strip().lower() == UNKNOWN_CALLSIGN


def is_unknown_callsign_body(body: str | bytes) -> bool:
    try:
        return is_unknown_callsign(orjson.loads(body))
    except orjson.JSONDecodeError:
        return False


def from_adsbdb(http_status: int, body: bytes, callsign: str, fetched_at: datetime) -> RouteValue:
    """adsbdb 응답 → found · not_found. 모양이 다르면 RouteParseError(호출자가 error 로 기록)."""
    try:
        doc = orjson.loads(body)
    except orjson.JSONDecodeError:
        raise RouteParseError("response is not JSON") from None
    if is_unknown_callsign(doc):
        return not_found(callsign, fetched_at)
    resp = doc.get("response") if isinstance(doc, dict) else None
    fr = resp.get("flightroute") if isinstance(resp, dict) else None
    if http_status != 200 or not isinstance(fr, dict):
        raise RouteParseError("unexpected response shape")
    origin, destination = parse_airport(fr.get("origin")), parse_airport(fr.get("destination"))
    if origin is None and destination is None:
        return not_found(callsign, fetched_at)
    return RouteValue(
        status="found",
        callsign=callsign,
        fetched_at=fetched_at,
        airline=parse_airline(fr.get("airline")),
        origin=origin,
        destination=destination,
        midpoint=parse_airport(fr.get("midpoint")),
    )
