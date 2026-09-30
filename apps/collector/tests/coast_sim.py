"""합성 연안 교통 분포(시뮬레이션 — 잰 값이 아니다) — ADR-023 2026-10-01 bbox 개정의 타일 수 · 시간 계산과 채우기 모형 시험에 쓴다.

해안선은 한반도 해안의 대략적인 점 몇 개(아래 WAYPOINTS — 위치를 손으로 찍은 근사, 실제 해안선 자료가 아니다)를 이은 꺾은선이고, 배가 들어설 수
있는 칸은 그 꺾은선에서 BAND_KM 안의 0.025° 칸, 칸의 무게는 해안에서 멀수록 줄고(exp(−d/SCALE_KM)) 항로 몇 개(LANES) 근처에서 는다. 칸 번호는
무작위 이름이다(번호에서 위치를 읽지 않는다). 모든 수는 이 가정에서 나온 것이다 — 운영의 칸 분포를 잰 것이 아니다.
"""

from __future__ import annotations

import math
import random

from wakeline_collector.marine_grid import CELL_DEG

# (위도, 경도) — 서해(북 → 남) · 남해(서 → 동) · 동해(남 → 북)를 잇는 근사 점. 제주는 따로 고리
WAYPOINTS = [
    (37.75, 126.15), (37.45, 126.45), (37.00, 126.50), (36.75, 126.15), (36.35, 126.50), (35.98, 126.55), (35.50, 126.40),
    (35.00, 126.25), (34.75, 126.30), (34.35, 126.55), (34.30, 126.90), (34.50, 127.40), (34.72, 127.75), (34.85, 128.30),
    (35.05, 128.75), (35.08, 129.05), (35.50, 129.40), (36.00, 129.45), (36.50, 129.43), (37.00, 129.40), (37.50, 129.12),
    (37.80, 128.95), (38.20, 128.60), (38.55, 128.40),
]  # fmt: skip
JEJU = (33.37, 126.55, 0.30, 0.40)  # 중심 위도 · 경도 · 반지름(위도 · 경도 °)
LANES = [
    ((35.08, 129.05), (33.52, 126.53)),
    ((34.75, 126.30), (33.52, 126.53)),
    ((37.45, 126.45), (37.20, 124.60)),
    ((35.08, 129.05), (34.60, 129.60)),
]
BAND_KM = 40.0
SCALE_KM = 8.0
KM_LAT = 111.0


def _seg_km(p: tuple[float, float], a: tuple[float, float], b: tuple[float, float]) -> float:
    """점 p 와 선분 ab 사이 거리(km, 국지 평면 근사)."""
    k = math.cos(math.radians(p[0]))
    ax, ay, bx, by, px, py = a[1] * k, a[0], b[1] * k, b[0], p[1] * k, p[0]
    dx, dy = bx - ax, by - ay
    t = 0.0 if dx == dy == 0 else max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
    return math.hypot(px - (ax + t * dx), py - (ay + t * dy)) * KM_LAT


def _coast_km(p: tuple[float, float]) -> float:
    d = min(_seg_km(p, a, b) for a, b in zip(WAYPOINTS, WAYPOINTS[1:], strict=False))
    lat0, lon0, rlat, rlon = JEJU
    ring = abs(math.hypot((p[0] - lat0) / rlat, (p[1] - lon0) / rlon) - 1.0) * rlat * KM_LAT
    return min(d, ring)


class Coast:
    """배가 들어설 수 있는 칸(무게 있음)의 합성 모음. cells[(i, j)] = 무게 — (i, j) = 격자점(위도 i × 0.025°, 경도 j × 0.025°)."""

    def __init__(self, seed: int = 3, band_km: float = BAND_KM, step: int = 1) -> None:
        self.rng = random.Random(seed)
        self.cells: dict[tuple[int, int], float] = {}
        for i in range(round(33.0 / CELL_DEG), round(38.8 / CELL_DEG), step):
            for j in range(round(124.4 / CELL_DEG), round(130.0 / CELL_DEG), step):
                p = ((i + 0.5) * CELL_DEG, (j + 0.5) * CELL_DEG)
                d = _coast_km(p)
                lane = min(_seg_km(p, a, b) for a, b in LANES)
                if d <= band_km or lane <= 6.0:
                    self.cells[(i, j)] = math.exp(-d / SCALE_KM) + 0.6 * math.exp(-lane / 3.0)

    def sample(self, n: int) -> list[tuple[int, int]]:
        """무게에 비례해 서로 다른 칸 n 개(Efraimidis–Spirakis)."""
        keyed = sorted(((self.rng.random() ** (1.0 / w), c) for c, w in self.cells.items() if w > 0), reverse=True)
        return [c for _k, c in keyed[:n]]
