"""QA-604(출시 QA 2차 · 신뢰성): 기상 작업의 다시 부르기는 "남은 하루의 정규 주기 몫을 남기고만" 예산을 예약한다(jobs/weather.py retry_headroom ·
budget_rules.regular_headroom — 하루 내내 일시 오류여도 정규 주기가 budget_exhausted 로 막히지 않게). 그런데 REGULAR_CALLS 에 kma_warning 이 없어
특보 작업의 여유가 늘 0 이다 — 하루 예산 400 · 정규 288(5분 주기)인데, 일시 오류로 다시 부른 횟수가 112 를 넘는 날은 남은 정규 주기가 UTC 자정(09시 KST)까지
budget_exhausted 로 막힌다(기상청이 회복해도). 기대: 여유 = 남은 정규 주기 수(5분 주기면 하루 시작에 289).
"""

from __future__ import annotations

from datetime import UTC, datetime
from types import SimpleNamespace

from wakeline_collector.config import settings
from wakeline_collector.jobs.weather import retry_headroom


def test_qa_604_warning_retries_leave_room_for_the_rest_of_the_days_regular_cycles() -> None:
    midnight = datetime(2026, 10, 10, 0, 0, tzinfo=UTC)
    rt = SimpleNamespace(sigmet_poll_s=300, metar_poll_s=600, radar_poll_s=60)
    got = retry_headroom(rt, "kma_warning", midnight)
    want = 86_400 // settings.kma_warning_poll_s + 1
    assert got == want, f"kma_warning headroom {got} — regular cycles left today {want}"
