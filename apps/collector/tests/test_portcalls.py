"""한국 항만 입출항 캐시 값(ADR-022) — PORT-MIS Info5 XML 응답 검증·정리. 저장소의 실제 응답 fixture 와 그것을 복제한 자료만 쓴다."""

from __future__ import annotations

from datetime import UTC, date, datetime
from pathlib import Path

import orjson
import pytest
from portmis_synthetic import empty_page, fixture_bytes, item, page

from wakeline_collector import portcalls as pc
from wakeline_collector.portcalls import (
    PORT_AUTHORITIES,
    PortCallApiError,
    PortCallParseError,
    build_value,
    normalize_call_sign,
    parse_page,
    portcalls_key,
    query_window,
)

AT = datetime(2026, 9, 29, 3, 0, 0, 123000, tzinfo=UTC)


# ---- 호출부호 규칙 ---------------------------------------------------------------------------------------------------
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


def test_key_only_for_valid_call_sign():
    assert portcalls_key("230025") == "wakeline:portcalls:230025"
    for bad in ("abc12", "AB", "AB:*", "ABC12 ", "ABCDEFGH"):
        with pytest.raises(ValueError):
            portcalls_key(bad)


def test_port_authorities_are_the_ten_verified_codes():
    """nlic.go.kr 항만청코드 표(11행이라 적혀 있으나 10개) — 2026-09-29 API 로 각 코드가 이 이름(prtAgNm)을 돌려줌을 확인했다."""
    assert PORT_AUTHORITIES == (
        ("020", "부산"), ("030", "인천"), ("200", "동해"), ("300", "대산"), ("500", "군산"),
        ("610", "목포"), ("620", "여수"), ("700", "포항"), ("810", "마산"), ("820", "울산"),
    )  # fmt: skip


# ---- 조회 창(KST 날짜) ------------------------------------------------------------------------------------------------
def test_query_window_uses_kst_dates():
    # 2026-09-29 16:00 UTC = 2026-09-30 01:00 KST → 오늘(KST) 9/30, 30일 전 8/31
    assert query_window(datetime(2026, 9, 29, 16, 0, tzinfo=UTC)) == (date(2026, 8, 31), date(2026, 9, 30))
    # 14:59 UTC = 23:59 KST 9/29
    assert query_window(datetime(2026, 9, 29, 14, 59, tzinfo=UTC)) == (date(2026, 8, 30), date(2026, 9, 29))


# ---- 응답 한 쪽 ------------------------------------------------------------------------------------------------------
def test_parse_fixture_reads_exactly_the_verified_fields():
    p = parse_page(fixture_bytes(), "230025")
    assert p.total == 1 and p.mismatched == 0 and len(p.items) == 1
    it = p.items[0]
    assert it.port_authority_code == "020" and it.port_authority == "부산"
    assert it.reported_name == "부광9호" and it.kind == "석유제품 운반선" and it.purpose == "양하"
    for port in (it.prev_port, it.next_port, it.dest_port):
        assert port is not None and port.code == "KRYOC" and port.name == "여천항"
    # 입항 2026-09-29T00:00:00+09:00 = 2026-09-28T15:00Z. 출항 신고는 없다 → null(지어내지 않는다)
    assert it.entry_at == datetime(2026, 9, 28, 15, 0, tzinfo=UTC)
    assert it.exit_at is None
    assert [(r.kind, r.at, r.type) for r in it.reports] == [("입항", datetime(2026, 9, 28, 15, 0, tzinfo=UTC), "최초")]
    # fixture 에 없는 필드는 null
    assert it.nationality is None


def test_items_with_another_call_sign_are_dropped_and_counted():
    """조회는 clsgn 으로 거르지만 응답을 믿지 않는다 — 다른 호출부호의 기록은 이 선박의 기록으로 보이지 않는다."""
    body = page([item(), item(clsgn="999999"), item(clsgn=None)], 3)
    p = parse_page(body, "230025")
    assert len(p.items) == 1 and p.mismatched == 2 and p.total == 3


def test_call_sign_in_response_is_compared_after_the_same_normalisation():
    p = parse_page(page([item(clsgn=" d7ab2 ")], 1), "D7AB2")
    assert len(p.items) == 1 and p.mismatched == 0


def test_unknown_elements_are_ignored_and_missing_ones_are_null():
    it = item(
        extra={"someNewField": "x", "vsslNltyNm": "대한민국"},
        drop=("vsslKndNm", "prvsDpmprtNatPrtCd", "dstnPrtNm", "dstnNatPrtCd"),
    )
    got = parse_page(page([it], 1), "230025").items[0]
    assert got.nationality == "대한민국"
    assert got.kind is None
    assert got.prev_port is not None and got.prev_port.code is None and got.prev_port.name == "여천항"
    assert got.dest_port is None  # 코드·이름 둘 다 없으면 항구 없음


