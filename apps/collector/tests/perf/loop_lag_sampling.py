"""수집기 루프 지연 측정(diag.LoopLag — main.LOOP_TICK_S)의 비용과 잡는 힘(collector-review §4 'Enabler (D0)').

- cost: 아무 일도 없는 루프에서 LoopLag 만 SECONDS 동안 — 프로세스 CPU 시간(초당 ms).
- catch: 루프를 BLOCK_MS 동안 막는 일이 약 every_s 마다(0.5–1.5 배 무작위) 있을 때, 창(60 s) 안에서 LoopLag 가 본 최댓값 — 표본 간격 0.5 s(ais) ·
  0.1 s(수집기). every_s: 0.5 s(잦은 막힘) · 5 s(드문 막힘 — demand focus 주기 모형). 이 기계의 다른 일(개발 스택 등)도 지연에 든다.

사용: cd apps/collector && uv run --frozen python tests/perf/loop_lag_sampling.py
"""

from __future__ import annotations

import asyncio
import logging
import random
import time

from wakeline_collector.diag import LoopLag

SECONDS = 10.0
BLOCK_MS = 20.0
EVERY_S = (0.5, 5.0)
RUN_S = 60.0


def _lag(tick_s: float) -> LoopLag:
    return LoopLag(label="perf", context="-", logger=logging.getLogger("perf"), tick_s=tick_s)


async def cost(tick_s: float) -> float:
    lag = _lag(tick_s)
    task = asyncio.create_task(lag.run())
    c0, t0 = time.process_time(), time.perf_counter()
    await asyncio.sleep(SECONDS)
    c1, t1 = time.process_time(), time.perf_counter()
    task.cancel()
    await asyncio.gather(task, return_exceptions=True)
    return (c1 - c0) / (t1 - t0) * 1000  # CPU ms per second


async def catch(tick_s: float, every_s: float, seed: int) -> float | None:
    rnd = random.Random(seed)
    lag = _lag(tick_s)
    task = asyncio.create_task(lag.run())
    end = time.perf_counter() + RUN_S
    while time.perf_counter() < end:
        await asyncio.sleep(every_s * rnd.uniform(0.5, 1.5))
        t = time.perf_counter()
        while (time.perf_counter() - t) * 1000 < BLOCK_MS:  # 루프를 막는 CPU 일(정규화의 모형)
            pass
    v = lag.max_s()
    task.cancel()
    await asyncio.gather(task, return_exceptions=True)
    return v


async def main() -> None:
    for tick in (0.5, 0.1):
        print(f"tick {tick:.1f} s: sampler cost {await cost(tick):.3f} CPU ms/s")
    for every in EVERY_S:
        for tick in (0.5, 0.1):
            seen = [await catch(tick, every, seed) for seed in (1, 2, 3)]
            shown = ", ".join("—" if v is None else f"{v * 1000:.1f} ms" for v in seen)
            print(
                f"tick {tick:.1f} s, a {BLOCK_MS:.0f} ms block every ~{every:g} s: loop_lag_max_s over {RUN_S:.0f} s -> {shown}"
            )


if __name__ == "__main__":
    asyncio.run(main())
