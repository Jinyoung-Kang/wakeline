"""공역 자료(국토교통부 '공역정보 지도자료' — AIP 차수 기준 KMZ/KML) 해석 규칙(ADR-034 · SPEC F1).

이용 조건(eAIP GEN 0.1 §5): 국토교통부 저작물 — 이익을 얻는 이용은 사전 허가, 무단 변경 금지, 출처 표시. 저장소(공개)에는 원본도, 원본에서 만든 좌표도
넣지 않는다 — 운영자가 받은 파일을 표준 입력으로 가져온다(tools.airspace_import). 시험은 같은 구조의 **가짜** KML(tests/fixtures/airspace)만 쓴다.

확인한 모양(AIP 25년 5차 기준, 2026-10-09 파일을 직접 세어 봄):
- KMZ = zip 안 `doc.kml` 하나(3.8 MB). 장소표(Placemark) 697개 = 다각형 383(MultiGeometry 안 Polygon 하나 — 안쪽 고리는 '공해' 하나) ·
  항로 선 314(MultiGeometry 안 LineString). 점 65,649개, 장소표 하나 최대 7,628점.
- 종류는 폴더 이름에 있다(`3.Airspace_통제공역 / 비행금지구역` …). `Type_Code` 는 128개가 'Other'(원전 · 초경량 · 군작전 …)라 종류로 쓰지 않는다 —
  원문 값만 보관한다.
- 속성은 description(CDATA 안 HTML 표)의 `<tr><td>열쇠</td><td>값</td></tr>`. 빈 값은 `<Null>`. 첫 줄(칸 하나)은 제목.
- 문서 요소에 `xsi:schemaLocation` 이 있는데 `xmlns:xsi` 선언이 없다 — 그대로는 XML 이 아니다(unbound prefix). 선언을 하나 더해 해석한다.
- 고도 한계 = `DistVert{Upper,Lower}_Val · _UOM · _Code`. 같은 뜻을 여러 글자로 적는다(Feet/FT · Flight Level/FL · Altitude/ALT/MSL ·
  Height/HEI · Surface/SFC · Ground/GND · Unlimited/UNLTD). 값이 있는데 기준이 SFC 인 것(비행장교통구역 상한 'n FT SFC')은 지면 기준 높이다.
  기준을 알 수 없거나 값이 ±100,000 ft(FL999) 밖이면 UNKNOWN — 판정에 쓰지 않는다(짐작하지 않는다).

거절(해석 전 · 중): 입력 20 MiB 초과 · zip 안 .kml 이 하나가 아님 · 풀린 크기 20 MiB 초과(머리말의 크기를 믿지 않고 읽으며 센다) ·
엄격한 UTF-8 아님 · DOCTYPE/ENTITY(xml_intake) · 장소표 5,000개 · 전체 점 300,000개 초과 · 깨진 zip 멤버(CRC · 압축) · 폴더 중첩 64단 초과. 장소표 하나의 문제(점 20,000개 초과 · 좌표가 위경도
범위 밖 · 고리 점 부족 · 도형 없음 · 다각형과 선이 섞임)는 그 장소표만 건너뛰고 까닭을 센다.
"""

from __future__ import annotations

import html
import io
import math
import re
import zipfile
import zlib
from collections import Counter
from dataclasses import dataclass, field
from html.parser import HTMLParser

from wakeline_collector.xml_intake import checked_text, child_local, local, parse_text, text_of

MAX_INPUT_BYTES = 20 * 2**20
MAX_KML_BYTES = 20 * 2**20
MAX_ZIP_MEMBERS = 64
MAX_PLACEMARKS = 5_000
MAX_POINTS_TOTAL = 300_000
MAX_POINTS_PER_FEATURE = 20_000
MAX_FOLDER_DEPTH = 64  # 실제 파일은 2단 — 깊은 중첩은 재귀 한도(RecursionError)로 traceback 이 됐다(QA-711)
MAX_LIMIT_FT = 100_000  # FL999 까지. 밖의 값(1e400 → inf · int 열을 넘는 값)은 숫자가 아닌 것과 같이 UNKNOWN(QA-711)

XSI = 'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"'


class AirspaceError(ValueError):
    """가져오기 전체를 거절하는 문제."""


class AirspaceTooLarge(AirspaceError):
    pass


