"""QA-1204(AWS 출시 QA · 독립 리뷰 · 특보): 특보 줄이 있는데 **모든 줄**을 버린 응답도 '특보 0건 · 버린 줄 N' 목록으로 발행한다.

공급자 형식이 바뀌면(열이 하나 늘거나 시각 모양이 달라짐) 모든 줄이 같은 까닭으로 버려진다. 수집기는 그래도 빈 목록(complete · dropped = N)을 보내고,
화면은 곧바로 '발효 중 0건'을 보이며, api 이력은 QA-1203 의 상한(MISSING_END_AFTER = 1 h)이 지나면 발효 중인 특보를 모두 끝낸다 — 해석하지 못한 것을
'해제'로 기록한다. 줄 하나하나의 격리(ADR-036 결정 2 · QA-602 · 603 · 1222)는 읽은 줄이 있을 때의 규칙이다. 하나도 읽지 못했으면 응답 전체의 모양이
틀린 것으로 보고 호출 실패처럼 발행하지 않는다(화면은 마지막 목록과 그 나이 — 빈 목록을 지어 내지 않는다).

기대: 모든 줄을 버린 응답은 WarningResponseError — 발행하지 않고 실패로 기록한다. 대조: 특보가 없는 응답(머리 주석만)은 빈 목록으로 발행하고, 한 줄이라도
읽으면 그 줄만 버린 목록을 발행한다.
실행: cd apps/collector && uv run --offline pytest tests/qa/test_qa_1204_warning_every_line_dropped.py -q
"""

from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path

import pytest
from fakes import FakeRedis, make_ctx
from test_ais_helpers import decode

from wakeline_collector import kma_warning_rules
from wakeline_collector.jobs.weather import KmaWarningJob
from wakeline_collector.models import ProviderResult
from wakeline_collector.publisher import STREAM_WXWARN

FX = Path(__file__).resolve().parents[1] / "fixtures" / "kma_warning"
BASE = (FX / "wrn_now_data_preliminary.txt").read_bytes()  # 2026-10-09 실제 응답(EUC-KR) — 특보 3줄
EMPTY = (FX / "wrn_now_data_empty.txt").read_bytes()  # 같은 날 특보가 없는 응답(머리 주석만)


def _rows_changed(body: bytes, change) -> bytes:
    text = body.decode("euc-kr")
    return (
        "\n".join(change(line) if line.strip() and not line.startswith("#") else line for line in text.splitlines()).encode(
            "euc-kr"
        )
        + b"\n"
    )


# 공급자가 끝에 열 하나를 더한 모양(모든 줄 'expected 10 columns, got 11')
ONE_MORE_COLUMN = _rows_changed(BASE, lambda line: line.replace(",=", ", NEW,="))
# 모든 줄의 글자를 풀 수 없음(줄마다 깨진 바이트 — QA-1222 의 줄 단위 풀기에서 모두 버려짐)
ALL_UNDECODABLE = b"".join(
    line + (b"\xff" if line.strip() and not line.startswith(b"#") else b"") + b"\n" for line in BASE.splitlines()
)


class _Kma:
    name, configured = "kma_warning", True

    def __init__(self, body: bytes) -> None:
        self.body = body

    async def current(self) -> ProviderResult:
        return ProviderResult(self.name, self.body, datetime.now(UTC), 200, 1, data=kma_warning_rules.parse(self.body))


@pytest.mark.parametrize("body", [ONE_MORE_COLUMN, ALL_UNDECODABLE], ids=["one-more-column", "all-undecodable"])
def test_qa_1204_a_response_whose_every_line_is_dropped_is_refused(body):
    with pytest.raises(kma_warning_rules.WarningResponseError, match="every warning line"):
        kma_warning_rules.parse(body)


@pytest.mark.parametrize("body", [ONE_MORE_COLUMN, ALL_UNDECODABLE], ids=["one-more-column", "all-undecodable"])
async def test_qa_1204_the_job_publishes_nothing_and_records_a_failure(body):
    r = FakeRedis()
    await KmaWarningJob(_Kma(body), make_ctx(r, limits={"kma_warning": 400})).run_once()
    entries = r.streams.get(STREAM_WXWARN, [])
    assert not entries, (
        f"published a list with every line dropped: {[decode(f) | {'warnings': len(decode(f)['warnings'])} for _, f in entries]}"
    )
    assert "every warning line" in (await r.hgetall("wakeline:provider:kma_warning")).get("last_error", "")


async def test_qa_1204_control_an_empty_list_and_a_partly_dropped_list_are_still_published():
    r = FakeRedis()
    ctx = make_ctx(r, limits={"kma_warning": 400})
    await KmaWarningJob(_Kma(EMPTY), ctx).run_once()
    one_bad = BASE + _rows_changed(BASE, lambda line: line.replace(",=", ", NEW,=")).splitlines()[-1] + b"\n"
    await KmaWarningJob(_Kma(one_bad), ctx).run_once()
    got = [(len(decode(f)["warnings"]), decode(f)["dropped"]) for _, f in r.streams[STREAM_WXWARN]]
    assert got == [(0, 0), (3, 1)]
