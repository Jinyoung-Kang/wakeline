"""공역 KML 해석 규칙(ADR-034 · SPEC F1) — 저장소의 합성 KML(가짜 이름 · 가짜 좌표, 실제 AIP 와 같은 구조)만 쓴다.

실제 KMZ(AIP 25년 5차 기준)는 저장소에 넣지 않는다(국토교통부 저작물 — 저장소가 공개). 그 파일로 확인한 수치(장소표 697 · 건너뜀 0 ·
금지 4 · 원전 10 · 제한 86 중 고도 기준 없음 1)는 VERIFICATION 에 적었다.
"""

from __future__ import annotations

import io
import re
import zipfile
from pathlib import Path

import pytest

from wakeline_collector import airspace
from wakeline_collector.airspace import AirspaceError, AirspaceTooLarge, Limit, limit, parse

FIXTURE = Path(__file__).parent / "fixtures" / "airspace" / "synthetic.kml"


def _kml() -> bytes:
    return FIXTURE.read_bytes()


def _by_name() -> dict[str, airspace.Feature]:
    return {f.name: f for f in parse(_kml()).features}


def _kmz(members: dict[str, bytes]) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for name, data in members.items():
            z.writestr(name, data)
    return buf.getvalue()


def test_the_synthetic_kml_reads_every_category_from_its_folder_and_skips_only_the_broken_placemarks():
    res = parse(_kml())
    assert res.document_name == "합성 시험 공역 1차"
    assert res.counts() == {
        "adiz": 1, "alert": 1, "atz": 1, "cta": 1, "ctr": 1, "danger": 1, "fir": 1, "moa": 1, "nuclear": 2, "other": 1,
        "prohibited": 1, "restricted": 3, "route": 1, "security": 1, "training": 1, "ultralight": 1, "uncontrolled": 1,
    }  # fmt: skip
    assert dict(res.skipped) == {"no geometry": 1, "coordinate out of range": 1}
    assert res.points == sum(f.points for f in res.features)


def test_the_type_comes_from_the_folder_not_from_type_code():
    f = _by_name()
    # 실제 자료에서 원전 · 초경량 · 군작전은 Type_Code 가 'Other' 이거나 비어 있다 — 폴더로 가른다
    assert (f["시험 원전 가"].category, f["시험 원전 가"].type_ko, f["시험 원전 가"].type_code) == (
        "nuclear",
        "원전 임시비행금지구역",
        None,
    )
    assert (f["시험 초경량"].category, f["시험 초경량"].type_code) == ("ultralight", "Other")
    assert f["시험 금지구역 A"].folder == "통제공역 / 비행금지구역"
    # 모르는 폴더는 짐작하지 않고 'other' + 폴더 이름
    assert (f["시험 모르는 종류"].category, f["시험 모르는 종류"].type_ko) == ("other", "시험_새폴더")


def test_vertical_limits_are_normalised_with_their_reference_and_the_original_text():
    f = _by_name()
    p = f["시험 금지구역 A"]
    assert (p.lower, p.upper) == (Limit(0, "SFC", "Ground"), Limit(None, "UNL", "Unlimited"))
    assert f["시험 제한구역 B"].upper == Limit(18_000, "FL", "180 Flight Level Altitude")
    assert f["시험 제한구역 C"].upper == Limit(5_000, "MSL", "5000 Feet Altitude")
    assert f["시험 제한구역 기준없음"].upper == Limit(None, "UNKNOWN", "Feet")
    assert f["시험 위험구역 D"].upper == Limit(2_000, "AGL", "2000 Feet Height")
    assert f["시험 원전 가"].upper == Limit(10_000, "FL", "100 FL ALT")
    assert f["시험 원전 나"].upper == Limit(2_000, "MSL", "2000 FT ALT")
    # 비행장교통구역 상한 'n FT SFC' = 지면에서 n ft, 하한 'HEI'(값 없음)는 모른다
    assert (f["시험 비행장교통구역"].upper, f["시험 비행장교통구역"].lower) == (
        Limit(3_000, "AGL", "3000 FT SFC"),
        Limit(None, "UNKNOWN", "HEI"),
    )


