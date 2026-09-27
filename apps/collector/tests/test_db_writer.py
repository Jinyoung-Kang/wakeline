"""DB 비동기 writer(REL-3): 작업은 기다리지 않고, DB 장애 동안 큐에 보관했다가 재연결 후 순서대로 기록한다."""

from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from datetime import UTC, datetime

import pytest

from skywx_collector import db as dbmod
from skywx_collector.db import Db, quality_rows


class FakeConn:
    def __init__(self, pool: FakePool):
        self.pool = pool

    @asynccontextmanager
    async def transaction(self):
        yield

    async def fetchval(self, sql, *args):
        return await self.pool.fetchval(sql, *args)

    async def executemany(self, sql, rows):
        await self.pool.executemany(sql, rows)


class FakePool:
    def __init__(self):
        self.up = True
        self.log: list[tuple[str, object]] = []
        self.reject: set[str] = set()  # 이 테이블 이름이 든 SQL 은 제약 위반처럼 실패
        self.next_id = 0

    def _check(self, sql):
        if not self.up:
            raise ConnectionError("db down")
        for t in self.reject:
            if t in sql:
                raise ValueError(f"violates constraint on {t}")

    async def fetchval(self, sql, *args):
        self._check(sql)
        if sql.strip() == "SELECT 1":
            return 1
        self.next_id += 1
        self.log.append((sql.split()[2], args))
        return self.next_id

    async def executemany(self, sql, rows):
        self._check(sql)
        self.log.append((sql.split()[2], list(rows)))

    async def execute(self, sql, *args):
        self._check(sql)
        self.log.append((sql.split()[2], args))

    @asynccontextmanager
    async def acquire(self):
        yield FakeConn(self)

    async def close(self):
        pass


async def _settle(db: Db, timeout: float = 2.0):
    async def wait():
        while db.pending:
            await asyncio.sleep(0.01)

    await asyncio.wait_for(wait(), timeout)


@pytest.fixture(autouse=True)
def fast_backoff(monkeypatch):
    monkeypatch.setattr(dbmod, "RECONNECT_MIN_S", 0.02)
    monkeypatch.setattr(dbmod, "RECONNECT_MAX_S", 0.05)


async def test_writes_in_order_with_quality_in_same_run():
    pool = FakePool()

    async def factory():
        return pool

    db = Db(factory)
    db.start()
    now = datetime.now(UTC)
    db.record_run("region", "adsb_lol", now, status="ok", quality=[("no_position", None, {})] * 25)
    db.upsert_airports([{"icao": "RKSI", "lat": 37.46, "lon": 126.44}])
    db.upsert_metar(
        [{"icao": "RKSI", "obs_time": now, "raw": "M", "provider": "awc", "fetched_at": now, "ceiling_state": "none"}]
    )
    await _settle(db)
    tables = [t for t, _ in pool.log]
    assert tables == ["ingest_run", "quality_event", "quality_rule_count", "airport", "metar_obs"]
    assert len(pool.log[1][1]) == 20  # 규칙별 대표 사례 20건
    assert pool.log[2][1] == [("no_position", 25)]
    metar_args = pool.log[4][1][0]
    assert metar_args[10] == "none"  # ceiling_state 가 11번째 인자
    await db.close()
    assert db.written == 3 and db.failures == 0 and db.available


async def test_db_outage_keeps_writes_and_flushes_after_reconnect():
    pool = FakePool()
    pool.up = False
    connects = 0

    async def factory():
        nonlocal connects
        connects += 1
        if connects < 3:
            raise OSError("connection refused")
        return pool

    db = Db(factory)
    db.start()
    for i in range(3):
        db.upsert_budget_day(f"p{i}", datetime.now(UTC), i, 10)
    await asyncio.sleep(0.2)
    assert db.pending == 3 and not db.available and db.failures >= 2
    pool.up = True
    await _settle(db)
    assert [a[0] for _t, a in pool.log] == ["p0", "p1", "p2"]  # 순서 보존
    assert db.available and db.dropped == 0
    await db.close()


async def test_rejected_write_is_dropped_and_does_not_block_queue():
    pool = FakePool()
    pool.reject = {"metar_obs"}

    async def factory():
        return pool

    db = Db(factory)
    db.start()
    now = datetime.now(UTC)
    db.upsert_metar([{"icao": "RKSI", "obs_time": now, "raw": "M", "provider": "awc", "fetched_at": now}])
    db.upsert_budget_day("awc", now, 1, 10)
    await _settle(db)
    assert [t for t, _ in pool.log] == ["provider_budget_day"]
    assert db.dropped == 1 and db.failures == 1 and db.available
    await db.close()


async def test_queue_overflow_drops_oldest(monkeypatch):
    monkeypatch.setattr(dbmod, "QUEUE_MAX", 3)
    db = Db()  # writer 를 시작하지 않음
    for i in range(5):
        db.upsert_budget_day(f"p{i}", datetime.now(UTC), i, 10)
    assert db.pending == 3 and db.dropped == 2
    await db.close(drain_s=0.1)
    assert db.dropped == 5  # 종료 시 남은 것도 집계


def test_quality_rows_sample_cap():
    rows, per_rule = quality_rows([("a", "h1", {"x": 1})] * 30 + [("b", None, {})])
    assert len([r for r in rows if r[0] == "a"]) == 20 and per_rule == {"a": 30, "b": 1}


def test_metrics_shape():
    m = Db().metrics()
    assert set(m) == {"db_ok", "db_pending", "db_failures", "db_dropped"}


async def test_metar_batch_rejected_by_one_row_falls_back_to_row_by_row():
    import asyncpg

    class NotNullPool(FakePool):
        async def executemany(self, sql, rows):
            if any(r[12] is None for r in rows):  # flight_cat_source NOT NULL 인 옛 스키마를 흉내
                raise asyncpg.NotNullViolationError("null value in column flight_cat_source")
            await super().executemany(sql, rows)

        async def execute(self, sql, *args):
            if "metar_obs" in sql and args[12] is None:
                raise asyncpg.NotNullViolationError("null value in column flight_cat_source")
            self.log.append(("metar_row", args[0]))

    pool = NotNullPool()

    async def factory():
        return pool

    db = Db(factory)
    db.start()
    now = datetime.now(UTC)
    rows = [
        {"icao": "RKSI", "obs_time": now, "raw": "M", "provider": "awc", "fetched_at": now, "flight_cat_source": "awc"},
        {"icao": "RJDC", "obs_time": now, "raw": "M", "provider": "awc", "fetched_at": now, "flight_cat_source": None},
        {"icao": "RKSS", "obs_time": now, "raw": "M", "provider": "awc", "fetched_at": now, "flight_cat_source": "computed"},
    ]
    db.upsert_metar(rows)
    await _settle(db)
    assert pool.log == [("metar_row", "RKSI"), ("metar_row", "RKSS")]  # 나머지 행은 살린다
    assert db.dropped == 1 and db.written == 1
    await db.close()
