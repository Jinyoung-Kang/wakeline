"""연안 교통량(ADR-023): 한국해양교통안전공단 실시간 해양교통정보(get_realtime) JSON 해석 · Redis 스냅샷 값 만들기.

fixtures/komsa_realtime_sample.json 은 2026-09-29 확인한 모양(response.header.resultCode "200" · body.items.item[] =
{grid_id, vmtc, dnsty} · body.totalCount · body.regDt KST)으로 만든 합성 자료다(값은 시험용).
"""

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta, timezone
from pathlib import Path

import orjson
import pytest

from wakeline_collector.marine_grid import Cell
from wakeline_collector.traffic_grid import (
    CELL_DEG,
    KomsaApiError,
    TrafficItem,
    build_payload,
    parse_komsa,
)

FIX = Path(__file__).resolve().parents[3] / "fixtures" / "komsa_realtime_sample.json"
KST = timezone(timedelta(hours=9))


def body(
    items: object = None, *, code: object = "200", msg: str = "ok", reg: object = "2026-09-29 18:05:05", total: object = None
) -> bytes:
    b: dict[str, object] = {"regDt": reg}
    if items is not None:
        b["items"] = items
    if total is not None:
        b["totalCount"] = total
    return json.dumps({"response": {"header": {"resultCode": code, "resultMsg": msg}, "body": b}}).encode()


def test_parse_fixture():
    s = parse_komsa(FIX.read_bytes())
    assert s.reg_dt == datetime(2026, 9, 29, 18, 5, 5, tzinfo=KST)
    assert s.reg_dt.astimezone(UTC) == datetime(2026, 9, 29, 9, 5, 5, tzinfo=UTC)
    assert s.total_count == 3
    assert s.items == [
        TrafficItem("GR4_F2K41_C3", 12, 34.0),
        TrafficItem("GR4_F2K41_C4", 1, 0.0),
        TrafficItem("GR4_F2K41_D3", 102, 100.0),
    ]
    assert s.rejected == [] and s.duplicates == 0


def test_single_item_object_is_a_list_of_one():
    s = parse_komsa(body({"item": {"grid_id": "GR4_A", "vmtc": 3, "dnsty": 7.5}}))
    assert s.items == [TrafficItem("GR4_A", 3, 7.5)]


def test_items_given_directly_as_a_list():
    s = parse_komsa(body([{"grid_id": "GR4_A", "vmtc": 3, "dnsty": 7}]))
    assert [i.grid_id for i in s.items] == ["GR4_A"]


@pytest.mark.parametrize("items", ["", None, {"item": None}, {"item": []}, {}])
def test_empty_item_shapes_are_an_empty_snapshot(items):
    raw = body(items) if items is not None else body()
    s = parse_komsa(raw)
    assert s.items == [] and s.reg_dt.tzinfo is not None


def test_numeric_strings_are_read_as_numbers():
    s = parse_komsa(body({"item": [{"grid_id": "GR4_A", "vmtc": "4", "dnsty": "12.5"}]}, total="1"))
    assert s.items == [TrafficItem("GR4_A", 4, 12.5)] and s.total_count == 1


def test_result_code_200_as_number_is_normal():
    assert parse_komsa(body({"item": []}, code=200)).items == []


@pytest.mark.parametrize(
    ("code", "msg"), [("03", "NODATA_ERROR"), ("30", "SERVICE_KEY_IS_NOT_REGISTERED_ERROR"), ("99", "x"), ("00", "?")]
)
def test_other_result_codes_are_api_errors(code, msg):
    with pytest.raises(KomsaApiError) as e:
        parse_komsa(body({"item": []}, code=code, msg=msg))
    assert e.value.code == code and msg in str(e.value)


def test_missing_header_is_a_shape_error():
    with pytest.raises(ValueError, match="resultCode"):
        parse_komsa(b'{"response":{"body":{"regDt":"2026-09-29 18:05:05"}}}')


def test_portal_xml_gateway_error_is_an_api_error():
    xml = (
        b"<OpenAPI_ServiceResponse><cmmMsgHeader><errMsg>SERVICE ERROR</errMsg>"
        b"<returnAuthMsg>LIMITED_NUMBER_OF_SERVICE_REQUESTS_EXCEEDS_ERROR</returnAuthMsg><returnReasonCode>22</returnReasonCode>"
        b"</cmmMsgHeader></OpenAPI_ServiceResponse>"
    )
    with pytest.raises(KomsaApiError) as e:
        parse_komsa(xml)
    assert e.value.code == "22" and "LIMITED_NUMBER_OF_SERVICE_REQUESTS_EXCEEDS_ERROR" in str(e.value)


@pytest.mark.parametrize("raw", [b"", b"<html><title>502</title></html>", b"not json", b"[]", b'{"x":1}', b'{"response":[]}'])
def test_non_json_or_wrong_shape_is_an_error(raw):
    with pytest.raises(ValueError):
        parse_komsa(raw)


@pytest.mark.parametrize("reg", [None, "", "2026-09-29T18:05:05", "yesterday", "2026-13-01 00:00:00", 20260929])
def test_reg_dt_must_be_a_kst_wall_clock_time(reg):
    with pytest.raises(ValueError, match="regDt"):
        parse_komsa(body({"item": []}, reg=reg))


