"""공급자 체인이 한 주기에 운영자 끔(is_disabled — 공급자마다 Redis HGET 한 번)을 몇 번 · 얼마나 오래 기다리는가(collector-review §3 'Other Low' ·
PLAN 3B-7). 외부 호출 · Redis 없음 — 가짜 상태(읽기 하나에 STALL_S 를 기다린다: Redis 가 멈춘 동안 AUX_TIMEOUT_S 1.5 s 로 끊기는 읽기의 모형)로 잰다.

주기 셋(관심 지역 체인, 공급자 a · b 모두 설정됨):
- normal: pick 하나 — a 를 고른다.
- first_disabled: 운영자가 a 를 껐다 — pick 이 b 를 고른다.
- after_429: pick(a) → a 가 429(on_rate_limited) → 경고의 'next:' 를 적는 peek(b) — aircraft 작업이 429 를 받은 주기와 같다.

사용: cd apps/collector && uv run --frozen python tests/perf/chain_disabled_reads.py
"""

from __future__ import annotations

import asyncio
import time
from types import SimpleNamespace

from wakeline_collector.fallback import ProviderChain

STALL_S = 0.05  # 읽기 하나의 기다림(모형 — 실제 상한 AUX_TIMEOUT_S 1.5 s 의 1/30)


class SlowStatus:
    def __init__(self, disabled: set[str]) -> None:
        self.disabled, self.reads = disabled, 0

    async def is_disabled(self, name: str) -> bool:
        self.reads += 1
        await asyncio.sleep(STALL_S)
        return name in self.disabled

    async def set_active(self, *_a, **_k) -> bool:
        return True

    async def switch_event(self, *_a, **_k) -> None:
        return None

    async def set_none(self, *_a, **_k) -> bool:
        return True

    async def clear_none(self, *_a, **_k) -> bool:
        return True


def _providers() -> dict[str, SimpleNamespace]:
    return {n: SimpleNamespace(name=n, supports_region=True, supports_global=False, configured=True) for n in ("a", "b")}


async def _cycle(kind: str) -> tuple[int, float]:
    st = SlowStatus({"a"} if kind == "first_disabled" else set())
    chain = ProviderChain("region", _providers(), st)  # type: ignore[arg-type]
    order = ["a", "b"]
    t0 = time.perf_counter()
    p = await chain.pick(order)
    if kind == "after_429":
        assert p is not None
        await chain.on_rate_limited(p.name)
        await chain.peek(order)
    return st.reads, time.perf_counter() - t0


async def main() -> None:
    print(f"is_disabled reads per cycle and wall time with each read stalled {STALL_S * 1000:.0f} ms")
    for kind in ("normal", "first_disabled", "after_429"):
        runs = [await _cycle(kind) for _ in range(5)]
        reads = runs[0][0]
        wall = sorted(w for _r, w in runs)[len(runs) // 2]
        print(f"  {kind:15s} reads={reads}  wall={wall * 1000:6.1f} ms  (= {wall / STALL_S:.2f} stalled reads)")


if __name__ == "__main__":
    asyncio.run(main())
