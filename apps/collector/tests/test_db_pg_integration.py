"""실 PostgreSQL 대조(선택 실행): WAKELINE_TEST_PG_URL(수집기 계정 wakeline_collector, api 의 --migrate 로 스키마를 올린 버리는 DB)이 있을 때만.

가짜 풀(test_db_writer.py)로는 확인할 수 없는 것 — record_run 의 실제 SQL(열·인자 순서, ON CONFLICT (run_key) 대상, 형 변환)이 asyncpg
(uuid.UUID 인자)로 V12 스키마에서 돈다는 것, 그리고 COMMIT 이 서버에 반영된 뒤 응답을 잃은 재시도(R-91, 계약 v5 §D2)가 실제 DB 에서도
실행 기록 · 품질 사례 · 규칙별 건수를 한 번만 남긴다는 것. api 쪽 MigrationDbTest 는 V12 의 제약을 손으로 쓴 문장으로 확인한다 — 이 시험은 db.py 자체를 돌린다.
실행(버리는 컨테이너 — 개발 스택의 DB 가 아니다. 시험 행은 지우지 않는다: 수집기 계정에는 DELETE 권한이 없다):
  docker run --rm -d --name wl-pgtest -p 127.0.0.1:55432:5432 -e POSTGRES_PASSWORD=root -e DB_MIGRATOR_PASSWORD=mig \
      -e DB_API_PASSWORD=api -e DB_COLLECTOR_PASSWORD=col -v "$PWD/infra/db/init:/docker-entrypoint-initdb.d:ro" imresamu/postgis:18-3.6
  (cd apps/api && DB_HOST=127.0.0.1 DB_PORT=55432 DB_NAME=wakeline DB_MIGRATOR_PASSWORD=mig ./gradlew -q bootRun --args=--migrate)
  WAKELINE_TEST_PG_URL=postgresql://wakeline_collector:col@127.0.0.1:55432/wakeline uv run pytest tests/test_db_pg_integration.py
"""

from __future__ import annotations

import asyncio
import os
import uuid
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from typing import Any

import asyncpg
import pytest

from wakeline_collector import db as dbmod
from wakeline_collector.db import Db

URL = os.environ.get("WAKELINE_TEST_PG_URL", "")
pytestmark = pytest.mark.skipif(not URL, reason="WAKELINE_TEST_PG_URL not set (opt-in real PostgreSQL check)")


class _Conn:
    """실제 연결을 그대로 쓰되, 트랜잭션이 커밋된 **뒤** 정해진 횟수만큼 TimeoutError 를 낸다(응답을 잃은 COMMIT)."""

    def __init__(self, conn: Any, owner: AmbiguousCommitPool):
        self._conn = conn
        self._owner = owner

    def __getattr__(self, name: str) -> Any:
        return getattr(self._conn, name)

    @asynccontextmanager
    async def transaction(self):
        async with self._conn.transaction():
            yield
        self._owner.commits += 1  # 여기까지 오면 COMMIT 이 서버에 반영됐다
        if self._owner.timeouts_after_commit > 0:
            self._owner.timeouts_after_commit -= 1
            raise TimeoutError  # …그런데 응답을 받기 전에 시간 초과(결과가 모호한 실패) — writer 는 일시 오류로 보고 다시 실행한다


class AmbiguousCommitPool:
    def __init__(self, pool: asyncpg.Pool, timeouts_after_commit: int):
        self._pool = pool
        self.timeouts_after_commit = timeouts_after_commit
        self.commits = 0

    async def fetchval(self, sql: str, *args: Any) -> Any:  # writer 의 생존 확인(SELECT 1)
        return await self._pool.fetchval(sql, *args)

    @asynccontextmanager
    async def acquire(self):
        async with self._pool.acquire() as conn:
            yield _Conn(conn, self)

    async def close(self) -> None:
        pass  # 실제 풀은 시험이 닫는다


