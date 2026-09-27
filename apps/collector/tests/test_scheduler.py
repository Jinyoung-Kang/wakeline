"""주기 실행기: 주기·지터·실패 백오프·런타임 설정 새로 읽기·종료."""

from __future__ import annotations

import asyncio

from wakeline_collector import scheduler
from wakeline_collector.scheduler import run_periodic


async def test_runs_until_stopped_and_refreshes_each_cycle():
    stop = asyncio.Event()
    runs = refreshes = 0

    async def run_once():
        nonlocal runs
        runs += 1
        if runs == 3:
            stop.set()

    async def refresh():
        nonlocal refreshes
        refreshes += 1

    await asyncio.wait_for(run_periodic("t", run_once, lambda: 0.01, stop, refresh), 2)  # type: ignore[arg-type,return-value]
    assert runs == 3 and refreshes == 3


async def test_unhandled_error_backs_off_exponentially_and_recovers(monkeypatch):
    delays: list[float] = []
    real_wait_for = asyncio.wait_for

    async def fake_wait_for(aw, timeout):
        delays.append(timeout)
        return await real_wait_for(aw, 0.001)

    monkeypatch.setattr(scheduler.asyncio, "wait_for", fake_wait_for)
    monkeypatch.setattr(scheduler.random, "uniform", lambda a, b: 0.0)
    stop = asyncio.Event()
    n = 0

    async def run_once():
        nonlocal n
        n += 1
        if n <= 3:
            raise RuntimeError("bug")
        if n == 5:
            stop.set()

    await run_periodic("t", run_once, lambda: 10, stop)
    assert delays[:4] == [20.0, 40.0, 80.0, 10.0]  # 실패마다 2배, 성공하면 원래 주기
    assert n == 5


async def test_backoff_capped_at_300s(monkeypatch):
    delays: list[float] = []
    real_wait_for = asyncio.wait_for

    async def fake_wait_for(aw, timeout):
        delays.append(timeout)
        return await real_wait_for(aw, 0.001)

    monkeypatch.setattr(scheduler.asyncio, "wait_for", fake_wait_for)
    monkeypatch.setattr(scheduler.random, "uniform", lambda a, b: 0.0)
    stop = asyncio.Event()
    n = 0

    async def run_once():
        nonlocal n
        n += 1
        if n == 8:
            stop.set()
        raise RuntimeError("always")

    await run_periodic("t", run_once, lambda: 60, stop)
    assert max(delays) == 300.0


async def test_stop_during_initial_delay_skips_run():
    stop = asyncio.Event()
    ran = False

    async def run_once():
        nonlocal ran
        ran = True

    task = asyncio.create_task(run_periodic("t", run_once, lambda: 1, stop, initial_delay=5))
    await asyncio.sleep(0.01)
    stop.set()
    await asyncio.wait_for(task, 1)
    assert not ran


async def test_initial_delay_then_runs():
    stop = asyncio.Event()

    async def run_once():
        stop.set()

    await asyncio.wait_for(run_periodic("t", run_once, lambda: 1, stop, initial_delay=0.01), 1)
    assert stop.is_set()