@pytest.mark.parametrize(
    ("val", "uom", "code", "want"),
    [
        ("<Null>", "<Null>", "Surface", Limit(0, "SFC", "Surface")),
        (None, None, "GND", Limit(0, "SFC", "GND")),
        ("", "", "UNLTD", Limit(None, "UNL", "UNLTD")),
        ("250", "FL", "", Limit(25_000, "FL", "250 FL")),
        ("250", "Flight Level", "Height", Limit(None, "UNKNOWN", "250 Flight Level Height")),
        ("1000", "M", "MSL", Limit(3_281, "MSL", "1000 M MSL")),
        ("1000", "Feet", None, Limit(None, "UNKNOWN", "1000 Feet")),
        ("1000", None, "Altitude", Limit(None, "UNKNOWN", "1000 Altitude")),
        ("abc", "Feet", "Altitude", Limit(None, "UNKNOWN", "abc Feet Altitude")),
        (None, None, None, Limit(None, "UNKNOWN", "")),
    ],
)
def test_limit_table(val, uom, code, want):
    assert limit(val, uom, code) == want


def test_geometry_keeps_the_hole_and_the_route_is_a_line():
    f = _by_name()
    hole = f["시험 공해"]
    assert hole.kind == "polygon" and hole.wkt.startswith("POLYGON((133.0 38.0,") and hole.wkt.count("(") == 3  # 바깥 · 안쪽 고리
    route = f["Z999"]
    assert (route.kind, route.ident, route.type_code) == ("line", "Z999", "Conventional")
    assert route.wkt == "LINESTRING(131.0 37.0,132.0 37.5)"
    assert (route.lower, route.upper) == (
        Limit(8_000, "MSL", "8000 Feet Altitude"),
        Limit(60_000, "FL", "600 Flight Level Altitude"),
    )


def test_a_kmz_reads_its_single_kml_member_without_unpacking_to_disk():
    assert [f.name for f in parse(_kmz({"doc.kml": _kml()})).features] == [f.name for f in parse(_kml()).features]
    with pytest.raises(AirspaceError, match="exactly one .kml"):
        parse(_kmz({"a.kml": _kml(), "b.kml": _kml()}))
    with pytest.raises(AirspaceError, match="exactly one .kml"):
        parse(_kmz({"readme.txt": b"x"}))
    with pytest.raises(AirspaceError, match="not a valid KMZ"):
        parse(b"PK\x03\x04 broken")


def test_size_limits_are_counted_while_reading_not_taken_from_the_zip_header(monkeypatch):
    monkeypatch.setattr(airspace, "MAX_KML_BYTES", 1_000)
    with pytest.raises(AirspaceTooLarge, match="when unpacked"):
        parse(_kmz({"doc.kml": b"<kml>" + b" " * 50_000 + b"</kml>"}))  # 압축하면 작다(풀면 50 KB)
    monkeypatch.setattr(airspace, "MAX_INPUT_BYTES", 100)
    with pytest.raises(AirspaceTooLarge, match="input too large"):
        parse(_kml())


def test_dangerous_or_foreign_xml_is_refused_before_parsing():
    with pytest.raises(AirspaceError, match="DOCTYPE"):
        parse(b'<?xml version="1.0"?><!DOCTYPE kml [<!ENTITY x SYSTEM "file:///etc/passwd">]><kml>&x;</kml>')
    with pytest.raises(AirspaceError, match="not UTF-8"):
        parse("<kml><Document><name>공역</name></Document></kml>".encode("euc-kr"))
    with pytest.raises(AirspaceError, match="unexpected root"):
        parse(b"<gpx></gpx>")
    with pytest.raises(AirspaceError, match="not XML"):
        parse(b"<kml><Document>")


def test_count_limits(monkeypatch):
    monkeypatch.setattr(airspace, "MAX_POINTS_PER_FEATURE", 5)
    res = parse(_kml())
    assert res.skipped["more than 5 points"] >= 1 and "시험 금지구역 A" in {f.name for f in res.features}  # 사각형(5점)은 받는다
    monkeypatch.setattr(airspace, "MAX_POINTS_PER_FEATURE", 20_000)
    monkeypatch.setattr(airspace, "MAX_PLACEMARKS", 5)
    with pytest.raises(AirspaceTooLarge, match="placemarks"):
        parse(_kml())
    monkeypatch.setattr(airspace, "MAX_PLACEMARKS", 5_000)
    monkeypatch.setattr(airspace, "MAX_POINTS_TOTAL", 50)
    with pytest.raises(AirspaceTooLarge, match="points in total"):
        parse(_kml())


