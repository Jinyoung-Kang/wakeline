"""믿지 않는 XML 을 받는 공통 규칙 — 크기 상한 · 엄격한 UTF-8 · NUL · DOCTYPE/ENTITY 를 **해석 전에** 거절하고, 거절을 본 그 글자를 해석한다.

해양격자 WFS(marine_grid, ADR-023)에서 처음 만들었고 공역 KML(airspace, ADR-034)도 같은 입구를 쓴다 — 규칙 모듈은 다른 기능의 규칙을 import 하지
않으므로(ADR-030) 공통(KERNEL)으로 둔다.

거절은 **해석할 글자 그대로** 본다(검토 지적 2026-10-01: 예전에는 원본 바이트를 훑어 UTF-16 본문의 DTD 가 expat 까지 갔고, DOCTYPE 은 앞
4 KiB 만 찾았다): 엄격한 UTF-8 로 풀리지 않거나 NUL 이 있으면 거절하고, 푼 글자 전체에서 DOCTYPE · ENTITY 를 찾은 뒤 그 글자(str)를
해석한다 — ElementTree 는 str 을 선언과 상관없이 UTF-8 로 넘기므로 훑은 것과 해석하는 것이 같다.
예외 형은 부르는 쪽이 준다(기능마다 자기 오류 형 · 같은 글).
"""

from __future__ import annotations

import xml.etree.ElementTree as ET  # noqa: S405 — UTF-8 · DOCTYPE·ENTITY 를 먼저 거절하고, 크기 상한을 둔 뒤에만 해석한다(checked_text)


def checked_text(body: bytes, limit: int, error: type[Exception], too_large: type[Exception]) -> str:
    """본문 → 해석해도 되는 글자. 크기 상한(too_large) · UTF-8 · NUL · DOCTYPE · ENTITY · 빈 본문(error)을 거절한다."""
    if len(body) > limit:
        raise too_large(f"response too large ({len(body)} bytes > {limit})")
    try:
        text = body.decode("utf-8")
    except UnicodeDecodeError as e:
        raise error(f"response is not UTF-8 (byte {e.start}) — refused before parsing") from None
    if "\x00" in text:
        raise error("NUL in response (UTF-16?) — refused before parsing")
    up = text.upper()
    if "<!DOCTYPE" in up or "<!ENTITY" in up:
        raise error("DOCTYPE/ENTITY in response — refused")
    if not text.strip():
        raise error("empty response")
    return text


def parse_text(text: str, error: type[Exception]) -> ET.Element:
    """checked_text 를 지난 글자(또는 그 글자를 부르는 쪽이 고친 것 — DOCTYPE 을 더하지 않는다)를 해석한다."""
    try:
        return ET.fromstring(text)  # noqa: S314 — UTF-8 · DOCTYPE·ENTITY 거절 · 크기 상한 뒤(checked_text)
    except ET.ParseError as e:
        raise error(f"not XML (line {e.position[0]})") from None


def local(tag: object) -> str:
    """요소의 지역 이름(네임스페이스 무시)."""
    return tag.rsplit("}", 1)[-1] if isinstance(tag, str) else ""


def text_of(el: ET.Element | None) -> str:
    """요소 안 글자 전부를 공백 하나로 이어 붙인 것."""
    return " ".join("".join(el.itertext()).split()) if el is not None else ""


def find_local(root: ET.Element, name: str) -> list[ET.Element]:
    return [e for e in root.iter() if local(e.tag) == name]


def child_local(el: ET.Element, name: str) -> ET.Element | None:
    return next((c for c in el if local(c.tag) == name), None)
