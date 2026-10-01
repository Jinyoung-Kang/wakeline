"""기상청 레이더 작업의 판정 셋 — 표 시험으로 지금 동작을 고정한다(PLAN Phase 0 · collector-review §2.4: 3B-4 kma_rules 로 옮기기 전).

- _streak_needs_prev_day: '파일 없음' 연속의 확인에 전날 목록이 필요한가.
- _behind_prev_day: 연속이 없어도 전날 목록을 읽어야 하는가(새 날 목록이 비었고 받은 가장 새 tm 이 전날 끝 23:55 에 닿지 않았다).
- _list_idle: 연속 밖의 목록 멈춤(LIST_IDLE_AFTER_S 넘게 목록이 받은 가장 새 tm 뒤로 새 tm 을 싣지 않는다).
tm 은 기상청 KST 벽시계(YYYYMMDDHHMM), 시각은 UTC. 작업을 거쳐 부른다(지금은 작업의 메서드다 — 옮기면 이 표를 순수 함수에 겨눈다).
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

import pytest
from fakes import FakeRedis, make_ctx

from wakeline_collector.jobs import kma_radar as mod
from wakeline_collector.jobs.kma_radar import KmaRadarJob, MissingStreak, _ListIdle

NOW = datetime(2026, 10, 1, 0, 30, tzinfo=UTC)  # 09:30 KST


def _job(last_tm: str | None = None, old_seen: str = "") -> KmaRadarJob:
    job = KmaRadarJob(SimpleNamespace(name="kma_radar", configured=True), make_ctx(FakeRedis()))  # type: ignore[arg-type]
    if last_tm is not None:
        job.missing = MissingStreak(since_tm=last_tm, last_tm=last_tm, tms=1, checked_at=NOW, warned_at=NOW)
    job._old_seen = old_seen
    return job


@pytest.mark.parametrize(
    ("last_tm", "day", "now_tm", "today", "needed"),
    [
        (None, "20261001", "202610010020", [], False),  # 연속이 없다
        ("202609301950", "20261001", "202610010020", [], True),  # 마지막 tm 이 전날 · 새 날 목록이 비었다
        ("202609291950", "20261001", "202610010020", [], True),  # 그저께도 같다(날짜 비교)
        ("202609301950", "20261001", "202610010020", ["202610010000"], False),  # 새 날 목록에 그 시각 이하의 tm 이 있다
        ("202609301950", "20261001", "202610010020", ["202610010020"], False),  # 같은 시각도 '이하'
        ("202609301950", "20261001", "202610010020", ["202610010025"], True),  # 시각 뒤의 tm 만 — 아직 싣지 않은 것과 같다
        ("202610010005", "20261001", "202610010020", [], False),  # 마지막 tm 이 오늘이다
    ],
)
def test_streak_needs_prev_day(last_tm, day, now_tm, today, needed):
    assert _job(last_tm)._streak_needs_prev_day(day, now_tm, today) is needed


@pytest.mark.parametrize(
    ("day", "end"),
    [("20261001", "202609302355"), ("20260101", "202512312355"), ("20240301", "202402292355"), ("20250301", "202502282355")],
)
def test_prev_end_is_the_last_five_minute_tm_of_the_previous_kst_day(day, end):
    assert KmaRadarJob._prev_end(day) == end


@pytest.mark.parametrize(
    ("today", "reached", "behind"),
    [
        ([], "", True),  # 받은 것이 없다
        ([], "202609301950", True),  # 전날 끝에 닿지 않았다
        ([], "202609302350", True),
        ([], "202609302355", False),  # 전날 끝까지 받았다 — 새로 받을 것이 없다
        ([], "202610010005", False),  # 오늘 tm 까지 받았다
        (["202610010000"], "", False),  # 새 날 목록이 답했다(그 시각 이하)
        (["202610010025"], "202609301950", True),  # 시각 뒤의 tm 만 — 빈 목록과 같다
    ],
)
def test_behind_prev_day(today, reached, behind):
    assert KmaRadarJob._behind_prev_day("20261001", "202610010020", today, reached) is behind


LATEST = "202610010900"  # 저장한 가장 새 tm(meta latest_tm)
NOW_TM = "202610010930"  # 지금(KST 벽시계 — NOW 와 같은 순간)


@pytest.mark.parametrize(
    ("case", "kw", "idle"),
    [
        ("streak open", {"last_tm": "202610010850"}, None),
        ("nothing stored", {"latest": ""}, None),
        ("no fetched_at", {"fetched": None}, None),
        ("listing grew", {"listing": ["202610010900", "202610010905"]}, None),
        ("only future tms after latest", {"listing": ["202610010900", "202610010935"]}, ("202610010900", "202610010900")),
        ("empty listing", {"listing": []}, ("202610010900", "")),
        ("exactly the idle limit", {"age_s": 900}, None),
        ("just past the idle limit", {"age_s": 901}, ("202610010900", "202610010900")),
        ("clock skew (fetched in the future)", {"age_s": -60}, None),
        # 보관(3 h)보다 오래돼 저장하지 않은 tm 의 파일을 받아 보았다 — 그것이 기준이다(그 뒤로 새 tm 이 없으면 멈춤)
        (
            "old tm seen beyond latest",
            {"old_seen": "202610010910", "listing": ["202610010905", "202610010910"]},
            ("202610010910", "202610010910"),
        ),
        ("old tm seen, listing grew past it", {"old_seen": "202610010910", "listing": ["202610010915"]}, None),
    ],
    ids=lambda v: v if isinstance(v, str) else "",
)
def test_list_idle(monkeypatch, case, kw, idle):
    monkeypatch.setattr(mod, "_now", lambda: NOW)
    age_s = kw.get("age_s", 1800)
    fetched = kw.get("fetched", NOW - timedelta(seconds=age_s))
    job = _job(kw.get("last_tm"), kw.get("old_seen", ""))
    job._list_days = ("20261001",)
    listing = kw.get("listing", ["202610010855", "202610010900"])
    got = job._list_idle(listing, NOW_TM, kw.get("latest", LATEST), fetched)
    if idle is None:
        assert got is None
    else:
        assert got == _ListIdle(tm=idle[0], newest=idle[1], days=("20261001",), latest=LATEST, age_s=float(age_s))
