"""QA-602 · QA-603(출시 QA 2차 · 신뢰성): 특보 해석은 "모양이 틀린 줄은 그 줄만 버리고 센다 — 목록 전체를 버리지 않는다"(ADR-036 결정 2 · kma_warning_rules docstring).

QA-602: 해석기가 스트림 계약(schemas/stream_envelope.v1.json wx_warnings_payload — end_notice ≤ 40 · kind/level/command ≤ 16 · 이름 ≤ 80 · raw ≤ 400)의
길이 한도를 보지 않는다. 한도를 넘는 줄 하나가 그대로 실리면 api 의 스키마 검사가 봉투 전체를 DLQ 로 보내 — 그 특보가 발효 중인 동안 5분마다 목록 전체가 버려지고
화면은 옛 목록에 머문다(수집기 상태는 ok). 기대: 그 줄만 버린다(dropped) — 나머지는 계약대로.
QA-603: 날짜 계산이 넘치는 줄(발표 0001-01-01 00:00 KST → UTC 는 서기 1년 앞, 예비 때 9999-12-31 밤 → 다음 날)은 OverflowError 를 낸다 — parse 는 ValueError 만
잡으므로 목록 전체가 그 주기에 발행되지 않는다. 기대: 그 줄만 버린다.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from jsonschema import Draft202012Validator

from wakeline_collector import kma_warning_rules

ROOT = Path(__file__).resolve().parents[4]
FX = Path(__file__).resolve().parents[1] / "fixtures" / "kma_warning"
_SCHEMA = json.loads((ROOT / "schemas" / "stream_envelope.v1.json").read_text(encoding="utf-8"))
PAYLOAD = Draft202012Validator({**_SCHEMA["$defs"]["wx_warnings_payload"], "$defs": _SCHEMA["$defs"]})


def _with(line: str) -> bytes:
    return (FX / "wrn_now_data_preliminary.txt").read_bytes() + (line + "\n").encode("euc-kr")


@pytest.mark.parametrize(
    "line",
    [
        # 해제예고(ED_TM — 자유 글자) 41자 이상
        "L1100000, 서울, L1101000, 서울동남권, 202610100900, 202610101000, 강풍, 주의보, 발표, 해제예고 10일 오후 늦게(18시~21시) 이후 기상상황에 따라 변동 가능,=",
        # 특보 종류 17자 이상
        "L1100000, 서울, L1101000, 서울동남권, 202610100900, 202610101000, 아주아주아주아주아주아주긴특보종류, 주의보, 발표,  ,=",
    ],
)
def test_qa_602_an_over_long_line_is_dropped_not_published(line: str) -> None:
    parsed = kma_warning_rules.parse(_with(line))
    payload = {"complete": True, "dropped": len(parsed.dropped), "warnings": parsed.warnings}
    errors = [f"{list(e.path)}: {e.message[:80]}" for e in PAYLOAD.iter_errors(payload)]
    assert errors == [], "한 줄이 계약을 어겨 목록 전체가 api 에서 버려진다"
    assert len(parsed.warnings) == 3 and len(parsed.dropped) == 1


@pytest.mark.parametrize(
    "line",
    [
        "L1100000, 서울, L1101000, 서울동남권, 000101010000, 202610101000, 강풍, 주의보, 발표,  ,=",
        "S1310000, 남해동부전해상, S1312020, 남해동부바깥먼바다, 202610091600, 999912312359, 풍랑, 예비, 발표,  ,=",
    ],
)
def test_qa_603_a_date_overflow_drops_only_that_line(line: str) -> None:
    parsed = kma_warning_rules.parse(_with(line))  # 고치기 전: OverflowError — 목록 전체가 그 주기에 없다
    assert len(parsed.warnings) == 3 and len(parsed.dropped) == 1
