"""해양수산부 해양격자 4단계(ADR-023) — EPSG:5179 좌표를 위경도로 풀고, 0.025° 격자에 맞는지 검사하고, WFS(GML 3.1.1) 응답을 해석한다.

- 투영(EPSG:5179, Korea 2000 / Unified CS): 횡메르카토르 · GRS80(a 6,378,137 m, 1/f 298.257222101) · 원점 위도 38° · 중앙 경선 127.5° ·
  축척 0.9996 · 동거 1,000,000 m · 북거 2,000,000 m. 역변환은 Krüger 급수(n 의 6차, Karney 2011)와 등각 위도 Newton 풀이 — 한반도
  해역(±5° 경도)에서 pyproj 와 1e-9° 안(시험). Korea 2000 은 ITRF 기반이라 WGS84 와의 변환은 0 으로 둔다(EPSG:5179 → 4326 의 표준 변환과 같다).
- 격자 맞춤(2026-09-29 확인: GR4_F2K41_C3 의 모서리가 정확히 37.450/37.475 N · 126.600/126.625 E): 4단계 칸은 0.025°(1′30″) 정사각형이다.
  모서리 네 개가 모두 0.025° 배수에서 1e-6° 안이고, 위도 두 값 · 경도 두 값이 정확히 한 칸(0.025°)을 이룰 때만 칸으로 받는다. 아니면 OffGrid —
  격리(쓰지 않는다). 칸 번호(grid_no)의 글자로 위치를 짐작하지 않는다 — 위치는 WFS 기하에서만 온다.
- GML: 요소의 지역 이름(네임스페이스 무시)으로 읽는다. 받는 것은 확인한 모양뿐이다: 실제 응답(2026-09-29)의 srsName="http://www.opengis.net/gml/srs/epsg.xml#5179" 인 posList(동거 북거 순 — 확인한 꼭짓점이
  0.025° 격자에 맞았다) 다각형 하나.
  다른 srsName(축 순서가 다를 수 있는 URN 등) · 없는 srsName 은 오류(짐작하지 않는다). 요청한 grid_no 와 다른 지물은 오류(다른 칸의 기하를 받지 않는다).
  DOCTYPE·ENTITY 가 있으면 해석하지 않는다(외부 엔티티·확장 공격), 본문 256 KiB 초과도 해석하지 않는다(지물 하나는 수 KB).
"""

from __future__ import annotations

import math
import re
import xml.etree.ElementTree as ET  # noqa: S405 — DOCTYPE·ENTITY 를 먼저 거절하고, 크기 상한을 둔 뒤에만 해석한다(parse_wfs)
from dataclasses import dataclass
from typing import Literal

# ---- EPSG:5179 정의(EPSG 레지스트리 값) ----
A = 6_378_137.0
F = 1 / 298.257222101
LAT0 = 38.0
LON0 = 127.5
K0 = 0.9996
FE = 1_000_000.0
FN = 2_000_000.0

CELL_DEG = 0.025  # 격자 4단계 칸 크기(도) — 확인한 표본의 모서리 간격
SNAP_TOL_DEG = 1e-6  # 모서리가 격자점에서 벗어나도 되는 한도(약 0.1 m)
MAX_WFS_BYTES = 256 * 1024
EXPECTED_SRS = "http://www.opengis.net/gml/srs/epsg.xml#5179"  # 실제 응답의 표기(축 순서 동거 · 북거) — 처음 구현은 짐작한 "EPSG:5179" 를 기대해 모든 조회가 실패했다

_N = F / (2 - F)
_E2 = F * (2 - F)
_E = math.sqrt(_E2)
_N2, _N3, _N4, _N5, _N6 = _N**2, _N**3, _N**4, _N**5, _N**6
_AA = A / (1 + _N) * (1 + _N2 / 4 + _N4 / 64 + _N6 / 256)  # 직각화 반지름

