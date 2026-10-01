"""KST 시각을 받는 규칙이 벽시계만 읽는가 — kst_now() 가 'UTC 표시를 붙인 KST 벽시계'(지금) 대신 시간대가 붙은 KST 시각(+09:00)을 돌려줘도 답이 같은지
고정한다(collector-review F8 · PLAN 3B-8: 같은 순간을 세 모양 — 시간대 없는 벽시계(시험이 바꿔 끼우는 모양) · UTC 표시 벽시계(지금 kst_now) · +09:00 —
으로 주고 답을 비교한다).

- kma_rules: streak_probe_every_s · select_refetch · gap_expired · old_tm_cut(그 시각의 tm 글자) · strftime 으로 만든 tm 과 날.
- kst_now 의 벽시계 필드(연 · 월 · 일 · 시 · 분)는 UTC + 9 h 의 필드다.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta, timezone

import pytest

from wakeline_collector.kma_rules import gap_expired, old_tm_cut, select_refetch, streak_probe_every_s
from wakeline_collector.timeutil import kst_now

KST_TZ = timezone(timedelta(hours=9))
INSTANTS = [
    datetime(2026, 9, 30, 14, 59, 30, tzinfo=UTC),  # KST 자정 직전
    datetime(2026, 9, 30, 15, 0, 0, tzinfo=UTC),  # KST 자정
    datetime(2026, 12, 31, 15, 5, 0, tzinfo=UTC),  # KST 새해
    datetime(2026, 10, 1, 3, 17, 0, tzinfo=UTC),
]


def _shapes(utc: datetime) -> list[datetime]:
    wall = (utc + timedelta(hours=9)).replace(tzinfo=None)
    return [wall, wall.replace(tzinfo=UTC), utc.astimezone(KST_TZ)]


@pytest.mark.parametrize("utc", INSTANTS, ids=lambda t: t.isoformat())
def test_the_kst_rules_read_only_the_wall_clock(utc):
    frames = [
        {"tm": (utc + timedelta(hours=9) - timedelta(minutes=m)).strftime("%Y%m%d%H%M"), "partial": True, "fetched_at": ""}
        for m in (5, 25, 35)
    ]
    answers = []
    for now_kst in _shapes(utc):
        tm = now_kst.strftime("%Y%m%d%H%M")
        answers.append(
            (
                tm,
                now_kst.strftime("%Y%m%d"),
                (now_kst.hour, now_kst.minute),
                (now_kst - timedelta(days=1)).strftime("%Y%m%d"),
                streak_probe_every_s("202609300000", now_kst, 300),
                select_refetch(frames, now_kst, utc),
                gap_expired((utc + timedelta(hours=9) - timedelta(hours=3, minutes=1)).strftime("%Y%m%d%H%M"), now_kst),
                gap_expired((utc + timedelta(hours=9) - timedelta(hours=2, minutes=59)).strftime("%Y%m%d%H%M"), now_kst),
                old_tm_cut(tm),
            )
        )
    assert answers[0] == answers[1] == answers[2]


@pytest.mark.parametrize("utc", INSTANTS, ids=lambda t: t.isoformat())
def test_kst_now_has_the_kst_wall_clock_fields(utc):
    got = kst_now(utc)
    wall = utc + timedelta(hours=9)
    assert (got.year, got.month, got.day, got.hour, got.minute, got.second) == (
        wall.year,
        wall.month,
        wall.day,
        wall.hour,
        wall.minute,
        wall.second,
    )
