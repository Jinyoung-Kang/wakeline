"""품질 게이트(3.4절). 규칙에 걸린 레코드는 격리(스트림에 싣지 않음)하고 규칙별로 집계한다. 원천에는 남는다."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime

from wakeline_collector.geo import haversine_nm
from wakeline_collector.models import AircraftState

MAX_GS_KT = 1200.0
MAX_ALT_FT = 60000
MAX_JUMP_NM_PER_10S = 200.0
FUTURE_TOLERANCE_S = 30.0


@dataclass
class Quarantine:
    rule: str
    hex: str | None
    detail: dict


@dataclass
class GateResult:
    kept: list[AircraftState] = field(default_factory=list)
    quarantined: list[Quarantine] = field(default_factory=list)


class AircraftGate:
    """직전 관측 위치를 기억해 '위치 점프' 를 판정한다(프로세스 메모리, 재시작 시 초기화)."""

    def __init__(self) -> None:
        self._last: dict[str, tuple[float, float, datetime]] = {}

    def apply(self, states: list[AircraftState | None], missing_position: int, now: datetime) -> GateResult:
        res = GateResult()
        for _ in range(missing_position):
            res.quarantined.append(Quarantine("no_position", None, {}))
        for s in states:
            if s is None:
                continue
            reason = self._check(s, now)
            if reason is None:
                res.kept.append(s)
                self._last[s.hex] = (s.lat, s.lon, s.seen_at)
            else:
                res.quarantined.append(reason)
        # 오래된 항목 정리 (10분 이상 미관측)
        if len(self._last) > 50000:
            cutoff = now.timestamp() - 600
            self._last = {h: v for h, v in self._last.items() if v[2].timestamp() > cutoff}
        return res

    def _check(self, s: AircraftState, now: datetime) -> Quarantine | None:
        if s.gs_kt is not None and s.gs_kt > MAX_GS_KT:
            return Quarantine("speed_gt_1200kt", s.hex, {"gs_kt": s.gs_kt})
        if s.alt_ft is not None and s.alt_ft > MAX_ALT_FT:
            return Quarantine("alt_gt_60000ft", s.hex, {"alt_ft": s.alt_ft})
        if (s.seen_at - now).total_seconds() > FUTURE_TOLERANCE_S:
            return Quarantine("seen_in_future", s.hex, {"seen_at": s.seen_at.isoformat()})
        prev = self._last.get(s.hex)
        if prev is not None:
            dt = (s.seen_at - prev[2]).total_seconds()
            if dt > 0:
                dist = haversine_nm(prev[0], prev[1], s.lat, s.lon)
                allowed = MAX_JUMP_NM_PER_10S * max(dt, 10.0) / 10.0
                if dist > allowed:
                    return Quarantine("position_jump", s.hex, {"nm": round(dist, 1), "dt_s": round(dt, 1)})
        return None
