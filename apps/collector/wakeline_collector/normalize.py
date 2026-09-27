"""공급자 응답 → AircraftState 정규화. 단위는 ft · kt · ft/min 으로 통일한다.

- readsb v2 (adsb.lol · adsb.fi): 필드 정의는 readsb README-json [S8]. 단위 그대로.
- OpenSky states/all: 배열 인덱스는 OpenSky REST 문서 [S1]. m→ft, m/s→kt, m/s→ft/min.
값이 없으면 None 으로 둔다(추정하지 않는다).
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any

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


def from_readsb(ac: dict[str, Any], provider: str, fetched_at: datetime) -> AircraftState | None:
    """readsb v2 aircraft 1건. 위치가 없으면 None(게이트가 '위치 없음'으로 집계)."""
    lat, lon = _num(ac.get("lat")), _num(ac.get("lon"))
    if lat is None or lon is None:
        return None
    hex_ = _str(ac.get("hex"), 6)
    if not hex_ or len(hex_) != 6:
        return None
    hex_ = hex_.lower()
    alt_raw = ac.get("alt_baro")
    on_ground = alt_raw == "ground"
    alt_ft: int | None
    if on_ground:
        alt_ft = 0
    else:
        a = _num(alt_raw)
        alt_ft = int(round(a)) if a is not None else None
    seen_pos = _num(ac.get("seen_pos"))
    seen_at = fetched_at - timedelta(seconds=seen_pos) if seen_pos is not None else fetched_at
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
    except ValueError:
        return None


# OpenSky states/all 벡터 인덱스 (공식 REST 문서의 state vector 표)
_OS_ICAO24, _OS_CALLSIGN, _OS_TIME_POS, _OS_LAST_CONTACT = 0, 1, 3, 4
_OS_LON, _OS_LAT, _OS_BARO_ALT, _OS_ON_GROUND, _OS_VELOCITY, _OS_TRACK, _OS_VRATE = 5, 6, 7, 8, 9, 10, 11
_OS_SQUAWK, _OS_CATEGORY = 14, 17


def from_opensky(vec: list[Any], fetched_at: datetime) -> AircraftState | None:
    if len(vec) < 12:
        return None
    lon, lat = _num(vec[_OS_LON]), _num(vec[_OS_LAT])
    if lat is None or lon is None:
        return None
    hex_ = _str(vec[_OS_ICAO24], 6)
    if not hex_ or len(hex_) != 6:
        return None
    on_ground = bool(vec[_OS_ON_GROUND])
    alt_m = _num(vec[_OS_BARO_ALT])
    alt_ft = 0 if on_ground else (int(round(alt_m * M_TO_FT)) if alt_m is not None else None)
    vel = _num(vec[_OS_VELOCITY])
    vr = _num(vec[_OS_VRATE])
    tpos = _num(vec[_OS_TIME_POS])
    seen_at = datetime.fromtimestamp(tpos, UTC) if tpos else fetched_at
    track = _track(vec[_OS_TRACK])
    gs = round(vel * MS_TO_KT, 1) if vel is not None else None
    quality = 0 if (gs is not None and track is not None) or on_ground else 1
    cat = vec[_OS_CATEGORY] if len(vec) > _OS_CATEGORY else None
    try:
        return AircraftState(
            hex=hex_.lower(),
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
    except ValueError:
        return None