def test_text_is_cleaned_and_capped_and_codes_are_shape_checked():
    it = item(
        extra={"vsslNm": "부광\u202e9호\u200b\t  ", "prvsDpmprtNatPrtCd": "kr yoc", "etryptPurpsNm": "양" * 200}, code="02O"
    )
    got = parse_page(page([it], 1), "230025").items[0]
    assert got.reported_name == "부광9호"
    assert got.prev_port is not None and got.prev_port.code is None  # 모양이 틀린 코드는 버린다(이름은 남는다)
    assert got.purpose is not None and len(got.purpose) == pc.TEXT_MAX
    assert got.port_authority_code is None  # 세 자리 숫자만


@pytest.mark.parametrize("dt", ["2026-09-29T00:00:00", "2026-09-29", "yesterday", "", "2026-13-01T00:00:00+09:00"])
def test_times_without_offset_or_unreadable_are_null(dt):
    got = parse_page(page([item(at=dt)], 1), "230025").items[0]
    assert got.entry_at is None
    assert got.reports[0].at is None and got.reports[0].kind == "입항"


def test_entry_and_exit_are_set_only_when_unambiguous():
    reports = [
        ("최초", "입항", "2026-09-20T08:00:00+09:00"),
        ("변경", "입항", "2026-09-20T10:00:00+09:00"),  # 입항 시각이 둘 — 어느 것이 맞는지 고르지 않는다
        ("최초", "출항", "2026-09-21T06:30:00+09:00"),
        ("최초", "출항", "2026-09-21T06:30:00+09:00"),  # 같은 시각 두 번은 하나로 본다
    ]
    got = parse_page(page([item(reports=reports)], 1), "230025").items[0]
    assert got.entry_at is None
    assert got.exit_at == datetime(2026, 9, 20, 21, 30, tzinfo=UTC)
    assert [r.type for r in got.reports] == ["최초", "변경", "최초", "최초"]


def test_non_normal_result_code_is_an_api_error_with_code_and_message():
    with pytest.raises(PortCallApiError) as e:
        parse_page(page([], None, code="99", msg="SOMETHING WRONG serviceKey=abc123XYZ"), "230025")
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
        parse_page(body, "230025")
    assert str(e.value) == want


def test_doctype_and_entities_are_refused_before_parsing():
    bomb = b'<?xml version="1.0"?><!DOCTYPE r [<!ENTITY a "aaaa">]><response>&a;</response>'
    with pytest.raises(PortCallParseError, match="DOCTYPE"):
        parse_page(bomb, "230025")


def test_empty_page():
    p = parse_page(empty_page(), "230025")
    assert p.total == 0 and p.items == [] and p.mismatched == 0


# ---- 캐시 값 ---------------------------------------------------------------------------------------------------------
def _items(*ats: str, codes: tuple[str, ...] = ("020",)):
    out = []
    for i, a in enumerate(ats):
        out += parse_page(page([item(code=codes[i % len(codes)], at=a)], 1), "230025").items
    return out


def test_build_value_sorts_newest_first_and_caps():
    ats = [f"2026-09-{d:02d}T0{d % 10}:00:00+09:00" for d in range(1, 26)]
    v = build_value("230025", AT, (date(2026, 8, 30), date(2026, 9, 29)), _items(*ats))
    assert v.status == "ok" and len(v.items) == pc.MAX_ITEMS and v.truncated
    first = [i.entry_at for i in v.items]
    assert first == sorted(first, reverse=True)
    assert v.items[0].entry_at == datetime(2026, 9, 24, 20, 0, tzinfo=UTC)  # 9/25 05:00 KST — 가장 최근


def test_build_value_sort_uses_latest_report_and_unknown_times_last():
    a = _items("2026-09-10T00:00:00+09:00")[0]
    b = parse_page(page([item(reports=[("최초", "입항", "2026-09-01T00:00:00+09:00"), ("최초", "출항", "2026-09-12T00:00:00+09:00")])], 1),
                   "230025").items[0]  # fmt: skip
    c = _items("unknown")[0]
    v = build_value("230025", AT, (date(2026, 8, 30), date(2026, 9, 29)), [c, a, b])
    assert [x.exit_at is not None for x in v.items] == [True, False, False]
    assert v.items[2].entry_at is None
    assert not v.truncated


def test_build_value_drops_duplicate_calls_across_pages():
    """같은 항만청·입항년도·입항횟수는 한 번만(페이지 경계에서 겹쳐 온 경우). 둘 중 하나라도 없으면 합치지 않는다."""
    x = parse_page(page([item(year="2026", count="101")], 1), "230025").items
    y = parse_page(page([item(year="2026", count="101")], 1), "230025").items
    z = parse_page(page([item(year="2026", count="102")], 1), "230025").items
    n = parse_page(page([item(), item()], 2), "230025").items
    v = build_value("230025", AT, (date(2026, 8, 30), date(2026, 9, 29)), [*x, *y, *z, *n])
    assert len(v.items) == 4


