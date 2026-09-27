"""AWC SIGMET JSON → 구조화(10.4절).

1. AREA = 링 1개, AREAS = 링 여러 개. lon/lat 이 null 인 점 제거, 점 < 3 이면 링 폐기.
2. 닫히지 않은 링은 닫고, 자기교차는 buffer(0) 로 정리. 경도 ±180 을 걸치면 두 조각으로 분할.
3. base null → 0(SFC), top null → None(상한 없음). 단위 ft.
4. 자연키 fir_id:series_id:valid_from. 폴리곤을 만들 수 없는 경보는 geometry=None + excluded_reason.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from shapely.geometry import MultiPolygon, Polygon, box, mapping
from shapely.ops import unary_union
from shapely.validation import make_valid

from skywx_collector.models import Sigmet

MAX_POINTS = 2000
MAX_AREA_SQDEG = 40000.0  # 좌표 폭탄 방지: 위경도 면적 상한(대략 반구 수준)


def _rings(item: dict[str, Any]) -> list[list[tuple[float, float]]]:
    coords = item.get("coords") or []
    raw_rings = coords if item.get("geom") == "AREAS" else [coords]
    rings: list[list[tuple[float, float]]] = []
    for ring in raw_rings:
        if not isinstance(ring, list):
            continue
        pts = [
            (float(p["lon"]), float(p["lat"]))
            for p in ring
            if isinstance(p, dict) and p.get("lon") is not None and p.get("lat") is not None
        ]
        if len(pts) >= 3:
            rings.append(pts[:MAX_POINTS])
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
    rings = _rings(item)
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
    base = item.get("base")
    top = item.get("top")
    base_ft = int(base) if isinstance(base, int | float) and base >= 0 else 0
    top_ft = int(top) if isinstance(top, int | float) else None
    if top_ft is not None and top_ft < base_ft:
        top_ft = None
    return Sigmet(
        id=f"{fir}:{series}:{int(vf.timestamp())}",
        fir_id=str(fir),
        fir_name=str(item["firName"]) if item.get("firName") else None,
        issuer=str(item["icaoId"]) if item.get("icaoId") else None,
        series_id=str(series),
        hazard=str(hazard),
        qualifier=str(item["qualifier"]) if item.get("qualifier") is not None else None,
        base_ft=base_ft,
        top_ft=top_ft,
        valid_from=vf,
        valid_to=vt,
        geometry=geometry,
        excluded_reason=excluded,
        move_dir=str(item["dir"]) if item.get("dir") is not None else None,
        move_spd=str(item["spd"]) if item.get("spd") is not None else None,
        chng=str(item["chng"]) if item.get("chng") is not None else None,
        raw_text=str(item.get("rawSigmet") or ""),
        provider=provider,
        fetched_at=fetched_at,
    )


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
    low = item.get("altitudeLow1")
    hi = item.get("altitudeHi1")
    if hi is None:
        hi = item.get("altitudeHi2")
    kind = item.get("airSigmetType") or "SIGMET"
    return Sigmet(
        id=f"{icao}:{kind}:{series}:{int(vf.timestamp())}",
        fir_id=str(icao),
        fir_name=f"US {kind}",
        issuer=str(icao),
        series_id=str(series),
        hazard=str(hazard),
        qualifier=str(item["severity"]) if item.get("severity") is not None else None,
        base_ft=int(low) if isinstance(low, int | float) and low >= 0 else 0,
        top_ft=int(hi) if isinstance(hi, int | float) else None,
        valid_from=vf,
        valid_to=vt,
        geometry=geometry,
        excluded_reason=excluded,
        move_dir=str(item["movementDir"]) if item.get("movementDir") is not None else None,
        move_spd=str(item["movementSpd"]) if item.get("movementSpd") is not None else None,
        chng=None,
        raw_text=str(item.get("rawAirSigmet") or ""),
        provider=provider,
        fetched_at=fetched_at,
    )
