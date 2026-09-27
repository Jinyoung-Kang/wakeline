"""AWC SIGMET JSON → 구조화(10.4절).

1. AREA = 링 1개, AREAS = 링 여러 개. lon/lat 이 null 인 점 제거, 점 < 3 이면 링 폐기.
   점이 2,000 개를 넘는 링·링 50 개 초과·전체 점 10,000 개 초과는 자르지 않고 판정 제외(too_many_points/too_many_rings).
2. 닫히지 않은 링은 닫고, 자기교차는 make_valid 로 정리. 경도 ±180 을 걸치면 두 조각으로 분할.
3. 고도대(ft)와 그 출처(계약 §4):
   - base: JSON 값이 있으면 base_source="json". null 이면 base_ft=0 + base_source="assumed_surface"(발표 없음, 판정은 SFC 가정).
   - top : JSON 값이 있으면 top_source="json". null(또는 base 보다 낮은 잘못된 값)이면 원문(raw text)이
           "TOP FLnnn" / "TOP ABV FLnnn" 로 하나의 값을 명시할 때만 그 값 + top_source="raw_text"
           (ABV 는 상한의 하한값 — 발표된 값을 그대로 저장). 그 밖에는 top_ft=None + top_source="unknown"(미발표, 판정은 무제한 가정).
4. 자연키 fir_id:series_id:valid_from. 폴리곤을 만들 수 없는 경보는 geometry=None + excluded_reason.
"""

from __future__ import annotations

import re
from datetime import UTC, datetime
from typing import Any, Literal

from shapely.geometry import MultiPolygon, Polygon, box, mapping
from shapely.ops import unary_union
from shapely.validation import make_valid

from wakeline_collector.models import Sigmet

MAX_POINTS = 2000  # 링 하나의 점 상한 — 넘으면 자르지 않고 제외(잘라서 저장하면 발표되지 않은 다각형이 된다)
MAX_RINGS = 50
MAX_TOTAL_POINTS = 10000  # 링 전체 점 상한(make_valid·unary_union 시간 상한 역할)
MAX_AREA_SQDEG = 40000.0  # 좌표 폭탄 방지: 위경도 면적 상한(대략 반구 수준)

# 원문 상한: "TOP FL380", "TOP ABV FL380"(공백·줄바꿈 변형 허용). "TOPS" 는 일치하지 않는다(\s+ 필요).
_TOP_RE = re.compile(r"\bTOP\s+(?:ABV\s+)?FL(\d{3})\b")


class _TooMany(Exception):
    def __init__(self, reason: str):
        self.reason = reason


def _rings(item: dict[str, Any]) -> list[list[tuple[float, float]]]:
    """유효한 링 목록. 상한을 넘으면 _TooMany(사유) — 잘라내지 않는다."""
    coords = item.get("coords") or []
    raw_rings = coords if item.get("geom") == "AREAS" else [coords]
    if not isinstance(raw_rings, list):
        return []
    rings: list[list[tuple[float, float]]] = []
    total = 0
    for ring in raw_rings:
        if not isinstance(ring, list):
            continue
        pts = [
            (float(p["lon"]), float(p["lat"]))
            for p in ring
            if isinstance(p, dict) and p.get("lon") is not None and p.get("lat") is not None
        ]
        if len(pts) > MAX_POINTS:
            raise _TooMany("too_many_points")
        if len(pts) >= 3:
            total += len(pts)
            rings.append(pts)
            if len(rings) > MAX_RINGS:
                raise _TooMany("too_many_rings")
            if total > MAX_TOTAL_POINTS:
                raise _TooMany("too_many_points")
    return rings


