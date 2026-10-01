"""여러 기능이 함께 쓰는 글자 정리 — 순수 규칙(노선 route · 항만 입출항 portcalls). ais 는 격벽이라 제 것(ais.parse.clean_text)을 쓴다."""

from __future__ import annotations

import unicodedata


def clean_text(v: object, limit: int) -> str | None:
    """제어·서식·서로게이트·미지정 문자(유니코드 C*)를 지우고 공백을 하나로 모은 뒤 limit 자로 자른다. 비면 None."""
    if not isinstance(v, str):
        return None
    s = "".join(ch for ch in v if not unicodedata.category(ch).startswith("C"))
    s = " ".join(s.split())[:limit].strip()
    return s or None
