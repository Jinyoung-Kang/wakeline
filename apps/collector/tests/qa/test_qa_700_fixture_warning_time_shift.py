"""QA-700(출시 QA 2차 · 기능 · fixture 모드): FixtureKmaWarningProvider 가 실제 응답(2026-10-09)의 시각을 지금으로 옮길 때 `replace` 를 두 번 잇는다 —
먼저 발표 시각 202610091600 → 이번 시(KST), 다음에 예비 때의 날짜 20261010 → 내일. 이번 시가 2026-10-10 이면 두 번째 치환이 방금 넣은 발표 시각의 날짜까지 바꿔
발표가 하루 미래(내일)가 된다. 2026-10-10 KST 하루 동안 기존 시험 test_the_fixture_provider_moves_the_times_to_now 가 실패했다(회귀 · CI 빨강) —
make demo · E2E 의 특보 화면도 그날 '발표 내일'로 보인다. 시계를 2026-10-10 12:00 KST 로 고정해 날짜와 상관없이 재현한다.
"""

from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path

import pytest

from wakeline_collector import kma_warning_rules
from wakeline_collector.providers import fixture as fx

FX = Path(__file__).resolve().parents[1] / "fixtures" / "kma_warning"


class _FrozenDatetime(datetime):
    """fixture 모듈 안의 datetime.now 만 2026-10-10 12:30 KST 로(다른 메서드는 그대로)."""

    @classmethod
    def now(cls, tz=None):  # type: ignore[override]
        fixed = datetime(2026, 10, 10, 3, 30, tzinfo=UTC)  # = 12:30 KST
        return fixed.astimezone(tz) if tz else fixed.replace(tzinfo=None)


@pytest.mark.parametrize("day", ["2026-10-10"])
async def test_issued_time_stays_this_hour_when_today_is_the_fixture_slot_day(monkeypatch, tmp_path, day) -> None:
    (tmp_path / "kma_wrn_now_data.txt").write_bytes((FX / "wrn_now_data_preliminary.txt").read_bytes())
    monkeypatch.setattr(fx.settings, "fixtures_dir", str(tmp_path))
    monkeypatch.setattr(fx, "datetime", _FrozenDatetime)
    res = await fx.FixtureKmaWarningProvider().current()
    ws = res.data.warnings
    assert len(ws) == 3
    # 발표 = 이번 시(12:00 KST = 03:00 UTC) — 하루 미래(2026-10-11)가 아니다
    assert {w["issued_at"] for w in ws} == {"2026-10-10T03:00:00Z"}, day
    # 예비 때는 내일(2026-10-11 KST) 오후
    assert {w["effective_text"] for w in ws} == {"10-11 오후(12–18시 KST)"}
    assert all(kma_warning_rules.iso(datetime(2026, 10, 11, 3, tzinfo=UTC)) == w["effective_from"] for w in ws)
