"""kma_rules 의 주기 끝 판정 — 순수 함수 표 시험(PLAN 3B-4 뒤). 작업을 거친 시험(test_kma_*)이 같은 규칙을 시나리오로 고정한다.

- cycle_status: 실행 기록 하나(상태 · 오류 글자 · http 상태)와 공급자 성공.
- streak_needs_prev_day · behind_prev_day · list_idle: test_kma_prev_day_rules 의 표를 작업 없이 순수 함수에 겨눈다.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from wakeline_collector.kma_rules import (
    CycleStatus,
    ListIdle,
    MissingStreak,
    behind_prev_day,
    cycle_status,
    list_idle,
    streak_needs_prev_day,
)

NOW = datetime(2026, 10, 1, 0, 30, tzinfo=UTC)  # 09:30 KST
IDLE = ListIdle(tm="202610010900", newest="202610010900", days=("20261001",), latest="202610010900", age_s=1800.0)
BAD = [("kma_radar_parse", None, {"tm": "202610010905", "error": "bad"})]
STOP_429 = ("binary tm=202610010905 — HTTP 429 · paused 30 s", 429)


@pytest.mark.parametrize(
    ("args", "kw", "want"),
    [
        ((1, 0, [], ""), {}, CycleStatus("ok", None, 200, True)),  # 저장했다
        ((0, 0, [], ""), {}, CycleStatus("ok", None, 200, True)),  # 새로 받을 tm 이 없다
        (
            (0, 1, [], "tm=x not available yet"),
            {},
            CycleStatus("missing", "no new frame stored — tm=x not available yet", 200, False),
        ),
        (
            (0, 0, BAD, ""),
            {},
            CycleStatus("quarantined", "no new frame stored — could not read tm=202610010905 kma_radar_parse: bad", 200, False),
        ),
        (
            (0, 0, [], "nothing to probe"),
            {"list_only": True},
            CycleStatus("missing", "no new frame stored — nothing to probe", 200, False),
        ),
        (
            (0, 1, [], "tm=x"),
            {"budget_stop": ("budget_exhausted", "daily budget exhausted (used=1000)")},
            CycleStatus("budget_exhausted", "daily budget exhausted (used=1000) — tm=x", 200, False),
        ),
        ((1, 0, [], ""), {"budget_stop": ("budget_exhausted", "daily budget exhausted")}, CycleStatus("ok", None, 200, True)),
        ((0, 0, [], ""), {"idle": IDLE}, CycleStatus("missing", f"no new frame stored — {IDLE.text()}", 200, False)),
        ((1, 0, [], ""), {"idle": IDLE}, CycleStatus("ok", None, 200, True)),  # 멈춘 동안 빈 곳을 채웠다 — 'ok'
        # 정규 부분이 429 로 멈췄다 — 주기의 답은 'throttled', 공급자 성공이 아니다
        ((0, 0, [], ""), {"stop": STOP_429, "regular_stopped": True}, CycleStatus("throttled", STOP_429[0], 429, False)),
        (
            (0, 1, [], "tm=x"),
            {"stop": STOP_429, "regular_stopped": True},
            CycleStatus("throttled", f"{STOP_429[0]} · missing: no new frame stored — tm=x", 429, False),
        ),
        # 다시 받기의 429: 정규 부분이 'ok' 면 'throttled' 이되 공급자 성공, 아니면 정규 부분의 상태에 덧붙인다
        ((0, 0, [], ""), {"stop": STOP_429}, CycleStatus("throttled", STOP_429[0], 429, True)),
        (
            (0, 1, [], "tm=x"),
            {"stop": STOP_429},
            CycleStatus("missing", f"no new frame stored — tm=x · {STOP_429[0]}", 200, False),
        ),
    ],
)
def test_cycle_status(args, kw, want):
    base = {"list_only": False, "budget_stop": None, "idle": None, "http_status": 200}
    assert cycle_status(*args, **(base | kw)) == want


def _streak(last_tm: str) -> MissingStreak:
    return MissingStreak(since_tm=last_tm, last_tm=last_tm, tms=1, checked_at=NOW, warned_at=NOW)


@pytest.mark.parametrize(
    ("last_tm", "today", "needed"),
    [(None, [], False), ("202609301950", [], True), ("202609301950", ["202610010020"], False), ("202610010005", [], False)],
)
def test_streak_needs_prev_day_is_pure(last_tm, today, needed):
    missing = _streak(last_tm) if last_tm else None
    assert streak_needs_prev_day(missing, "20261001", "202610010020", today) is needed


@pytest.mark.parametrize(("reached", "behind"), [("", True), ("202609302350", True), ("202609302355", False)])
def test_behind_prev_day_is_pure(reached, behind):
    assert behind_prev_day("20261001", "202610010020", [], reached) is behind


@pytest.mark.parametrize(
    ("kw", "idle"),
    [
        ({}, ("202610010900", "202610010900")),
        ({"missing": _streak("202610010850")}, None),
        ({"listing": ["202610010905"]}, None),
        ({"age_s": 900}, None),
        ({"old_seen": "202610010910", "listing": ["202610010910"]}, ("202610010910", "202610010910")),
    ],
)
def test_list_idle_is_pure(kw, idle):
    age_s = kw.get("age_s", 1800)
    got = list_idle(
        kw.get("listing", ["202610010855", "202610010900"]),
        "202610010930",
        "202610010900",
        NOW - timedelta(seconds=age_s),
        NOW,
        missing=kw.get("missing"),
        old_seen=kw.get("old_seen", ""),
        days=("20261001",),
    )
    want = None if idle is None else ListIdle(idle[0], idle[1], ("20261001",), "202610010900", float(age_s))
    assert got == want