@pytest.fixture(autouse=True)
def fast_backoff(monkeypatch):
    monkeypatch.setattr(dbmod, "RECONNECT_MIN_S", 0.02)
    monkeypatch.setattr(dbmod, "RECONNECT_MAX_S", 0.05)


@pytest.fixture
async def pg():
    pool = await asyncpg.create_pool(URL, min_size=1, max_size=3, server_settings={"timezone": "UTC"})
    yield pool
    await pool.close()


async def _settle(db: Db, timeout: float = 10.0) -> None:
    async def wait() -> None:
        while db.pending:
            await asyncio.sleep(0.02)

    await asyncio.wait_for(wait(), timeout)


async def test_record_run_retried_after_a_lost_commit_reply_is_one_run_on_real_postgres(pg):
    tag = uuid.uuid4().hex[:10]
    job, rule = f"pgtest_{tag}", f"pgtest_rule_{tag}"  # 이 시험의 행만 센다(지우지 못하므로 매번 새 이름)
    pool = AmbiguousCommitPool(pg, timeouts_after_commit=1)

    async def factory() -> AmbiguousCommitPool:
        return pool

    db = Db(factory)
    db.start()
    started = datetime.now(UTC)
    db.record_run(
        job,
        "adsb_lol",
        started,
        status="ok",
        http_status=200,
        latency_ms=12,
        records_in=7,
        records_quarantined=25,
        raw_ref="raw/x.json",
        quality=[(rule, f"{i:06x}", {"i": i}) for i in range(25)],
    )
    await _settle(db)
    await db.close()
    assert pool.commits == 2, "the retry reached the database a second time"
    assert (db.failures, db.written, db.dropped) == (1, 1, 0)

    runs = await pg.fetch(
        """SELECT id, run_key, provider, started_at, status, http_status, latency_ms, records_in, records_quarantined, raw_ref, error_text
           FROM ingest_run WHERE job = $1""",
        job,
    )
    assert len(runs) == 1, runs  # 재시도했지만 실행 기록은 하나
    r = runs[0]
    assert isinstance(r["run_key"], uuid.UUID) and r["run_key"].version == 4
    assert (
        r["provider"],
        r["status"],
        r["http_status"],
        r["latency_ms"],
        r["records_in"],
        r["records_quarantined"],
        r["raw_ref"],
    ) == (
        "adsb_lol",
        "ok",
        200,
        12,
        7,
        25,
        "raw/x.json",
    )  # 인자 순서가 열 순서와 맞는다
    assert r["started_at"] == started and r["error_text"] is None
    assert await pg.fetchval("SELECT count(*) FROM quality_event WHERE rule = $1", rule) == 20  # 대표 사례 20건, 한 번만
    assert await pg.fetchval("SELECT count(*) FROM quality_event WHERE rule = $1 AND run_id = $2", rule, r["id"]) == 20
    assert await pg.fetchval("SELECT count FROM quality_rule_count WHERE rule = $1", rule) == 25  # 규칙별 건수도 두 배가 아니다


async def test_two_runs_are_two_rows_on_real_postgres(pg):
    job = f"pgtest_{uuid.uuid4().hex[:10]}"

    pool = AmbiguousCommitPool(pg, timeouts_after_commit=0)  # 모호한 실패 없음 — 닫기는 시험이(실제 풀을 계속 읽는다)

    async def factory() -> AmbiguousCommitPool:
        return pool

    db = Db(factory)
    db.start()
    now = datetime.now(UTC)
    db.record_run(job, "adsb_lol", now, status="ok")
    db.record_run(job, "adsb_lol", now, status="error", http_status=503, error_text="HTTP 503")
    await _settle(db)
    await db.close()
    rows = await pg.fetch("SELECT run_key, status FROM ingest_run WHERE job = $1 ORDER BY id", job)
    assert [x["status"] for x in rows] == ["ok", "error"]
    assert rows[0]["run_key"] != rows[1]["run_key"]
