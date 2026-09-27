"""출력 크기 상한이 있는 gzip 해제 — 압축 폭탄(작은 입력이 수 GB 로 부푸는 파일)을 거부한다.

전송 크기 상한(http_max_bytes)은 압축된 바이트만 막는다. 해제 결과는 여기서 따로 막는다.
"""

from __future__ import annotations

import zlib


class DecompressedTooLarge(ValueError):
    """해제 결과가 상한을 넘는다(압축 폭탄으로 간주하고 거부)."""


def gunzip_bounded(data: bytes, max_bytes: int) -> bytes:
    """gzip 1개 멤버를 해제한다. 결과가 max_bytes 를 넘으면 DecompressedTooLarge, 스트림이 끝나지 않았으면 ValueError."""
    d = zlib.decompressobj(16 + zlib.MAX_WBITS)  # 16+: gzip 헤더·CRC 검사
    try:
        out = d.decompress(data, max_bytes + 1)
    except zlib.error as e:
        raise ValueError(f"invalid gzip: {e}") from e
    if len(out) > max_bytes or d.unconsumed_tail:
        raise DecompressedTooLarge(f"decompressed size exceeds {max_bytes} bytes")
    if not d.eof:
        raise ValueError("gzip stream truncated")
    return out
