"""AWC SIGMET JSON → 구조화(10.4절).

1. AREA = 링 1개, AREAS = 링 여러 개. lon/lat 이 null 인 점 제거, 점 < 3 이면 링 폐기.
   점이 2,000 개를 넘는 링·링 50 개 초과·전체 점 10,000 개 초과는 자르지 않고 판정 제외(too_many_points/too_many_rings).
2. 닫히지 않은 링은 닫고, 자기교차는 make_valid 로 정리. 경도 ±180 을 걸치면(점프든 180 을 넘는 이어진 경도든) [-180, 180] 조각으로 분할.
3. 고도대(ft)와 그 출처(계약 §4):
   - base: JSON 값이 있으면 base_source="json". null 이면 base_ft=0 + base_source="assumed_surface"(발표 없음, 판정은 SFC 가정).
           원문 고도대(아래)의 가장 낮은 값이 JSON 하한보다 낮으면 그 값 + base_source="raw_text"(계약 v5 §G59).
   - top : JSON 값이 있으면 그 값 + top_source="json". 다만 원문의 "TOP ABV FLnnn" 값 가운데 어느 하나가 바로 그 값이면(AWC 가
           ABV 값을 top 으로 준 경우 — 원문에 TOP 값이 여럿이어도) top_source="raw_text_lower_bound" — 상한이 아니라 상한의 하한이다
           (IM-01 · R8). V4 SQL 보정은 원문의 첫 "TOP ABV" 값만 보므로 이 규칙이 하한 쪽으로만 조금 넓다(알림을 빼는 쪽으로는
           갈리지 않는다). JSON 값과 같은 ABV 값이 없으면 단정하지 않고 "json" 그대로, "TOPS ABV" 는 정규식이 일부러 받지 않아
           "json" 그대로.
           JSON 이 null(또는 base 보다 낮은 잘못된 값)이면 원문이 "TOP FLnnn" / "TOP ABV FLnnn" 로 하나의 값을 명시할 때만 그 값 +
           top_source="raw_text"(ABV 는 "raw_text_lower_bound" — 발표된 값을 그대로 저장, 판정은 위쪽 무제한 가정).
           그 밖에는 top_ft=None + top_source="unknown"(미발표, 판정은 무제한 가정). "TOP FLaaa/bbb"(상한이 aaa–bbb)는 bbb 쪽 큰 값이다
           — 앞 값만 읽으면 그 사이 항공기를 뺀다(ABV 는 V4 · V22 SQL 과 같게 앞 값).
   - 원문 고도대 "A/B"(A = SFC · FLnnn · nnnFT · nnnM, B = FLnnn · nnnFT · nnnM — 숫자 3–5자리, A 가 FL 이면 FL 을 뺀 nnn 도)가 JSON 보다 넓으면
     넓은 쪽만 원문 값으로 바꾼다 — 상한은 원문 값 가운데 가장 높은 값(top_source="raw_text", band_note "top_below_raw_band"), 하한은 가장
     낮은 값(base_source="raw_text", band_note "base_above_raw_band" — "TOP FLaaa/bbb" 의 aaa 는 하한이 아니다). 품질 기록 sigmet_invalid_band.
     실수신(VERIFICATION #156): AWC 가 오류 없이 'SFC/10000FT' 를 top 100, 'TOP FL230/250' 을 23000, 구역 둘의 'SFC/FL070 … SFC/FL120' 을
     7000, 역순 'FL400/280' 을 base 40000 · top null 로 줬다(같은 'SFC/10000FT' 가 맞게 온 날도 있다). 넓히는 쪽만 바꾼다: JSON 이 원문보다
     넓거나, 상한이 없거나(무제한 가정) 'ABV' 하한이거나, 하한이 SFC 가정이면 그대로 두고, 원문 자체의 이상한 값(SKED 'SFC/190FT')은 고치지
     않는다. 이미 저장된 행은 V23 이 같은 규칙으로 고쳤다.
4. 자연키 fir_id:series_id:valid_from. 폴리곤을 만들 수 없는 경보는 geometry=None + excluded_reason.
5. 유효 시간(validTimeFrom/To, 유닉스 초): 값이 빠졌으면 받지 않는다(다른 필수 필드와 같다). 값이 있는데 시각이 될 수 없으면(0 이하 ·
   끝 ≤ 시작 · MAX_VALIDITY_S 초과) InvalidValidity — 받지 않되 작업이 sigmet_parse_error 품질 기록에 남긴다. 실수신(NFFF SIGMET 15,
   2026-09-30): 30일에 낸 원문이 9월에 없는 31일을 유효 시작으로 적자 AWC 가 validTimeFrom 0 을 줬고, 그것을 1970-01-01 로 저장해 api 일 통계
   따라잡기가 1970 까지 거꾸로 셌다(VERIFICATION #155). 발표 시각 · 받은 시각으로 메우지 않는다 — 발표되지 않은 유효 시작이 되고(SIGMET 은 유효
   시작보다 최대 몇 시간 먼저 낸다) 자연키도 그 값으로 만든다.
"""

