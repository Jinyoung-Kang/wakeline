"""aisstream.io 메시지(JSON) → 위치·정적 정보. 순수 함수 — I/O 없음.

'값 없음' 표기는 null 로 바꾸고 추정해서 채우지 않는다(소유자 규칙). 근거:
- 위치 보고(ADR-014, USCG NAVCEN): lat 91 · lon 181(위치 없음 → 레코드 없음), SOG 102.3, COG 360, heading 511, ROT -128.
  Timestamp → position_source(계약 v3 §B): 0–59 = 전자 위치 장치(EPFS)가 낸 위치의 UTC 초 → "epfs" · 61 수동 입력 · 62 추측항법 ·
  63 위치 장치 비작동. 60(값 없음 기본값)·필드 없음·범위 밖 → null(장치 종류·출처를 단정하지 않는다).
- 정적·항해 정보(USCG NAVCEN 메시지 5 표, 2026-09-28 확인): IMO 0 · 선종 0 · 흘수 0 · A=B=C=D=0 · ETA 월 0 / 일 0 / 시 24 / 분 60 ·
  '@' 채움 문자열 = 값 없음. IMO 1–999,999 는 '사용 안 함'.
- 메시지 24B 의 크기 30 bit 는 보조 선박(MMSI 98MIDxxxx)이면 모선 MMSI 다(gpsd AIVDM 문서 확인 2026-09-28) → 크기 null.
- 수신 시각(seen_at)은 MetaData.time_utc(aisstream 수신 시각)다. 선박 송신 시각이 아니며, 없거나 해석할 수 없으면 메시지를 버린다
  (수신한 우리 시각으로 대신하지 않는다 — DH-13 과 같은 원칙).
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any

import orjson

# 구독하는 메시지 형식(aisstream FilterMessageTypes 이름). 위치: A 1·2·3, B 18·19 / 정적: 5 · 24 · 19
POSITION_CLASS = {
    "PositionReport": "A",
    "StandardClassBPositionReport": "B",
    "ExtendedClassBPositionReport": "B",
}
SUBSCRIBED_TYPES = (
    "PositionReport",
    "StandardClassBPositionReport",
    "ExtendedClassBPositionReport",
    "ShipStaticData",
    "StaticDataReport",
)
POSITION_SOURCE_EPFS = "epfs"  # Timestamp 0–59
POSITION_SOURCE = {61: "manual", 62: "estimated", 63: "inoperative"}
AUX_CRAFT_PREFIX = "98"  # 보조 선박(모선에 딸린 작은 배) MMSI 98MIDxxxx
STATIC_FIELDS = (
    "name",
    "call_sign",
    "imo",
    "ship_type",
    "dim_a",
    "dim_b",
    "dim_c",
    "dim_d",
    "draught_m",
    "destination",
    "eta_month",
    "eta_day",
    "eta_hour",
    "eta_minute",
)
MAX_NAME, MAX_CALL_SIGN, MAX_DESTINATION = 20, 7, 20

SOG_NA = 102.3
COG_NA = 360.0
HEADING_NA = 511
ROT_NA = -128
LAT_NA, LON_NA = 91.0, 181.0
IMO_MIN, IMO_MAX = 1_000_000, 1_073_741_823  # NAVCEN: 1–999,999 사용 안 함 · 30 bit
DIM_MAX = 511  # 크기 필드의 상한(9 bit 필드 최대). 각 필드의 비트 폭을 단정하지 않고 가장 넓은 값으로 막는다
DRAUGHT_MAX = 25.5  # 255 × 0.1 m = '25.5 m 이상'

# aisstream time_utc: "2026-09-27 16:29:43.949762231 +0000 UTC" (Go time.String, 소수 자릿수 가변)
_GO_TIME = re.compile(
    r"^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))? ?(?:([+-])(\d{2}):?(\d{2}))?(?: ?(?:UTC|Z))?$"
)


@dataclass(slots=True, frozen=True)
class Position:
    mmsi: str
    lat: float
    lon: float
    sog_kn: float | None
    cog_deg: float | None
    heading_deg: int | None
    nav_status: int | None
    rot: int | None
    position_source: str | None  # epfs · manual · estimated · inoperative · None(모름)
    seen_at: str  # ISO-8601 UTC, ms
    t: float  # seen_at 의 epoch 초
    msg_type: str
    cls: str  # "A" | "B"


@dataclass(slots=True, frozen=True)
class StaticPart:
    """정적 정보 조각 — 이 메시지가 실은 필드만 담는다(24A 는 name 만, 24B 는 호출부호·선종·크기)."""

    mmsi: str
    fields: dict[str, Any]
    seen_at: str
    t: float


@dataclass(slots=True, frozen=True)
class Parsed:
    position: Position | None = None
    static: StaticPart | None = None
    # 위치를 만들지 못한 이유(집계용): json · shape · type · invalid_flag · mmsi · time · no_position · position_range · part · provider_error
    reject: str | None = None
    error_text: str | None = field(default=None)  # provider_error 일 때 공급자가 보낸 오류 문구(호출자가 가린 뒤 기록)


# ── 시각 ─────────────────────────────────────────────────────────────


def parse_time_utc(value: Any) -> tuple[str, float] | None:
    """aisstream time_utc(또는 시간대가 있는 ISO-8601) → (ISO ms Z, epoch 초). 시간대가 없거나 해석할 수 없으면 None."""
    if not isinstance(value, str) or len(value) > 64:
        return None
    m = _GO_TIME.match(value.strip())
    if not m:
        return None
    y, mo, d, h, mi, s, frac, sign, oh, om = m.groups()
    if sign is None and not value.rstrip().endswith(("UTC", "Z")):
        return None  # 시간대 없는 시각은 추측하지 않는다
    try:
        dt = datetime(int(y), int(mo), int(d), int(h), int(mi), int(s), int((frac or "0").ljust(6, "0")[:6]), tzinfo=UTC)
    except ValueError:
        return None
    if sign is not None:
        off = timedelta(hours=int(oh), minutes=int(om))
        dt = dt - off if sign == "+" else dt + off
    return iso_ms(dt.timestamp()), dt.timestamp()


def iso_ms(epoch: float) -> str:
    dt = datetime.fromtimestamp(epoch, UTC)
    return f"{dt:%Y-%m-%dT%H:%M:%S}.{dt.microsecond // 1000:03d}Z"


def go_time(epoch: float) -> str:
    """aisstream 과 같은 모양의 time_utc(fixture 재생이 시각을 지금으로 옮길 때 쓴다)."""
    dt = datetime.fromtimestamp(epoch, UTC)
    return f"{dt:%Y-%m-%d %H:%M:%S}.{dt.microsecond:06d}000 +0000 UTC"


# ── 값 정리 ─────────────────────────────────────────────────────────


def _num(v: Any) -> float | None:
    if isinstance(v, bool) or not isinstance(v, int | float):
        return None
    f = float(v)
    return f if math.isfinite(f) else None


def _int(v: Any) -> int | None:
    if isinstance(v, bool):
        return None
    if isinstance(v, int):
        return v
    if isinstance(v, float) and math.isfinite(v) and v.is_integer():
        return int(v)
    return None


def _ranged(v: Any, lo: int, hi: int) -> int | None:
    i = _int(v)
    return i if i is not None and lo <= i <= hi else None


def clean_text(v: Any, max_len: int) -> str | None:
    """AIS 6-bit 문자열: 뒤쪽 '@'(값 없음 채움)·공백을 걷어내고, 인쇄할 수 없는 문자를 뺀다. 비면 null, 필드 길이를 넘으면 null."""
    if not isinstance(v, str):
        return None
    s = "".join(ch for ch in v if ch.isprintable()).rstrip("@ ").strip()
    if not s or len(s) > max_len:
        return None
    return s


def _sog(v: Any) -> float | None:
    f = _num(v)
    if f is None or f < 0 or f >= SOG_NA - 1e-9:
        return None
    return round(f, 1)


def _cog(v: Any) -> float | None:
    f = _num(v)
    if f is None or f < 0 or f >= COG_NA:
        return None
    return round(f, 1)


def _heading(v: Any) -> int | None:
    return _ranged(v, 0, 359)  # 511 = 값 없음, 그 밖의 범위 밖 값도 null


def _rot(v: Any) -> int | None:
    return _ranged(v, -127, 127)  # -128 = 값 없음


def _position_source(v: Any) -> str | None:
    ts = _int(v)
    if ts is None:
        return None
    if 0 <= ts <= 59:
        return POSITION_SOURCE_EPFS
    return POSITION_SOURCE.get(ts)  # 60(값 없음)·범위 밖 → None


def _dims(d: Any) -> dict[str, int | None]:
    if not isinstance(d, dict):
        return {"dim_a": None, "dim_b": None, "dim_c": None, "dim_d": None}
    vals = [_ranged(d.get(k), 0, DIM_MAX) for k in ("A", "B", "C", "D")]
    if all(v == 0 for v in vals):  # A=B=C=D=0 = 기본값(값 없음)
        vals = [None, None, None, None]
    return dict(zip(("dim_a", "dim_b", "dim_c", "dim_d"), vals, strict=True))


def _imo(v: Any) -> int | None:
    return _ranged(v, IMO_MIN, IMO_MAX)


def _ship_type(v: Any) -> int | None:
    return _ranged(v, 1, 99)  # 0 = 값 없음, 100 이상은 예약


def _draught(v: Any) -> float | None:
    f = _num(v)
    if f is None or f <= 0 or f > DRAUGHT_MAX:
        return None
    return round(f, 1)


def _eta(e: Any) -> dict[str, int | None]:
    e = e if isinstance(e, dict) else {}
    return {
        "eta_month": _ranged(e.get("Month"), 1, 12),
        "eta_day": _ranged(e.get("Day"), 1, 31),
        "eta_hour": _ranged(e.get("Hour"), 0, 23),
        "eta_minute": _ranged(e.get("Minute"), 0, 59),
    }


def _mmsi(meta: dict[str, Any], body: dict[str, Any]) -> str | None:
    """본문 UserID 가 기준. MetaData.MMSI 가 있으면 같아야 한다. 9자리(100000000–999999999)만."""
    uid = _int(body.get("UserID"))
    if uid is None or not 100_000_000 <= uid <= 999_999_999:
        return None
    meta_id = meta.get("MMSI")
    if meta_id is not None and _int(meta_id) != uid:
        return None
    return str(uid)


# ── 메시지 ─────────────────────────────────────────────────────────


def _is_error_doc(doc: dict[str, Any]) -> bool:
    return "error" in doc and "Message" not in doc


def is_provider_error(raw: bytes | str) -> bool:
    """공급자 오류 프레임({"error": ...})인지 — parse_message 의 provider_error 와 같은 규칙. 수신 태스크가 데이터와 가르는 데 쓴다.
    '"error"' 글자열이 있는 프레임만 파싱한다(나머지 데이터 프레임은 파싱하지 않고 그대로 대기열로)."""
    marked = (b'"error"' in raw) if isinstance(raw, bytes) else ('"error"' in raw)
    if not marked:
        return False
    try:
        doc = orjson.loads(raw)
    except orjson.JSONDecodeError:
        return False
    return isinstance(doc, dict) and _is_error_doc(doc)


def parse_message(raw: bytes | str) -> Parsed:
    try:
        doc = orjson.loads(raw)
    except orjson.JSONDecodeError:
        return Parsed(reject="json")
    if not isinstance(doc, dict):
        return Parsed(reject="shape")
    if _is_error_doc(doc):
        err = doc.get("error")
        return Parsed(reject="provider_error", error_text=str(err)[:300] if err is not None else "")
    mtype = doc.get("MessageType")
    meta, msg = doc.get("MetaData"), doc.get("Message")
    if not isinstance(mtype, str) or not isinstance(meta, dict) or not isinstance(msg, dict):
        return Parsed(reject="shape")
    if mtype not in SUBSCRIBED_TYPES:
        return Parsed(reject="type")
    body = msg.get(mtype)
    if not isinstance(body, dict):
        return Parsed(reject="shape")
    if body.get("Valid") is False:
        return Parsed(reject="invalid_flag")
    mmsi = _mmsi(meta, body)
    if mmsi is None:
        return Parsed(reject="mmsi")
    when = parse_time_utc(meta.get("time_utc"))
    if when is None:
        return Parsed(reject="time")
    seen_at, t = when

    static = _static(mtype, body, mmsi, seen_at, t)
    if mtype not in POSITION_CLASS:
        if static is None:
            return Parsed(reject="part")
        return Parsed(static=static)

    lat, lon = _num(body.get("Latitude")), _num(body.get("Longitude"))
    if lat is None or lon is None or lat == LAT_NA or lon == LON_NA:
        return Parsed(static=static, reject="no_position")
    if not (-90.0 <= lat <= 90.0 and -180.0 <= lon <= 180.0):
        return Parsed(static=static, reject="position_range")
    is_a = mtype == "PositionReport"
    pos = Position(
        mmsi=mmsi,
        lat=round(lat, 6),
        lon=round(lon, 6),
        sog_kn=_sog(body.get("Sog")),
        cog_deg=_cog(body.get("Cog")),
        heading_deg=_heading(body.get("TrueHeading")),
        nav_status=_ranged(body.get("NavigationalStatus"), 0, 15) if is_a else None,
        rot=_rot(body.get("RateOfTurn")) if is_a else None,
        position_source=_position_source(body.get("Timestamp")),
        seen_at=seen_at,
        t=t,
        msg_type=mtype,
        cls=POSITION_CLASS[mtype],
    )
    return Parsed(position=pos, static=static)


def _static(mtype: str, body: dict[str, Any], mmsi: str, seen_at: str, t: float) -> StaticPart | None:
    f: dict[str, Any]
    if mtype == "ShipStaticData":  # 메시지 5: 전 필드
        f = {
            "name": clean_text(body.get("Name"), MAX_NAME),
            "call_sign": clean_text(body.get("CallSign"), MAX_CALL_SIGN),
            "imo": _imo(body.get("ImoNumber")),
            "ship_type": _ship_type(body.get("Type")),
            **_dims(body.get("Dimension")),
            "draught_m": _draught(body.get("MaximumStaticDraught")),
            "destination": clean_text(body.get("Destination"), MAX_DESTINATION),
            **_eta(body.get("Eta")),
        }
    elif mtype == "StaticDataReport":  # 메시지 24: PartNumber false = A(선명), true = B(호출부호·선종·크기)
        part_b = body.get("PartNumber") is True
        rep = body.get("ReportB" if part_b else "ReportA")
        if not isinstance(rep, dict) or rep.get("Valid") is not True:
            return None
        if part_b:
            # 보조 선박(98MIDxxxx): 크기 자리에 모선 MMSI 가 실린다 — 크기로 읽지 않고 크기 키를 아예 싣지 않는다.
            # None 으로 실으면 ShipBook 병합이 메시지 19 등에서 이미 받은 실제 크기를 지운다(이 프레임은 크기 정보가 없다).
            aux = mmsi.startswith(AUX_CRAFT_PREFIX)
            f = {
                "call_sign": clean_text(rep.get("CallSign"), MAX_CALL_SIGN),
                "ship_type": _ship_type(rep.get("ShipType")),
                **({} if aux else _dims(rep.get("Dimension"))),
            }
        else:
            f = {"name": clean_text(rep.get("Name"), MAX_NAME)}
    elif mtype == "ExtendedClassBPositionReport":  # 메시지 19: 위치 + 선명·선종·크기
        f = {
            "name": clean_text(body.get("Name"), MAX_NAME),
            "ship_type": _ship_type(body.get("Type")),
            **_dims(body.get("Dimension")),
        }
    else:
        return None
    return StaticPart(mmsi=mmsi, fields=f, seen_at=seen_at, t=t)
