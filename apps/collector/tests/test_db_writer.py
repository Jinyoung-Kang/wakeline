"""DB 비동기 writer(REL-3): 작업은 기다리지 않고, DB 장애 동안 큐에 보관했다가 재연결 후 순서대로 기록한다."""

from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from typing import Any

import pytest

from wakeline_collector import db as dbmod
from wakeline_collector.db import Db, quality_rows
from wakeline_collector.portcalls import kst_date


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
    assert pool.log[2][1] == [(kst_date(now), "no_position", 25)]  # 실행한 날(KST 날짜 — 계약 v5 §G19)로 집계(COL-6)
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


# ---- COL-3: 오류 분류(일시 오류는 보관·재시도, 결정적 오류만 버림) ---------------------------------------------------------
class SlowPool(FakePool):
    """쓰기가 OP_TIMEOUT_S 보다 오래 걸리지만 생존 확인(SELECT 1)은 바로 답하는 DB."""

    def __init__(self):
        super().__init__()
        self.slow = True

    async def execute(self, sql, *args):
        if self.slow:
            await asyncio.sleep(1.0)
        await super().execute(sql, *args)


async def test_timed_out_write_is_kept_and_written_when_db_gets_fast(monkeypatch):
    monkeypatch.setattr(dbmod, "OP_TIMEOUT_S", 0.05)
    pool = SlowPool()

    async def factory():
        return pool

    db = Db(factory)
    db.start()
    db.upsert_budget_day("adsb_fi", datetime.now(UTC), 1, 10)
    await asyncio.sleep(0.15)
    assert db.pending == 1 and db.dropped == 0 and db.failures >= 1 and db.available  # 버리지 않는다
    pool.slow = False
    await _settle(db)
    assert [t for t, _ in pool.log] == ["provider_budget_day"] and db.written == 1 and db.dropped == 0
    await db.close()


async def test_transient_failures_while_db_up_are_capped(monkeypatch):
    import asyncpg

    monkeypatch.setattr(dbmod, "MAX_ATTEMPTS", 3)

    class DeadlockPool(FakePool):
        async def execute(self, sql, *args):
            if "provider_budget_day" in sql and args[0] == "poison":
                raise asyncpg.DeadlockDetectedError("deadlock detected")
            await super().execute(sql, *args)

    pool = DeadlockPool()

    async def factory():
        return pool

    db = Db(factory)
    db.start()
    db.upsert_budget_day("poison", datetime.now(UTC), 1, 10)
    db.upsert_budget_day("ok", datetime.now(UTC), 1, 10)
    await _settle(db)
    assert [a[0] for _t, a in pool.log] == ["ok"]  # 독이 든 작업이 큐를 영원히 막지 않는다
    assert db.dropped == 1 and db.failures == 3
    await db.close()


async def test_failures_while_db_down_do_not_count_toward_the_cap(monkeypatch):
    monkeypatch.setattr(dbmod, "MAX_ATTEMPTS", 2)
    pool = FakePool()
    pool.up = False

    async def factory():
        return pool

    db = Db(factory)
    db.start()
    db.upsert_budget_day("p", datetime.now(UTC), 1, 10)
    await asyncio.sleep(0.3)
    assert db.failures >= 3 and db.pending == 1 and db.dropped == 0 and not db.available
    pool.up = True
    await _settle(db)
    assert db.written == 1 and db.dropped == 0
    await db.close()


def test_error_classification():
    import asyncpg

    from wakeline_collector.db import classify_error

    for e in (
        asyncpg.UniqueViolationError("x"),
        asyncpg.DataError("x"),
        asyncpg.InsufficientPrivilegeError("x"),
        asyncpg.UndefinedTableError("x"),
        ValueError("x"),
    ):
        assert classify_error(e) == "permanent", e
    for e in (
        TimeoutError(),
        asyncpg.QueryCanceledError("x"),
        asyncpg.DeadlockDetectedError("x"),
        asyncpg.LockNotAvailableError("x"),
        asyncpg.SerializationError("x"),
        asyncpg.ConnectionDoesNotExistError("x"),
        asyncpg.InterfaceError("x"),
        asyncpg.TooManyConnectionsError("x"),
        ConnectionRefusedError(),
        RuntimeError("unknown"),
    ):
        assert classify_error(e) == "transient", e


# ---- COL-6: 규칙별 건수는 실행한 날로 — 그 날은 KST 날짜(계약 v5 §G19) ----------------------------------------------------------
async def test_quality_count_booked_to_run_day_even_if_flushed_after_midnight():
    pool = FakePool()
    pool.up = False

    async def factory():
        return pool

    db = Db(factory)
    db.start()
    started = datetime(2026, 9, 28, 14, 59, 30, tzinfo=UTC)  # 23:59:30 KST
    db.record_run("region", "adsb_lol", started, status="ok", quality=[("position_jump", "abcdef", {})])
    await asyncio.sleep(0.05)
    pool.up = True  # KST 자정 이후에 기록된다고 가정 — 날짜는 SQL 의 CURRENT_DATE 가 아니라 인자로 간다
    await _settle(db)
    rule_rows = [rows for t, rows in pool.log if t == "quality_rule_count"][0]
    assert rule_rows == [(datetime(2026, 9, 28).date(), "position_jump", 1)]
    await db.close()


