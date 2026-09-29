"""입출항 색인의 해석(ADR-022 개정): 실제 전체 기록(fixtures/portmis_info5_busan_V7A3884.xml)과 실제 빈 응답으로.

- 입항 = 입항 detail 의 etryptDt, 출항 = 출항 detail 의 tkoffDt(+09:00 만) — 판은 최종이 최초보다 먼저.
- 선석 = 고른 입항 신고의 laidupFcltyNm. 오프셋 없는 필드(tkoffPrrrnDt 등)는 시각으로 읽지 않는다.
- 호출부호 없이 받은 쪽의 모든 item 을 행으로 — 자연 키(항만청 · 호출부호 · 입항년도 · 입항횟수)를 만들 수 없는 item 은 세고 버린다.
"""

from __future__ import annotations

import copy
import json
import xml.etree.ElementTree as ET  # noqa: S405 — 저장소 fixture 만 읽는다
from datetime import UTC, date, datetime
from pathlib import Path

import pytest
from portmis_observed import empty_bytes, full_record_bytes, real_item, response

from wakeline_collector.portcalls import (
    PORT_AUTHORITIES,
    Coverage,
    PortCallApiError,
    PortCallParseError,
    kst_date,
    merge_day,
    normalize_call_sign,
    parse_index_page,
)

ROOT = Path(__file__).resolve().parents[3]
ROW_FIXTURE = ROOT / "fixtures" / "portcall_row_V7A3884.json"
DAY = date(2026, 9, 24)


def _page(*items: ET.Element, total: int | None = None) -> bytes:
    return response(list(items), len(items) if total is None else total, 1, 50)


def _with_details(rows: list[tuple[str, str, str, str | None]], *, berth: str | None = None) -> ET.Element:
    """실제 기록의 details 를 [(reqstSeNm, etryndNm, 시각 태그, 값)] 로 바꾼 item."""
    it = real_item()
    details = it.find("details")
    assert details is not None
    for d in list(details):
        details.remove(d)
    for rev, kind, tag, value in rows:
        d = ET.SubElement(details, "detail")
        ET.SubElement(d, "reqstSeNm").text = rev
        ET.SubElement(d, "etryndNm").text = kind
        if value is not None:
            ET.SubElement(d, tag).text = value
        if berth is not None:
            ET.SubElement(d, "laidupFcltyNm").text = f"{berth} {rev}"
    return it


def test_the_real_full_record_gives_entry_exit_from_tkoffdt_berth_and_the_final_revision():
    p = parse_index_page(full_record_bytes(), "020", DAY)
    assert (p.total, p.items, p.unmatchable, p.unkeyed, p.foreign, p.date_mismatch) == (494, 1, 0, 0, 0, 0)
    (row,) = p.rows
    assert row.key == ("020", "V7A3884", "2026", "005") and row.listed_date == DAY
    assert row.entry_at == datetime(2026, 9, 23, 23, 17, tzinfo=UTC)  # 2026-09-24T08:17:00+09:00
    assert row.exit_at == datetime(2026, 9, 25, 5, 24, tzinfo=UTC)  # 출항 detail 의 tkoffDt 2026-09-25T14:24:00+09:00
    assert (row.entry_revision, row.exit_revision) == ("최종", "최종")
    assert row.berth == "북항크루즈터미널 2선석"
    assert (row.prt_ag_nm, row.vssl_nm, row.purpose_nm) == ("부산", "AZAMARA PURSUIT", "여객상륙")
    assert (row.nationality_cd, row.nationality_nm, row.kind_cd, row.kind_nm) == ("MH", "마샬 제도", "14", "크루즈선")
    assert (row.first_port_cd, row.first_port_nm, row.prev_port_cd, row.prev_port_nm) == ("JPUKB", "KOBE", "JPSMN", "SAKAIMINATO")
    assert (row.next_port_cd, row.next_port_nm, row.dest_port_cd, row.dest_port_nm) == (
        "JPHIJ",
        "HIROSHIMA",
        "JPHIJ",
        "HIROSHIMA",
    )


def test_the_shared_row_fixture_is_what_the_parser_makes_from_the_real_record():
    """api 시험(PortCallIndexDbTest)이 이 파일을 DB 에 넣고 읽는다 — 손으로 고치지 않는다(해석이 바뀌면 둘 다 실패한다)."""
    (row,) = parse_index_page(full_record_bytes(), "020", DAY).rows
    doc = json.loads(ROW_FIXTURE.read_text(encoding="utf-8"))
    assert doc["row"] == row.as_dict()