def _split_antimeridian(pts: list[tuple[float, float]]) -> list[Polygon]:
    """경도 점프가 180 을 넘는 링은 +360 으로 펴서 폴리곤을 만들고 [-180,180]·[180,540] 로 잘라 되돌린다."""
    crosses = any(abs(pts[i][0] - pts[i - 1][0]) > 180 for i in range(1, len(pts)))
    if not crosses:
        return [Polygon(pts)]
    shifted = [(lon + 360 if lon < 0 else lon, lat) for lon, lat in pts]
    poly = make_valid(Polygon(shifted))
    west = poly.intersection(box(180, -90, 540, 90))
    east = poly.intersection(box(-180, -90, 180, 90))
    out: list[Polygon] = []
    for part in (west, east):
        geoms = list(part.geoms) if hasattr(part, "geoms") else [part]
        for g in geoms:
            if isinstance(g, Polygon) and not g.is_empty:
                if g.bounds[0] >= 180:
                    g = Polygon([(x - 360, y) for x, y in g.exterior.coords])
                out.append(g)
    return out


def build_geometry(item: dict[str, Any]) -> tuple[dict[str, Any] | None, str | None]:
    try:
        rings = _rings(item)
    except _TooMany as e:
        return None, e.reason
    if not rings:
        n = sum(
            1
            for r in ([item.get("coords") or []] if item.get("geom") != "AREAS" else (item.get("coords") or []))
            for _ in (r if isinstance(r, list) else [])
        )
        return None, "line_or_point_geometry" if n else "no_coordinates"
    polys: list[Polygon] = []
    for ring in rings:
        if ring[0] != ring[-1]:
            ring = [*ring, ring[0]]
        for p in _split_antimeridian(ring):
            fixed = make_valid(p) if not p.is_valid else p
            if fixed.is_empty:
                continue
            if isinstance(fixed, Polygon):
                polys.append(fixed)
            elif hasattr(fixed, "geoms"):
                polys.extend(g for g in fixed.geoms if isinstance(g, Polygon) and not g.is_empty)
    if not polys:
        return None, "invalid_polygon"
    merged = unary_union(polys)
    if merged.is_empty:
        return None, "invalid_polygon"
    mp = (
        merged
        if isinstance(merged, MultiPolygon)
        else MultiPolygon([merged] if isinstance(merged, Polygon) else [g for g in merged.geoms if isinstance(g, Polygon)])
    )
    if mp.is_empty:
        return None, "invalid_polygon"
    if mp.area > MAX_AREA_SQDEG:
        return None, "area_too_large"
    return mapping(mp), None


def _num(v: Any) -> float | None:
    return float(v) if isinstance(v, int | float) and not isinstance(v, bool) else None


def raw_text_top_ft(raw: str) -> int | None:
    """원문이 상한을 하나의 값으로 명시하면 그 값(ft). 없거나 서로 다른 값이 여럿이면 None(추정하지 않는다)."""
    levels = {int(m.group(1)) for m in _TOP_RE.finditer(raw or "")}
    if len(levels) != 1:
        return None
    fl = levels.pop()
    return fl * 100 if fl > 0 else None


BaseSource = Literal["json", "assumed_surface"]
TopSource = Literal["json", "raw_text", "unknown"]


def resolve_band(base: Any, top: Any, raw: str) -> tuple[int, BaseSource, int | None, TopSource, str | None]:
    """(base_ft, base_source, top_ft, top_source, band_note). band_note 는 품질 기록용(JSON top 이 base 보다 낮음 등)."""
    b = _num(base)
    base_ft: int
    base_source: BaseSource
    if b is not None and b >= 0:
        base_ft, base_source = int(b), "json"
    else:
        base_ft, base_source = 0, "assumed_surface"
    note = None
    t = _num(top)
    if t is not None and t > 0 and int(t) >= base_ft:
        return base_ft, base_source, int(t), "json", None
    if t is not None:
        note = "invalid_top"  # 발표값이 있으나 base 이하/0 이하 — 쓰지 않는다(넓히거나 좁혀 추정하지 않음)
    rt = raw_text_top_ft(raw)
    if rt is not None and rt >= base_ft:
        return base_ft, base_source, rt, "raw_text", note
    return base_ft, base_source, None, "unknown", note


