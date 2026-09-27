"""주기 작업 실행기 — 지터, 실패 시 지수 백오프(2→300 s), 런타임 설정 반영."""

from __future__ import annotations

import asyncio
import logging
import random
from collections.abc import Callable

log = logging.getLogger("scheduler")


async def run_periodic(
    name: str,
    run_once: Callable,
    interval_fn: Callable[[], int],
    stop: asyncio.Event,
    refresh: Callable | None = None,
    initial_delay: float = 0.0,
) -> None:
    failures = 0
    if initial_delay:
        try:
            await asyncio.wait_for(stop.wait(), timeout=initial_delay)
            return
        except TimeoutError:
            pass
    while not stop.is_set():
        if refresh:
            await refresh()
        try:
            await run_once()
            failures = 0
        except Exception:  # noqa: BLE001 — 작업 내부에서 못 잡은 예외도 루프를 죽이지 않는다
            failures += 1
            log.exception("%s: unhandled error (#%d)", name, failures)
        base = interval_fn()
        delay = min(300.0, base * (2 ** min(failures, 5))) if failures else float(base)
        delay += random.uniform(0, min(1.0, base * 0.05))  # noqa: S311 — 지터
        try:
            await asyncio.wait_for(stop.wait(), timeout=delay)
        except TimeoutError:
            continue