def test_the_missing_xsi_declaration_is_added_only_when_needed():
    declared = _kml().replace(b'<kml xmlns="', b'<kml xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns="', 1)
    assert len(parse(declared).features) == len(parse(_kml()).features)
    assert len(parse(_kml().replace(b'xsi:schemaLocation="', b'schemaLocation="')).features) == 20


def test_names_and_html_entities():
    kml = b"""<kml xmlns="http://www.opengis.net/kml/2.2"><Document><Folder><name>3.Airspace_\xed\x86\xb5\xec\xa0\x9c\xea\xb3\xb5\xec\x97\xad</name>
      <Folder><name>\xeb\xb9\x84\xed\x96\x89\xea\xb8\x88\xec\xa7\x80\xea\xb5\xac\xec\x97\xad</name>
      <Placemark><name>fallback</name><description><![CDATA[<table><tr><td>T</td></tr><tr><td>Name_Txt</td><td>A &amp; B</td></tr></table>]]></description>
      <Polygon><outerBoundaryIs><LinearRing><coordinates>1,1 2,1 2,2 1,1</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>
      <Placemark><name>  </name><description><![CDATA[<table><tr><td>Name_Txt</td><td>&lt;Null&gt;</td></tr></table>]]></description>
      <Polygon><outerBoundaryIs><LinearRing><coordinates>1,1 2,1 2,2 1,1</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>
      <Placemark><name>open ring</name><Polygon><outerBoundaryIs><LinearRing><coordinates>1,1 2,1 2,2</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>
      <Placemark><name>short</name><Polygon><outerBoundaryIs><LinearRing><coordinates>1,1 2,1 1,1</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>
      </Folder></Folder></Document></kml>"""
    res = parse(kml)
    names = [f.name for f in res.features]
    assert names == ["A & B", "open ring"]  # 제목보다 Name_Txt, 빈 이름은 건너뜀, 열린 고리는 닫는다
    assert res.features[1].wkt == "POLYGON((1.0 1.0,2.0 1.0,2.0 2.0,1.0 1.0))"
    assert res.features[0].category == "prohibited" and res.features[0].lower == Limit(None, "UNKNOWN", "")
    assert dict(res.skipped) == {"no name": 1, "ring with fewer than 4 points": 1}


# ---- 가져오기 명령(tools.airspace_import) — DB 는 가짜로 ----


class _Stdin:
    def __init__(self, data: bytes, tty: bool = False):
        self.buffer = io.BytesIO(data)
        self._tty = tty

    def isatty(self) -> bool:
        return self._tty


def _run(monkeypatch, capsys, data: bytes, *argv: str, tty: bool = False):
    from wakeline_collector.tools import airspace_import

    monkeypatch.setattr("sys.stdin", _Stdin(data, tty))
    rc = airspace_import.main(list(argv))
    out = capsys.readouterr()
    return rc, out.out, out.err


def test_the_import_command_dry_run_reports_without_touching_the_database(monkeypatch, capsys):
    from wakeline_collector import db

    async def no_db():  # pragma: no cover — 불리면 실패
        raise AssertionError("dry-run must not open the database")

    monkeypatch.setattr(db, "open_pool", no_db)
    rc, out, _ = _run(monkeypatch, capsys, _kml(), "--dry-run")
    assert rc == 0
    assert "도형 20개" in out and re.search(r"^  restricted +3$", out, re.M) is not None and "coordinate out of range 1" in out
    assert "(dry-run) 기준 차수 '합성 시험 공역 1차'" in out