def test_offset_less_fields_are_not_times():
    """tkoffPrrrnDt(출항 예정 "2026-09-25 14:24:00")는 입항 detail 에 있어도 출항 시각이 아니다 — tkoffDt 가 없으면 출항 시각은 모른다."""
    it = real_item()
    for d in it.iterfind("details/detail"):
        if d.findtext("etryndNm") == "출항":
            t = d.find("tkoffDt")
            assert t is not None
            t.text = "2026-09-25 14:24:00"  # 오프셋 없음
    (row,) = parse_index_page(_page(it), "020", DAY).rows
    assert row.exit_at is None and row.exit_revision is None
    assert row.entry_at is not None


def test_exit_is_read_from_tkoffdt_only_not_from_an_etryptdt_on_the_exit_detail():
    it = _with_details(
        [("최종", "입항", "etryptDt", "2026-09-24T08:17:00+09:00"), ("최종", "출항", "etryptDt", "2026-09-25T14:24:00+09:00")]
    )
    (row,) = parse_index_page(_page(it), "020", DAY).rows
    assert row.exit_at is None


@pytest.mark.parametrize(
    ("details", "entry", "revision"),
    [
        # 최종이 있으면 최종(최초보다 나중 판)
        (
            [
                ("최초", "입항", "etryptDt", "2026-09-24T07:00:00+09:00"),
                ("최종", "입항", "etryptDt", "2026-09-24T08:17:00+09:00"),
            ],
            datetime(2026, 9, 23, 23, 17, tzinfo=UTC),
            "최종",
        ),
        # 최초뿐이면 최초
        ([("최초", "입항", "etryptDt", "2026-09-24T07:00:00+09:00")], datetime(2026, 9, 23, 22, 0, tzinfo=UTC), "최초"),
        # 최종 신고에 시각이 없으면 시각이 있는 최초(판 이름을 함께 둔다 — 화면이 '최초 신고' 로 밝힌다)
        (
            [("최초", "입항", "etryptDt", "2026-09-24T07:00:00+09:00"), ("최종", "입항", "etryptDt", None)],
            datetime(2026, 9, 23, 22, 0, tzinfo=UTC),
            "최초",
        ),
        # 같은 판에 서로 다른 시각 — 고르지 않는다
        (
            [
                ("최종", "입항", "etryptDt", "2026-09-24T07:00:00+09:00"),
                ("최종", "입항", "etryptDt", "2026-09-24T08:17:00+09:00"),
            ],
            None,
            "최종",
        ),
        # 같은 판에 같은 시각 둘 — 하나로 정해진다
        (
            [
                ("최종", "입항", "etryptDt", "2026-09-24T08:17:00+09:00"),
                ("최종", "입항", "etryptDt", "2026-09-24T08:17:00+09:00"),
            ],
            datetime(2026, 9, 23, 23, 17, tzinfo=UTC),
            "최종",
        ),
        # 모르는 판 이름은 읽지 않는다(순서를 모른다)
        ([("변경", "입항", "etryptDt", "2026-09-24T07:00:00+09:00")], None, None),
    ],
)
def test_revision_order_final_over_first(details, entry, revision):
    (row,) = parse_index_page(_page(_with_details(details)), "020", DAY).rows
    assert (row.entry_at, row.entry_revision) == (entry, revision)


def test_berth_comes_from_the_chosen_entry_report_else_the_chosen_exit_report():
    it = _with_details(
        [("최초", "입항", "etryptDt", "2026-09-24T07:00:00+09:00"), ("최종", "입항", "etryptDt", "2026-09-24T08:17:00+09:00")],
        berth="북항",
    )
    (row,) = parse_index_page(_page(it), "020", DAY).rows
    assert row.berth == "북항 최종"
    only_exit = _with_details([("최종", "출항", "tkoffDt", "2026-09-25T14:24:00+09:00")], berth="감만")
    (row,) = parse_index_page(_page(only_exit), "020", DAY).rows
    assert (row.entry_at, row.exit_at, row.berth) == (None, datetime(2026, 9, 25, 5, 24, tzinfo=UTC), "감만 최종")


def test_the_real_empty_response_is_an_empty_day():
    p = parse_index_page(empty_bytes(), "020", DAY)
    assert (p.total, p.items, p.rows) == (0, 0, [])


