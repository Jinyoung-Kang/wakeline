"""db.py 의 입출항 색인 쓰기 · 읽기(ADR-022 개정 · V15) — 흐름과 인자 모양. 실제 SQL 은 test_db_pg_integration(선택 실행)이 PostgreSQL 에서 돈다.

- 하루 = 한 트랜잭션: 범위 행 잠금(FOR UPDATE) → (0건인데 저장된 행이 많으면 멈춤) → upsert → 그 날 목록에서 빠진 행 삭제 → 범위 넓히기 · refreshed_at.
- DB 에 닿지 못하거나 트랜잭션이 실패하면 None — 작업은 그 날을 다시 받는다(아무것도 바뀌지 않았다).
"""

from __future__ import annotations

import re
from contextlib import asynccontextmanager
from dataclasses import fields
from datetime import UTC, date, datetime
from typing import Any

from wakeline_collector import db as dbmod
from wakeline_collector.db import Db
from wakeline_collector.portcalls import Coverage, PortCallRow

AT = datetime(2026, 9, 29, 13, 0, tzinfo=UTC)
D = date(2026, 9, 29)


def _row(cs: str = "V7A3884", co: str = "005", **kw: Any) -> PortCallRow:
    return PortCallRow(prt_ag_cd="020", clsgn=cs, etrypt_year="2026", etrypt_co=co, listed_date=D, **kw)


class _Conn:
    def __init__(self, pool: _Pool):
        self.p = pool

    @asynccontextmanager
    async def transaction(self):
        self.p.log.append("BEGIN")
        try:
            yield
        except BaseException:
            self.p.log.append("ROLLBACK")
            raise
        self.p.log.append("COMMIT")

    async def fetchrow(self, sql: str, *args: Any):
        self.p.log.append(("fetchrow", sql, args))
        return self.p.cov

    async def fetchval(self, sql: str, *args: Any):
        self.p.log.append(("fetchval", sql, args))
        return self.p.stored

    async def executemany(self, sql: str, rows: list[tuple]):
        self.p.log.append(("executemany", sql, rows))
        if self.p.fail_upsert:
            raise TimeoutError

    async def execute(self, sql: str, *args: Any):
        self.p.log.append(("execute", sql, args))
        return "DELETE 2" if sql.lstrip().startswith("DELETE") else "INSERT 0 1"


class _Pool:
    def __init__(self, cov: dict | None = None, stored: int = 0):
        self.cov, self.stored = cov, stored
        self.log: list[Any] = []
        self.fail_upsert = False

    @asynccontextmanager
    async def acquire(self):
        yield _Conn(self)

    async def fetch(self, sql: str):
        self.log.append(("fetch", sql))
        return [{"prt_ag_cd": "020", "covered_from": date(2026, 8, 30), "covered_to": D, "refreshed_at": AT}]


def _db(pool: _Pool | None) -> Db:
    async def factory():
        if pool is None:
            raise OSError("no db")
        return pool

    return Db(factory)


def test_the_column_list_matches_the_row_fields_and_the_upsert_placeholders():
    names = tuple(f.name for f in fields(PortCallRow))
    assert dbmod._PORT_CALL_COLS == names
    cols = re.search(r"INSERT INTO port_call \(([^)]*)\)", dbmod._PORT_CALL_UPSERT, re.S)
    assert cols is not None
    assert [c.strip() for c in cols.group(1).split(",")] == [*names, "fetched_at", "updated_at"]
    assert re.findall(r"\$(\d+)", dbmod._PORT_CALL_UPSERT.split("VALUES", 1)[1].split("ON CONFLICT")[0]) == [
        *(str(i) for i in range(1, len(names) + 2)),
        str(len(names) + 1),
    ]  # fetched_at 과 updated_at 은 같은 인자(새 행)
    distinct = dbmod._PORT_CALL_UPSERT.split("IS DISTINCT FROM", 1)
    assert [c.strip() for c in distinct[0].rsplit("(", 1)[1].rstrip(") \n").split(",")] == [f"port_call.{n}" for n in names[4:]]