def test_the_import_command_writes_and_reports(monkeypatch, capsys):
    from wakeline_collector import airspace_store, db

    calls = {}

    class Pool:
        async def close(self):
            calls["closed"] = True

    async def open_pool():
        return Pool()

    async def import_edition(pool, *, label, sha256, res):
        calls.update(label=label, sha=sha256, n=len(res.features))
        return airspace_store.ImportReport(7, "imported", 20, 0, 0, 3)

    monkeypatch.setattr(db, "open_pool", open_pool)
    monkeypatch.setattr(airspace_store, "import_edition", import_edition)
    rc, out, _ = _run(monkeypatch, capsys, _kml(), "--edition", "  AIP   25년 5차 ")
    assert rc == 0 and calls["label"] == "AIP 25년 5차" and calls["n"] == 20 and calls["closed"]
    assert len(calls["sha"]) == 64 and "차수 id 7" in out and "앞 차수 id 3 은 끔" in out

    async def again(pool, **_):
        return airspace_store.ImportReport(7, "already_active")

    monkeypatch.setattr(airspace_store, "import_edition", again)
    assert "이미 켜진 차수" in _run(monkeypatch, capsys, _kml())[1]

    async def back(pool, **_):
        return airspace_store.ImportReport(5, "reactivated", previous_active=7)

    monkeypatch.setattr(airspace_store, "import_edition", back)
    assert "옛 차수(id 5)를 다시 켰다" in _run(monkeypatch, capsys, _kml())[1]

    async def broken(pool, **_):
        raise OSError("password=secret123 connection refused")

    monkeypatch.setattr(airspace_store, "import_edition", broken)
    rc, _, err = _run(monkeypatch, capsys, _kml())
    assert rc == 2 and "DB 실패" in err and "secret123" not in err


def test_the_import_command_refuses_bad_input_and_arguments(monkeypatch, capsys):
    assert _run(monkeypatch, capsys, b"<gpx/>")[0] == 1
    assert _run(monkeypatch, capsys, _kml(), tty=True)[0] == 3
    assert _run(monkeypatch, capsys, _kml(), "--edition", "x" * 81)[0] == 3
    no_name = _kml().replace(
        b"<name>\xed\x95\xa9\xec\x84\xb1 \xec\x8b\x9c\xed\x97\x98 \xea\xb3\xb5\xec\x97\xad 1\xec\xb0\xa8</name>", b""
    )
    assert _run(monkeypatch, capsys, no_name, "--dry-run")[0] == 3  # 문서 이름도 --edition 도 없다
    empty = b'<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>x</name></Document></kml>'
    assert _run(monkeypatch, capsys, empty, "--dry-run")[0] == 1
    monkeypatch.setattr(airspace, "MAX_INPUT_BYTES", 10)
    rc, _, err = _run(monkeypatch, capsys, _kml())
    assert rc == 1 and "too large" in err


@pytest.mark.parametrize(
    ("val", "uom", "code", "want"),
    [
        ("100000", "FT", "MSL", Limit(100_000, "MSL", "100000 FT MSL")),
        ("100001", "FT", "MSL", Limit(None, "UNKNOWN", "100001 FT MSL")),
        ("999", "FL", "STD", Limit(None, "UNKNOWN", "999 FL STD")),  # 기준이 STD 면 원래 UNKNOWN(표 그대로)
        ("999", "FL", None, Limit(99_900, "FL", "999 FL")),
        ("1001", "FL", None, Limit(None, "UNKNOWN", "1001 FL")),
        ("9" * 400, "FT", "MSL", Limit(None, "UNKNOWN", "9" * 400 + " FT MSL")),  # float → inf
        ("30480", "M", "MSL", Limit(100_000, "MSL", "30480 M MSL")),  # 한도는 바꾼 ft 로 — 30,480 m = 100,000 ft
        ("31000", "M", "MSL", Limit(None, "UNKNOWN", "31000 M MSL")),  # 101,706 ft
    ],
)
def test_limit_out_of_range_is_unknown(val, uom, code, want):
    """±100,000 ft(FL999) 밖의 값은 숫자가 아닌 것과 같이 UNKNOWN — int 열 · round(inf) 로 가져오기가 깨지지 않는다(QA-711)."""
    assert limit(val, uom, code) == want


def test_deep_nesting_and_broken_member_are_rejected():
    deep = (
        "<kml><Document>"
        + "<Folder>" * (airspace.MAX_FOLDER_DEPTH + 1)
        + "</Folder>" * (airspace.MAX_FOLDER_DEPTH + 1)
        + "</Document></kml>"
    )
    with pytest.raises(AirspaceError, match="nested deeper"):
        parse(deep.encode())
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("doc.kml", "<kml>" + "x" * 5000 + "</kml>")
    data = bytearray(buf.getvalue())
    data[data.find(b"PK\x03\x04") + 30 + len("doc.kml") + 5] ^= 0xFF
    with pytest.raises(AirspaceError, match="unreadable"):
        parse(bytes(data))
