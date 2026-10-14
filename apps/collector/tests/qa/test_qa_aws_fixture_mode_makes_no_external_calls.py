"""AWS 출시 QA(수집기 · 후보 6): fixture 모드는 "서버의 외부 호출 0"(QA 계획 §1.1 · make demo · make e2e · QA 스택)인데, 그것을 **전체 주기 동안** 단언하는
시험이 없었다 — test_main 의 fixture 연기 시험은 관심 지역 · focus 가 한 번 발행되면 멈춰서, 기동 8 s(KMA 레이더) · 12 s(연안 교통량) · 15 s(특보) ·
30 s(유지보수) 뒤에 처음 도는 작업이 외부를 부르는지 보지 못한다.

이 시험은 수집기 main()을 fixture 모드로 띄우고, 주기 · 첫 지연을 줄여 **모든 주기 작업이 여러 번** 돈 뒤 멈춘다. 그동안 나가는 연결을 모두 가로챈다
(httpx 전송 · asyncio create_connection · socket.connect) — 하나라도 있으면 실패. Redis 는 가짜, DB 는 연결하지 않는다.
결함이 아니라 빠진 단언을 메우는 회귀 시험이다(통과가 기대).
실행: cd apps/collector && uv run --offline pytest tests/qa/test_qa_aws_fixture_mode_makes_no_external_calls.py -q
"""

from __future__ import annotations

import asyncio
import socket
from collections import Counter

import httpx
from fakes import FakeRedis

from wakeline_collector import main as mainmod
from wakeline_collector import scheduler
from wakeline_collector.db import Db

PERIODIC = ("region", "global", "sigmet", "radar", "metar", "maintenance", "radar_kr", "kma_warning", "traffic_grid")


async def test_fixture_mode_makes_no_outbound_connection_while_every_periodic_job_runs(monkeypatch, tmp_path):
    attempts: list[str] = []

    async def no_send(self, request, *a, **kw):  # httpx 전송(HttpClient 는 모두 이 길로)
        attempts.append(f"httpx {request.method} {request.url.host}")
        raise httpx.ConnectError("blocked by QA test", request=request)

    real_create = asyncio.base_events.BaseEventLoop.create_connection

    async def no_create(self, *a, **kw):  # asyncio 연결(websockets · asyncpg · redis-py 등)
        attempts.append(f"create_connection {a[1:3] if len(a) > 2 else kw.get('host')}")
        raise OSError("blocked by QA test")

    real_connect = socket.socket.connect

    def no_connect(self, address):
        attempts.append(f"socket.connect {address!r}")
        raise OSError("blocked by QA test")

    monkeypatch.setattr(httpx.AsyncHTTPTransport, "handle_async_request", no_send)
    monkeypatch.setattr(asyncio.base_events.BaseEventLoop, "create_connection", no_create)
    monkeypatch.setattr(socket.socket, "connect", no_connect)

    ran: Counter[str] = Counter()
    real_periodic = scheduler.run_periodic

    def fast(name, run_once, interval_fn, stop, refresh=None, initial_delay: float = 0.0):
        async def counted() -> None:
            await run_once()
            ran[name] += 1

        return real_periodic(name, counted, lambda: 0.2, stop, refresh, initial_delay=0.05 if initial_delay else 0.0)

    monkeypatch.setattr(mainmod, "run_periodic", fast)
    monkeypatch.setattr(mainmod.settings, "wakeline_fixture_mode", 1)
    monkeypatch.setattr(mainmod.settings, "raw_dir", str(tmp_path / "raw"))
    monkeypatch.setattr(mainmod, "DB_DRAIN_S", 0.1)

    async def no_db():
        raise OSError("no db in tests")

    r = FakeRedis()
    stop = asyncio.Event()
    task = asyncio.create_task(mainmod.main(stop=stop, redis=r, db=Db(no_db)))
    try:
        for _ in range(200):
            if all(ran[n] >= 3 for n in PERIODIC):
                break
            await asyncio.sleep(0.05)
    finally:
        stop.set()
        await asyncio.wait_for(task, 10)
    monkeypatch.setattr(asyncio.base_events.BaseEventLoop, "create_connection", real_create)
    monkeypatch.setattr(socket.socket, "connect", real_connect)
    assert all(ran[n] >= 3 for n in PERIODIC), dict(ran)
    hb = r.kv["wakeline:collector"]
    assert hb.get("traffic_grid_state") == "fixture" and hb.get("portcalls_index_state") == "fixture", hb
    assert hb.get("kma_warning_state") == "ok" and hb.get("http_rps_1m") == "0.000", hb
    assert attempts == [], attempts