_ALPHA = (
    _N / 2 - 2 * _N2 / 3 + 5 * _N3 / 16 + 41 * _N4 / 180 - 127 * _N5 / 288 + 7891 * _N6 / 37800,
    13 * _N2 / 48 - 3 * _N3 / 5 + 557 * _N4 / 1440 + 281 * _N5 / 630 - 1983433 * _N6 / 1935360,
    61 * _N3 / 240 - 103 * _N4 / 140 + 15061 * _N5 / 26880 + 167603 * _N6 / 181440,
    49561 * _N4 / 161280 - 179 * _N5 / 168 + 6601661 * _N6 / 7257600,
    34729 * _N5 / 80640 - 3418889 * _N6 / 1995840,
    212378941 * _N6 / 319334400,
)
_BETA = (
    _N / 2 - 2 * _N2 / 3 + 37 * _N3 / 96 - _N4 / 360 - 81 * _N5 / 512 + 96199 * _N6 / 604800,
    _N2 / 48 + _N3 / 15 - 437 * _N4 / 1440 + 46 * _N5 / 105 - 1118711 * _N6 / 3870720,
    17 * _N3 / 480 - 37 * _N4 / 840 - 209 * _N5 / 4480 + 5569 * _N6 / 90720,
    4397 * _N4 / 161280 - 11 * _N5 / 504 - 830251 * _N6 / 7257600,
    4583 * _N5 / 161280 - 108847 * _N6 / 3991680,
    20648693 * _N6 / 638668800,
)


def _taup(tau: float) -> float:
    """τ = tan(위도) → τ' = tan(등각 위도) = τ·√(1+σ²) − σ·√(1+τ²), σ = sinh(e·atanh(e·τ/√(1+τ²)))."""
    sig = math.sinh(_E * math.atanh(_E * tau / math.hypot(1.0, tau)))
    return tau * math.hypot(1.0, sig) - sig * math.hypot(1.0, tau)


def _tau_from_taup(taup: float) -> float:
    """τ' → τ(= tan 위도), Newton 풀이(Karney 2011). 몇 번이면 기계 정밀도에 닿는다."""
    e2m = 1.0 - _E2
    tau = taup / e2m
    for _ in range(8):
        tp = _taup(tau)
        dtau = (taup - tp) * (1 + e2m * tau * tau) / (e2m * math.hypot(1.0, tau) * math.hypot(1.0, tp))
        tau += dtau
        if abs(dtau) < 1e-15 * max(1.0, abs(tau)):
            break
    return tau


def _xi_eta(phi: float, dlam: float) -> tuple[float, float]:
    tp = _taup(math.tan(phi))
    xip = math.atan2(tp, math.cos(dlam))
    etap = math.asinh(math.sin(dlam) / math.hypot(tp, math.cos(dlam)))
    xi, eta = xip, etap
    for j, a in enumerate(_ALPHA, start=1):
        xi += a * math.sin(2 * j * xip) * math.cosh(2 * j * etap)
        eta += a * math.cos(2 * j * xip) * math.sinh(2 * j * etap)
    return xi, eta


_XI0, _ = _xi_eta(math.radians(LAT0), 0.0)


def wgs84_to_tm5179(lat: float, lon: float) -> tuple[float, float]:
    """위경도(도) → EPSG:5179 (동거 x, 북거 y) m. 시험·검산용(수집 경로는 역변환만 쓴다)."""
    xi, eta = _xi_eta(math.radians(lat), math.radians(lon - LON0))
    return FE + K0 * _AA * eta, FN + K0 * _AA * (xi - _XI0)


def tm5179_to_wgs84(x: float, y: float) -> tuple[float, float]:
    """EPSG:5179 (동거 x, 북거 y) m → (위도, 경도) 도. 유한하지 않은 값은 ValueError."""
    if not (math.isfinite(x) and math.isfinite(y)):
        raise ValueError("non-finite EPSG:5179 coordinate")
    xi = (y - FN) / (K0 * _AA) + _XI0
    eta = (x - FE) / (K0 * _AA)
    xip, etap = xi, eta
    for j, b in enumerate(_BETA, start=1):
        xip -= b * math.sin(2 * j * xi) * math.cosh(2 * j * eta)
        etap -= b * math.cos(2 * j * xi) * math.sinh(2 * j * eta)
    s, c = math.sinh(etap), math.cos(xip)
    r = math.hypot(s, c)
    taup = math.sin(xip) / r if r else math.copysign(math.inf, math.sin(xip))
    lat = math.degrees(math.atan(_tau_from_taup(taup)))
    lon = LON0 + math.degrees(math.atan2(s, c))
    return lat, lon