async def test_a_complete_day_is_one_transaction_upsert_delete_withdrawn_and_widen_coverage():
    pool = _Pool(cov={"covered_from": date(2026, 9, 27), "covered_to": date(2026, 9, 28), "refreshed_at": None})
    db = _db(pool)
    res = await db.apply_port_call_day("020", D, [_row(), _row("D7AB2", "001")], AT, refreshed_at=AT, refuse_empty_over=3)
    assert res is not None and res.applied and res.merged and (res.upserted, res.deleted) == (2, 2)
    assert res.coverage == Coverage(date(2026, 9, 27), D, AT)
    kinds = [x if isinstance(x, str) else x[0] for x in pool.log]
    assert kinds == ["BEGIN", "fetchrow", "executemany", "execute", "execute", "COMMIT"]
    assert "FOR UPDATE" in pool.log[1][1]
    rows = pool.log[2][2]
    assert len(rows) == 2 and len(rows[0]) == len(dbmod._PORT_CALL_COLS) + 1 and rows[0][-1] == AT
    _kind, sql, args = pool.log[3]
    assert sql == dbmod._PORT_CALL_DELETE_WITHDRAWN and args == ("020", D, ["V7A3884", "D7AB2"], ["2026", "2026"], ["005", "001"])
    _kind, sql, args = pool.log[4]
    assert sql == dbmod._PORT_CALL_COVERAGE_UPSERT and args[:4] == ("020", date(2026, 9, 27), D, AT)


async def test_an_empty_day_with_many_stored_rows_changes_nothing_until_confirmed():
    pool = _Pool(cov={"covered_from": date(2026, 9, 27), "covered_to": D, "refreshed_at": AT}, stored=4)
    db = _db(pool)
    res = await db.apply_port_call_day("020", D, [], AT, refuse_empty_over=3)
    assert res is not None and not res.applied and res.suspect_empty and res.stored == 4
    assert [x if isinstance(x, str) else x[0] for x in pool.log] == ["BEGIN", "fetchrow", "fetchval", "COMMIT"]
    pool.log.clear()
    res = await db.apply_port_call_day("020", D, [], AT, refuse_empty_over=None)  # 다시 확인한 뒤 — 지운다
    assert res is not None and res.applied and res.deleted == 2
    assert [x if isinstance(x, str) else x[0] for x in pool.log] == ["BEGIN", "fetchrow", "execute", "execute", "COMMIT"]


async def test_a_day_that_does_not_touch_the_coverage_keeps_it_and_stores_the_rows():
    cov = {"covered_from": date(2026, 9, 1), "covered_to": date(2026, 9, 10), "refreshed_at": AT}
    pool = _Pool(cov=cov)
    res = await _db(pool).apply_port_call_day("020", D, [_row()], AT, refreshed_at=AT)
    assert (
        res is not None and res.applied and not res.merged and res.coverage == Coverage(date(2026, 9, 1), date(2026, 9, 10), AT)
    )
    assert not any(isinstance(x, tuple) and x[1] == dbmod._PORT_CALL_COVERAGE_UPSERT for x in pool.log)


async def test_a_reset_starts_the_coverage_at_that_day():
    pool = _Pool(cov={"covered_from": date(2026, 7, 1), "covered_to": date(2026, 7, 10), "refreshed_at": AT})
    res = await _db(pool).apply_port_call_day("020", D, [], AT, reset=True)
    assert res is not None and res.coverage == Coverage(D, D, None)


async def test_a_failed_transaction_rolls_back_and_returns_none():
    pool = _Pool()
    pool.fail_upsert = True
    db = _db(pool)
    assert await db.apply_port_call_day("020", D, [_row()], AT) is None
    assert pool.log[-1] == "ROLLBACK" and db.failures == 1


async def test_without_a_database_reads_and_writes_are_none():
    db = _db(None)
    assert await db.read_port_call_coverage() is None
    assert await db.apply_port_call_day("020", D, [_row()], AT) is None


async def test_coverage_read_maps_rows_to_coverage():
    assert await _db(_Pool()).read_port_call_coverage() == {"020": Coverage(date(2026, 8, 30), D, AT)}


async def test_coverage_read_failure_is_none_not_empty():
    class Broken(_Pool):
        async def fetch(self, sql: str):
            raise TimeoutError

    db = _db(Broken())
    assert await db.read_port_call_coverage() is None and db.failures == 1


async def test_retention_deletes_old_rows_and_lifts_the_coverage_start_in_one_transaction():
    pool = _Pool()
    db = _db(pool)
    db.start()
    db.purge_port_calls(date(2026, 7, 31))
    for _ in range(100):
        if db.pending == 0 and "COMMIT" in pool.log:
            break
        import asyncio

        await asyncio.sleep(0.01)
    await db.close(drain_s=1)
    sqls = [x[1].strip().split()[0] for x in pool.log if isinstance(x, tuple) and x[0] == "execute"]
    assert sqls == ["DELETE", "UPDATE"] and pool.log[0] == "BEGIN" and "COMMIT" in pool.log
    assert all(x[2] == (date(2026, 7, 31),) for x in pool.log if isinstance(x, tuple) and x[0] == "execute")
