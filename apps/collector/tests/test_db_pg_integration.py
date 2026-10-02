"""실 PostgreSQL 대조(선택 실행): WAKELINE_TEST_PG_URL(수집기 계정 wakeline_collector, api 의 --migrate 로 스키마를 올린 버리는 DB)이 있을 때만.

가짜 풀(test_db_writer.py)로는 확인할 수 없는 것 — record_run 의 실제 SQL(열·인자 순서, ON CONFLICT (run_key) 대상, 형 변환)이 asyncpg
(uuid.UUID 인자)로 V12 스키마에서 돈다는 것, 그리고 COMMIT 이 서버에 반영된 뒤 응답을 잃은 재시도(R-91, 계약 v5 §D2)가 실제 DB 에서도
실행 기록 · 품질 사례 · 규칙별 건수를 한 번만 남긴다는 것. api 쪽 MigrationDbTest 는 V12 의 제약을 손으로 쓴 문장으로 확인한다 — 이 시험은 db.py 자체를 돌린다.
실행: `make test-collector-db`(= bash infra/tests/collector_pg_test.sh — make infra-docker-test 에도 들어 있다). 버리는 컨테이너(운영과 같은 db 이미지
wakeline-db:local · 임의 포트 · 임의 비밀번호 — 개발 스택의 DB 가 아니다)에 api 의 마이그레이션을 migrator 계정으로 올리고 이 파일을 수집기 계정으로 돌린다.
건너뛴 시험이 하나라도 있으면 실패다. 시험 행은 지우지 않는다(수집기 계정에는 DELETE 권한이 없다 — 컨테이너째 버린다).
"""

from __future__ import annotations

import asyncio
import os
import uuid
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from typing import Any
from urllib.parse import unquote, urlparse

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


async def test_a_cell_parsed_from_the_real_wfs_response_is_stored_and_restored_by_the_next_start(fixtures_dir):
    """ADR-023 개정(2026-10-01) — '찾은 칸이 marine_grid4 에 남아 다음 기동이 다시 묻지 않는가': 실제 WFS 응답(바이트 그대로의 fixture)을 해석한 값이
    V14 CHECK 를 통과해 저장되고, 다음 기동의 읽기(GridGeometry.load_cells — 격자 검사를 다시 한다)가 같은 칸으로 되살린다. 시험 행은 지우지
    않으므로 칸 번호만 새 이름으로 바꾼다(값은 해석한 그대로)."""
    from wakeline_collector.jobs.traffic_grid import GridGeometry
    from wakeline_collector.marine_grid import Cell, parse_wfs

    got = parse_wfs((fixtures_dir / "mof_grid4_wfs_GR4_F2K41_C3.xml").read_bytes(), "GR4_F2K41_C3")
    assert got.kind == "found" and got.cell is not None
    c = got.cell
    g = f"GR4_W{uuid.uuid4().hex[:8]}"
    pool = await asyncpg.create_pool(URL, min_size=1, max_size=2)

    async def factory() -> Any:
        return pool

    db = Db(pool_factory=factory)
    db.start()
    try:
        db.upsert_marine_grid4([Cell(g, c.lat_min, c.lon_min, c.lat_max, c.lon_max, c.gid)], datetime.now(UTC))
        for _ in range(300):
            if db.pending == 0:
                break
            await asyncio.sleep(0.02)
        rows = await db.read_marine_grid4()
        assert rows is not None and db.dropped == 0
        mine = [r for r in rows if r[0] == g]
        assert mine == [(g, c.lat_min, c.lon_min, c.lat_max, c.lon_max, c.gid)]
        restored = GridGeometry()
        assert restored.load_cells(mine) == (1, 0)
        assert restored.cells[g] == Cell(g, 37.45, 126.6, 37.475, 126.625, 167305)
        assert restored.observe([(g, 3)], datetime.now(UTC)) == 0  # 다음 기동은 이 칸을 대기열에 넣지 않는다(다시 묻지 않는다)
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


class FreezeProxy:
    """TCP 중계 — 얼리면(freeze) 오가는 바이트를 붙들어 두고 새 연결도 잇지 않는다. 얼어붙은 DB 서버(멈춘 VM · 끊긴 망 · docker pause)처럼 TCP 는 열린 채
    답이 없다(커널은 받지만 프로세스가 답하지 않는다). 풀면(thaw) 붙들어 둔 것부터 그대로 잇는다."""

    def __init__(self, host: str, port: int) -> None:
        self.host, self.port = host, port
        self.flowing = asyncio.Event()
        self.flowing.set()
        self.server: asyncio.base_events.Server | None = None
        self.listen_port = 0
        self._writers: list[asyncio.StreamWriter] = []

    async def start(self) -> None:
        self.server = await asyncio.start_server(self._client, "127.0.0.1", 0)
        self.listen_port = self.server.sockets[0].getsockname()[1]

    async def _client(self, cr: asyncio.StreamReader, cw: asyncio.StreamWriter) -> None:
        self._writers.append(cw)
        await self.flowing.wait()  # 얼린 동안 새 연결은 받기만 하고 잇지 않는다
        try:
            ur, uw = await asyncio.open_connection(self.host, self.port)
        except OSError:
            cw.close()
            return
        self._writers.append(uw)
        await asyncio.gather(self._pump(cr, uw), self._pump(ur, cw), return_exceptions=True)

    async def _pump(self, r: asyncio.StreamReader, w: asyncio.StreamWriter) -> None:
        try:
            while data := await r.read(65536):
                await self.flowing.wait()  # 얼린 동안 전하지 않는다
                w.write(data)
                await w.drain()
        finally:
            w.close()

    def freeze(self) -> None:
        self.flowing.clear()

    def thaw(self) -> None:
        self.flowing.set()

    def close(self) -> None:
        self.thaw()
        for w in self._writers:
            w.close()
        if self.server is not None:
            self.server.close()


