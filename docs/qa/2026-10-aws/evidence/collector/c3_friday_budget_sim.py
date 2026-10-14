"""후보 1(AWS 리뷰 C-3 와 같음): AWS 평일 운영(08:50 KST 시작 · 18:00 KST 정지)에서 provider_budget_day 가 금요일 마지막 몇 분을 잃는가 — 모의 실행.

실제 코드: budget.Budget(예약 Lua 의미는 tests/fakes.FakeRedis) · jobs.maintenance.MaintenanceJob(매시 스냅샷 — 오늘 키 + 어제 키).
모의한 것: 시계(UTC), 수집기 기동 시각(평일 08:52 KST = 전날 23:52 UTC — EC2 08:50 시작 + 기동 약 2분), 유지보수 첫 실행 기동 30 s 뒤 · 그 뒤 3600 s 마다
(main.py:301), 정지 18:00 KST = 09:00 UTC, 예산 키 TTL 48 h(마지막 예약 시각 기준 — Redis 만료 시각은 절대 시각이라 EC2 가 꺼져 있어도 흐른다),
특보 작업처럼 5분마다 호출 1(kma_warning — 정지 · 주말에는 없음). 외부 호출 · Redis · DB 없음.
실행: cd apps/collector && uv run --offline python ../../docs/qa/2026-10-aws/evidence/collector/c3_friday_budget_sim.py
"""

from __future__ import annotations

import asyncio
import sys
from collections import Counter
from datetime import UTC, date, datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path.cwd() / "tests"))

from fakes import FakeRedis  # noqa: E402

from wakeline_collector import budget as budget_mod  # noqa: E402
from wakeline_collector.budget import Budget  # noqa: E402
from wakeline_collector.jobs import maintenance as maint_mod  # noqa: E402
from wakeline_collector.jobs.maintenance import MaintenanceJob  # noqa: E402

KST = timedelta(hours=9)
P = "kma_warning"
Q = "adsb_fi"  # 관심 지역 10 s 주기(예산은 세기만 — 한도 0)
CLOCK = [datetime(2026, 10, 11, tzinfo=UTC)]


class Db:
    def __init__(self) -> None:
        self.rows: dict[tuple[str, date], tuple[int, int]] = {}

    def upsert_budget_day(self, provider: str, day: datetime, used: int, limit: int) -> None:
        self.rows[(provider, day.date())] = (used, limit)

    def purge_port_calls(self, before) -> None:
        pass


class Raw:
    def purge(self) -> int:
        return 0


class Ctx:
    def __init__(self, r: FakeRedis, db: Db) -> None:
        self.budget = Budget(r, {P: 400, Q: 0})  # type: ignore[arg-type]
        self.db, self.raw = db, Raw()


async def main() -> None:
    real_day_key = budget_mod.day_key
    budget_mod.day_key = lambda p, now=None: real_day_key(p, now or CLOCK[0])  # type: ignore[assignment]
    maint_mod._utcnow = lambda: CLOCK[0]  # type: ignore[assignment]
    r, db = FakeRedis(), Db()
    ctx = Ctx(r, db)
    job = MaintenanceJob([P, Q], ctx)  # type: ignore[arg-type]
    last_reserve: dict[str, datetime] = {}
    actual: Counter[date] = Counter()
    actual_q: Counter[date] = Counter()

    def expire() -> None:  # TTL 48 h(마지막 예약 기준) — Redis 의 절대 만료 시각
        for k, t in list(last_reserve.items()):
            if CLOCK[0] - t >= timedelta(hours=48):
                r.kv.pop(k, None)
                del last_reserve[k]

    # 월(10-12) ~ 다음 주 월(10-19) — 평일만 켠다. 시작 = 그날 08:52 KST = 전날 23:52 UTC
    days = [date(2026, 10, 12) + timedelta(days=i) for i in range(9)]  # 다음 주 화요일까지 — 월요일 키가 마감되게
    for d in days:
        if d.weekday() >= 5:
            continue
        start = datetime(d.year, d.month, d.day, 8, 52, tzinfo=UTC) - KST
        stop = datetime(d.year, d.month, d.day, 18, 0, tzinfo=UTC) - KST
        t, next_maint = start, start + timedelta(seconds=30)
        while t < stop:
            CLOCK[0] = t
            expire()
            if t >= next_maint:
                await job.run_once()
                next_maint += timedelta(seconds=3600)
            if (t - start).total_seconds() % 300 == 0:  # 5분마다 호출 1
                ok, _ = await ctx.budget.reserve(P)
                assert ok
                last_reserve[real_day_key(P, t)] = t
                actual[t.date()] += 1
            if (t - start).total_seconds() % 10 == 0:  # 10 s 마다 호출 1
                await ctx.budget.reserve(Q)
                last_reserve[real_day_key(Q, t)] = t
                actual_q[t.date()] += 1
            t += timedelta(seconds=10)
        CLOCK[0] = stop
    for prov, act in ((P, actual), (Q, actual_q)):
        print(f"[{prov}] {'UTC 날':<12}{'실제 호출':>10}{'provider_budget_day.calls':>28}{'빠짐':>8}")
        for d in sorted(set(act) | {k[1] for k in db.rows if k[0] == prov}):
            got = db.rows.get((prov, d), (None, None))[0]
            miss = act[d] - (got or 0)
            note = '   ← 금요일(UTC) = KST 금 08:52–18:00 의 대부분' if d.weekday() == 4 else ''
            print(f"{'':<{len(prov) + 3}}{d.isoformat():<12}{act[d]:>10}{str(got):>28}{miss:>8}{note}")


asyncio.run(main())