def test_invalid_items_are_rejected_one_by_one_and_duplicates_counted():
    items = [
        {"grid_id": "GR4_OK", "vmtc": 2, "dnsty": 3},
        {"grid_id": "GR4 BAD", "vmtc": 1, "dnsty": 1},  # 공백
        {"grid_id": "GR4/../x", "vmtc": 1, "dnsty": 1},  # URL 에 들어가는 값
        {"grid_id": "G" * 33, "vmtc": 1, "dnsty": 1},  # 너무 김
        {"grid_id": "GR4_NEG", "vmtc": -1, "dnsty": 1},
        {"grid_id": "GR4_BOOL", "vmtc": True, "dnsty": 1},
        {"grid_id": "GR4_FRAC", "vmtc": 1.5, "dnsty": 1},
        {"grid_id": "GR4_PCT", "vmtc": 1, "dnsty": 100.5},
        {"grid_id": "GR4_NAN", "vmtc": 1, "dnsty": "NaN"},
        {"grid_id": "GR4_NODN", "vmtc": 1},
        "not an object",
        {"grid_id": "GR4_OK", "vmtc": 9, "dnsty": 9},  # 겹침 — 처음 것만
    ]
    s = parse_komsa(body({"item": items}))
    assert s.items == [TrafficItem("GR4_OK", 2, 3.0)]
    assert s.duplicates == 1
    reasons = [r["reason"] for r in s.rejected]
    assert len(reasons) == 10
    assert (
        reasons.count("grid_id") == 3
        and reasons.count("vmtc") == 3
        and reasons.count("dnsty") == 3
        and reasons.count("item") == 1
    )
    assert all(len(json.dumps(r)) < 300 for r in s.rejected)  # 품질 사례는 짧게


def test_integral_float_vmtc_is_accepted():
    s = parse_komsa(body({"item": [{"grid_id": "GR4_A", "vmtc": 7.0, "dnsty": 0}]}))
    assert s.items[0].vmtc == 7 and isinstance(s.items[0].vmtc, int)


# ---- Redis 스냅샷 값 ------------------------------------------------------------------------------------------------


def _cell(g: str, lat: float, lon: float) -> Cell:
    return Cell(g, lat, lon, round(lat + CELL_DEG, 3), round(lon + CELL_DEG, 3), None)


def test_payload_counts_and_cells():
    s = parse_komsa(FIX.read_bytes())
    fetched = datetime(2026, 9, 29, 9, 6, 1, 250000, tzinfo=UTC)
    cells = {"GR4_F2K41_C3": _cell("GR4_F2K41_C3", 37.45, 126.6), "GR4_F2K41_D3": _cell("GR4_F2K41_D3", 37.425, 126.6)}
    p = build_payload(s, fetched, cells, {"GR4_F2K41_C4": "not_found"})
    assert "published_at" not in p  # 같은 입력 → 같은 값(ETag)
    assert build_payload(s, fetched, cells, {"GR4_F2K41_C4": "not_found"}) == p
    assert p["v"] == 1
    assert p["reg_dt_kst"] == "2026-09-29T18:05:05+09:00"
    assert p["reg_dt_utc"] == "2026-09-29T09:05:05Z"
    assert p["fetched_at"] == "2026-09-29T09:06:01.250Z"
    assert p["cell_deg"] == 0.025
    assert (p["total"], p["resolved"], p["unresolved"]) == (3, 2, 1)
    assert (p["pending"], p["not_found"], p["off_grid"], p["rejected"]) == (0, 1, 0, 0)
    assert p["partial"] is False and p["total_count"] == 3
    # 칸: [grid_no, lat_min, lon_min, 척수, 밀집도 %] — grid_no 순(같은 입력이면 같은 값 → 같은 ETag)
    assert p["cells"] == [["GR4_F2K41_C3", 37.45, 126.6, 12, 34.0], ["GR4_F2K41_D3", 37.425, 126.6, 102, 100.0]]


def test_payload_marks_a_truncated_page_partial_and_counts_pending_and_off_grid():
    s = parse_komsa(
        body({"item": [{"grid_id": "A1", "vmtc": 1, "dnsty": 1}, {"grid_id": "A2", "vmtc": 1, "dnsty": 1}]}, total=6200)
    )
    p = build_payload(s, datetime.now(UTC), {}, {"A2": "off_grid"})
    assert p["partial"] is True and p["total_count"] == 6200
    assert (p["resolved"], p["unresolved"], p["pending"], p["off_grid"]) == (0, 2, 1, 1)
    assert p["cells"] == []


def test_payload_unknown_total_count_is_not_partial():
    s = parse_komsa(body({"item": [{"grid_id": "A1", "vmtc": 1, "dnsty": 1}]}))
    p = build_payload(s, datetime.now(UTC), {}, {})
    assert p["total_count"] is None and p["partial"] is False


def test_full_snapshot_payload_stays_small():
    items = [{"grid_id": f"GR4_F{i // 100:03d}K{i % 100:02d}_C3", "vmtc": 1 + i % 102, "dnsty": i % 101} for i in range(5099)]
    s = parse_komsa(body({"item": items}, total=5099))
    cells = {
        it.grid_id: _cell(it.grid_id, 33.0 + (n // 300) * CELL_DEG, 124.0 + (n % 300) * CELL_DEG) for n, it in enumerate(s.items)
    }
    p = build_payload(s, datetime.now(UTC), cells, {})
    raw = orjson.dumps(p)
    assert p["resolved"] == 5099
    assert len(raw) < 300_000, len(raw)
    for c in p["cells"]:
        assert c[1] == round(c[1], 3) and c[2] == round(c[2], 3)