from __future__ import annotations

import math
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
# 유효 기간 상한: ICAO Annex 3 SIGMET 4 h(화산재 · 열대저기압 6 h), 미국 AIRMET 6 h. 로컬 저장분 12,208건의 최대는 7 h 59 m(2026-10-20) —
# 넉넉히 하루. 넘으면 두 시각 중 하나가 틀린 것이다.
MAX_VALIDITY_S = 24 * 3600

# 원문 상한: "TOP FL380", "TOP ABV FL380", "TOP FL320/370"(공백·줄바꿈 변형 허용). "TOPS" 는 일치하지 않는다(\s+ 필요).
# 뒤에 다른 '/' 가 붙은 값(TOP FL320/10000FT 등)은 받지 않는다 — 앞 값만 읽지 않도록.
_TOP_RE = re.compile(r"\bTOP\s+(ABV\s+)?FL(\d{3})(?:/(?:FL)?(\d{3}))?\b(?!/)")
# 원문 고도대 "A/B"(모듈 설명 3). 앞뒤가 글자 · 숫자 · '/' 이면 고도대가 아니다(유효 시간 270800/271200 · 좌표 등).
_BAND_RE = re.compile(
    r"(?<![A-Z0-9/])(?P<lead>(?:TOP\s+)?(?:ABV\s+)?)(?P<a>SFC|FL\d{3}|\d{3,5}FT|\d{3,5}M)/(?P<b>FL\d{3}|\d{3,5}FT|\d{3,5}M|\d{3})(?![A-Z0-9/])"
)


class InvalidValidity(ValueError):
    """유효 시간 값이 있으나 시각이 될 수 없다 — 그 경보는 받지 않고 품질 기록에 남긴다(모듈 설명 5)."""


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
    """경도를 [-180, 180] 조각으로. 링을 먼저 이어진 경도로 편다(점 사이 점프가 180 을 넘으면 ∓360) — 공급자가 날짜변경선을
    점프(175 → -175)로 주든 이어진 경도(179 → 184, 실수신 UHMM 2026-09-29)로 주든 같은 폴리곤이 된다. 그다음 360° 폭 창
    [-180 + 360k, 180 + 360k] 마다 잘라 k·360 만큼 되돌린다. 모든 좌표가 이미 [-180, 180] 안이고 점프가 없으면 그대로."""
    unwrapped: list[tuple[float, float]] = []
    for lon, lat in pts:
        if unwrapped:
            prev = unwrapped[-1][0]
            while lon - prev > 180:
                lon -= 360
            while lon - prev < -180:
                lon += 360
        unwrapped.append((lon, lat))
    lons = [x for x, _ in unwrapped]
    if min(lons) >= -180 and max(lons) <= 180:
        return [Polygon(unwrapped)]
    poly = make_valid(Polygon(unwrapped))
    out: list[Polygon] = []
    for k in range(math.floor((min(lons) + 180) / 360), math.floor((max(lons) + 180) / 360) + 1):
        part = poly.intersection(box(-180 + 360 * k, -90, 180 + 360 * k, 90))
        geoms = list(part.geoms) if hasattr(part, "geoms") else [part]
        for g in geoms:
            if isinstance(g, Polygon) and not g.is_empty:
                out.append(
                    Polygon(
                        [(x - 360 * k, y) for x, y in g.exterior.coords],
                        [[(x - 360 * k, y) for x, y in r.coords] for r in g.interiors],
                    )
                )
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