def test_none_when_no_items():
    v = build_value("230025", AT, (date(2026, 8, 30), date(2026, 9, 29)), [])
    assert v.status == "none" and v.items == () and v.ttl_s == pc.TTL_RESULT_S


def test_value_json_shape_and_ttls():
    v = build_value("230025", AT, (date(2026, 8, 30), date(2026, 9, 29)), _items("2026-09-29T00:00:00+09:00"))
    doc = orjson.loads(v.to_json())
    assert doc["v"] == 1 and doc["status"] == "ok" and doc["call_sign"] == "230025"
    assert doc["fetched_at"] == "2026-09-29T03:00:00.123Z"
    assert doc["window"] == {"from": "2026-08-30", "to": "2026-09-29", "days": 30}
    assert doc["source"] == "해양수산부 선박운항정보(PORT-MIS)"
    it = doc["items"][0]
    assert it == {
        "port_authority_code": "020",
        "port_authority": "부산",
        "entry_at": "2026-09-28T15:00:00Z",
        "exit_at": None,
        "reports": [{"kind": "입항", "at": "2026-09-28T15:00:00Z", "type": "최초"}],
        "purpose": "양하",
        "prev_port": {"code": "KRYOC", "name": "여천항"},
        "next_port": {"code": "KRYOC", "name": "여천항"},
        "dest_port": {"code": "KRYOC", "name": "여천항"},
        "reported_name": "부광9호",
        "kind": "석유제품 운반선",
        "nationality": None,
    }
    assert v.ttl_s == 6 * 3600
    assert pc.error("230025", "HTTP 500", AT).ttl_s == pc.TTL_ERROR_S
    assert pc.disabled("230025", "no_key", AT).ttl_s == pc.TTL_DISABLED_S
    assert doc["truncated"] is False and doc["incomplete"] is False and doc["error"] is None and doc["reason"] is None
    assert doc["error_kind"] is None and doc["error_code"] is None


def test_error_and_disabled_carry_a_masked_capped_reason():
    e = pc.error("230025", "boom serviceKey=SECRETSECRET&x=1 " + "y" * 400, AT)
    doc = orjson.loads(e.to_json())
    assert doc["status"] == "error" and doc["items"] == [] and "SECRETSECRET" not in doc["error"]
    assert len(doc["error"]) <= pc.ERROR_MAX
    d = orjson.loads(pc.disabled("230025", "no_key", AT).to_json())
    assert d["status"] == "disabled" and d["reason"] == "no_key" and d["error"] is None and d["window"] is None


@pytest.mark.parametrize(
    ("kind", "code", "want_code"),
    [("http", "503", "503"), ("provider", "30", "30"), ("provider", "SERVICE KEY", None), ("budget", None, None)],
)
def test_error_carries_a_public_kind_and_a_shape_checked_code(kind, code, want_code):
    """화면(공개)에는 사유 원문 대신 종류·코드만 간다 — 원문(예산 수치 등)은 캐시·운영 화면·로그에만."""
    doc = orjson.loads(pc.error("230025", "prtAgCd 020: x", AT, kind=kind, code=code).to_json())
    assert doc["error_kind"] == kind and doc["error_code"] == want_code and doc["error"] == "prtAgCd 020: x"


def test_error_kind_defaults_to_internal():
    assert orjson.loads(pc.error("230025", "boom", AT).to_json())["error_kind"] == "internal"


def test_incomplete_flag_is_carried():
    v = build_value("230025", AT, (date(2026, 8, 30), date(2026, 9, 29)), [], incomplete=True)
    assert orjson.loads(v.to_json())["incomplete"] is True


# ---- 언어 간 계약(api PortCallReader · PortCallsInfo 와 같은 파일을 읽는다) ------------------------------------------------
_ROOT = Path(__file__).resolve().parents[3]


def test_call_sign_rule_matches_the_shared_vectors():
    doc = orjson.loads((_ROOT / "schemas" / "vectors" / "call-sign-cases.v1.json").read_bytes())
    assert doc["version"] == 1 and len(doc["cases"]) >= 15
    for c in doc["cases"]:
        assert normalize_call_sign(c["input"]) == c["expected"], c


def test_shared_cache_value_sample_is_what_the_collector_writes_for_the_fixture():
    """fixtures/portcalls_value_230025.json = 실제 응답 fixture → 캐시 값(fetched_at 고정). api 시험이 같은 파일을 읽는다."""
    sample = orjson.loads((_ROOT / "fixtures" / "portcalls_value_230025.json").read_bytes())["value"]
    p = parse_page(fixture_bytes(), "230025")
    v = build_value("230025", AT, (date(2026, 8, 30), date(2026, 9, 29)), p.items)
    assert orjson.loads(v.to_json()) == sample
