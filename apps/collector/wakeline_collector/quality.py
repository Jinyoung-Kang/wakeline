"""품질 게이트(3.4절). 규칙에 걸린 레코드는 격리(스트림에 싣지 않음)하고 규칙별로 집계한다. 원천에는 남는다.

규칙: no_position · no_position_time · invalid_record(정규화 단계) · speed_gt_1200kt · alt_gt_60000ft · seen_in_future ·
stale_position · position_jump.
stale_position(COR-3): 공급자가 오래된 위치를 계속 돌려주면(OpenSky time_position 고정 등) 매 수집마다 같은 점을 '현재' 로
싣지 않는다. 기준은 api 의 판단보다 느슨하게 둔다 — 지도에서 오래된 아이콘(STALE)을 보여 줄 여지를 남기고,
api 는 자체 기준(관심 지역 60 s · OpenSky 300 s 판정, 전세계 600 s 제거)을 그대로 적용한다.
"""

from __future__ import annotations

from collections.abc import Iterable, Sequence
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

from wakeline_collector.geo import haversine_nm
from wakeline_collector.models import AircraftState

MAX_GS_KT = 1200.0
MAX_ALT_FT = 60000
MAX_JUMP_NM_PER_10S = 200.0
FUTURE_TOLERANCE_S = 30.0
# 위치 나이 상한(초). opensky = api SnapshotStore 의 전세계 제거 기준(600 s)과 같다.
MAX_POSITION_AGE_S: dict[str, float] = {"opensky": 600.0}
DEFAULT_MAX_POSITION_AGE_S = 300.0
LAST_SEEN_MAX = 50000


def max_position_age_s(provider: str) -> float:
    return MAX_POSITION_AGE_S.get(provider, DEFAULT_MAX_POSITION_AGE_S)


@dataclass
class Quarantine:
    rule: str
    hex: str | None
    detail: dict[str, Any]


@dataclass
class GateResult:
    kept: list[AircraftState] = field(default_factory=list)
    quarantined: list[Quarantine] = field(default_factory=list)


class AircraftGate:
    """직전 관측 위치를 기억해 '위치 점프' 를 판정한다(프로세스 메모리, 재시작 시 초기화)."""

    def __init__(self) -> None:
        self._last: dict[str, tuple[float, float, datetime]] = {}

    def apply(
        self,
        states: Sequence[AircraftState | None],
        missing_position: int,
        now: datetime,
        *,
        pre: Iterable[Quarantine] = (),
    ) -> GateResult:
        """missing_position = 위치 없는 레코드 수(구형 호출). pre = 정규화 단계에서 이미 격리한 사유."""
        res = GateResult()
        for _ in range(missing_position):
            res.quarantined.append(Quarantine("no_position", None, {}))
        res.quarantined.extend(pre)
        for s in states:
            if s is None:
                continue
            reason = self._check(s, now)
            if reason is None:
                res.kept.append(s)
                self._last[s.hex] = (s.lat, s.lon, s.seen_at)
            else:
                res.quarantined.append(reason)
        # 오래된 항목 정리 (10분 이상 미관측) — 메모리 상한
        if len(self._last) > LAST_SEEN_MAX:
            cutoff = now.timestamp() - 600
            self._last = {h: v for h, v in self._last.items() if v[2].timestamp() > cutoff}
        return res

    def _check(self, s: AircraftState, now: datetime) -> Quarantine | None:
        if s.gs_kt is not None and s.gs_kt > MAX_GS_KT:
            return Quarantine("speed_gt_1200kt", s.hex, {"gs_kt": s.gs_kt})
        if s.alt_ft is not None and s.alt_ft > MAX_ALT_FT:
            return Quarantine("alt_gt_60000ft", s.hex, {"alt_ft": s.alt_ft})
        age = (now - s.seen_at).total_seconds()
        if -age > FUTURE_TOLERANCE_S:
            return Quarantine("seen_in_future", s.hex, {"seen_at": s.seen_at.isoformat()})
        if age > max_position_age_s(s.provider):
            return Quarantine("stale_position", s.hex, {"age_s": round(age, 1), "provider": s.provider})
        prev = self._last.get(s.hex)
        if prev is not None:
            dt = (s.seen_at - prev[2]).total_seconds()
            if dt > 0:
                dist = haversine_nm(prev[0], prev[1], s.lat, s.lon)
                allowed = MAX_JUMP_NM_PER_10S * max(dt, 10.0) / 10.0
                if dist > allowed:
                    return Quarantine("position_jump", s.hex, {"nm": round(dist, 1), "dt_s": round(dt, 1)})
        return None
