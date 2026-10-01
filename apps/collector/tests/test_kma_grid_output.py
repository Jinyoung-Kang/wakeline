"""kma_grid.render_mercator_png 의 출력(PNG 바이트 · 에코 셀 수 · 관측 셀 수)을 고정한다 — 임계값을 실수에서 정수로 바꾸기 전(collector-review F9 ·
PLAN Phase 4-2). 실제 헤더(fixtures/kma_rdr_cmp_head.bin — 2305 × 2881)에 합성 격자를 싣는다: 관측 반경 밖 · 안(비관측 · 에코 없음)과, 에코 칸에는
무작위 값과 함께 모든 경계값(min_dbz 와 색 구간마다 ×100 의 −1 · 0 · +1)과 int16 의 양 끝을 넣는다. 같은 입력이면 PNG 는 바이트까지 같아야 한다
(Pillow 는 uv.lock 으로 고정)."""

from __future__ import annotations

import hashlib
from pathlib import Path

import numpy as np
import pytest

from wakeline_collector.kma_grid import DBZ_STOPS, DISPLAY_MIN, NULL_OUTSIDE, NULL_UNOBSERVED, parse_header, render_mercator_png

FIX = Path(__file__).resolve().parents[3] / "fixtures" / "kma_rdr_cmp_head.bin"


def edge_values(min_dbz: float = 5.0) -> list[int]:
    """임계값 바로 아래 · 위 · 그 값(×100) — 색 구간 · min_dbz — 과 특수값 · int16 양 끝."""
    out = {-32768, 32767, NULL_OUTSIDE, NULL_UNOBSERVED, DISPLAY_MIN, DISPLAY_MIN + 1, 0}
    for lo in [min_dbz, *(lo for lo, _c in DBZ_STOPS)]:
        c = int(round(lo * 100))
        out |= {c - 1, c, c + 1}
    return sorted(out)


def synthetic_grid(seed: int) -> np.ndarray:
    h = parse_header(FIX.read_bytes())
    rnd = np.random.default_rng(seed)
    grid = np.full((h.ny, h.nx), NULL_OUTSIDE, dtype="<i2")
    yy, xx = np.mgrid[0 : h.ny, 0 : h.nx]
    inside = (yy - 1681) ** 2 + (xx - 1121) ** 2 < 1000**2  # 관측 반경(모형)
    grid[inside] = DISPLAY_MIN  # 에코 없음
    grid[inside & (rnd.random(grid.shape) < 0.05)] = NULL_UNOBSERVED
    echo = inside & (rnd.random(grid.shape) < 0.3)
    n = int(echo.sum())
    vals = rnd.integers(-2500, 7500, size=n, dtype=np.int16)  # -25 ~ 75 dBZ
    edges = np.array(edge_values(), dtype=np.int16)
    vals[: len(edges) * 50] = np.tile(edges, 50)
    grid[echo] = rnd.permutation(vals)
    return grid


def render_digest(seed: int, width: int) -> tuple[str, int, int]:
    h = parse_header(FIX.read_bytes())
    png, meta = render_mercator_png(h, synthetic_grid(seed), width=width)
    return hashlib.sha256(png).hexdigest(), meta["echo_cells"], meta["observed_cells"]


# 현재 코드(실수 임계값 — kma_grid 의 grid.astype(float32) / 100 ≥ min_dbz)로 만든 값
GOLDEN = {
    (1, 1152): ("ffd26b3c3296b70cff031f0f803ad230e92e2da6d982a55b74391d23369c993e", 659549, 3141421),
    (2, 576): ("3eff2d18ad105962c09dd275e92539cc0f184f417510133e25e10abb4a7d406a", 659413, 3141421),
    (3, 288): ("db2d850bb14120612d82b39a134d9d803d5cd92845f140322b6b85fa9951a2de", 658807, 3141421),
}


@pytest.mark.parametrize(("seed", "width"), sorted(GOLDEN))
def test_render_output_is_pinned(seed, width):
    assert render_digest(seed, width) == GOLDEN[(seed, width)]