def test_items_that_cannot_be_keyed_or_matched_are_counted_not_guessed():
    no_cs = real_item()
    cs = no_cs.find("clsgn")
    assert cs is not None
    no_cs.remove(cs)
    bad_cs = copy.deepcopy(real_item())
    el = bad_cs.find("clsgn")
    assert el is not None
    el.text = "V7-A3884"  # 조회 형식 밖(AIS 호출부호와 맞출 수 없다)
    no_count = real_item()
    co = no_count.find("etryptCo")
    assert co is not None
    no_count.remove(co)
    other = real_item()
    pa = other.find("prtAgCd")
    assert pa is not None
    pa.text = "820"
    p = parse_index_page(_page(no_cs, bad_cs, no_count, other, real_item()), "020", DAY)
    assert (p.items, len(p.rows), p.unmatchable, p.unkeyed, p.foreign) == (5, 1, 2, 1, 1)


def test_a_row_whose_entry_is_on_another_kst_day_is_kept_and_counted():
    p = parse_index_page(full_record_bytes(), "020", date(2026, 9, 25))
    assert len(p.rows) == 1 and p.date_mismatch == 1 and p.rows[0].listed_date == date(2026, 9, 25)


def test_kst_date_is_utc_plus_nine():
    assert kst_date(datetime(2026, 9, 23, 15, 0, tzinfo=UTC)) == date(2026, 9, 24)
    assert kst_date(datetime(2026, 9, 23, 14, 59, 59, tzinfo=UTC)) == date(2026, 9, 23)


# ---- 범위 합치기 ----------------------------------------------------------------------------------------------------------
D = date(2026, 9, 29)
AT = datetime(2026, 9, 29, 3, 0, tzinfo=UTC)


def _d(n: int) -> date:
    return date.fromordinal(D.toordinal() + n)


@pytest.mark.parametrize(
    ("cov", "day", "reset", "want"),
    [
        (None, D, False, Coverage(D, D, None)),  # 처음
        (Coverage(_d(-2), D, AT), _d(-1), False, Coverage(_d(-2), D, AT)),  # 범위 안 — 다시 받기(refreshed_at 은 그대로)
        (Coverage(_d(-2), _d(-1), AT), D, False, Coverage(_d(-2), D, AT)),  # 뒤로 이어짐(날이 바뀜)
        (Coverage(_d(-2), D, AT), _d(-3), False, Coverage(_d(-3), D, AT)),  # 앞으로 이어짐(채우기)
        (Coverage(_d(-10), _d(-5), AT), D, False, None),  # 이어지지 않음 — 범위는 그대로
        (Coverage(_d(-10), _d(-5), AT), _d(-12), False, None),
        (Coverage(_d(-60), _d(-40), AT), _d(-2), True, Coverage(_d(-2), _d(-2), None)),  # 새로 시작
    ],
)
def test_merge_day(cov, day, reset, want):
    assert merge_day(cov, day, reset=reset) == want


# ---- 호출부호 규칙 · 항만청 · 모양 검사(검색 방식이 바뀌어도 그대로인 규칙) ------------------------------------------------------------
@pytest.mark.parametrize(
    ("raw", "want"),
    [
        ("230025", "230025"),
        (" d7ab2 ", "D7AB2"),
        ("ABC", "ABC"),
        ("ABCDEFG", "ABCDEFG"),
        ("AB", None),  # 3자 미만
        ("ABCDEFGH", None),  # AIS 호출부호 칸은 7자(schemas/ship_static.v1.json)
        ("AB-12", None),
        ("AB 12", None),  # 가운데 공백을 지워 다른 호출부호로 만들지 않는다
        ("", None),
        (None, None),
        (230025, None),
        ("ABı12", None),  # ASCII 가 아니면 거절(대문자 변환으로 모양이 바뀌지 않게)
        ("\tabc12\r\n", "ABC12"),
    ],
)
def test_normalize_call_sign(raw, want):
    assert normalize_call_sign(raw) == want


def test_call_sign_rule_matches_the_shared_vectors():
    """api(PortCallReader.normalizeCallSign)가 같은 파일을 읽는다 — 색인에 넣는 호출부호와 찾는 호출부호가 같은 규칙이다."""
    doc = json.loads((ROOT / "schemas" / "vectors" / "call-sign-cases.v1.json").read_text(encoding="utf-8"))
    assert doc["version"] == 1 and len(doc["cases"]) >= 15
    for c in doc["cases"]:
        assert normalize_call_sign(c["input"]) == c["expected"], c


