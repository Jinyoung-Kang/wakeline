"""PORT-MIS(해양수산부 선박운항정보 Info5) 시험 자료 — 저장소의 실제 응답 fixture 에서 만든다(필드 이름을 지어내지 않는다).

fixture(fixtures/portmis_info5_busan_230025.xml)의 item 을 복제해 값만 바꾼다: 페이지·정렬·중복·불일치 시험용.
바꾸는 값은 fixture 에 있는 필드뿐이다(etryptYear·etryptCo 는 ADR-022 가 적은 확인된 필드 이름이다 — 값은 시험용 합성).
"""

from __future__ import annotations

import copy
import xml.etree.ElementTree as ET  # noqa: S405 — 저장소 fixture 만 읽는다
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
FIXTURE = ROOT / "fixtures" / "portmis_info5_busan_230025.xml"


def fixture_bytes() -> bytes:
    return FIXTURE.read_bytes()


def _root() -> ET.Element:
    return ET.fromstring(fixture_bytes())  # noqa: S314 — 저장소 fixture


def fixture_item() -> ET.Element:
    item = _root().find("body/items/item")
    assert item is not None
    return item


def item(
    *,
    code: str = "020",
    name: str | None = "부산",
    clsgn: str | None = "230025",
    at: str | None = "2026-09-29T00:00:00+09:00",
    reports: list[tuple[str, str, str]] | None = None,
    year: str | None = None,
    count: str | None = None,
    extra: dict[str, str] | None = None,
    drop: tuple[str, ...] = (),
) -> ET.Element:
    """fixture item 복제. reports = [(reqstSeNm, etryndNm, etryptDt)] (없으면 fixture 의 detail 하나 — at 만 바꾼다)."""
    it = copy.deepcopy(fixture_item())
    _set(it, "prtAgCd", code)
    _set(it, "prtAgNm", name)
    _set(it, "clsgn", clsgn)
    if year is not None:
        _set(it, "etryptYear", year)
    if count is not None:
        _set(it, "etryptCo", count)
    details = it.find("details")
    assert details is not None
    rows = reports if reports is not None else [("최초", "입항", at)]
    for d in list(details):
        details.remove(d)
    for se, kind, dt in rows:
        d = ET.SubElement(details, "detail")
        ET.SubElement(d, "reqstSeNm").text = se
        ET.SubElement(d, "etryndNm").text = kind
        if dt is not None:
            ET.SubElement(d, "etryptDt").text = dt
    for k, v in (extra or {}).items():
        _set(it, k, v)
    for k in drop:
        el = it.find(k)
        if el is not None:
            it.remove(el)
    return it


def _set(it: ET.Element, tag: str, value: str | None) -> None:
    el = it.find(tag)
    if value is None:
        if el is not None:
            it.remove(el)
        return
    if el is None:
        el = ET.SubElement(it, tag)
    el.text = value


def page(items: list[ET.Element], total: int | None, *, code: str = "00", msg: str | None = None) -> bytes:
    """응답 한 쪽(fixture 와 같은 구조)."""
    root = ET.Element("response")
    header = ET.SubElement(root, "header")
    ET.SubElement(header, "resultCode").text = code
    if msg is not None:
        ET.SubElement(header, "resultMsg").text = msg
    body = ET.SubElement(root, "body")
    its = ET.SubElement(body, "items")
    for i in items:
        its.append(i)
    if total is not None:
        ET.SubElement(body, "totalCount").text = str(total)
    return b'<?xml version="1.0" encoding="UTF-8"?>' + ET.tostring(root, encoding="unicode").encode("utf-8")


def empty_page() -> bytes:
    return page([], 0)
