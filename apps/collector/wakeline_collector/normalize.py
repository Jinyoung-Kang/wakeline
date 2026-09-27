"""공급자 응답 → AircraftState 정규화. 단위는 ft · kt · ft/min 으로 통일한다.

- readsb v2 (adsb.lol · adsb.fi): 필드 정의는 readsb README-json [S8]. 단위 그대로.
- OpenSky states/all: 배열 인덱스는 OpenSky REST 문서 [S1]. m→ft, m/s→kt, m/s→ft/min.
값이 없으면 None 으로 둔다(추정하지 않는다).

정직성(소유자 규칙):
- 지상(alt_baro "ground" / OpenSky on_ground)은 on_ground=True 로만 표시한다. 고도를 0 ft 로 만들지 않는다 —
  readsb 는 지상일 때 기압고도를 주지 않으므로 alt_ft=None, OpenSky 는 보고된 baro_altitude 를 그대로 쓴다(COL-2).
- 위치 관측 시각(readsb seen_pos, OpenSky time_position)이 없으면 수신 시각으로 대신하지 않는다.
  그런 레코드는 Rejected("no_position_time") 로 돌려 게이트가 격리·집계한다(DH-13, 원천에는 남는다).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any

from pydantic import ValidationError

from wakeline_collector.models import AircraftState

M_TO_FT = 3.28084
MS_TO_KT = 1.94384
MS_TO_FPM = 196.85


def _str(v: Any, maxlen: int) -> str | None:
    if v is None:
        return None
    s = str(v).strip()
    return s[:maxlen] if s else None


def _num(v: Any) -> float | None:
    if v is None or isinstance(v, bool):
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if f == f else None  # NaN 제거


def _squawk(v: Any) -> str | None:
    s = _str(v, 4)
    if s and len(s) == 4 and all(c in "01234567" for c in s):
        return s
    return None


def _track(v: Any) -> float | None:
    t = _num(v)
    if t is None:
        return None
    t = t % 360.0
    return round(t, 2)


@dataclass(frozen=True)
class Rejected:
    """정규화 단계에서 스트림에 싣지 않기로 한 레코드(품질 게이트가 규칙별로 격리·집계)."""

    rule: str  # no_position | no_position_time | invalid_record
    hex: str | None  # 유효한 6자리 hex 일 때만(quality_event.hex 는 char(6))
    detail: dict[str, Any] = field(default_factory=dict)


def _hex(v: Any) -> str | None:
    """6자리 16진 ICAO 주소(소문자). 그 외(비 ICAO '~' 주소 등)는 None."""
    if not isinstance(v, str):
        return None
    h = v.strip().lower()
    return h if len(h) == 6 and all(c in "0123456789abcdef" for c in h) else None


def normalize_readsb(ac: dict[str, Any], provider: str, fetched_at: datetime) -> AircraftState | Rejected:
    """readsb v2 aircraft 1건 → AircraftState, 또는 격리 사유."""
    raw_hex = ac.get("hex")
    hex_ = _hex(raw_hex)
    lat, lon = _num(ac.get("lat")), _num(ac.get("lon"))
    if lat is None or lon is None:
        return Rejected("no_position", hex_)
    if hex_ is None:
        return Rejected("invalid_record", None, {"field": "hex", "value": str(raw_hex)[:16]})
    seen_pos = _num(ac.get("seen_pos"))
    if seen_pos is None:
        return Rejected("no_position_time", hex_, {"provider": provider})
    try:
        seen_at = fetched_at - timedelta(seconds=seen_pos)
    except OverflowError:
        return Rejected("invalid_record", hex_, {"field": "seen_pos"})
    alt_raw = ac.get("alt_baro")
    on_ground = alt_raw == "ground"
    alt_ft: int | None = None
    if not on_ground:
        a = _num(alt_raw)
        alt_ft = int(round(a)) if a is not None else None
    gs = _num(ac.get("gs"))
    track = _track(ac.get("track"))
    if track is None:
        track = _track(ac.get("calc_track"))
    vrate = _num(ac.get("baro_rate"))
    if vrate is None:
        vrate = _num(ac.get("geom_rate"))
    quality = 0 if (gs is not None and track is not None) or on_ground else 1
    try:
        return AircraftState(
            hex=hex_,
            callsign=_str(ac.get("flight"), 8),
            registration=_str(ac.get("r"), 16),
            type_code=_str(ac.get("t"), 8),
            category=_str(ac.get("category"), 4),
            lat=lat,
            lon=lon,
            alt_ft=alt_ft,
            gs_kt=round(gs, 1) if gs is not None else None,
            track_deg=track,
            vrate_fpm=round(vrate, 0) if vrate is not None else None,
            on_ground=on_ground,
            squawk=_squawk(ac.get("squawk")),
            seen_at=seen_at.astimezone(UTC),
            provider=provider,
            fetched_at=fetched_at.astimezone(UTC),
            quality=quality,
        )
    except ValidationError as e:
        return Rejected("invalid_record", hex_, {"errors": _fields(e)})


def _fields(e: ValidationError) -> list[str]:
    return sorted({".".join(str(p) for p in err["loc"]) for err in e.errors()})[:8]


def from_readsb(ac: dict[str, Any], provider: str, fetched_at: datetime) -> AircraftState | None:
    """normalize_readsb 의 편의형: 격리 사유 없이 상태 또는 None."""
    r = normalize_readsb(ac, provider, fetched_at)
    return r if isinstance(r, AircraftState) else None


# OpenSky states/all 벡터 인덱스 (공식 REST 문서의 state vector 표)
_OS_ICAO24, _OS_CALLSIGN, _OS_TIME_POS, _OS_LAST_CONTACT = 0, 1, 3, 4
_OS_LON, _OS_LAT, _OS_BARO_ALT, _OS_ON_GROUND, _OS_VELOCITY, _OS_TRACK, _OS_VRATE = 5, 6, 7, 8, 9, 10, 11
_OS_SQUAWK, _OS_CATEGORY = 14, 17


def normalize_opensky(vec: list[Any], fetched_at: datetime) -> AircraftState | Rejected:
    """OpenSky state vector 1건 → AircraftState, 또는 격리 사유."""
    if not isinstance(vec, list) or len(vec) < 12:
        return Rejected("invalid_record", None, {"field": "vector", "len": len(vec) if isinstance(vec, list) else None})
    hex_ = _hex(vec[_OS_ICAO24])
    lon, lat = _num(vec[_OS_LON]), _num(vec[_OS_LAT])
    if lat is None or lon is None:
        return Rejected("no_position", hex_)
    if hex_ is None:
        return Rejected("invalid_record", None, {"field": "icao24", "value": str(vec[_OS_ICAO24])[:16]})
    tpos = _num(vec[_OS_TIME_POS])
    if not tpos or tpos <= 0:
        return Rejected("no_position_time", hex_, {"provider": "opensky"})
    try:
        seen_at = datetime.fromtimestamp(tpos, UTC)
    except (OverflowError, OSError, ValueError):
        return Rejected("invalid_record", hex_, {"field": "time_position"})
    on_ground = bool(vec[_OS_ON_GROUND])
    alt_m = _num(vec[_OS_BARO_ALT])
    alt_ft = int(round(alt_m * M_TO_FT)) if alt_m is not None else None  # 지상이어도 보고값 그대로(0 으로 만들지 않음)
    vel = _num(vec[_OS_VELOCITY])
    vr = _num(vec[_OS_VRATE])
    track = _track(vec[_OS_TRACK])
    gs = round(vel * MS_TO_KT, 1) if vel is not None else None
    quality = 0 if (gs is not None and track is not None) or on_ground else 1
    cat = vec[_OS_CATEGORY] if len(vec) > _OS_CATEGORY else None
    try:
        return AircraftState(
            hex=hex_,
            callsign=_str(vec[_OS_CALLSIGN], 8),
            lat=lat,
            lon=lon,
            alt_ft=alt_ft,
            gs_kt=gs,
            track_deg=track,
            vrate_fpm=round(vr * MS_TO_FPM, 0) if vr is not None else None,
            on_ground=on_ground,
            squawk=_squawk(vec[_OS_SQUAWK]) if len(vec) > _OS_SQUAWK else None,
            category=str(cat) if cat not in (None, 0) else None,
            seen_at=seen_at,
            provider="opensky",
            fetched_at=fetched_at.astimezone(UTC),
            quality=quality,
        )
    except ValidationError as e:
        return Rejected("invalid_record", hex_, {"errors": _fields(e)})


def from_opensky(vec: list[Any], fetched_at: datetime) -> AircraftState | None:
    """normalize_opensky 의 편의형: 격리 사유 없이 상태 또는 None."""
    r = normalize_opensky(vec, fetched_at)
    return r if isinstance(r, AircraftState) else None