# ---- 격자 맞춤 ----


def snap(v: float) -> float | None:
    """v 가 0.025° 배수에서 SNAP_TOL_DEG 안이면 그 배수(소수 셋째 자리로 반올림한 정확한 값), 아니면 None."""
    if not math.isfinite(v):
        return None
    k = round(v / CELL_DEG)
    if abs(v - k * CELL_DEG) > SNAP_TOL_DEG:
        return None
    return round(k * CELL_DEG, 3) + 0.0  # -0.0 → 0.0


class OffGrid(ValueError):
    """기하가 0.025° 격자 한 칸이 아니다 — 격리한다(지도에 쓰지 않는다)."""


@dataclass(frozen=True)
class Cell:
    grid_no: str
    lat_min: float
    lon_min: float
    lat_max: float
    lon_max: float
    gid: int | None = None


def cell_from_ring(grid_no: str, gid: int | None, ring: list[tuple[float, float]]) -> Cell:
    """닫힌 외곽선(EPSG:5179 동거·북거, 점 5개) → 칸. 격자에 맞지 않으면 OffGrid(이유)."""
    if len(ring) != 5:
        raise OffGrid(f"exterior ring has {len(ring)} points, expected 5 points (closed square)")
    if ring[0] != ring[-1]:
        raise OffGrid("exterior ring is not closed")
    lats: set[float] = set()
    lons: set[float] = set()
    corners: set[tuple[float, float]] = set()
    for x, y in ring[:4]:
        lat, lon = tm5179_to_wgs84(x, y)
        sl, so = snap(lat), snap(lon)
        if sl is None or so is None:
            raise OffGrid(f"corner {lat:.7f},{lon:.7f} is off the 0.025° lattice (tolerance {SNAP_TOL_DEG:g}°)")
        lats.add(sl)
        lons.add(so)
        corners.add((sl, so))
    if len(corners) != 4:
        raise OffGrid(f"{len(corners)} distinct corners, expected 4")
    if len(lats) != 2 or len(lons) != 2:
        raise OffGrid("corners do not form an axis-aligned square")
    lat_min, lat_max = sorted(lats)
    lon_min, lon_max = sorted(lons)
    if abs(lat_max - lat_min - CELL_DEG) > SNAP_TOL_DEG or abs(lon_max - lon_min - CELL_DEG) > SNAP_TOL_DEG:
        raise OffGrid(f"square {lat_max - lat_min:.3f}°×{lon_max - lon_min:.3f}° is not one 0.025° cell")
    if not (-90 <= lat_min and lat_max <= 90 and -180 <= lon_min and lon_max <= 180):
        raise OffGrid("cell outside WGS84 bounds")
    return Cell(grid_no, lat_min, lon_min, lat_max, lon_max, gid)


# ---- WFS(GML) ----


class WfsError(ValueError):
    """응답이 확인한 모양이 아니다(오류 문서 · 다른 좌표계 · 형식 오류). 메시지는 응답에서 온 짧은 글(가려서 싣는다 — 호출자)."""


@dataclass(frozen=True)
class WfsResult:
    kind: Literal["found", "not_found", "off_grid"]
    cell: Cell | None = None
    detail: str | None = None


def _local(tag: object) -> str:
    return tag.rsplit("}", 1)[-1] if isinstance(tag, str) else ""


def _text(el: ET.Element | None) -> str:
    return " ".join("".join(el.itertext()).split()) if el is not None else ""


def _find_local(root: ET.Element, name: str) -> list[ET.Element]:
    return [e for e in root.iter() if _local(e.tag) == name]


def _child_local(el: ET.Element, name: str) -> ET.Element | None:
    return next((c for c in el if _local(c.tag) == name), None)


_WS = re.compile(r"\s+")


