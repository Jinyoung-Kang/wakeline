"""실 PostgreSQL 대조(선택 실행): WAKELINE_TEST_PG_URL(수집기 계정 wakeline_collector, api 의 --migrate 로 스키마를 올린 버리는 DB)이 있을 때만.

가짜 풀(test_db_writer.py)로는 확인할 수 없는 것 — record_run 의 실제 SQL(열·인자 순서, ON CONFLICT (run_key) 대상, 형 변환)이 asyncpg
(uuid.UUID 인자)로 V12 스키마에서 돈다는 것, 그리고 COMMIT 이 서버에 반영된 뒤 응답을 잃은 재시도(R-91, 계약 v5 §D2)가 실제 DB 에서도
실행 기록 · 품질 사례 · 규칙별 건수를 한 번만 남긴다는 것. api 쪽 MigrationDbTest 는 V12 의 제약을 손으로 쓴 문장으로 확인한다 — 이 시험은 db.py 자체를 돌린다.
실행(버리는 컨테이너 — 개발 스택의 DB 가 아니다. 시험 행은 지우지 않는다: 수집기 계정에는 DELETE 권한이 없다):
  docker run --rm -d --name wl-pgtest -p 127.0.0.1:55432:5432 -e POSTGRES_PASSWORD=root -e DB_MIGRATOR_PASSWORD=mig \
      -e DB_API_PASSWORD=api -e DB_COLLECTOR_PASSWORD=col -v "$PWD/infra/db/init:/docker-entrypoint-initdb.d:ro" wakeline-db:local   # make build(또는 docker build -t wakeline-db:local infra/db) 뒤
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


async def test_marine_grid4_upsert_and_read_on_the_v14_schema():
    """ADR-023: db.py 의 격자 기하 upsert(ON CONFLICT grid_no) · 읽기가 V14 스키마와 수집기 권한으로 돈다. 격자에 맞지 않는 행은 V14 CHECK 가
    거절하고, 행별 재시도(_executemany_rowwise_on_reject)가 그 행만 버린다. 시험 행은 지우지 않는다(수집기 계정에 DELETE 권한이 없다)."""
    from wakeline_collector.marine_grid import Cell

    pool = await asyncpg.create_pool(URL, min_size=1, max_size=2)

    async def factory() -> Any:
        return pool

    db = Db(pool_factory=factory)
    db.start()
    g = f"GR4_T{uuid.uuid4().hex[:8]}"
    at = datetime.now(UTC)
    try:
        db.upsert_marine_grid4([Cell(g, 37.45, 126.6, 37.475, 126.625, 7)], at)
        db.upsert_marine_grid4([Cell(g, 37.45, 126.6, 37.475, 126.625, 8)], at)  # 같은 칸 — 마지막 값
        db.upsert_marine_grid4(
            [Cell(g + "X", 37.4512, 126.6, 37.4762, 126.625, None), Cell(g + "Y", 37.425, 126.6, 37.45, 126.625, None)], at
        )
        for _ in range(300):
            if db.pending == 0:
                break
            await asyncio.sleep(0.02)
        rows = await db.read_marine_grid4()
        assert rows is not None
        mine = {r[0]: r for r in rows if r[0].startswith(g)}
        assert mine[g] == (g, 37.45, 126.6, 37.475, 126.625, 8)
        assert g + "Y" in mine and g + "X" not in mine
        assert db.dropped == 1
    finally:
        await db.close(drain_s=2)


async def test_port_call_day_upsert_withdraw_and_coverage_on_the_v15_schema():
    """ADR-022 개정: db.py 의 하루 적용(upsert · 철회된 신고 삭제 · 범위 넓히기 · refreshed_at · 빈 날 확인)과 보존 정리가 V15 스키마와 수집기
    권한으로 돈다. 값이 바뀐 행만 updated_at 이 바뀐다. 시험 행은 지운다(수집기 계정에 port_call DELETE 가 있다 — 범위 행은 못 지우므로 매번 새 코드)."""
    import random
    from datetime import date, timedelta

    from wakeline_collector.portcalls import Coverage, PortCallRow

    pool = await asyncpg.create_pool(URL, min_size=1, max_size=2)

    async def factory() -> Any:
        return pool

    db = Db(pool_factory=factory)
    pa = f"{random.randint(900, 999)}"  # 실제 항만청이 아닌 코드(범위 행은 수집기가 지우지 못한다 — 겹쳐도 reset 으로 시작)
    tag = uuid.uuid4().hex[:4].upper()
    day = date(2026, 9, 24)
    t1 = datetime(2026, 9, 29, 13, 0, tzinfo=UTC)
    t2 = datetime(2026, 9, 29, 14, 0, tzinfo=UTC)

    def row(cs: str, **kw: Any) -> PortCallRow:
        return PortCallRow(
            prt_ag_cd=pa, clsgn=cs, etrypt_year="2026", etrypt_co="005", listed_date=day, vssl_nm="AZAMARA PURSUIT", **kw
        )

    a, b = f"A{tag}", f"B{tag}"
    try:
        entry = datetime(2026, 9, 23, 23, 17, tzinfo=UTC)
        res = await db.apply_port_call_day(pa, day, [row(a, entry_at=entry, entry_revision="최초"), row(b)], t1, reset=True)
        assert res is not None and res.merged and res.coverage == Coverage(day, day, None) and res.upserted == 2
        # 같은 날을 다시: a 는 최종 신고 · 출항이 붙었다, b 는 그대로, 새 행 없음
        exit_ = datetime(2026, 9, 25, 5, 24, tzinfo=UTC)
        a2 = row(a, entry_at=entry, entry_revision="최종", exit_at=exit_, exit_revision="최종", berth="북항크루즈터미널 2선석")
        res = await db.apply_port_call_day(pa, day, [a2, row(b)], t2, refreshed_at=t2)
        assert res is not None and res.coverage == Coverage(day, day, t2)
        got = {r["clsgn"]: r for r in await pool.fetch("SELECT * FROM port_call WHERE prt_ag_cd = $1", pa)}
        assert got[a]["exit_at"] == exit_ and got[a]["entry_revision"] == "최종" and got[a]["berth"] == "북항크루즈터미널 2선석"
        assert (got[a]["fetched_at"], got[a]["updated_at"]) == (t2, t2)  # 값이 바뀌었다
        assert (got[b]["fetched_at"], got[b]["updated_at"]) == (t2, t1)  # 다시 받았지만 값은 같다
        # 이웃한 날이 범위를 넓힌다 · 떨어진 날은 행만 적고 범위는 그대로
        res = await db.apply_port_call_day(pa, day + timedelta(days=1), [], t2)
        assert res is not None and res.merged and res.coverage == Coverage(day, day + timedelta(days=1), t2)
        res = await db.apply_port_call_day(pa, day + timedelta(days=5), [], t2)
        assert res is not None and not res.merged and res.coverage == Coverage(day, day + timedelta(days=1), t2)
        assert (await db.read_port_call_coverage() or {})[pa] == Coverage(day, day + timedelta(days=1), t2)
        # 빈 응답: 저장된 행이 2개 — 먼저 지키고, 확인한 뒤에 지운다(철회된 신고)
        res = await db.apply_port_call_day(pa, day, [], t2, refuse_empty_over=2)
        assert res is not None and res.suspect_empty and res.stored == 2
        res = await db.apply_port_call_day(pa, day, [a2], t2)
        assert res is not None and res.deleted == 1
        assert [r["clsgn"] for r in await pool.fetch("SELECT clsgn FROM port_call WHERE prt_ag_cd = $1", pa)] == [a]
        # 보존: 그 날 이전을 지우고 범위의 시작을 올린다
        db.start()
        db.purge_port_calls(day + timedelta(days=1))
        for _ in range(300):
            if db.pending == 0:
                break
            await asyncio.sleep(0.02)
        await asyncio.sleep(0.1)
        assert await pool.fetchval("SELECT count(*) FROM port_call WHERE prt_ag_cd = $1", pa) == 0
        assert (await db.read_port_call_coverage() or {})[pa] == Coverage(day + timedelta(days=1), day + timedelta(days=1), t2)
    finally:
        await pool.execute("DELETE FROM port_call WHERE prt_ag_cd = $1", pa)
        await db.close(drain_s=2)  # 풀도 닫는다


async def test_a_day_with_two_times_in_one_revision_is_accepted_by_the_v15_checks():
    """리뷰 재현(2026-09-29): 한 판(최종)에 입항 시각이 둘인 item 을 해석한 행이 V15 CHECK port_call_revision_needs_time 에 걸려 그 날 전체가
    되돌려졌다. 이제 해석기는 시각도 판 이름도 두지 않는다 — 같은 날의 다른 행과 함께 실제 V15 에 들어간다."""
    import copy
    import random
    from datetime import date

    from portmis_observed import response, synthetic_item

    from wakeline_collector.portcalls import parse_index_page

    pa = f"{random.randint(900, 999)}"
    tag = uuid.uuid4().hex[:4].upper()
    day = date(2026, 9, 24)
    amb = synthetic_item(pa=pa, clsgn=f"M{tag}", entry="2026-09-24T07:00:00+09:00", count="009")
    details = amb.find("details")
    assert details is not None
    second = copy.deepcopy(details[0])
    second.find("etryptDt").text = "2026-09-24T08:17:00+09:00"  # type: ignore[union-attr]
    details.append(second)
    ok = synthetic_item(pa=pa, clsgn=f"K{tag}", entry="2026-09-24T10:00:00+09:00", count="010")
    rows = parse_index_page(response([amb, ok], 2, 1, 50), pa, day).rows
    assert len(rows) == 2
    pool = await asyncpg.create_pool(URL, min_size=1, max_size=2)

    async def factory() -> Any:
        return pool

    db = Db(pool_factory=factory)
    try:
        res = await db.apply_port_call_day(pa, day, rows, datetime.now(UTC), reset=True)
        assert res is not None and res.applied and res.upserted == 2
        got = {r["clsgn"]: r for r in await pool.fetch("SELECT * FROM port_call WHERE prt_ag_cd = $1", pa)}
        assert (got[f"M{tag}"]["entry_at"], got[f"M{tag}"]["entry_revision"]) == (None, None)
        assert got[f"K{tag}"]["entry_revision"] == "최종"
    finally:
        await pool.execute("DELETE FROM port_call WHERE prt_ag_cd = $1", pa)
        await db.close(drain_s=2)


async def test_hole_days_and_a_refused_day_on_the_v15_schema():
    """빈 곳(hole_days): 끝까지 색인하지 못한 날은 지우지 않고 범위를 넓히며 그 날을 적는다 · 끝까지 색인하면 뺀다 · 보존 정리가 cutoff 앞의 것을
    뺀다. DB 가 행을 거절하면(CHECK) None(장애)이 아니라 rejected — 트랜잭션은 되돌려진다."""
    import random
    from datetime import date, timedelta

    from wakeline_collector.portcalls import Coverage, PortCallRow

    pool = await asyncpg.create_pool(URL, min_size=1, max_size=2)

    async def factory() -> Any:
        return pool

    db = Db(pool_factory=factory)
    pa = f"{random.randint(900, 999)}"
    tag = uuid.uuid4().hex[:4].upper()
    d1, d2, d3 = date(2026, 9, 24), date(2026, 9, 25), date(2026, 9, 26)
    at = datetime(2026, 9, 29, 13, 0, tzinfo=UTC)

    def row(cs: str, day: date, **kw: Any) -> PortCallRow:
        return PortCallRow(prt_ag_cd=pa, clsgn=cs, etrypt_year="2026", etrypt_co="001", listed_date=day, **kw)

    a, b = f"A{tag}", f"B{tag}"
    try:
        res = await db.apply_port_call_day(pa, d1, [row(a, d1), row(b, d1)], at, reset=True)
        assert res is not None and res.coverage == Coverage(d1, d1, None)
        # d1 을 다시 받았는데 끝까지 색인하지 못했다(키 있는 a 만) — b 를 지우지 않고 d1 을 빈 곳으로
        res = await db.apply_port_call_day(pa, d1, [row(a, d1)], at, hole=True, refuse_empty_over=1)
        assert res is not None and res.applied and res.deleted == 0 and res.coverage == Coverage(d1, d1, None, frozenset({d1}))
        assert await pool.fetchval("SELECT count(*) FROM port_call WHERE prt_ag_cd = $1", pa) == 2
        res = await db.apply_port_call_day(pa, d2, [], at, hole=True)  # 빈 곳도 범위는 넓힌다
        assert res is not None and res.coverage == Coverage(d1, d2, None, frozenset({d1, d2}))
        res = await db.apply_port_call_day(pa, d3, [], at, refreshed_at=at)
        assert res is not None and res.coverage == Coverage(d1, d3, at, frozenset({d1, d2}))
        assert (await db.read_port_call_coverage() or {})[pa] == Coverage(d1, d3, at, frozenset({d1, d2}))
        # d2 를 끝까지 색인했다 — 빈 곳에서 뺀다
        res = await db.apply_port_call_day(pa, d2, [], at)
        assert res is not None and res.coverage == Coverage(d1, d3, at, frozenset({d1}))
        # DB 가 거절하는 행(형식 CHECK) — 장애가 아니라 rejected, 되돌려졌다(범위 · 행 그대로)
        res = await db.apply_port_call_day(pa, d3, [row("bad-cs", d3)], at)
        assert res is not None and res.rejected == "CheckViolationError" and not res.applied
        assert (await db.read_port_call_coverage() or {})[pa] == Coverage(d1, d3, at, frozenset({d1}))
        # 보존: cutoff 앞의 빈 곳도 뺀다
        db.start()
        db.purge_port_calls(d1 + timedelta(days=1))
        for _ in range(300):
            if db.pending == 0:
                break
            await asyncio.sleep(0.02)
        await asyncio.sleep(0.1)
        assert (await db.read_port_call_coverage() or {})[pa] == Coverage(d2, d3, at, frozenset())
    finally:
        await pool.execute("DELETE FROM port_call WHERE prt_ag_cd = $1", pa)
        await db.close(drain_s=2)
