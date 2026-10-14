"""QA-1222(AWS 출시 QA · 수집기 · 특보): EUC-KR 로 풀리지 않는 바이트가 **한 줄**에만 있어도 특보 목록 전체를 버린다.

kma_warning_rules 는 "모르는 모양의 줄은 버리고 센다 — 목록 전체를 버리지 않는다"(모듈 설명 · ADR-036 결정 2)고, 앞선 QA 가 같은 규칙을 길이(QA-602) ·
날짜 넘침(QA-603)에 대해 고쳤다. 그런데 글자 풀기(decode — kma_warning_rules.py:68-78)는 **본문 전체**를 한 번에 UTF-8 → EUC-KR 로 풀고, 실패하면
WarningResponseError 로 목록 전체를 버린다. 그래서 한 줄에 EUC-KR(KS X 1001) 밖의 글자 — CP949(UHC) 확장 한글(예: '똠') · 깨진 바이트 하나 — 가 있으면
그 줄이 목록에 있는 동안 5분마다 아무것도 발행되지 않는다(화면은 옛 목록과 그 나이). 응답 머리는 `charset=EUC-KR` 이지만 한국 서버는 흔히 CP949 를
그 이름으로 보낸다 — 기상청이 그런 글자를 실제로 보내는지는 확인하지 못했다(저장된 실제 응답에는 없다).

기대: 그 줄만 버리고(dropped) 나머지 특보는 발행한다.
실행: cd apps/collector && uv run --offline pytest tests/qa/test_qa_1222_warning_one_undecodable_line.py -q
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


def _extra_line(name: str) -> str:
    text = BASE.decode("euc-kr")
    row = next(line for line in text.splitlines() if line.strip() and not line.startswith("#"))
    cols = row.split(",")
    cols[2], cols[3] = "S1399999", name
    return ",".join(cols) + "\n"


class _Kma:
    name, configured = "kma_warning", True

    def __init__(self, body: bytes) -> None:
        self.body = body

    async def current(self) -> ProviderResult:
        return ProviderResult(self.name, self.body, datetime.now(UTC), 200, 1, data=kma_warning_rules.parse(self.body))


@pytest.mark.parametrize(
    ("label", "line"),
    [
        ("CP949-only syllable in a zone name", _extra_line("똠섬앞바다").encode("cp949")),
        ("one stray 0xFF byte", _extra_line("깨진바다").encode("euc-kr").replace(b"=", b"\xff=")),
    ],
    ids=["cp949-syllable", "stray-0xff"],
)
async def test_qa_1222_one_undecodable_line_drops_only_that_line(label, line):
    r = FakeRedis()
    await KmaWarningJob(_Kma(BASE + line), make_ctx(r, limits={"kma_warning": 400})).run_once()
    entries = r.streams.get(STREAM_WXWARN, [])
    last_error = (await r.hgetall("wakeline:provider:kma_warning")).get("last_error")
    assert entries, f"[{label}] nothing published — the whole list was dropped: {last_error}"
    payload = decode(entries[-1][1])
    assert (len(payload["warnings"]), payload["dropped"]) == (3, 1), payload