def test_port_authorities_are_the_ten_verified_codes():
    """nlic.go.kr 항만청코드 표(11행이라 적혀 있으나 10개) — 2026-09-29 API 로 각 코드가 이 이름(prtAgNm)을 돌려줌을 확인했다.
    api 가 같은 파일(schemas/vectors/port-authorities.v1.json)로 '10곳 모두 창을 덮었는가' 를 판정한다."""
    doc = json.loads((ROOT / "schemas" / "vectors" / "port-authorities.v1.json").read_text(encoding="utf-8"))
    assert doc["version"] == 1 and tuple((a["code"], a["name"]) for a in doc["authorities"]) == PORT_AUTHORITIES
    assert PORT_AUTHORITIES == (
        ("020", "부산"), ("030", "인천"), ("200", "동해"), ("300", "대산"), ("500", "군산"),
        ("610", "목포"), ("620", "여수"), ("700", "포항"), ("810", "마산"), ("820", "울산"),
    )  # fmt: skip


def test_the_trimmed_230025_fixture_has_no_entry_count_so_its_day_cannot_be_indexed():
    """portmis_info5_busan_230025.xml 은 값을 확인한 필드만 남긴 응답이다(입항년도 · 입항횟수 없음) — 자연 키를 짓지 않고 세기만 한다."""
    p = parse_index_page((ROOT / "fixtures" / "portmis_info5_busan_230025.xml").read_bytes(), "020", date(2026, 9, 29))
    assert (p.total, p.items, p.rows, p.unkeyed) == (1, 1, [], 1)


def test_text_is_cleaned_and_capped_and_codes_are_shape_checked():
    it = real_item()
    for tag, value in (
        ("vsslNm", "AZAMARA‮ PURSUIT​\t  "),
        ("prvsDpmprtNatPrtCd", "jp smn"),
        ("etryptPurpsNm", "여" * 200),
        ("vsslNltyCd", "M-H"),
    ):
        el = it.find(tag)
        assert el is not None
        el.text = value
    (row,) = parse_index_page(_page(it), "020", DAY).rows
    assert row.vssl_nm == "AZAMARA PURSUIT"
    assert row.prev_port_cd is None and row.prev_port_nm == "SAKAIMINATO"  # 모양이 틀린 코드는 버린다(이름은 남는다)
    assert row.purpose_nm is not None and len(row.purpose_nm) == 80
    assert row.nationality_cd is None and row.nationality_nm == "마샬 제도"


@pytest.mark.parametrize("dt", ["2026-09-24T08:17:00", "2026-09-24", "yesterday", "", "2026-13-01T00:00:00+09:00"])
def test_entry_times_without_offset_or_unreadable_are_unknown(dt):
    it = _with_details([("최종", "입항", "etryptDt", dt)])
    (row,) = parse_index_page(_page(it), "020", DAY).rows
    assert (row.entry_at, row.entry_revision) == (None, None)


def test_non_normal_result_code_is_an_api_error_with_a_masked_message():
    body = b"<response><header><resultCode>99</resultCode><resultMsg>SOMETHING WRONG serviceKey=abc123XYZ</resultMsg></header></response>"
    with pytest.raises(PortCallApiError) as e:
        parse_index_page(body, "020", DAY)
    assert e.value.code == "99"
    assert str(e.value) == "resultCode 99 · SOMETHING WRONG serviceKey=***"


@pytest.mark.parametrize(
    ("body", "want"),
    [
        (b"not xml", "response is not XML"),
        (b'{"response":{}}', "response is not XML"),
        (
            b"<OpenAPI_ServiceResponse><cmmMsgHeader><errMsg>SERVICE ERROR</errMsg></cmmMsgHeader></OpenAPI_ServiceResponse>",
            "unexpected response (root <OpenAPI_ServiceResponse>: SERVICE ERROR)",
        ),
        (b"<response><body><totalCount>0</totalCount></body></response>", "resultCode missing"),
        (
            b"<response><header><resultCode>00</resultCode></header><body><items/></body></response>",
            "totalCount missing or invalid",
        ),
        (
            b"<response><header><resultCode>00</resultCode></header><body><totalCount>-1</totalCount></body></response>",
            "totalCount missing or invalid",
        ),
    ],
)
def test_unexpected_shapes_are_parse_errors(body, want):
    with pytest.raises(PortCallParseError) as e:
        parse_index_page(body, "020", DAY)
    assert str(e.value) == want


def test_doctype_and_entities_are_refused_before_parsing():
    bomb = b'<?xml version="1.0"?><!DOCTYPE r [<!ENTITY a "aaaa">]><response>&a;</response>'
    with pytest.raises(PortCallParseError, match="DOCTYPE"):
        parse_index_page(bomb, "020", DAY)