async def test_a_frozen_database_does_not_hold_the_writer_past_its_time_limits(monkeypatch, pg):
    """얼어붙은 DB(TCP 는 열린 채 답이 없음): writer 는 작업 상한(OP_TIMEOUT_S) 근처에서 실패로 끝내고 db_ok 를 0 으로 알린다 — 풀면 쌓인 쓰기를 쓴다.
    예전: 시간 초과 · 취소된 명령의 취소를 asyncpg 가 서버의 답까지 상한 없이 기다려(풀 반납 · 트랜잭션 ROLLBACK) writer 가 얼린 내내 멈췄고 db_ok 는 1 로
    남았다(격리 스택 docker pause 45 s — VERIFICATION #110). 운영 풀(_create_pool) 그대로 — 중계(FreezeProxy)를 거쳐 실제 PostgreSQL 로."""
    u = urlparse(URL)
    proxy = FreezeProxy(u.hostname or "127.0.0.1", u.port or 5432)
    await proxy.start()
    monkeypatch.setattr(dbmod.settings, "db_host", "127.0.0.1")
    monkeypatch.setattr(dbmod.settings, "db_port", proxy.listen_port)
    monkeypatch.setattr(dbmod.settings, "db_name", u.path.lstrip("/"))
    monkeypatch.setattr(dbmod.settings, "db_collector_password", unquote(u.password or ""))
    monkeypatch.setattr(dbmod, "OP_TIMEOUT_S", 1.0)
    monkeypatch.setattr(dbmod, "PROBE_TIMEOUT_S", 1.0)
    monkeypatch.setattr(dbmod, "PROBE_INTERVAL_S", 0.2, raising=False)
    # 빌림 상한은 길게 — asyncpg 는 반납 정리에도 이 상한을 쓰고 넘기면 스스로 연결을 버린다. 이 시험은 그 뒷받침이 아니라 감싸개가 끊긴 명령의 연결을
    # 곧바로 버리는지(풀 반납 · 트랜잭션 ROLLBACK 이 취소 답을 기다리지 않는지)를 본다 — 고치기 전에는 얼린 내내 멈췄다
    monkeypatch.setattr(dbmod, "ACQUIRE_TIMEOUT_S", 30.0, raising=False)
    tag = uuid.uuid4().hex[:10]
    providers = [f"pgfreeze_{tag}_{i}" for i in range(3)]
    job = f"pgfreeze_{tag}"
    loop = asyncio.get_running_loop()
    db = Db()
    db.start()
    try:
        db.upsert_budget_day(providers[0], datetime.now(UTC), 1, 10)
        await _settle(db)
        assert db.available
        froze = False

        async def mid_transaction(pool: Any) -> None:
            """트랜잭션 가운데(BEGIN · INSERT 뒤)에서 서버가 얼어붙는다 — 끊긴 트랜잭션에 ROLLBACK 을 보내면 asyncpg 는 취소 답을 기다린다."""
            nonlocal froze
            async with pool.acquire() as conn, conn.transaction():
                await conn.execute(
                    "INSERT INTO provider_budget_day (provider, day, calls, limit_value) VALUES ($1, $2, 3, 10)",
                    providers[2],
                    datetime.now(UTC).date(),
                )
                if not froze:
                    froze = True
                    proxy.freeze()
                await conn.execute("SELECT 1")

        t0 = loop.time()
        db._submit("mid_transaction", mid_transaction)  # 진행 중에 얼어붙는 작업
        db.record_run(job, "adsb_lol", datetime.now(UTC), status="ok")  # 뒤에 쌓이는 트랜잭션(실행 기록)
        db.upsert_budget_day(providers[1], datetime.now(UTC), 2, 10)
        reported = None
        try:
            while loop.time() - t0 < 8:  # 작업 1 s · 확인 1 s · 빌림 1 s 의 몇 배
                if not db.available:
                    reported = loop.time() - t0
                    break
                await asyncio.sleep(0.05)
        finally:
            proxy.thaw()
        assert reported is not None, (
            "the writer stayed stuck on the frozen database (db_ok stayed 1) — it did not end the write at its time limit"
        )
        assert reported < 5.0
        thawed = loop.time()
        await _settle(db, timeout=15)  # 풀면 쌓인 쓰기를 쓴다
        print(
            f"frozen db: db_ok=0 after {reported:.2f} s (op limit {dbmod.OP_TIMEOUT_S} s); queued write in {loop.time() - thawed:.2f} s after thaw"
        )
        assert db.available
        n = await pg.fetchval("SELECT count(*) FROM provider_budget_day WHERE provider = ANY($1::text[])", providers)
        assert n == 3  # 끊긴 트랜잭션은 서버가 되돌렸고, 풀린 뒤 다시 실행해 한 번
        assert (
            await pg.fetchval("SELECT count(*) FROM ingest_run WHERE job = $1", job) == 1
        )  # 끊긴 트랜잭션은 서버가 되돌렸고 다시 실행해 하나
    finally:
        await db.close(drain_s=2)
        proxy.close()
