"""QA-1130 덧붙임: 머리에 적힌 풀린 크기를 작게 속인 bzip2 · LZMA 멤버도 읽기 전에 거절한다(런타임 판과 상관없이) — stored · deflate 는 그대로 읽는다."""

from __future__ import annotations

import io
import zipfile

import pytest

from wakeline_collector import airspace

KML = b'<?xml version="1.0" encoding="UTF-8"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document/></kml>'


def _kmz(method: int, payload: bytes = KML) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", method) as z:
        z.writestr("doc.kml", payload)
    return buf.getvalue()


@pytest.mark.parametrize("method", [zipfile.ZIP_BZIP2, zipfile.ZIP_LZMA], ids=["bzip2", "lzma"])
def test_qa_1130_a_small_member_in_another_compression_is_refused_before_reading(method: int) -> None:
    with pytest.raises(airspace.AirspaceError, match="unsupported compression"):
        airspace.kml_bytes(_kmz(method))


@pytest.mark.parametrize("method", [zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED], ids=["stored", "deflate"])
def test_qa_1130_stored_and_deflate_members_are_read(method: int) -> None:
    assert airspace.kml_bytes(_kmz(method)) == KML
