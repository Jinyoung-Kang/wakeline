"""QA-711(출시 QA 2차 · 기능 · 운영 도구): `make airspace-import` 는 받아들일 수 없는 입력을 "거절: <까닭>"(종료 코드 1)으로 알린다(tools/airspace_import.py ·
ADR-034). 그런데 airspace.AirspaceError 만 잡아 — 깨진 KMZ(CRC 가 틀린 멤버 → zipfile.BadZipFile · 깨진 deflate → zlib.error), 아주 깊은 Folder 중첩
(RecursionError), 엄청 큰 고도 값(round(inf) → OverflowError)은 파이썬 traceback 으로 끝난다(DB 에는 아무것도 쓰지 않는다 — 운영자가 까닭을 읽기 어렵다).

고친 뒤 기대: 깨진 KMZ · 깊은 중첩은 파일 전체의 문제라 "거절:"(1). 터무니없는 고도 값 하나는 모듈의 규칙("기준을 알 수 없으면 UNKNOWN — 짐작하지
않는다", 숫자가 아닌 값과 같이)대로 그 한계만 UNKNOWN 으로 두고 가져온다 — 장소표 하나의 값 때문에 공식 파일 전체를 거절하지 않는다.
"""

from __future__ import annotations

import io
import sys
import zipfile
from pathlib import Path

import pytest

from wakeline_collector.tools import airspace_import

FX = Path(__file__).resolve().parents[1] / "fixtures" / "airspace" / "synthetic.kml"


def _corrupt_kmz() -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("doc.kml", FX.read_bytes())
    data = bytearray(buf.getvalue())
    i = data.find(b"PK\x03\x04") + 30 + len("doc.kml") + 10  # 첫 멤버의 압축된 내용 한가운데
    data[i] ^= 0xFF
    return bytes(data)


def _deep_folders(n: int = 1500) -> bytes:
    kml = FX.read_text(encoding="utf-8")
    i = kml.index("<Folder>")
    j = kml.rindex("</Document>")
    return (kml[:i] + "<Folder>" * n + kml[i:j] + "</Folder>" * n + kml[j:]).encode("utf-8")


def _huge_altitude() -> bytes:
    kml = FX.read_text(encoding="utf-8")
    marker = "<td>DistVertUpper_Val</td>\n<td>5000</td>"
    assert marker in kml, "fixture has an upper limit value"
    return kml.replace(marker, "<td>DistVertUpper_Val</td>\n<td>" + "9" * 400 + "</td>", 1).encode("utf-8")


class _Stdin:
    def __init__(self, data: bytes):
        self.buffer = io.BytesIO(data)

    def isatty(self) -> bool:
        return False


@pytest.mark.parametrize("make", [_corrupt_kmz, _deep_folders], ids=["corrupt_kmz", "deep_folders"])
def test_qa_711_bad_input_is_rejected_not_a_traceback(make, monkeypatch, capsys) -> None:
    monkeypatch.setattr(sys, "stdin", _Stdin(make()))
    rc = airspace_import.main(["--dry-run", "--edition", "QA"])
    err = capsys.readouterr().err
    assert rc == 1 and err.startswith("거절:"), err[:200]


def test_qa_711_huge_altitude_is_unknown_not_a_traceback(monkeypatch, capsys) -> None:
    monkeypatch.setattr(sys, "stdin", _Stdin(_huge_altitude()))
    rc = airspace_import.main(["--dry-run", "--edition", "QA"])
    assert rc == 0, capsys.readouterr().err[:200]
    from wakeline_collector import airspace

    uppers = [f.upper for f in airspace.parse(_huge_altitude()).features if "9" * 400 in f.upper.raw]
    assert [(u.ft, u.basis) for u in uppers] == [(None, "UNKNOWN")]
