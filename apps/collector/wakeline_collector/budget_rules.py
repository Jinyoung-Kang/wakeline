"""예산 계산 중 Redis 를 건드리지 않는 것 — 순수 규칙. budget(Redis 어댑터)이 같은 이름으로 다시 내보낸다(작업 · 시험의 옛 import 경로).
다시 부르기 정책(retry)과 다시 받기 규칙(kma_rules)은 어댑터를 import 하지 않고 여기서 읽는다.
"""

from __future__ import annotations

from collections.abc import Iterable
from datetime import UTC, datetime, timedelta

UNKNOWN = -1  # 예약 결과의 사용량을 알 수 없음(Redis 장애)


def regular_headroom(schedule: Iterable[tuple[float, int]], now: datetime) -> int:
    """정규 주기가 예산 날(UTC — day_key)이 끝날 때까지 더 쓸 수 있는 최대 호출 수: Σ (남은 초 // 주기 + 1) × 주기당 호출 수.
    schedule = (주기 초, 주기당 호출 수) 목록 — 지금 주기 설정으로 계산한 상한이다(잰 값이 아니다). run_periodic 은 주기가 끝난 뒤
    주기만큼 쉬므로 남은 주기는 남은 초 // 주기 + 1(지금 돌거나 곧 시작할 주기 하나) 이하다. 우선순위가 낮은 추가 호출(기상 작업의 다시
    부르기 · KMA 부분 합성 다시 받기)은 이 값을 headroom 으로 예약한다 — 사용량 + 1 ≤ 한도 − 이 값일 때만 부르므로 정규 주기가 예산 소진으로
    막히지 않는다."""
    now = now.astimezone(UTC)
    left = ((now + timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0) - now).total_seconds()
    return sum((int(left // period) + 1) * calls for period, calls in schedule)
