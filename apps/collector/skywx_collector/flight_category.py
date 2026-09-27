"""비행 카테고리(10.5절, AWC GFA Help 기준).

VFR  : 실링 > 3,000 ft AGL 그리고 시정 > 5 mi
MVFR : 실링 1,000~3,000 ft 및/또는 시정 3~5 mi
IFR  : 실링 500~<1,000 ft 및/또는 시정 1~<3 mi
LIFR : 실링 < 500 ft 및/또는 시정 < 1 mi
실링과 시정 중 나쁜 쪽이 정한다. 실링이 없으면(SKC/CLR/FEW/SCT) 시정만으로 판단한다.
AWC 가 fltCat 을 주면 그 값을 쓰고, 없을 때만 이 계산값을 'computed' 출처로 저장한다.
"""

from __future__ import annotations

ORDER = {"VFR": 0, "MVFR": 1, "IFR": 2, "LIFR": 3}


def by_ceiling(ceiling_ft: int | None) -> str:
    if ceiling_ft is None or ceiling_ft > 3000:
        return "VFR"
    if ceiling_ft >= 1000:
        return "MVFR"
    if ceiling_ft >= 500:
        return "IFR"
    return "LIFR"


def by_visibility(vis_sm: float | None) -> str:
    if vis_sm is None or vis_sm > 5:
        return "VFR"
    if vis_sm >= 3:
        return "MVFR"
    if vis_sm >= 1:
        return "IFR"
    return "LIFR"


def flight_category(ceiling_ft: int | None, vis_sm: float | None) -> str:
    c, v = by_ceiling(ceiling_ft), by_visibility(vis_sm)
    return c if ORDER[c] >= ORDER[v] else v


def ceiling_from_clouds(clouds: list[dict] | None) -> int | None:
    """BKN/OVC/VV 중 가장 낮은 base(ft AGL). 없으면 None(실링 없음)."""
    if not clouds:
        return None
    bases = [
        c.get("base") for c in clouds if c.get("cover") in ("BKN", "OVC", "OVX", "VV") and isinstance(c.get("base"), int | float)
    ]
    return int(min(bases)) if bases else None


def parse_visibility_sm(v: object) -> float | None:
    """AWC visib: 숫자 또는 '6+', '10+' 같은 문자열. '+' 는 그 값 이상."""
    if v is None:
        return None
    if isinstance(v, int | float):
        return float(v)
    s = str(v).strip()
    if s.endswith("+"):
        s = s[:-1]
    try:
        return float(s)
    except ValueError:
        return None
