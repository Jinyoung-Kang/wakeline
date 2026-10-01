"""기상청 레이더 격자 해석 · PNG 의 시간과 최고 메모리(collector-review F9 · §4 P3 · PLAN Phase 4-2).

- render: kma_grid.render_mercator_png(운영 폭 1152) 한 번 — 가운데 시간(REPEAT 번) · tracemalloc 최고점(그 호출 안에서 늘어난 만큼).
- echo: 에코 셀 수 식 둘 — 실수(grid.astype(float32) / 100 ≥ 5 — 지금까지) · 정수(grid ≥ 500) — 같은 수인지와 시간 · 최고점.
격자: 실제 헤더(fixtures/kma_rdr_cmp_head.bin, 2305 × 2881)에 tests/test_kma_grid_output.synthetic_grid(1) — 외부 호출 없음.

사용: cd apps/collector && uv run --frozen python tests/perf/kma_render.py
"""

from __future__ import annotations

import statistics
import sys
import time
import tracemalloc
from collections.abc import Callable
from pathlib import Path
from typing import Any

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # tests/ — 합성 격자

from test_kma_grid_output import FIX, synthetic_grid  # noqa: E402

from wakeline_collector.kma_grid import DISPLAY_MIN, parse_header, render_mercator_png  # noqa: E402

REPEAT = 7


def measure(fn: Callable[[], Any], repeat: int = REPEAT) -> tuple[float, float, Any]:
    """(가운데 ms, 최고점 MiB, 결과)."""
    out = fn()  # 덥히기(캐시 · 첫 할당)
    times = []
    for _ in range(repeat):
        t0 = time.perf_counter()
        fn()
        times.append((time.perf_counter() - t0) * 1000)
    tracemalloc.start()
    base = tracemalloc.get_traced_memory()[0]
    fn()
    peak = tracemalloc.get_traced_memory()[1] - base
    tracemalloc.stop()
    return statistics.median(times), peak / 2**20, out


def main() -> None:
    h = parse_header(FIX.read_bytes())
    grid = synthetic_grid(1)
    ms, mib, (png, meta) = measure(lambda: render_mercator_png(h, grid))
    print(f"render_mercator_png width 1152: {ms:.1f} ms, peak +{mib:.1f} MiB (png {len(png)} B, echo_cells {meta['echo_cells']})")
    f_ms, f_mib, f_n = measure(lambda: int(((grid > DISPLAY_MIN) & (grid.astype(np.float32) / 100.0 >= 5.0)).sum()), 21)
    i_ms, i_mib, i_n = measure(lambda: int(((grid > DISPLAY_MIN) & (grid >= 500)).sum()), 21)
    print(f"echo cells, float32 threshold: {f_ms:.1f} ms, peak +{f_mib:.1f} MiB -> {f_n}")
    print(
        f"echo cells, int16 threshold:   {i_ms:.1f} ms, peak +{i_mib:.1f} MiB -> {i_n} ({'same' if f_n == i_n else 'DIFFERENT'})"
    )


if __name__ == "__main__":
    main()
