"""한국 표준시(KST) — 수집기의 하나뿐인 정의(collector-review F8: 전에는 providers/kma_radar · portcalls · traffic_grid 에 셋이었다). 순수 규칙.

KST 는 UTC+9 고정이다(일광 절약 시간 없음). kst_now() 는 시간대가 붙은(+09:00) 시각을 돌려준다 — 전에는 KST 벽시계에 UTC 표시를 붙여 돌려줘
.timestamp() · .isoformat() · UTC 시각과의 뺄셈이 오류 없이 9 h 어긋났다(그렇게 쓰는 곳은 없었다 — 모두 벽시계 필드만 읽는다: tests/test_kst_clock.py).
기상청 tm(YYYYMMDDHHMM)은 시간대 없는 KST 벽시계다 — kst_wall_to_utc 로 같은 순간의 UTC 를 얻는다.
"""

from __future__ import annotations

from datetime import UTC, date, datetime, timedelta, timezone

KST = timezone(timedelta(hours=9))


def kst_now(now_utc: datetime | None = None) -> datetime:
    """지금(또는 now_utc 의 순간)의 KST 시각 — 시간대가 붙은(+09:00) datetime. 벽시계 필드(연 · 월 · 일 · 시 · 분)는 UTC + 9 h 의 것이다."""
    return (now_utc or datetime.now(UTC)).astimezone(KST)


def kst_date(at: datetime) -> date:
    """이 순간의 KST 날짜(UTC+9 고정)."""
    return at.astimezone(KST).date()


def kst_wall_to_utc(wall: datetime) -> datetime:
    """KST 벽시계(시간대 없는 datetime — 기상청 tm 등) → 같은 순간의 UTC 시각."""
    return wall.replace(tzinfo=KST).astimezone(UTC)