def _ts(v: Any) -> datetime | None:
    try:
        return datetime.fromtimestamp(int(v), UTC)
    except (TypeError, ValueError, OSError):
        return None


def parse_isigmet(item: dict[str, Any], fetched_at: datetime, provider: str = "awc_isigmet") -> Sigmet | None:
    fir = item.get("firId") or item.get("icaoId")
    series = item.get("seriesId")
    vf, vt = _ts(item.get("validTimeFrom")), _ts(item.get("validTimeTo"))
    hazard = item.get("hazard")
    if not fir or not series or vf is None or vt is None or not hazard or vt <= vf:
        return None
    geometry, excluded = build_geometry(item)
    raw_text = str(item.get("rawSigmet") or "")
    base_ft, base_source, top_ft, top_source, note = resolve_band(item.get("base"), item.get("top"), raw_text)
    s = Sigmet(
        id=f"{fir}:{series}:{int(vf.timestamp())}",
        fir_id=str(fir),
        fir_name=str(item["firName"]) if item.get("firName") else None,
        issuer=str(item["icaoId"]) if item.get("icaoId") else None,
        series_id=str(series),
        hazard=str(hazard),
        qualifier=str(item["qualifier"]) if item.get("qualifier") is not None else None,
        base_ft=base_ft,
        base_source=base_source,
        top_ft=top_ft,
        top_source=top_source,
        valid_from=vf,
        valid_to=vt,
        geometry=geometry,
        excluded_reason=excluded,
        move_dir=str(item["dir"]) if item.get("dir") is not None else None,
        move_spd=str(item["spd"]) if item.get("spd") is not None else None,
        chng=str(item["chng"]) if item.get("chng") is not None else None,
        raw_text=raw_text,
        provider=provider,
        fetched_at=fetched_at,
    )
    s.band_note = note
    return s


def parse_airsigmet(item: dict[str, Any], fetched_at: datetime, provider: str = "awc_airsigmet") -> Sigmet | None:
    """미국 SIGMET/AIRMET(FR-28). 좌표는 단일 링. 고도는 altitudeLow1/Hi1(ft)."""
    icao = item.get("icaoId")
    series = item.get("seriesId")
    vf, vt = _ts(item.get("validTimeFrom")), _ts(item.get("validTimeTo"))
    hazard = item.get("hazard")
    if not icao or not series or vf is None or vt is None or not hazard or vt <= vf:
        return None
    pseudo = {"geom": "AREA", "coords": item.get("coords") or []}
    geometry, excluded = build_geometry(pseudo)
    hi = item.get("altitudeHi1")
    if hi is None:
        hi = item.get("altitudeHi2")
    raw_text = str(item.get("rawAirSigmet") or "")
    base_ft, base_source, top_ft, top_source, note = resolve_band(item.get("altitudeLow1"), hi, raw_text)
    kind = item.get("airSigmetType") or "SIGMET"
    s = Sigmet(
        id=f"{icao}:{kind}:{series}:{int(vf.timestamp())}",
        fir_id=str(icao),
        fir_name=f"US {kind}",
        issuer=str(icao),
        series_id=str(series),
        hazard=str(hazard),
        qualifier=str(item["severity"]) if item.get("severity") is not None else None,
        base_ft=base_ft,
        base_source=base_source,
        top_ft=top_ft,
        top_source=top_source,
        valid_from=vf,
        valid_to=vt,
        geometry=geometry,
        excluded_reason=excluded,
        move_dir=str(item["movementDir"]) if item.get("movementDir") is not None else None,
        move_spd=str(item["movementSpd"]) if item.get("movementSpd") is not None else None,
        chng=None,
        raw_text=raw_text,
        provider=provider,
        fetched_at=fetched_at,
    )
    s.band_note = note
    return s