def _top_fl(m: re.Match[str]) -> int:
    """_TOP_RE 일치의 FL 값. 'TOP FLaaa/bbb' 는 큰 값, ABV 는 앞 값(V4 · V22 SQL 의 첫 'TOP ABV' 값과 같게)."""
    if m.group(1) or not m.group(3):
        return int(m.group(2))
    return max(int(m.group(2)), int(m.group(3)))


def _level_ft(tok: str, *, upper: bool) -> int | None:
    if tok == "SFC":
        return 0
    if tok.startswith("FL"):
        return int(tok[2:]) * 100
    if tok.endswith("FT"):
        return int(tok[:-2])
    if tok.endswith("M"):  # 1 ft = 0.3048 m(정확) — 넓히는 쪽으로(상한은 올림 · 하한은 내림). 정수로 셈해 V23 SQL 과 같은 값
        n = int(tok[:-1]) * 10000
        return -(-n // 3048) if upper else n // 3048
    return None


def raw_text_band(raw: str) -> tuple[int | None, int | None]:
    """원문 고도대 "A/B" 의 (가장 낮은 하한, 가장 높은 상한) ft. ABV 가 붙은 것은 빼고, "TOP FLaaa/bbb" 는 상한에만 든다(aaa 는 하한이 아니다).
    순서는 보지 않는다(역순 'FL400/280' 도 FL280–400). 고도대가 없으면 (None, None)."""
    lows: list[int] = []
    tops: list[int] = []
    for m in _BAND_RE.finditer(raw or ""):
        lead = m.group("lead")
        if "ABV" in lead:
            continue
        a, b = m.group("a"), m.group("b")
        if b.isdigit():  # FL 을 뺀 nnn 은 앞이 FL 일 때만(FL250/350)
            if not a.startswith("FL"):
                continue
            b = f"FL{b}"
        tops.append(max(v for v in (_level_ft(a, upper=True), _level_ft(b, upper=True)) if v is not None))
        if not lead.startswith("TOP"):
            lows.append(min(v for v in (_level_ft(a, upper=False), _level_ft(b, upper=False)) if v is not None))
    return (min(lows) if lows else None), (max(tops) if tops else None)


def raw_text_top(raw: str) -> tuple[int, bool] | None:
    """원문이 상한을 하나의 값으로 명시하면 (ft, 하한인가). "TOP ABV FLnnn" 은 상한이 그 값 *이상*이라는 뜻이라
    lower_bound=True — 그 값을 상한으로 쓰면 더 높은 고도의 항공기를 경보 밖으로 잘못 뺀다(DH-4).
    값이 없거나 서로 다른 값이 여럿이면 None(추정하지 않는다)."""
    found = [(_top_fl(m), m.group(1) is not None) for m in _TOP_RE.finditer(raw or "")]
    levels = {fl for fl, _ in found}
    if len(levels) != 1:
        return None
    fl = levels.pop()
    if fl <= 0:
        return None
    return fl * 100, any(abv for _, abv in found)


def raw_text_top_ft(raw: str) -> int | None:
    """원문 상한 값(ft) — 하한 여부는 raw_text_top 참고."""
    r = raw_text_top(raw)
    return r[0] if r else None


BaseSource = Literal["json", "assumed_surface", "raw_text"]
TopSource = Literal["json", "raw_text", "raw_text_lower_bound", "unknown"]


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
    rt = raw_text_top(raw)
    top_ft: int | None
    top_source: TopSource
    if t is not None and t > 0 and int(t) >= base_ft:
        # 원문 "TOP ABV FLnnn" 값 가운데 하나와 같으면 AWC 가 하한을 top 으로 준 것 — 고정 상한으로 쓰면 위쪽 항공기를 빼게 된다
        # (IM-01). 원문에 TOP 값이 여럿이어도(관측분 · 예보분) 같다 — 여기서는 값을 고르지 않고 JSON 값의 성격만 보므로
        # raw_text_top 의 단일 값 조건을 쓰지 않는다(R8). 같은 ABV 값이 없으면 단정하지 않고 발표된 JSON 그대로(V4 의 ABV_OTHER).
        abv_tops = {int(m.group(2)) * 100 for m in _TOP_RE.finditer(raw or "") if m.group(1)}
        top_ft, top_source = int(t), ("raw_text_lower_bound" if int(t) in abv_tops else "json")
    else:
        if t is not None:
            note = "invalid_top"  # 발표값이 있으나 base 이하/0 이하 — 쓰지 않는다(넓히거나 좁혀 추정하지 않음)
        if rt is not None and rt[0] >= base_ft:
            top_ft, top_source = rt[0], ("raw_text_lower_bound" if rt[1] else "raw_text")
        else:
            top_ft, top_source = None, "unknown"
    # 원문 고도대가 더 넓으면 넓힌다(모듈 설명 3) — 상한은 고정 상한(json · raw_text)일 때만(무제한 가정 · 'ABV' 하한은 이미 더 넓다),
    # 하한은 발표된 JSON 하한일 때만(SFC 가정은 더 낮출 것이 없다). 위의 상한 결정은 JSON 하한으로 한다 — 예전과 같은 값을 고르고 넓히기만 더한다.
    band_low, band_top = raw_text_band(raw)
    if top_ft is not None and top_source in ("json", "raw_text") and band_top is not None and band_top > top_ft:
        top_ft, top_source = band_top, "raw_text"
        note = f"{note};top_below_raw_band" if note else "top_below_raw_band"
    if base_source == "json" and band_low is not None and band_low < base_ft:
        base_ft, base_source = band_low, "raw_text"
        note = f"{note};base_above_raw_band" if note else "base_above_raw_band"
    return base_ft, base_source, top_ft, top_source, note


def _ts(v: Any) -> datetime | None:
    try:
        return datetime.fromtimestamp(int(v), UTC)
    except (TypeError, ValueError, OSError):
        return None


def _validity(item: dict[str, Any], who: str) -> tuple[datetime, datetime] | None:
    """(valid_from, valid_to). 값이 빠졌으면 None(받지 않는다), 있는데 시각이 될 수 없으면 InvalidValidity(모듈 설명 5)."""
    raw_from, raw_to = item.get("validTimeFrom"), item.get("validTimeTo")
    if raw_from is None or raw_to is None:
        return None
    vf, vt = _ts(raw_from), _ts(raw_to)
    shown = f"{who}: validTimeFrom={raw_from!r} validTimeTo={raw_to!r}"
    if vf is None or vf.timestamp() <= 0:
        raise InvalidValidity(f"{shown} — validTimeFrom is not a time")
    if vt is None or vt.timestamp() <= 0:
        raise InvalidValidity(f"{shown} — validTimeTo is not a time")
    if vt <= vf:
        raise InvalidValidity(f"{shown} — validTimeTo is not after validTimeFrom")
    if (vt - vf).total_seconds() > MAX_VALIDITY_S:
        raise InvalidValidity(f"{shown} — validity longer than {MAX_VALIDITY_S // 3600} h")
    return vf, vt


def parse_isigmet(item: dict[str, Any], fetched_at: datetime, provider: str = "awc_isigmet") -> Sigmet | None:
    fir = item.get("firId") or item.get("icaoId")
    series = item.get("seriesId")
    hazard = item.get("hazard")
    if not fir or not series or not hazard:
        return None
    validity = _validity(item, f"{fir} {series}")
    if validity is None:
        return None
    vf, vt = validity
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
    hazard = item.get("hazard")
    if not icao or not series or not hazard:
        return None
    validity = _validity(item, f"{icao} {series}")
    if validity is None:
        return None
    vf, vt = validity
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
