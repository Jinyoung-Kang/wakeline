"""kma_grid.render_mercator_png 의 출력(PNG 바이트 · 에코 셀 수 · 관측 셀 수)을 고정한다 — 임계값을 실수에서 정수로 바꾸기 전(collector-review F9 ·
PLAN Phase 4-2). 실제 헤더(fixtures/kma_rdr_cmp_head.bin — 2305 × 2881)에 합성 격자를 싣는다: 관측 반경 밖 · 안(비관측 · 에코 없음)과, 에코 칸에는
무작위 값과 함께 모든 경계값(min_dbz 와 색 구간마다 ×100 의 −1 · 0 · +1)과 int16 의 양 끝을 넣는다. 같은 입력이면 그린 그림(디코딩한 RGBA 화소 ·
크기)이 같아야 한다. PNG 압축 바이트는 고정하지 않는다 — 같은 Pillow 판(uv.lock)이라도 플랫폼마다 휠에 든 zlib 이 달라 압축 결과가 다르다(CI · Linux x86_64 에서
macOS 의 해시와 달랐다 — 화소는 같다)."""

from __future__ import annotations

import hashlib
import io
from pathlib import Path

import numpy as np
import pytest
from PIL import Image

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
    assert png[:8] == b"\x89PNG\r\n\x1a\n"
    img = Image.open(io.BytesIO(png))
    pixels = hashlib.sha256(f"{img.mode} {img.size[0]}x{img.size[1]} ".encode() + img.tobytes()).hexdigest()
    return pixels, meta["echo_cells"], meta["observed_cells"]


# 디코딩한 화소의 해시 · 에코 셀 · 관측 셀. 실수 임계값(grid.astype(float32) / 100 ≥ min_dbz) 때의 PNG 해시(ffd26b3c… · 3eff2d18… · db2d850b… — macOS)와
# 같은 PNG 바이트를 디코딩한 값이다(정수 임계값으로 바꾼 뒤에도 그 PNG 해시가 같았다 — 화소가 같다). 화소는 플랫폼과 상관없다(Linux x86_64 에서도 같음).
GOLDEN = {
    (1, 1152): ("e856e4f1b52ce657bda164269f4137ab27f0e6698752efeb146924cb3d3d0522", 659549, 3141421),
    (2, 576): ("07b5d5405772f0d64f53f405615e7b801fcfe7ec0cbbf44470dc119909860fb5", 659413, 3141421),
    (3, 288): ("24fd2dfd0e44bf4b6e2f88fe6a27bc4d58b4f0d6130bb898305471f6f24119ba", 658807, 3141421),
}


@pytest.mark.parametrize(("seed", "width"), sorted(GOLDEN))
def test_render_output_is_pinned(seed, width):
    assert render_digest(seed, width) == GOLDEN[(seed, width)]


@pytest.mark.parametrize(
    "min_dbz",
    [5.0, *(lo for lo, _c in DBZ_STOPS), 0.0, -5.0, 4.995, 5.005, 0.015, 12.345, 327.67, 327.68, -327.68, -327.69, 400.0],
)
def test_the_integer_threshold_selects_exactly_the_cells_the_float_form_did(min_dbz):
    """F9: grid ≥ dbz_threshold(m) 은 모든 int16 값에서 float32(grid) / 100 ≥ m(전의 식)과 같다 — 색 구간 · min_dbz · 경계 근처 · 범위 밖."""
    from wakeline_collector.kma_grid import dbz_threshold

    every = np.arange(-32768, 32768, dtype=np.int16)
    assert np.array_equal(every >= dbz_threshold(min_dbz), every.astype(np.float32) / 100.0 >= min_dbz)
