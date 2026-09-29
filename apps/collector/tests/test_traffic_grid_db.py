"""연안 교통량 격자 기하 캐시(ADR-023 · V14 marine_grid4) — Db.upsert_marine_grid4(큐 · 멱등 upsert)와 read_marine_grid4(큐를 거치지 않는 읽기,
DB 에 닿지 못하면 None — 빈 목록과 다르다). 실제 SQL 은 test_db_pg_integration.py(선택 실행)가 V14 스키마에서 돌린다."""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime

from wakeline_collector import db as dbmod
from wakeline_collector.db import Db
from wakeline_collector.marine_grid import Cell


class Pool:
    def __init__(self, rows=None, fail: Exception | None = None):
        self.rows = rows or []
        self.fail = fail
        self.many: list[tuple[str, list]] = []

    async def fetch(self, sql):
        if self.fail:
            raise self.fail
        assert sql.startswith("SELECT grid_no, lat_min, lon_min, lat_max, lon_max, gid FROM marine_grid4")
        return self.rows

    async def fetchval(self, sql, *args):
        return 1

    async def executemany(self, sql, rows):
        self.many.append((sql, list(rows)))

    async def close(self):
        pass


async def test_read_returns_rows_as_tuples():
    rows = [{"grid_no": "GR4_A", "lat_min": 37.45, "lon_min": 126.6, "lat_max": 37.475, "lon_max": 126.625, "gid": 3}]
    pool = Pool(rows)

    async def factory():
        return pool

    db = Db(pool_factory=factory)
    assert await db.read_marine_grid4() == [("GR4_A", 37.45, 126.6, 37.475, 126.625, 3)]


async def test_read_is_none_when_the_db_is_unreachable_or_fails():
    async def down():
        raise ConnectionError("db down")

    assert await Db(pool_factory=down).read_marine_grid4() is None

    async def broken():
        return Pool(fail=TimeoutError())

    db = Db(pool_factory=broken)
    assert await db.read_marine_grid4() is None and db.failures == 1


async def test_upsert_is_queued_once_per_batch_and_idempotent_sql():
    pool = Pool()

    async def factory():
        return pool

    db = Db(pool_factory=factory)
    db.start()
    at = datetime(2026, 9, 29, 9, 6, tzinfo=UTC)
    db.upsert_marine_grid4(
        [Cell("GR4_A", 37.45, 126.6, 37.475, 126.625, 3), Cell("GR4_B", 37.425, 126.6, 37.45, 126.625, None)], at
    )
    db.upsert_marine_grid4([], at)  # 빈 목록은 큐에 넣지 않는다
    for _ in range(200):
        if pool.many:
            break
        await asyncio.sleep(0.01)
    await db.close(drain_s=1)
    ((sql, rows),) = pool.many
    assert "ON CONFLICT (grid_no) DO UPDATE" in sql
    assert rows == [("GR4_A", 37.45, 126.6, 37.475, 126.625, 3, at), ("GR4_B", 37.425, 126.6, 37.45, 126.625, None, at)]


async def test_concurrent_reader_and_writer_share_one_pool():
    made = 0

    async def factory():
        nonlocal made
        made += 1
        await asyncio.sleep(0.02)
        return Pool()

    db = Db(pool_factory=factory)
    await asyncio.gather(db.read_marine_grid4(), db._ensure_pool(), db.read_marine_grid4())
    assert made == 1


def test_select_and_upsert_name_the_v14_columns():
    assert "marine_grid4 (grid_no, lat_min, lon_min, lat_max, lon_max, gid, fetched_at)" in dbmod._MARINE_GRID4_UPSERT
