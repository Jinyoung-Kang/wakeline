"""기상청 특보현황(wrn_now_data, disp=0) 해석 규칙(ADR-036 · SPEC F3). fixture 는 2026-10-09 실제 응답(EUC-KR — 예비 풍랑 3건 · 그 줄을 뺀 빈 목록)."""

from __future__ import annotations

from pathlib import Path

import pytest

from wakeline_collector import kma_warning_rules as r

FX = Path(__file__).parent / "fixtures" / "kma_warning"
HEAD = "#START7777\n# REG_UP  REG_UP_KO----  REG_ID    REG_KO----  TM_FC         TM_EF         WRN     LVL       CMD   ED_TM\n"


def body(*rows: str, enc: str = "euc-kr") -> bytes:
    return (HEAD + "".join(row + "\n" for row in rows)).encode(enc)


def row(
    reg_id="S1312020",
    tm_fc="202610091600",
    tm_ef="202610100900",
    wrn="풍랑  ",
    lvl="주의보  ",
    cmd="발표",
    ed="  ",
    up="S1310000",
) -> str:
    return f"{up}, 남해동부전해상    , {reg_id}, 남해동부바깥먼바다   , {tm_fc}, {tm_ef}, {wrn}, {lvl}, {cmd}, {ed},="


def test_the_real_response_with_preliminary_warnings():
    p = r.parse((FX / "wrn_now_data_preliminary.txt").read_bytes())
    assert p.dropped == []
    assert [w["zone_code"] for w in p.warnings] == ["S1312020", "S1324020", "S1324110"]
    w = p.warnings[0]
    assert w == {
        "zone_code": "S1312020", "zone_name": "남해동부바깥먼바다", "sea": True, "kind": "풍랑", "level": "예비", "command": "발표",
        "preliminary": True, "issued_at": "2026-10-09T07:00:00Z",  # 16:00 KST
        "effective_from": "2026-10-10T03:00:00Z", "effective_to": "2026-10-10T09:00:00Z", "effective_text": "10-10 오후(12–18시 KST)",
        "raw": w["raw"], "parent_code": "S1310000", "parent_name": "남해동부전해상",
    }  # fmt: skip
    assert "effective_at" not in w, "예비특보의 hh:58 은 시각이 아니라 때 — 시각을 짐작하지 않는다"
    assert w["raw"].startswith("S1310000, 남해동부전해상") and w["raw"].endswith(",=")


def test_an_empty_list_is_not_an_error():
    p = r.parse((FX / "wrn_now_data_empty.txt").read_bytes())
    assert (p.warnings, p.dropped) == ([], [])


def test_a_regular_warning_has_an_exact_effective_time_and_the_end_notice_is_kept_as_text():
    w = r.parse(body(row(ed="202610101800"))).warnings[0]
    assert (w["effective_at"], w["level"], w["preliminary"], w["end_notice"]) == (
        "2026-10-10T00:00:00Z",
        "주의보",
        False,
        "202610101800",
    )
    assert "effective_text" not in w and "effective_from" not in w
    assert "end_notice" not in r.parse(body(row())).warnings[0]


def test_every_preliminary_slot_in_the_header_and_an_unknown_code():
    for code, (name, h0, h1) in r.PRELIMINARY_SLOTS.items():
        w = r.parse(body(row(lvl="예비", tm_ef="20261010" + code.replace(":", "")))).warnings[0]
        assert w["effective_text"] == f"10-10 {name}({h0:02d}–{h1:02d}시 KST)"
        assert w["effective_from"] < w["effective_to"]
    w = r.parse(body(row(lvl="예비", tm_ef="202610101230"))).warnings[0]
    assert w["effective_text"] == "10-10 때 모름(부호 12:30)" and "effective_from" not in w and "effective_at" not in w
    assert len(r.PRELIMINARY_SLOTS) == 13


def test_bad_rows_are_dropped_and_counted_not_the_whole_list():
    p = r.parse(body(row(), row(reg_id="X123"), row(tm_fc="2026100916"), row(wrn=" "), row()[:-1], "S1, a, b,="))
    assert len(p.warnings) == 1
    assert [d["reason"] for d in p.dropped] == ["bad zone code", "bad time", "missing kind/level/command", "line does not end with '='",
                                                "expected 10 columns, got 3"]  # fmt: skip


def test_a_land_zone_without_a_parent():
    w = r.parse(body(row(reg_id="L1100100", up="00000000", wrn="호우", lvl="경보"))).warnings[0]
    assert (w["sea"], w["kind"], w["level"]) == (False, "호우", "경보")
    assert "parent_code" not in w


def test_responses_that_are_not_a_warning_list_are_refused():
    for bad in ("인증키가 유효하지 않습니다".encode(), b'{"result":{"status":401}}', b"", b"<html>504 Gateway Time-out</html>"):
        with pytest.raises(r.WarningResponseError):
            r.parse(bad)
    with pytest.raises(r.WarningResponseError, match="neither"):
        r.parse(b"\xff\xfe\xfa" * 3)
    assert len(r.parse(body(row(), enc="utf-8")).warnings) == 1  # UTF-8 로 와도 읽는다


def test_size_and_row_limits(monkeypatch):
    monkeypatch.setattr(r, "MAX_ROWS", 2)
    with pytest.raises(r.WarningResponseError, match="too many rows"):
        r.parse(body(row(), row(), row()))
    monkeypatch.setattr(r, "MAX_BYTES", 10)
    with pytest.raises(r.WarningResponseError, match="too large"):
        r.parse(body(row()))
