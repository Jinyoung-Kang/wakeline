"""수요 추적(focus · hot)이 이벤트 루프 위에서 하는 일의 길이(collector-review §4 P2 · PLAN Phase 4 D2): 응답 하나 → 정규화 + 품질 게이트
(normalize.readsb_batch) → 발행 필드(hot_payload + envelope: orjson · gzip · base64). 스레드로 옮길지(D2)는 루프를 20 ms 넘게 막을 때만이다.

- block: 그 일 한 번의 길이 — p50 · p99 · 최대(REPEAT 번, 같은 프로세스에서 덥힌 뒤).
- loop lag: 그 일을 REPEAT 번 하는 동안 1 ms 표본기(asyncio.sleep(0.001))가 본 늦음의 p99 · 최대 — 루프 위에서(지금) · 전용 스레드 하나에서(D2 후보).
항공기 수: fixtures/adsb_lol_region.json(127대)을 hex 를 바꿔 늘린다(127 · 300 · 600 — 리뷰 측정과 같은 크기). 외부 호출 · Redis 없음.

사용: cd apps/collector && uv run --frozen python tests/perf/demand_on_loop.py
"""

from __future__ import annotations

import asyncio
import concurrent.futures
import time
from datetime import UTC, datetime
from pathlib import Path

import orjson

from wakeline_collector.demand import HotCell
from wakeline_collector.jobs.demand import hot_payload
from wakeline_collector.normalize import readsb_batch
from wakeline_collector.publisher import envelope
from wakeline_collector.quality import AircraftGate

FIX = Path(__file__).resolve().parents[4] / "fixtures" / "adsb_lol_region.json"
SIZES = (127, 300, 600)
REPEAT = 100
CELL = HotCell("37.5:127.0", 37.5, 127.0, 25, 0.0)


def body(n: int, now: datetime) -> dict:
    """n 대. 응답 시각(now)을 지금으로 옮긴다 — seen_pos 는 응답 시각에서 거꾸로 센 초라 관측 나이는 고정본 그대로고, 게이트가 낡은 위치로
    버리지 않는다(고정본의 날짜 그대로면 모두 버려 발행할 것이 없다 — 일을 적게 잰다)."""
    src = orjson.loads(FIX.read_bytes())
    acs = []
    for i in range(n):
        ac = dict(src["ac"][i % len(src["ac"])])
        ac["hex"] = f"{0x710000 + i:06x}"  # 서로 다른 항공기
        acs.append(ac)
    return {**src, "now": now.timestamp() * 1000, "ac": acs}


def work(data: dict, gate: AircraftGate, fetched_at: datetime) -> dict[str, str]:
    """수요 작업이 응답 하나에 루프 위에서 하는 일(_normalize → _publish 의 envelope)."""
    _records, g, _seen = readsb_batch(data, "adsb_fi", fetched_at, gate, keep=lambda _h: True)
    return envelope(
        kind="aircraft",
        scope="hot",
        provider="adsb_fi",
        fetched_at=fetched_at,
        raw_ref="perf",
        count=len(g.kept),
        payload=hot_payload(CELL, g.kept),
    )


async def lag_while(data: dict, fetched_at: datetime, *, thread: bool) -> list[float]:
    """그 일을 REPEAT 번(사이 5 ms) 하는 동안 1 ms 표본기의 늦음(초) 목록. thread=True 면 일을 전용 스레드 하나에서(KMA 해석과 같은 방식)."""
    gate = AircraftGate()
    lags: list[float] = []
    done = asyncio.Event()
    pool = concurrent.futures.ThreadPoolExecutor(max_workers=1)

    async def sampler() -> None:
        loop = asyncio.get_running_loop()
        while not done.is_set():
            t0 = loop.time()
            await asyncio.sleep(0.001)
            lags.append(loop.time() - t0 - 0.001)

    task = asyncio.create_task(sampler())
    await asyncio.sleep(0.01)
    loop = asyncio.get_running_loop()
    for _ in range(REPEAT):
        if thread:
            await loop.run_in_executor(pool, work, data, gate, fetched_at)
        else:
            work(data, gate, fetched_at)
        await asyncio.sleep(0.005)  # 다른 일 사이(실제로는 fetch 를 기다린다)
    done.set()
    await task
    pool.shutdown()
    return lags


def _q(values: list[float], q: float) -> float:
    v = sorted(values)
    return v[min(len(v) - 1, int(q * len(v)))]


def main() -> None:
    fetched_at = datetime.now(UTC)
    print(f"demand work per response ({REPEAT} times) and the 1 ms-sampler loop lag — on the loop vs in a dedicated thread")
    for n in SIZES:
        data = body(n, fetched_at)
        gate = AircraftGate()
        kept = work(data, gate, fetched_at)["count"]  # 덥히기 — 게이트를 지나 발행하는 항공기 수
        times = []
        for _ in range(REPEAT):
            t0 = time.perf_counter()
            work(data, gate, fetched_at)
            times.append((time.perf_counter() - t0) * 1000)
        inline = asyncio.run(lag_while(data, fetched_at, thread=False))
        threaded = asyncio.run(lag_while(data, fetched_at, thread=True))
        print(
            f"  {n:4d} aircraft ({kept} published): block p50 {_q(times, 0.5):5.1f} · p99 {_q(times, 0.99):5.1f} · max {max(times):5.1f} ms; "
            f"loop lag p99/max on the loop {_q(inline, 0.99) * 1000:5.1f}/{max(inline) * 1000:5.1f} ms, "
            f"in a thread {_q(threaded, 0.99) * 1000:5.1f}/{max(threaded) * 1000:5.1f} ms"
        )


if __name__ == "__main__":
    main()