# 폴더 이름(앞의 'n.Airspace_' 를 뗀 것) → (종류 코드, 화면 이름). 장소표의 폴더 경로를 안쪽부터 보며 처음 맞는 것. 모르는 폴더는 'other'.
CATEGORIES: dict[str, tuple[str, str]] = {
    "비행금지구역": ("prohibited", "비행금지구역"),
    "원자력발전소": ("nuclear", "원전 임시비행금지구역"),
    "안보구역": ("security", "안보 임시비행금지구역"),
    "비행제한구역": ("restricted", "비행제한구역"),
    "위험구역": ("danger", "위험구역"),
    "경계구역": ("alert", "경계구역"),
    "군작전구역": ("moa", "군작전구역"),
    "훈련구역": ("training", "훈련구역"),
    "통제공역_초경량비행장치비행구역": ("ultralight", "초경량비행장치 비행구역"),
    "관제권": ("ctr", "관제권"),
    "지역관제구역": ("cta", "지역관제구역"),
    "비행장교통구역": ("atz", "비행장교통구역"),
    "공역등급": ("class", "공역등급"),
    "CONV": ("route", "항공로"),
    "RNAV": ("route", "항공로(RNAV)"),
    "ATSRoute_HOLDING_정렬": ("route", "항공로(대기)"),
    "고고도": ("uncontrolled", "비관제공역"),
    "저고도": ("uncontrolled", "비관제공역"),
    "비행정보구역": ("fir", "비행정보구역"),
    "방공식별구역": ("adiz", "방공식별구역"),
}
_FOLDER_PREFIX = re.compile(r"^\d+\.Airspace_")

BASES = ("MSL", "FL", "AGL", "SFC", "UNL", "UNKNOWN")
_FT_UOM = {"FEET", "FT"}
_FL_UOM = {"FLIGHT LEVEL", "FL"}
_M_UOM = {"METERS", "METRES", "M"}
_MSL_CODE = {"ALTITUDE", "ALT", "MSL"}
_AGL_CODE = {"HEIGHT", "HEI", "AGL"}
_SURFACE_CODE = {"SURFACE", "SFC", "GROUND", "GND"}
_UNL_CODE = {"UNLIMITED", "UNLTD", "UNL"}
_NUM = re.compile(r"^-?\d+(\.\d+)?$")


@dataclass(frozen=True)
class Limit:
    """고도 한계 하나. ft 는 FL 이면 FL×100, SFC 면 0, UNL · UNKNOWN 이면 None. raw 는 원문 세 값(빈 값 뺌)."""

    ft: int | None
    basis: str
    raw: str


@dataclass(frozen=True)
class Feature:
    category: str
    type_ko: str
    folder: str
    type_code: str | None
    ident: str | None
    name: str
    class_code: str | None
    remarks: str | None
    gfid: str | None
    lower: Limit
    upper: Limit
    kind: str  # polygon | line
    wkt: str
    points: int


@dataclass
class ParseResult:
    document_name: str | None
    features: list[Feature] = field(default_factory=list)
    skipped: Counter[str] = field(default_factory=Counter)
    points: int = 0

    def counts(self) -> dict[str, int]:
        return dict(sorted(Counter(f.category for f in self.features).items()))


def _clean(v: str | None) -> str | None:
    if v is None:
        return None
    v = " ".join(v.split())
    return None if not v or v.upper() == "<NULL>" else v


def limit(val: str | None, uom: str | None, code: str | None) -> Limit:
    """원문 세 값 → 고도 한계(모듈 설명의 표). 모르는 조합은 UNKNOWN — 판정에 쓰지 않는다."""
    v, u, c = _clean(val), _clean(uom), _clean(code)
    raw = " ".join(x for x in (v, u, c) if x)
    uu, cc = (u or "").upper(), (c or "").upper()
    num = float(v) if v is not None and _NUM.match(v) else None
    if num is not None and not abs(num) <= MAX_LIMIT_FT:  # inf · 터무니없는 값 — FL 은 ×100 하므로 아래에서 한 번 더 본다
        num = None
    if num is None:
        if v is not None:
            return Limit(None, "UNKNOWN", raw)
        if cc in _SURFACE_CODE:
            return Limit(0, "SFC", raw)
        if cc in _UNL_CODE:
            return Limit(None, "UNL", raw)
        return Limit(None, "UNKNOWN", raw)
    if uu in _FL_UOM:
        ok = (cc in _MSL_CODE or not cc) and abs(num * 100) <= MAX_LIMIT_FT
        return Limit(round(num * 100), "FL", raw) if ok else Limit(None, "UNKNOWN", raw)
    if uu in _FT_UOM or uu in _M_UOM:
        ft = round(num) if uu in _FT_UOM else round(num / 0.3048)
        if cc in _MSL_CODE:
            return Limit(ft, "MSL", raw)
        if cc in _AGL_CODE or cc in _SURFACE_CODE:  # 'n FT SFC' = 지면에서 n ft
            return Limit(ft, "AGL", raw)
    return Limit(None, "UNKNOWN", raw)