def _error_document(root: ET.Element) -> str | None:
    """OGC 예외 문서 · 공공데이터포털 게이트웨이 오류면 짧은 설명, 아니면 None."""
    name = _local(root.tag)
    if name in ("ServiceExceptionReport", "ExceptionReport"):
        parts: list[str] = []
        for e in root.iter():
            if _local(e.tag) in ("ServiceException", "Exception"):
                code = e.get("code") or e.get("exceptionCode") or ""
                parts.append(f"{code}: {_text(e)}".strip(": "))
        return f"{name} — " + ("; ".join(parts) if parts else "no detail")
    if name == "OpenAPI_ServiceResponse":
        get = {_local(e.tag): _text(e) for e in root.iter()}
        auth, code, msg = get.get("returnAuthMsg", ""), get.get("returnReasonCode", ""), get.get("errMsg", "")
        return f"portal error {msg} {auth} (returnReasonCode {code})".replace("  ", " ")
    return None


def _pos_list(text: str) -> list[tuple[float, float]]:
    toks = _WS.split(text.strip()) if text.strip() else []
    if len(toks) % 2:
        raise WfsError(f"posList has an odd number of values ({len(toks)})")
    try:
        vals = [float(t) for t in toks]
    except ValueError:
        raise WfsError("posList has a non-numeric value") from None
    if not all(math.isfinite(v) for v in vals):
        raise WfsError("posList has a non-finite value")
    return [(vals[i], vals[i + 1]) for i in range(0, len(vals), 2)]


def parse_wfs(body: bytes, grid_no: str) -> WfsResult:
    """getOpnG4sWFS 응답 하나(grid_no=…&maxFeatures=1) → found · not_found · off_grid. 그 밖은 WfsError."""
    if len(body) > MAX_WFS_BYTES:
        raise WfsError(f"response too large ({len(body)} bytes)")
    head = body[:4096].upper()
    if b"<!DOCTYPE" in head or b"<!ENTITY" in body.upper():
        raise WfsError("DOCTYPE/ENTITY in response — refused")
    if not body.strip():
        raise WfsError("empty response")
    try:
        root = ET.fromstring(body)  # noqa: S314 — DOCTYPE·ENTITY 거절 · 크기 상한 뒤(모듈 설명)
    except ET.ParseError as e:
        raise WfsError(f"not XML (line {e.position[0]})") from None
    err = _error_document(root)
    if err is not None:
        raise WfsError(err[:300])
    if _local(root.tag) != "FeatureCollection":
        raise WfsError(f"unexpected root element {_local(root.tag)[:40]}")
    features = [f for f in root.iter() if _child_local(f, "grid_no") is not None and _child_local(f, "geom") is not None]
    declared = root.get("numberOfFeatures")
    if not features:
        if declared not in (None, "0"):
            raise WfsError(f"numberOfFeatures={declared[:12]} but no feature with grid_no and geom")
        return WfsResult("not_found")
    if len(features) > 1:
        raise WfsError(f"{len(features)} features for maxFeatures=1")
    f = features[0]
    got = _text(_child_local(f, "grid_no"))
    if got != grid_no:
        raise WfsError(f"grid_no mismatch: asked {grid_no}, got {got[:40]}")
    gid_text = _text(_child_local(f, "gid"))
    gid = int(gid_text) if re.fullmatch(r"-?\d{1,9}", gid_text) else None
    geom = _child_local(f, "geom")
    assert geom is not None  # 위에서 골랐다
    srs = {e.get("srsName") for e in geom.iter() if e.get("srsName") is not None}
    if srs != {EXPECTED_SRS}:
        raise WfsError(f"unexpected srsName {sorted(s or '' for s in srs) or 'missing'} (expected {EXPECTED_SRS})")
    polygons = _find_local(geom, "Polygon")
    if len(polygons) != 1:
        return WfsResult("off_grid", detail=f"{len(polygons)} polygons, expected 1")
    if _find_local(polygons[0], "interior"):
        return WfsResult("off_grid", detail="polygon has interior rings")
    exterior = _find_local(polygons[0], "exterior")
    pos = _find_local(exterior[0], "posList") if exterior else []
    if len(pos) != 1:
        raise WfsError("exterior ring without exactly one posList")
    dim = pos[0].get("srsDimension")
    if dim not in (None, "2"):
        raise WfsError(f"posList srsDimension {dim[:4]} (expected 2)")
    ring = _pos_list(_text(pos[0]))
    try:
        return WfsResult("found", cell=cell_from_ring(grid_no, gid, ring))
    except OffGrid as e:
        return WfsResult("off_grid", detail=str(e))