async def test_quality_count_day_is_the_kst_date_of_the_run_start():
    """계약 v5 §G19: 규칙별 건수의 날짜 = 실행이 시작된 KST 날짜 — 경계는 KST 자정(15:00 UTC). 수정 전에는 UTC 날짜라 KST 00:00–08:59 의
    실행이 전날에 들어갔다(이 시험이 실패했다)."""
    pool = FakePool()

    async def factory():
        return pool

    db = Db(factory)
    db.start()
    for started in (
        datetime(2026, 9, 28, 14, 59, 59, tzinfo=UTC),  # 09-28 23:59:59 KST
        datetime(2026, 9, 28, 15, 0, 0, tzinfo=UTC),  # 09-29 00:00:00 KST(UTC 로는 아직 09-28)
        datetime(2026, 9, 28, 23, 59, 0, tzinfo=UTC),  # 09-29 08:59 KST
    ):
        db.record_run("region", "adsb_lol", started, status="ok", quality=[("position_jump", "abcdef", {})])
    await _settle(db)
    days = [rows[0][0] for t, rows in pool.log if t == "quality_rule_count"]
    assert days == [datetime(2026, 9, 28).date(), datetime(2026, 9, 29).date(), datetime(2026, 9, 29).date()]
    await db.close()


# ---- R-91(계약 v5 §D2): 결과가 모호한 실패(커밋 뒤 시간 초과) 뒤 재시도해도 실행 기록은 한 번만 ------------------------------------
class LedgerConn:
    """트랜잭션 단위로 커밋하는 가짜 연결. 쓰기는 트랜잭션 안에 쌓였다가 정상 종료 때만 원장(pool.committed)에 들어간다.
    ingest_run 의 run_key UNIQUE + ON CONFLICT (run_key) DO NOTHING 을 흉내 낸다(같은 키가 이미 있으면 RETURNING 결과 없음).
    ingest_run 항목은 ("ingest_run", {"id", "key", "args"}) — key 는 키를 쓰는 문장일 때만 $1, 아니면 None."""

    def __init__(self, pool: LedgerPool):
        self.pool = pool
        self.staged: list[tuple[str, Any]] = []

    @asynccontextmanager
    async def transaction(self):
        self.staged = []
        yield
        self.pool.committed.extend(self.staged)  # COMMIT 이 서버에 반영됐다
        if self.pool.timeouts_after_commit > 0:
            self.pool.timeouts_after_commit -= 1
            raise TimeoutError  # …그런데 COMMIT 응답을 받기 전에 시간 초과(모호한 실패)

    def _runs(self) -> list[dict[str, Any]]:
        return [p for t, p in self.pool.committed + self.staged if t == "ingest_run"]

    async def fetchval(self, sql, *args):
        if sql.strip() == "SELECT 1":
            return 1
        if "INSERT INTO ingest_run" in sql:
            key = args[0] if "ON CONFLICT (run_key) DO NOTHING" in sql else None
            if key is not None and any(r["key"] == key for r in self._runs()):
                return None
            self.pool.next_id += 1
            self.staged.append(("ingest_run", {"id": self.pool.next_id, "key": key, "args": args}))
            return self.pool.next_id
        if "SELECT id FROM ingest_run WHERE run_key" in sql:
            return next((r["id"] for r in self._runs() if r["key"] == args[0]), None)
        raise AssertionError(sql)

    async def executemany(self, sql, rows):
        self.staged.append((sql.split()[2], list(rows)))


class LedgerPool(FakePool):
    def __init__(self):
        super().__init__()
        self.committed: list[tuple[str, object]] = []
        self.timeouts_after_commit = 0

    @asynccontextmanager
    async def acquire(self):
        yield LedgerConn(self)


async def test_run_committed_then_timed_out_is_recorded_once_on_retry():
    """COMMIT 이 서버에 반영된 뒤 응답 전에 시간 초과가 나면 writer 는 일시 오류로 보고 같은 작업을 다시 실행한다(DB 는 응답한다).
    실행 키(run_key) 가 없으면 ingest_run 이 두 행이 되고 품질 사례·규칙별 건수가 두 배로 집계됐다(R-91)."""
    pool = LedgerPool()
    pool.timeouts_after_commit = 1

    async def factory():
        return pool

    db = Db(factory)
    db.start()
    now = datetime.now(UTC)
    db.record_run("region", "adsb_lol", now, status="ok", records_in=7, quality=[("no_position", None, {})] * 25)
    await _settle(db)
    runs = [r for t, r in pool.committed if t == "ingest_run"]
    events = [r for t, rows in pool.committed if t == "quality_event" for r in rows]
    counts = [r for t, rows in pool.committed if t == "quality_rule_count" for r in rows]
    assert len(runs) == 1, runs  # 재시도해도 실행 기록은 하나
    assert len(events) == 20 and all(e[0] == 1 for e in events)  # 대표 사례 20건, 첫 커밋의 run id 에 붙는다
    assert counts == [(kst_date(now), "no_position", 25)]  # 규칙별 건수도 한 번만(두 배 집계 없음)
    assert db.failures == 1 and db.written == 1 and db.dropped == 0 and db.pending == 0
    await db.close()


async def test_each_run_gets_its_own_run_key():
    """실행마다 새 uuid — 서로 다른 실행이 같은 키로 합쳐지지 않는다. 같은 실행의 재시도만 같은 키를 쓴다."""
    import uuid

    pool = LedgerPool()

    async def factory():
        return pool

    db = Db(factory)
    db.start()
    now = datetime.now(UTC)
    db.record_run("region", "adsb_lol", now, status="ok")
    db.record_run("region", "adsb_lol", now, status="ok")
    await _settle(db)
    keys = [r["key"] for t, r in pool.committed if t == "ingest_run"]
    assert len(keys) == 2 and keys[0] != keys[1]
    assert all(isinstance(k, uuid.UUID) and k.version == 4 for k in keys)
    await db.close()
