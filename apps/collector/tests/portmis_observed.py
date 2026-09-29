"""배포 뒤 확인한 PORT-MIS Info5 의 동작을 그대로 흉내 내는 가짜 공급자(docs/review/evidence/public-data-apis-2026-09-29.txt 마지막 절).

같은 키 · 같은 항만청(020 부산)으로 사용자가 직접 부른 결과:
  clsgn=V7A3884(기간 · deGb 무엇이든) → totalCount 0(빈 응답 — fixtures/portmis_info5_empty.xml)
  clsgn 없음 · 2026-09-24~09-29 → totalCount 494, 1쪽에 clsgn V7A3884 · AZAMARA PURSUIT(fixtures/portmis_info5_busan_V7A3884.xml)
즉 명세에 있는 clsgn 파라미터로는 선박을 찾을 수 없다. 이 가짜는 clsgn 이 있는 요청에는 늘 빈 응답을, 없는 요청에는 기간 안에 입항한 기록을 준다.

- 기록: 저장소의 실제 항목(V7A3884 전체 기록)과, 그것을 복제해 입항일·키만 바꾼 합성 항목(필드 이름은 실제 응답의 것만).
- 날짜 필터(sde · ede · deGb=I = 입항일 기준, 기본)는 명세대로 흉내 낸다 — 항목의 입항 신고(etryptDt, +09:00)의 KST 날짜로 거른다.
- 쪽: numOfRows(≤ 50) · pageNo 로 자른다. totalCount 는 거른 전체 수.
"""

from __future__ import annotations

import copy
import xml.etree.ElementTree as ET  # noqa: S405 — 저장소 fixture 만 읽는다
from collections.abc import Callable
from datetime import date
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

import httpx

ROOT = Path(__file__).resolve().parents[3]
FULL_RECORD = ROOT / "fixtures" / "portmis_info5_busan_V7A3884.xml"
EMPTY = ROOT / "fixtures" / "portmis_info5_empty.xml"


def full_record_bytes() -> bytes:
    return FULL_RECORD.read_bytes()


def empty_bytes() -> bytes:
    return EMPTY.read_bytes()


def real_item() -> ET.Element:
    """실제 전체 기록(부산 020 · V7A3884 · AZAMARA PURSUIT · 입항 2026-09-24T08:17 · 출항 2026-09-25T14:24)."""
    it = ET.fromstring(full_record_bytes()).find("body/items/item")  # noqa: S314 — 저장소 fixture
    assert it is not None
    return copy.deepcopy(it)


def synthetic_item(*, pa: str, clsgn: str, entry: str, count: str, pa_name: str = "부산") -> ET.Element:
    """실제 기록을 복제해 항만청 · 호출부호 · 입항횟수 · 입항 시각(+09:00)만 바꾼다(출항 detail 은 뺀다 — 아직 입항 중)."""
    it = real_item()
    for tag, value in (("prtAgCd", pa), ("prtAgNm", pa_name), ("clsgn", clsgn), ("etryptCo", count)):
        el = it.find(tag)
        assert el is not None
        el.text = value
    details = it.find("details")
    assert details is not None
    for d in list(details):
        kind = d.find("etryndNm")
        if kind is not None and kind.text == "출항":
            details.remove(d)
        else:
            t = d.find("etryptDt")
            assert t is not None
            t.text = entry
    return it


def entry_date(it: ET.Element) -> date | None:
    """항목의 입항 신고 시각(+09:00)의 날짜 — 가짜의 날짜 필터(deGb=I)."""
    for d in it.iterfind("details/detail"):
        if d.findtext("etryndNm") == "입항":
            t = d.findtext("etryptDt")
            if t:
                return date.fromisoformat(t[:10])
    return None


def response(items: list[ET.Element], total: int, page_no: int, rows: int) -> bytes:
    root = ET.fromstring(empty_bytes())  # noqa: S314 — 실제 빈 응답의 뼈대(header · body)에 항목만 넣는다
    body = root.find("body")
    assert body is not None
    its = body.find("items")
    assert its is not None
    for i in items:
        its.append(i)
    for tag, value in (("numOfRows", rows), ("pageNo", page_no), ("totalCount", total)):
        el = body.find(tag)
        assert el is not None
        el.text = str(value)
    return b'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' + ET.tostring(root, encoding="unicode").encode("utf-8")


class ObservedPortMis:
    """clsgn 을 무시하지 않고 '빈 응답' 으로 답하는(확인한 그대로) Info5. requests 에 받은 쿼리를 모은다."""

    def __init__(self, items: list[ET.Element] | None = None):
        self.items = items if items is not None else [real_item()]
        self.requests: list[dict[str, str]] = []

    def __call__(self, req: httpx.Request) -> httpx.Response:
        q = {k: v[0] for k, v in parse_qs(urlsplit(str(req.url)).query).items()}
        self.requests.append(q)
        rows = min(50, int(q.get("numOfRows", "10")))
        page_no = int(q.get("pageNo", "1"))
        if q.get("clsgn"):
            return httpx.Response(200, content=response([], 0, 1, 0), headers={"content-type": "text/xml;charset=UTF-8"})
        sde, ede = date(*_ymd(q["sde"])), date(*_ymd(q["ede"]))
        hits = [
            it
            for it in self.items
            if it.findtext("prtAgCd") == q["prtAgCd"] and (d := entry_date(it)) is not None and sde <= d <= ede
        ]
        chunk = hits[(page_no - 1) * rows : page_no * rows]
        body = response([copy.deepcopy(i) for i in chunk], len(hits), page_no, rows if chunk else 0)
        return httpx.Response(200, content=body, headers={"content-type": "text/xml;charset=UTF-8"})


def _ymd(s: str) -> tuple[int, int, int]:
    return int(s[:4]), int(s[4:6]), int(s[6:8])


Responder = Callable[[httpx.Request], httpx.Response]
