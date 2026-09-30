"""시험용 격자4단계 WFS bbox 응답 만들기(ADR-023 2026-10-01 bbox 개정) — 외부 호출 없이.

지물 하나의 모양은 실제 응답(fixtures/mof_grid4_wfs_GR4_F2K41_C3.xml — 2026-09-29) 그대로다: 같은 이름공간 · 같은 요소 · posList 소수 여덟 자리.
그래서 만든 지물 하나는 실제 지물과 같은 약 641 B 이고, 봉투(머리 · 꼬리)는 실제 봉투 그대로다.

`FakeGrid` 는 **가정한 서버**다(잰 것이 아니다): 칸은 0.025° 정사각형이 빈틈없이 깔려 있고(칸 번호는 무작위 이름 — 번호에서 위치를 읽지 않는다),
bbox 질의는 그 상자와 겹치는(EPSG:5179 에서 꼭짓점 범위가 닿는) 칸을 모두 준다. 확인한 것은 10 km 상자 28칸(18,635 B) · 50 km 상자
450칸(289,093 B)뿐이다 — 이 모형은 같은 두 상자에서 28칸(18,504 B) · 450칸(287,599 B)을 낸다(test_traffic_grid_tile_parse). 그 밖의 곳(육지 ·
먼바다)에도 칸이 깔려 있는지는 확인하지 않았다 — 모형의 가정이다.
"""

from __future__ import annotations

import math
import random
from pathlib import Path

from wakeline_collector.marine_grid import CELL_DEG, EXPECTED_SRS, wgs84_to_tm5179

FIX = Path(__file__).resolve().parents[3] / "fixtures" / "mof_grid4_wfs_GR4_F2K41_C3.xml"
_TEXT = FIX.read_text()
_A = _TEXT.index("<ofbd-DB:opn_grid_4_step_a")
_B = _TEXT.index("</ofbd-DB:opn_grid_4_step_a>") + len("</ofbd-DB:opn_grid_4_step_a>")
HEAD, TAIL = _TEXT[:_A], _TEXT[_B:]
assert 'numberOfFeatures="1"' in HEAD


def ring(lat: float, lon: float) -> list[tuple[float, float]]:
    """칸 (lat, lon)(남서 모서리)의 외곽선 — 실제 응답과 같은 순서(북서 → 북동 → 남동 → 남서 → 북서), EPSG:5179 동거 · 북거."""
    la1, lo1 = lat + CELL_DEG, lon + CELL_DEG
    pts = [wgs84_to_tm5179(la1, lon), wgs84_to_tm5179(la1, lo1), wgs84_to_tm5179(lat, lo1), wgs84_to_tm5179(lat, lon)]
    return [*pts, pts[0]]


def feature(
    grid_no: str, lat: float, lon: float, gid: int, *, pts: list[tuple[float, float]] | None = None, srs: str = EXPECTED_SRS
) -> str:
    pos = " ".join(f"{x:.8f} {y:.8f}" for x, y in (pts if pts is not None else ring(lat, lon)))
    return (
        f'<ofbd-DB:opn_grid_4_step_a gml:id="opn_grid_4_step_a.{gid}"><ofbd-DB:gid>{gid}</ofbd-DB:gid>'
        f"<ofbd-DB:grid_no>{grid_no}</ofbd-DB:grid_no><ofbd-DB:geom>"
        f'<gml:MultiSurface srsName="{srs}" srsDimension="2"><gml:surfaceMember><gml:Polygon gml:id="null.1"><gml:exterior>'
        f"<gml:LinearRing><gml:posList>{pos}</gml:posList></gml:LinearRing></gml:exterior></gml:Polygon></gml:surfaceMember>"
        "</gml:MultiSurface></ofbd-DB:geom></ofbd-DB:opn_grid_4_step_a>"
    )


def collection(features: list[str], declared: int | None = None) -> bytes:
    n = len(features) if declared is None else declared
    return (HEAD.replace('numberOfFeatures="1"', f'numberOfFeatures="{n}"') + "".join(features) + TAIL).encode()


def extent(lat: float, lon: float) -> tuple[float, float, float, float]:
    pts = ring(lat, lon)[:4]
    return min(p[0] for p in pts), min(p[1] for p in pts), max(p[0] for p in pts), max(p[1] for p in pts)


class FakeGrid:
    """가정한 격자 서버 — 칸마다 무작위 이름(번호 체계를 흉내 내지 않는다)과 gid. bbox 는 상자와 겹치는 칸을 모두(가정)."""

    def __init__(self, seed: int = 7) -> None:
        self.rng = random.Random(seed)
        self.ids: dict[tuple[int, int], str] = {}
        self.where: dict[str, tuple[float, float]] = {}
        self.gids: dict[str, int] = {}

    def cell_id(self, i: int, j: int) -> str:
        """격자점 (i, j) = (위도 i × 0.025°, 경도 j × 0.025°) 칸의 이름(처음 물을 때 정한다)."""
        g = self.ids.get((i, j))
        if g is None:
            g = f"GR4_{self.rng.getrandbits(40):010X}"
            self.ids[(i, j)] = g
            self.where[g] = (round(i * CELL_DEG, 3), round(j * CELL_DEG, 3))
            self.gids[g] = len(self.gids) + 1
        return g

    def cells_in(self, box: tuple[float, float, float, float]) -> list[str]:
        x0, y0, x1, y1 = box
        corners = _box_latlon(box)
        lat_lo = min(c[0] for c in corners) - CELL_DEG
        lat_hi = max(c[0] for c in corners) + CELL_DEG
        lon_lo = min(c[1] for c in corners) - CELL_DEG
        lon_hi = max(c[1] for c in corners) + CELL_DEG
        out = []
        for i in range(math.floor(lat_lo / CELL_DEG), math.ceil(lat_hi / CELL_DEG) + 1):
            for j in range(math.floor(lon_lo / CELL_DEG), math.ceil(lon_hi / CELL_DEG) + 1):
                ex = extent(i * CELL_DEG, j * CELL_DEG)
                if ex[0] <= x1 and ex[2] >= x0 and ex[1] <= y1 and ex[3] >= y0:
                    out.append(self.cell_id(i, j))
        return out

    def body(self, box: tuple[float, float, float, float], max_features: int = 1000) -> bytes:
        ids = self.cells_in(box)[:max_features]
        return collection([feature(g, *self.where[g], self.gids[g]) for g in ids])


def _box_latlon(box: tuple[float, float, float, float]) -> list[tuple[float, float]]:
    from wakeline_collector.marine_grid import tm5179_to_wgs84

    x0, y0, x1, y1 = box
    return [tm5179_to_wgs84(x, y) for x, y in ((x0, y0), (x0, y1), (x1, y0), (x1, y1))]
