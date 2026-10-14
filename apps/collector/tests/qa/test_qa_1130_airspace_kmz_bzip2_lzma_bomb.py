"""QA-1130(AWS 공개 데모 QA · 버전 · 알려진 취약점): 수집기 이미지의 파이썬 3.13.15 는 CVE-2026-15310(gh-156002 — 3.13.16 에서 고침)을 품고 있어,
`airspace.kml_bytes` 의 '풀린 크기 20 MiB 초과는 읽으며 세어 거절' 규칙(airspace.py 머리말 · QA-711)이 bzip2 · LZMA 멤버에서는 메모리를 지키지 못한다.

zipfile 은 deflate 멤버만 한 번 읽을 때 푸는 양을 묶고, bzip2 · LZMA(· Zstandard) 멤버는 읽은 압축 조각 전체를 한꺼번에 푼다(3.13.16 changelog gh-156002:
"A small archive member could previously expand into an unbounded allocation even when read in small chunks"). 64 KiB 씩 읽어도 첫 읽기에서
수백 MiB 를 잡는다 — 917 B 짜리 KMZ 하나가 512m 컨테이너(수집기 한도)에서 `airspace_import --dry-run` 을 OOM(종료 137)으로 끝낸다(증거:
docs/qa/2026-10-aws/evidence/versions/qa-1130-*.txt). 기대는 "거절: KML larger than … when unpacked"(종료 1)이고, 고친 런타임(3.14.8)에서는 그렇게 된다.

이 시험은 지금 도는 파이썬에서 kml_bytes 의 최고 메모리(tracemalloc)를 잰다. deflate 는 대조(지금도 통과).
고치는 길(고치기 단계에서 고른다): 기반 이미지를 3.13.16 이상으로 올리거나, KMZ 멤버의 압축 방식을 stored · deflate 로 묶는다(KMZ 는 deflate).
"""

from __future__ import annotations

import io
import tracemalloc
import zipfile

import pytest

from wakeline_collector import airspace

UNPACKED_MIB = 128  # 상한(20 MiB)의 여섯 배 남짓 — 묶이지 않으면 최고 메모리가 이 크기를 넘는다


def _kmz(method: int, mib: int = UNPACKED_MIB) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", method) as z, z.open("doc.kml", "w", force_zip64=True) as w:
        block = b" " * (1 << 20)
        for _ in range(mib):
            w.write(block)
    return buf.getvalue()


@pytest.mark.parametrize(
    "method",
    [zipfile.ZIP_BZIP2, zipfile.ZIP_LZMA, zipfile.ZIP_DEFLATED],
    ids=["bzip2", "lzma", "deflate_control"],
)
def test_qa_1130_kmz_unpack_limit_bounds_memory(method: int) -> None:
    data = _kmz(method)
    assert len(data) < airspace.MAX_INPUT_BYTES  # 입력 상한은 통과하는 작은 파일
    tracemalloc.start()
    try:
        with pytest.raises(airspace.AirspaceTooLarge, match="when unpacked"):
            airspace.kml_bytes(data)
        peak = tracemalloc.get_traced_memory()[1]
    finally:
        tracemalloc.stop()
    # 모은 바이트(상한 20 MiB) + bytes() 사본 + 읽기 버퍼 여유 — 상한의 세 배를 넘으면 '읽으며 세는' 규칙이 메모리를 지키지 못한 것
    budget = 3 * airspace.MAX_KML_BYTES
    assert peak < budget, (
        f"{len(data):,} B KMZ 의 {UNPACKED_MIB} MiB 멤버를 읽는 동안 최고 {peak / 2**20:.1f} MiB "
        f"(> {budget / 2**20:.0f} MiB) — 한 번 읽을 때 푸는 양이 묶이지 않았다(CVE-2026-15310)"
    )
