"""비행 카테고리(10.5절, AWC GFA Help 기준)와 실링 상태(계약 §5).

VFR  : 실링 > 3,000 ft AGL 그리고 시정 > 5 mi
MVFR : 실링 1,000~3,000 ft 및/또는 시정 3~5 mi
IFR  : 실링 500~<1,000 ft 및/또는 시정 1~<3 mi
LIFR : 실링 < 500 ft 및/또는 시정 < 1 mi
실링과 시정 중 나쁜 쪽이 정한다. 실링층이 없으면(SKC/CLR/FEW/SCT) 시정만으로 판단한다.

실링 상태(ceiling_state):
- "measured": BKN/OVC/OVX/VV 층이 있고 모든 실링층의 높이가 숫자로 주어짐 → ceiling_ft = 가장 낮은 높이
- "none"    : 구름 자료가 있으나 실링층이 없음(FEW/SCT 뿐), 또는 CLR/SKC/NSC/NCD/CAVOK
- "unknown" : 구름 자료 없음, 높이 없는 실링층(BKN/// 등), 해석할 수 없는 운량
AWC 가 fltCat 을 주면 그 값을 쓰고('awc'), 없을 때만 시정을 알고 실링 상태가 unknown 이 아닐 때 계산한다('computed').
그 밖에는 NULL — 모르는 값을 VFR 로 채우지 않는다.
"""

from __future__ import annotations

import math

ORDER = {"VFR": 0, "MVFR": 1, "IFR": 2, "LIFR": 3}
CEILING_COVERS = frozenset({"BKN", "OVC", "OVX", "VV"})
NON_CEILING_COVERS = frozenset({"FEW", "SCT"})
CLEAR_COVERS = frozenset({"CLR", "SKC", "NSC", "NCD", "CAVOK"})


def by_ceiling(ceiling_ft: int | None) -> str:
    """ceiling_ft None = 실링층 없음(ceiling_state 'none')일 때만 부른다."""
    if ceiling_ft is None or ceiling_ft > 3000:
        return "VFR"
    if ceiling_ft >= 1000:
        return "MVFR"
    if ceiling_ft >= 500:
        return "IFR"
    return "LIFR"


def by_visibility(vis_sm: float) -> str:
    if vis_sm > 5:
        return "VFR"
    if vis_sm >= 3:
        return "MVFR"
    if vis_sm >= 1:
        return "IFR"
    return "LIFR"


def flight_category(ceiling_ft: int | None, vis_sm: float | None, ceiling_state: str) -> str | None:
    """입력이 모두 알려졌을 때만 계산한다. 시정 미상 또는 실링 상태 unknown 이면 None."""
    if vis_sm is None or ceiling_state not in ("measured", "none"):
        return None
    if ceiling_state == "measured" and ceiling_ft is None:
        return None
    c, v = by_ceiling(ceiling_ft if ceiling_state == "measured" else None), by_visibility(vis_sm)
    return c if ORDER[c] >= ORDER[v] else v


def _base(layer: dict) -> int | None:
    b = layer.get("base")
    return int(b) if isinstance(b, int | float) and not isinstance(b, bool) and b >= 0 else None


def assess_ceiling(clouds: list[dict] | None, cover: str | None = None) -> tuple[int | None, str]:
    """(ceiling_ft, ceiling_state). clouds = AWC 층 목록, cover = AWC 요약 운량(층 목록이 비었을 때 CLR 등)."""
    layers = [c for c in clouds if isinstance(c, dict)] if isinstance(clouds, list) else []
    if not layers:
        if isinstance(cover, str) and cover.strip().upper() in CLEAR_COVERS:
            return None, "none"
        return None, "unknown"
    bases: list[int] = []
    for layer in layers:
        cv = str(layer.get("cover") or "").strip().upper()
        if cv in CEILING_COVERS:
            b = _base(layer)
            if b is None:
                return None, "unknown"  # 실링층 높이 미상(BKN/// 등) — 실링을 '없음' 으로 단정하지 않는다
            bases.append(b)
        elif cv in NON_CEILING_COVERS or cv in CLEAR_COVERS:
            continue
        else:
            return None, "unknown"  # 운량 미상(/// 등)
    if bases:
        return min(bases), "measured"
    return None, "none"


def ceiling_from_clouds(clouds: list[dict] | None, cover: str | None = None) -> int | None:
    """측정된 실링(ft AGL). 없음·미상은 None — 구분이 필요하면 assess_ceiling 을 쓴다."""
    return assess_ceiling(clouds, cover)[0]


def parse_visibility_sm(v: object) -> float | None:
    """AWC visib: 숫자 또는 '6+', '10+' 같은 문자열. '+' 는 그 값 이상."""
    if v is None or isinstance(v, bool):
        return None
    if isinstance(v, int | float):
        f = float(v)
    else:
        s = str(v).strip()
        if s.endswith("+"):
            s = s[:-1]
        try:
            f = float(s)
        except ValueError:
            return None
    return f if math.isfinite(f) and f >= 0 else None