class _Rows(HTMLParser):
    """description 의 표 → 제목(칸 하나인 첫 줄)과 {열쇠: 값}(칸 둘인 줄). 표 안의 표는 줄을 쌓아 따로 센다."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.rows: list[list[str]] = []
        self._stack: list[list[str]] = []
        self._cell: list[str] | None = None
        self.title: str | None = None
        self.kv: dict[str, str] = {}

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag == "tr":
            self._stack.append([])
        elif tag == "td" and self._stack:
            self._cell = []

    def handle_endtag(self, tag: str) -> None:
        if tag == "td" and self._stack and self._cell is not None:
            self._stack[-1].append(" ".join("".join(self._cell).split()))
            self._cell = None
        elif tag == "tr" and self._stack:
            row = self._stack.pop()
            if len(row) == 2 and row[0]:
                self.kv.setdefault(row[0], row[1])
            elif len(row) == 1 and row[0] and self.title is None:
                self.title = row[0]

    def handle_data(self, data: str) -> None:
        if self._cell is not None:
            self._cell.append(data)


def _attributes(description: str) -> tuple[str | None, dict[str, str]]:
    p = _Rows()
    p.feed(description)
    p.close()
    return p.title, p.kv


def _coords(text: str) -> list[tuple[float, float]]:
    pts: list[tuple[float, float]] = []
    for tok in text.split():
        parts = tok.split(",")
        if len(parts) < 2:
            raise ValueError("coordinate without lon,lat")
        lon, lat = float(parts[0]), float(parts[1])
        if not (math.isfinite(lon) and math.isfinite(lat)) or not (-180 <= lon <= 180 and -90 <= lat <= 90):
            raise ValueError("coordinate out of range")
        pts.append((lon, lat))
    return pts


def _ring_wkt(pts: list[tuple[float, float]]) -> str:
    if pts and pts[0] != pts[-1]:
        pts = [*pts, pts[0]]
    if len(pts) < 4:
        raise ValueError("ring with fewer than 4 points")
    return "(" + ",".join(f"{x!r} {y!r}" for x, y in pts) + ")"


def _geometry(pm: object) -> tuple[str, str, int]:
    """장소표 → (kind, WKT, 점 수). 다각형 여러 개 = MULTIPOLYGON, 선 여러 개 = MULTILINESTRING. 섞이면 ValueError."""
    polys: list[str] = []
    lines: list[str] = []
    n = 0
    for el in pm.iter():  # type: ignore[attr-defined]
        name = local(el.tag)
        if name == "Polygon":
            rings: list[str] = []
            for b in el:
                if local(b.tag) not in ("outerBoundaryIs", "innerBoundaryIs"):
                    continue
                for coords in (e for e in b.iter() if local(e.tag) == "coordinates"):
                    pts = _coords(coords.text or "")
                    n += len(pts)
                    if n > MAX_POINTS_PER_FEATURE:
                        raise ValueError(f"more than {MAX_POINTS_PER_FEATURE} points")
                    ring = _ring_wkt(pts)
                    if local(b.tag) == "outerBoundaryIs":
                        rings.insert(0, ring)  # 바깥 고리가 먼저(WKT)
                    else:
                        rings.append(ring)
            if not rings:
                raise ValueError("polygon without rings")
            polys.append("(" + ",".join(rings) + ")")
        elif name == "LineString":
            c = child_local(el, "coordinates")
            pts = _coords(c.text or "" if c is not None else "")
            n += len(pts)
            if n > MAX_POINTS_PER_FEATURE:
                raise ValueError(f"more than {MAX_POINTS_PER_FEATURE} points")
            if len(pts) < 2:
                raise ValueError("line with fewer than 2 points")
            lines.append("(" + ",".join(f"{x!r} {y!r}" for x, y in pts) + ")")
    if polys and lines:
        raise ValueError("polygons and lines mixed")
    if polys:
        return "polygon", ("POLYGON" + polys[0]) if len(polys) == 1 else "MULTIPOLYGON(" + ",".join(polys) + ")", n
    if lines:
        return "line", ("LINESTRING" + lines[0]) if len(lines) == 1 else "MULTILINESTRING(" + ",".join(lines) + ")", n
    raise ValueError("no geometry")


def _category(path: list[str]) -> tuple[str, str, str]:
    names = [_FOLDER_PREFIX.sub("", p) for p in path]
    for nm in reversed(names):
        if nm in CATEGORIES:
            code, ko = CATEGORIES[nm]
            return code, ko, " / ".join(names)
    return "other", (names[-1] if names else "분류 없음"), " / ".join(names)


def kml_bytes(data: bytes) -> bytes:
    """입력(KMZ 또는 KML) → KML 바이트. zip 은 디스크에 풀지 않고 이름이 .kml 로 끝나는 멤버 하나만, 크기를 세며 읽는다."""
    if len(data) > MAX_INPUT_BYTES:
        raise AirspaceTooLarge(f"input too large ({len(data)} bytes > {MAX_INPUT_BYTES})")
    if not data.startswith(b"PK\x03\x04"):
        return data
    try:
        z = zipfile.ZipFile(io.BytesIO(data))
        infos = z.infolist()
    except zipfile.BadZipFile as e:
        raise AirspaceError(f"not a valid KMZ (zip): {e}") from None
    if len(infos) > MAX_ZIP_MEMBERS:
        raise AirspaceError(f"too many zip members ({len(infos)})")
    kmls = [i for i in infos if i.filename.lower().endswith(".kml") and not i.is_dir()]
    if len(kmls) != 1:
        raise AirspaceError(f"KMZ must hold exactly one .kml (found {len(kmls)})")
    out = bytearray()
    try:
        with z.open(kmls[0]) as f:
            while chunk := f.read(1 << 16):
                out += chunk
                if len(out) > MAX_KML_BYTES:
                    raise AirspaceTooLarge(f"KML larger than {MAX_KML_BYTES} bytes when unpacked")
    except (zipfile.BadZipFile, zlib.error, EOFError, OSError, RuntimeError, NotImplementedError) as e:
        # CRC 가 틀림 · 깨진 deflate · 잘린 멤버 · 암호 · 모르는 압축 — 읽다가 나는 것(QA-711: 전에는 traceback)
        raise AirspaceError(f"KMZ member unreadable: {type(e).__name__}: {str(e)[:120]}") from None
    return bytes(out)


def parse(data: bytes) -> ParseResult:
    """KMZ · KML 바이트 → 장소표 목록 · 건너뛴 까닭. 전체를 거절할 문제는 AirspaceError."""
    text = checked_text(kml_bytes(data), MAX_KML_BYTES, AirspaceError, AirspaceTooLarge)
    if "xsi:" in text and "xmlns:xsi" not in text:
        text = re.sub(r"<kml\b", "<kml " + XSI, text, count=1)
    root = parse_text(text, AirspaceError)
    if local(root.tag) != "kml":
        raise AirspaceError(f"unexpected root element {local(root.tag)[:40]}")
    doc = child_local(root, "Document")
    res = ParseResult(document_name=_clean(text_of(child_local(doc, "name"))) if doc is not None else None)
    seen = 0

    def walk(el: object, path: list[str], depth: int = 0) -> None:
        nonlocal seen
        if depth > MAX_FOLDER_DEPTH:
            raise AirspaceError(f"folders nested deeper than {MAX_FOLDER_DEPTH}")
        for ch in el:  # type: ignore[attr-defined]
            name = local(ch.tag)
            if name == "Folder":
                walk(ch, [*path, text_of(child_local(ch, "name"))], depth + 1)
            elif name == "Placemark":
                seen += 1
                if seen > MAX_PLACEMARKS:
                    raise AirspaceTooLarge(f"more than {MAX_PLACEMARKS} placemarks")
                _placemark(ch, path, res)
                if res.points > MAX_POINTS_TOTAL:
                    raise AirspaceTooLarge(f"more than {MAX_POINTS_TOTAL} points in total")
            elif name in ("Document", "kml"):
                walk(ch, path, depth + 1)

    walk(root, [])
    return res


def _placemark(pm: object, path: list[str], res: ParseResult) -> None:
    desc_el = child_local(pm, "description")  # type: ignore[arg-type]
    desc = desc_el.text if desc_el is not None and desc_el.text else ""
    title, kv = _attributes(desc)
    name = _clean(kv.get("Name_Txt")) or _clean(text_of(child_local(pm, "name"))) or _clean(title)  # type: ignore[arg-type]
    if name is None:
        res.skipped["no name"] += 1
        return
    try:
        kind, wkt, n = _geometry(pm)
    except ValueError as e:
        res.skipped[str(e)] += 1
        return
    category, type_ko, folder = _category(path)
    res.points += n
    res.features.append(
        Feature(
            category=category,
            type_ko=type_ko,
            folder=folder,
            type_code=_clean(kv.get("Type_Code") or kv.get("RouteType_Code")),
            ident=_clean(kv.get("Ident_Txt")),
            name=html.unescape(name),
            class_code=_clean(kv.get("Class_Code")),
            remarks=_clean(kv.get("Remarks_Txt")),
            gfid=_clean(kv.get("GFID")),
            lower=limit(kv.get("DistVertLower_Val"), kv.get("DistVertLower_UOM"), kv.get("DistVertLower_Code")),
            upper=limit(kv.get("DistVertUpper_Val"), kv.get("DistVertUpper_UOM"), kv.get("DistVertUpper_Code")),
            kind=kind,
            wkt=wkt,
            points=n,
        )
    )
