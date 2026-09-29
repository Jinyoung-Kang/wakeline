"""수집 전용 DB 역할(wakeline_collector)로 ingest 테이블에만 쓴다. 테이블은 api 의 Flyway 가 만든다.

DB 쓰기는 부가 경로다(설계 5.1 "실시간 경로는 DB에 의존하지 않음", 계약 §5).
- 작업은 쓰기를 큐에 넣고 바로 돌아간다(await 하지 않음). 백그라운드 writer 하나가 순서대로 기록한다.
- DB 가 내려가 있으면 writer 가 재연결을 기다리며 큐(최대 500건)에 보관하고, 넘치면 오래된 것부터 버린다.
- 실패는 예외 종류로 가른다(COL-3). 제약 위반·자료형·문법/권한 오류처럼 결정적인 것은 재시도해도 같으므로 그 작업만 버린다.
  시간 초과·쿼리 취소·교착·잠금 대기·연결 끊김처럼 일시적인 것은 맨 앞에 두고 물러났다가 다시 시도한다.
  DB 가 응답하는데도 같은 작업이 일시 오류로 MAX_ATTEMPTS 번 실패하면(독이 든 작업) 큐를 막지 않도록 버린다.
  DB 가 응답하지 않는 동안의 실패는 시도 횟수에 세지 않는다(장애 동안 보관한다는 약속).
- 실패·버림은 건수로 집계해 heartbeat(wakeline:collector)로 노출하고, 경고 로그는 분당 1회로 제한한다.
- 시간 초과는 COMMIT 이 서버에 반영된 뒤 응답을 받기 전에도 날 수 있다(결과가 모호한 실패). 그래서 재시도되는 쓰기는 멱등이어야 한다 —
  upsert 는 원래 멱등이고, 실행 기록(record_run)은 실행마다 만든 run_key(uuid)로 한 번만 들어간다(R-91, 계약 v5 §D2 · ADR-019).
"""

from __future__ import annotations

import asyncio
import logging
import time
import uuid
from collections import deque
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import UTC, date, datetime
from typing import Any

import asyncpg
import orjson

from wakeline_collector.config import settings
from wakeline_collector.masking import mask
from wakeline_collector.portcalls import Coverage, PortCallRow, merge_day

log = logging.getLogger("db")

QUEUE_MAX = 500
OP_TIMEOUT_S = 10.0
PROBE_TIMEOUT_S = 5.0
RECONNECT_MIN_S, RECONNECT_MAX_S = 2.0, 30.0
QUALITY_SAMPLES_PER_RULE = 20
MAX_ATTEMPTS = 5  # DB 가 살아 있는데 일시 오류로 실패한 횟수 상한(독이 든 작업이 큐를 영원히 막지 않게)

# 재시도해도 결과가 같은 오류 → 그 작업만 버린다
PERMANENT_ERRORS: tuple[type[BaseException], ...] = (
    asyncpg.IntegrityConstraintViolationError,
    asyncpg.DataError,
    asyncpg.SyntaxOrAccessError,
    asyncpg.FeatureNotSupportedError,
    ValueError,  # 인자 인코딩 등 Python 쪽 결정적 오류
    TypeError,
    KeyError,
)
# 일시적 오류 → 맨 앞에 두고 물러났다가 재시도
TRANSIENT_ERRORS: tuple[type[BaseException], ...] = (
    TimeoutError,
    asyncpg.QueryCanceledError,
    asyncpg.OperatorInterventionError,
    asyncpg.DeadlockDetectedError,
    asyncpg.SerializationError,
    asyncpg.LockNotAvailableError,
    asyncpg.InsufficientResourcesError,
    asyncpg.PostgresConnectionError,
    asyncpg.InterfaceError,
    OSError,
    ConnectionError,
)


def classify_error(e: BaseException) -> str:
    """'transient' | 'permanent'. 모르는 예외는 일시적으로 보고 시도 횟수 상한에 맡긴다."""
    if isinstance(e, TRANSIENT_ERRORS):
        return "transient"
    if isinstance(e, PERMANENT_ERRORS):
        return "permanent"
    return "transient"


PoolFactory = Callable[[], Awaitable[Any]]

_METAR_UPSERT = """INSERT INTO metar_obs (icao, obs_time, raw, temp_c, dewp_c, wind_dir, wind_kt, vis_sm, vis_raw, ceiling_ft,
                                   ceiling_state, flight_cat, flight_cat_source, wx_string, taf_raw, provider, fetched_at)
   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
   ON CONFLICT (icao, obs_time) DO UPDATE SET raw=EXCLUDED.raw, temp_c=EXCLUDED.temp_c, dewp_c=EXCLUDED.dewp_c,
       wind_dir=EXCLUDED.wind_dir, wind_kt=EXCLUDED.wind_kt, vis_sm=EXCLUDED.vis_sm, vis_raw=EXCLUDED.vis_raw,
       ceiling_ft=EXCLUDED.ceiling_ft, ceiling_state=EXCLUDED.ceiling_state, flight_cat=EXCLUDED.flight_cat,
       flight_cat_source=EXCLUDED.flight_cat_source, wx_string=EXCLUDED.wx_string,
       taf_raw=EXCLUDED.taf_raw, provider=EXCLUDED.provider, fetched_at=EXCLUDED.fetched_at"""


# 연안 교통량 격자 기하 캐시(ADR-023 · V14 marine_grid4): 수집기가 WFS 로 확인한 칸만 쓴다(0.025° 격자 검사를 통과한 것 — marine_grid.cell_from_ring).
_MARINE_GRID4_UPSERT = """INSERT INTO marine_grid4 (grid_no, lat_min, lon_min, lat_max, lon_max, gid, fetched_at)
   VALUES ($1,$2,$3,$4,$5,$6,$7)
   ON CONFLICT (grid_no) DO UPDATE SET lat_min=EXCLUDED.lat_min, lon_min=EXCLUDED.lon_min, lat_max=EXCLUDED.lat_max,
       lon_max=EXCLUDED.lon_max, gid=EXCLUDED.gid, fetched_at=EXCLUDED.fetched_at"""
_MARINE_GRID4_SELECT = "SELECT grid_no, lat_min, lon_min, lat_max, lon_max, gid FROM marine_grid4"


# 한국 항만 입출항 색인(ADR-022 개정 · V15 port_call · port_call_coverage). 열 순서 = PortCallRow 의 필드 순서(키 넷 · listed_date · 나머지).
_PORT_CALL_COLS = (
    "prt_ag_cd", "clsgn", "etrypt_year", "etrypt_co", "listed_date", "prt_ag_nm", "vssl_nm", "nationality_cd", "nationality_nm", "kind_cd",
    "kind_nm", "purpose_nm", "first_port_cd", "first_port_nm", "prev_port_cd", "prev_port_nm", "next_port_cd", "next_port_nm", "dest_port_cd",
    "dest_port_nm", "entry_at", "entry_revision", "exit_at", "exit_revision", "berth",
)  # fmt: skip
# 값이 바뀐 행만 updated_at 을 바꾼다(fetched_at 은 받을 때마다) — updated_at = 신고가 마지막으로 고쳐진 것을 색인이 본 때.
# 열 목록은 _PORT_CALL_COLS 와 같은 순서다(test_db_port_calls 가 확인한다).
_PORT_CALL_UPSERT = """INSERT INTO port_call (prt_ag_cd, clsgn, etrypt_year, etrypt_co, listed_date, prt_ag_nm, vssl_nm, nationality_cd,
       nationality_nm, kind_cd, kind_nm, purpose_nm, first_port_cd, first_port_nm, prev_port_cd, prev_port_nm, next_port_cd, next_port_nm,
       dest_port_cd, dest_port_nm, entry_at, entry_revision, exit_at, exit_revision, berth, fetched_at, updated_at)
   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$26)
   ON CONFLICT (prt_ag_cd, clsgn, etrypt_year, etrypt_co) DO UPDATE SET listed_date=EXCLUDED.listed_date, prt_ag_nm=EXCLUDED.prt_ag_nm,
       vssl_nm=EXCLUDED.vssl_nm, nationality_cd=EXCLUDED.nationality_cd, nationality_nm=EXCLUDED.nationality_nm, kind_cd=EXCLUDED.kind_cd,
       kind_nm=EXCLUDED.kind_nm, purpose_nm=EXCLUDED.purpose_nm, first_port_cd=EXCLUDED.first_port_cd, first_port_nm=EXCLUDED.first_port_nm,
       prev_port_cd=EXCLUDED.prev_port_cd, prev_port_nm=EXCLUDED.prev_port_nm, next_port_cd=EXCLUDED.next_port_cd,
       next_port_nm=EXCLUDED.next_port_nm, dest_port_cd=EXCLUDED.dest_port_cd, dest_port_nm=EXCLUDED.dest_port_nm, entry_at=EXCLUDED.entry_at,
       entry_revision=EXCLUDED.entry_revision, exit_at=EXCLUDED.exit_at, exit_revision=EXCLUDED.exit_revision, berth=EXCLUDED.berth,
       fetched_at=EXCLUDED.fetched_at,
       updated_at=CASE WHEN (port_call.listed_date, port_call.prt_ag_nm, port_call.vssl_nm, port_call.nationality_cd, port_call.nationality_nm,
                             port_call.kind_cd, port_call.kind_nm, port_call.purpose_nm, port_call.first_port_cd, port_call.first_port_nm,
                             port_call.prev_port_cd, port_call.prev_port_nm, port_call.next_port_cd, port_call.next_port_nm,
                             port_call.dest_port_cd, port_call.dest_port_nm, port_call.entry_at, port_call.entry_revision, port_call.exit_at,
                             port_call.exit_revision, port_call.berth)
                   IS DISTINCT FROM (EXCLUDED.listed_date, EXCLUDED.prt_ag_nm, EXCLUDED.vssl_nm, EXCLUDED.nationality_cd, EXCLUDED.nationality_nm,
                             EXCLUDED.kind_cd, EXCLUDED.kind_nm, EXCLUDED.purpose_nm, EXCLUDED.first_port_cd, EXCLUDED.first_port_nm,
                             EXCLUDED.prev_port_cd, EXCLUDED.prev_port_nm, EXCLUDED.next_port_cd, EXCLUDED.next_port_nm,
                             EXCLUDED.dest_port_cd, EXCLUDED.dest_port_nm, EXCLUDED.entry_at, EXCLUDED.entry_revision, EXCLUDED.exit_at,
                             EXCLUDED.exit_revision, EXCLUDED.berth)
                   THEN EXCLUDED.updated_at ELSE port_call.updated_at END"""
# 하루를 끝까지 받았으면 그 날 목록에 없는 행은 철회된 신고다 — 지운다(목록 날짜가 바뀐 행은 새 날짜로 이미 옮겨졌다)
_PORT_CALL_DELETE_WITHDRAWN = """DELETE FROM port_call WHERE prt_ag_cd = $1 AND listed_date = $2
   AND (clsgn, etrypt_year, etrypt_co) NOT IN (SELECT * FROM unnest($3::text[], $4::text[], $5::text[]))"""
_PORT_CALL_COVERAGE_UPSERT = """INSERT INTO port_call_coverage (prt_ag_cd, covered_from, covered_to, refreshed_at, hole_days, updated_at)
   VALUES ($1, $2, $3, $4, $5::date[], $6)
   ON CONFLICT (prt_ag_cd) DO UPDATE SET covered_from=EXCLUDED.covered_from, covered_to=EXCLUDED.covered_to,
       refreshed_at=EXCLUDED.refreshed_at, hole_days=EXCLUDED.hole_days, updated_at=EXCLUDED.updated_at"""
_PORT_CALL_COVERAGE_SELECT = "SELECT prt_ag_cd, covered_from, covered_to, refreshed_at, hole_days FROM port_call_coverage"
# DB 가 그 날의 행을 거절한다(CHECK · NOT NULL · 자료형 — 해석기와 V15 가 어긋났다): 다시 보내도 같다. 장애(연결 · 시간 초과)와 나눠 알린다
_PORT_CALL_REFUSED = (asyncpg.IntegrityConstraintViolationError, asyncpg.DataError)


def _coverage(r: Any) -> Coverage:
    return Coverage(r["covered_from"], r["covered_to"], r["refreshed_at"], frozenset(r["hole_days"] or ()))


@dataclass(frozen=True)
class DayApplied:
    """하루 적용 결과. applied False = 아무것도 바꾸지 않았다 — suspect_empty: 저장된 행이 stored 개인데 원천이 0건(한 번 더 확인할 때까지 지우지
    않는다) · rejected: DB 가 그 날의 행을 거절했다(제약 · 자료형 위반 — 오류 종류 이름, 되돌려졌다. 다시 보내도 같으므로 장애와 나눈다 — coverage 는 None).
    merged False = 행은 적었지만 범위와 이어지지 않아 범위는 그대로(coverage 는 지금 범위)."""

    applied: bool
    coverage: Coverage | None
    merged: bool = False
    upserted: int = 0
    deleted: int = 0
    stored: int = 0
    suspect_empty: bool = False
    rejected: str | None = None


@dataclass
class _Op:
    name: str
    fn: Callable[[Any], Awaitable[None]]
    attempts: int = 0  # DB 가 응답하는 상태에서 일시 오류로 실패한 횟수


async def _create_pool() -> asyncpg.Pool:
    return await asyncpg.create_pool(
        host=settings.db_host,
        port=settings.db_port,
        database=settings.db_name,
        user="wakeline_collector",
        password=settings.db_collector_password,
        min_size=1,
        max_size=2,  # writer 1 + 생존 확인 1
        timeout=5,  # 연결 수립 상한(기본 60 s)
        command_timeout=OP_TIMEOUT_S,
        server_settings={"application_name": "wakeline-collector", "timezone": "UTC"},
    )


def quality_rows(
    events: list[tuple[str, str | None, dict[str, Any]]],
) -> tuple[list[tuple[str, str | None, str]], dict[str, int]]:
    """규칙별 대표 사례 최대 20건만 개별 저장, 나머지는 건수로 집계(운영 화면은 규칙별 건수 + 최근 사례)."""
    per_rule: dict[str, int] = {}
    rows: list[tuple[str, str | None, str]] = []
    for rule, hex_, detail in events:
        per_rule[rule] = per_rule.get(rule, 0) + 1
        if per_rule[rule] <= QUALITY_SAMPLES_PER_RULE:
            rows.append((rule, hex_, orjson.dumps(detail).decode()))
    return rows, per_rule


class Db:
    def __init__(self, pool_factory: PoolFactory | None = None) -> None:
        self._factory = pool_factory or _create_pool
        self._pool: Any = None
        self._q: deque[_Op] = deque()
        self._wake = asyncio.Event()  # 새 쓰기 도착
        self._stop = asyncio.Event()  # 종료 요청
        self._closing = False
        self._task: asyncio.Task | None = None
        self._pool_lock = asyncio.Lock()  # writer 와 읽기(read_marine_grid4)가 동시에 풀을 만들지 않게
        self._last_log = 0.0
        self._ok = False
        self.failures = 0  # 연결·쓰기 실패 누적(지표)
        self.dropped = 0  # 기록하지 못하고 버린 작업 누적(지표)
        self.written = 0

    # ---- 수명 주기 ----------------------------------------------------------------------------------------------
    def start(self) -> None:
        if self._task is None:
            self._task = asyncio.create_task(self._writer(), name="db-writer")

    async def close(self, drain_s: float = 5.0) -> None:
        """남은 쓰기를 drain_s 초 안에서 비우고 닫는다."""
        self._closing = True
        self._stop.set()
        self._wake.set()
        if self._task is not None:
            try:
                await asyncio.wait_for(self._task, drain_s)
            except (TimeoutError, asyncio.CancelledError):
                pass
            if not self._task.done():
                self._task.cancel()
        if self._q:
            self.dropped += len(self._q)
            log.warning("db: %d pending writes dropped at shutdown", len(self._q))
            self._q.clear()
        if self._pool is not None:
            try:
                await asyncio.wait_for(self._pool.close(), drain_s)
            except Exception as e:  # noqa: BLE001
                log.info("db: pool close: %s", type(e).__name__)

    # ---- 지표 ---------------------------------------------------------------------------------------------------
    @property
    def available(self) -> bool:
        return self._ok

    @property
    def pending(self) -> int:
        return len(self._q)

    def metrics(self) -> dict[str, str]:
        return {
            "db_ok": "1" if self._ok else "0",
            "db_pending": str(len(self._q)),
            "db_failures": str(self.failures),
            "db_dropped": str(self.dropped),
        }

    def _warn(self, msg: str, *args: object) -> None:
        now = time.monotonic()
        if now - self._last_log > 60:
            self._last_log = now
            log.warning(msg, *args)

    # ---- 큐·writer ---------------------------------------------------------------------------------------------
    def _submit(self, name: str, fn: Callable[[Any], Awaitable[None]]) -> None:
        if self._closing:
            self.dropped += 1
            return
        if len(self._q) >= QUEUE_MAX:
            self._q.popleft()
            self.dropped += 1
            self._warn("db: write queue full (%d) — dropping oldest (dropped=%d)", QUEUE_MAX, self.dropped)
        self._q.append(_Op(name, fn))
        self._wake.set()

    async def _ensure_pool(self) -> Any:
        if self._pool is None:
            async with self._pool_lock:
                if self._pool is not None:  # 기다리는 사이 다른 쪽이 만들었다
                    return self._pool
                try:
                    self._pool = await asyncio.wait_for(self._factory(), OP_TIMEOUT_S)
                except Exception as e:  # noqa: BLE001
                    self.failures += 1
                    self._ok = False
                    self._warn(
                        "db: connect failed (%s) — live path continues, writes queued (%d)", type(e).__name__, len(self._q)
                    )
        return self._pool

    async def _reachable(self, pool: Any) -> bool:
        try:
            await asyncio.wait_for(pool.fetchval("SELECT 1"), PROBE_TIMEOUT_S)
            return True
        except Exception:  # noqa: BLE001
            return False

    async def _pause(self, seconds: float) -> None:
        """재연결 대기(새 쓰기가 와도 깨지 않는다). 종료 요청이 오면 바로 깬다."""
        try:
            await asyncio.wait_for(self._stop.wait(), seconds)
        except TimeoutError:
            pass

    async def _writer(self) -> None:
        backoff = RECONNECT_MIN_S
        while True:
            try:
                if await self._step():
                    backoff = RECONNECT_MIN_S
                elif self._q and not self._closing:
                    await self._pause(backoff)
                    backoff = min(RECONNECT_MAX_S, backoff * 2)
            except asyncio.CancelledError:
                raise
            except Exception:  # noqa: BLE001 — writer 가 죽으면 기록이 조용히 멈춘다. 남기고 계속한다.
                log.exception("db writer: unexpected error")
                await self._pause(backoff)
            if self._closing and (not self._q or not self._ok):
                return

    async def _step(self) -> bool:
        """큐 맨 앞 작업 하나를 처리한다. True = 진행(기록 또는 버림), False = DB 불가(대기 필요)."""
        if not self._q:
            if self._closing:
                return True
            self._wake.clear()
            await self._wake.wait()
            return True
        pool = await self._ensure_pool()
        if pool is None:
            return False
        op = self._q[0]
        try:
            await asyncio.wait_for(op.fn(pool), OP_TIMEOUT_S)
        except Exception as e:  # noqa: BLE001
            self.failures += 1
            detail = (mask(str(e)) or "")[:160]
            if classify_error(e) == "permanent":
                # 이 작업 자체의 문제(제약 위반·스키마 불일치 등). 재시도해도 같으므로 버린다.
                self._pop(op)
                self.dropped += 1
                self._ok = await self._reachable(pool)
                log.warning("db: %s rejected (%s: %s) — dropped", op.name, type(e).__name__, detail)
                return True
            if await self._reachable(pool):
                # DB 는 응답한다 → 이 작업의 일시 오류(시간 초과·교착·잠금 대기 등). 맨 앞에 두고 물러났다 재시도.
                self._ok = True
                op.attempts += 1
                if op.attempts >= MAX_ATTEMPTS:
                    self._pop(op)
                    self.dropped += 1
                    log.warning(
                        "db: %s failed %d times while db is up (%s: %s) — dropped", op.name, op.attempts, type(e).__name__, detail
                    )
                    return True
                self._warn("db: %s transient failure #%d (%s) — retrying", op.name, op.attempts, type(e).__name__)
                return False
            self._ok = False
            self._warn("db: %s failed (%s) — db unreachable, keeping %d queued", op.name, type(e).__name__, len(self._q))
            return False
        self._pop(op)
        self.written += 1
        self._ok = True
        return True

    def _pop(self, op: _Op) -> None:
        if self._q and self._q[0] is op:  # 대기 중 큐가 넘쳐 이미 밀려났을 수 있다
            self._q.popleft()

    # ---- 쓰기 API(모두 즉시 반환) -----------------------------------------------------------------------------
    def record_run(
        self,
        job: str,
        provider: str,
        started_at: datetime,
        *,
        status: str,
        http_status: int | None = None,
        latency_ms: int | None = None,
        records_in: int = 0,
        records_quarantined: int = 0,
        raw_ref: str | None = None,
        error_text: str | None = None,
        quality: list[tuple[str, str | None, dict[str, Any]]] | None = None,
    ) -> None:
        """ingest_run 1행(+ 품질 사례·규칙별 건수)을 한 트랜잭션으로 기록한다.
        규칙별 건수는 실행이 시작된 UTC 날짜에 싣는다(COL-6: 큐에서 자정을 넘겨 기록돼도 실행한 날로).
        멱등(R-91): 실행마다 run_key(uuid4)를 한 번 만들고 재시도는 같은 키를 쓴다. INSERT … ON CONFLICT (run_key) DO NOTHING 이
        행을 돌려주지 않으면 앞선 시도가 이미 커밋된 것이다 — 품질 사례·규칙별 건수도 그 트랜잭션에 함께 커밋됐으므로 다시 넣지 않는다
        (다시 넣으면 사례가 겹치고 건수가 두 배가 된다). 그 run id 는 run_key 로 되찾아 로그에 남긴다."""
        finished_at = datetime.now(UTC)
        day = started_at.astimezone(UTC).date()
        rows, per_rule = quality_rows(quality or [])
        err = mask(error_text)
        run_key = uuid.uuid4()  # 실행 하나 = 키 하나(재시도는 이 클로저를 다시 부르므로 같은 키)

        async def fn(pool: Any) -> None:
            async with pool.acquire() as conn, conn.transaction():
                run_id = await conn.fetchval(
                    """INSERT INTO ingest_run (run_key, job, provider, started_at, finished_at, status, http_status, latency_ms,
                                              records_in, records_quarantined, raw_ref, error_text)
                       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
                       ON CONFLICT (run_key) DO NOTHING RETURNING id""",
                    run_key,
                    job,
                    provider,
                    started_at,
                    finished_at,
                    status,
                    http_status,
                    latency_ms,
                    records_in,
                    records_quarantined,
                    raw_ref,
                    err,
                )
                if run_id is None:
                    # 앞선 시도가 커밋된 뒤 응답을 받지 못했다(시간 초과·연결 끊김) — 이 실행은 이미 기록돼 있다
                    existing = await conn.fetchval("SELECT id FROM ingest_run WHERE run_key = $1", run_key)
                    log.info(
                        "db: ingest_run(%s) already recorded as run id %s (retry after an ambiguous commit) — not duplicated",
                        job,
                        existing,
                    )
                    return
                if rows:
                    await conn.executemany(
                        "INSERT INTO quality_event (run_id, rule, hex, detail) VALUES ($1,$2,$3,$4::jsonb)",
                        [(run_id, rule, hex_, detail) for rule, hex_, detail in rows],
                    )
                if per_rule:
                    await conn.executemany(
                        """INSERT INTO quality_rule_count (day, rule, count) VALUES ($1, $2, $3)
                           ON CONFLICT (day, rule) DO UPDATE SET count = quality_rule_count.count + EXCLUDED.count""",
                        [(day, rule, n) for rule, n in per_rule.items()],
                    )

        self._submit(f"ingest_run({job})", fn)

    def upsert_airports(self, rows: list[dict[str, Any]]) -> None:
        if not rows:
            return
        args = [(r["icao"], r.get("iata"), r.get("name"), r.get("country"), r["lon"], r["lat"], r.get("elev_ft")) for r in rows]

        async def fn(pool: Any) -> None:
            await pool.executemany(
                """INSERT INTO airport (icao, iata, name, country, geom, elev_ft, watched, updated_at)
                   VALUES ($1,$2,$3,$4, ST_SetSRID(ST_MakePoint($5,$6),4326), $7, true, now())
                   ON CONFLICT (icao) DO UPDATE SET name=EXCLUDED.name, geom=EXCLUDED.geom, elev_ft=EXCLUDED.elev_ft,
                       country=COALESCE(EXCLUDED.country, airport.country), updated_at=now()""",
                args,
            )

        self._submit("airport", fn)

    def upsert_metar(self, rows: list[dict[str, Any]]) -> None:
        """관측(icao, obs_time) 단위 upsert. 같은 관측을 다시 받으면 해석 결과(실링 상태·카테고리 포함)를 최신 해석으로 맞춘다."""
        if not rows:
            return
        args = [
            (
                r["icao"],
                r["obs_time"],
                r["raw"],
                r.get("temp_c"),
                r.get("dewp_c"),
                r.get("wind_dir"),
                r.get("wind_kt"),
                r.get("vis_sm"),
                r.get("vis_raw"),
                r.get("ceiling_ft"),
                r.get("ceiling_state"),
                r.get("flight_cat"),
                r.get("flight_cat_source"),
                r.get("wx_string"),
                r.get("taf_raw"),
                r["provider"],
                r["fetched_at"],
            )
            for r in rows
        ]

        async def fn(pool: Any) -> None:
            await self._executemany_rowwise_on_reject(pool, "metar_obs", _METAR_UPSERT, args)

        self._submit("metar_obs", fn)

    async def _executemany_rowwise_on_reject(self, pool: Any, table: str, sql: str, args: list[tuple]) -> None:
        """배치가 행 단위 제약(NOT NULL·CHECK·FK·자료형)으로 거부되면 행마다 다시 넣어 나머지를 살린다.
        executemany 는 원자적이라 이상한 행 하나가 전체를 버리게 만들기 때문이다. 연결 오류는 그대로 올려 writer 가 재시도한다."""
        try:
            await pool.executemany(sql, args)
            return
        except (asyncpg.IntegrityConstraintViolationError, asyncpg.DataError) as e:
            first = e
        stored = rejected = 0
        for a in args:
            try:
                await pool.execute(sql, *a)
                stored += 1
            except (asyncpg.IntegrityConstraintViolationError, asyncpg.DataError):
                rejected += 1
        self.failures += rejected
        self.dropped += rejected
        log.warning(
            "db: %s batch rejected (%s: %s) — row-by-row stored %d, rejected %d",
            table,
            type(first).__name__,
            (mask(str(first)) or "")[:160],
            stored,
            rejected,
        )

    def insert_radar_frames(self, host: str, frames: list[dict[str, Any]], fetched_at: datetime) -> None:
        if not frames:
            return
        args = [(int(f["time"]), host, f["path"], fetched_at) for f in frames]

        async def fn(pool: Any) -> None:
            await pool.executemany(
                """INSERT INTO radar_frame (frame_time, host, path, fetched_at) VALUES (to_timestamp($1), $2, $3, $4)
                   ON CONFLICT (frame_time) DO NOTHING""",
                args,
            )

        self._submit("radar_frame", fn)

    def upsert_budget_day(self, provider: str, day: datetime, used: int, limit: int) -> None:
        async def fn(pool: Any) -> None:
            await pool.execute(
                """INSERT INTO provider_budget_day (provider, day, calls, limit_value) VALUES ($1,$2,$3,$4)
                   ON CONFLICT (provider, day) DO UPDATE SET calls=EXCLUDED.calls, limit_value=EXCLUDED.limit_value""",
                provider,
                day.date(),
                used,
                limit,
            )

        self._submit(f"provider_budget_day({provider})", fn)

    # ---- 연안 교통량 격자 기하 캐시(ADR-023) ------------------------------------------------------------------------
    def upsert_marine_grid4(self, cells: list[Any], fetched_at: datetime) -> None:
        """확인한 칸(marine_grid.Cell)들을 한 번에 upsert — 멱등(같은 grid_no 는 마지막 값)."""
        if not cells:
            return
        args = [(c.grid_no, c.lat_min, c.lon_min, c.lat_max, c.lon_max, c.gid, fetched_at) for c in cells]

        async def fn(pool: Any) -> None:
            await self._executemany_rowwise_on_reject(pool, "marine_grid4", _MARINE_GRID4_UPSERT, args)

        self._submit(f"marine_grid4({len(cells)})", fn)

    async def read_marine_grid4(self) -> list[tuple[str, float, float, float, float, int | None]] | None:
        """저장된 칸 전부(grid_no, lat_min, lon_min, lat_max, lon_max, gid). DB 에 닿지 못하면 None(모름 — 빈 목록과 다르다).
        큐를 거치지 않는 읽기다(기동 때 한 번 · 실패하면 호출자가 다시). 값 검사는 호출자가 한다."""
        pool = await self._ensure_pool()
        if pool is None:
            return None
        try:
            rows = await asyncio.wait_for(pool.fetch(_MARINE_GRID4_SELECT), OP_TIMEOUT_S)
        except Exception as e:  # noqa: BLE001
            self.failures += 1
            self._warn("db: marine_grid4 read failed (%s) — geometry cache stays in memory", type(e).__name__)
            return None
        return [(r["grid_no"], r["lat_min"], r["lon_min"], r["lat_max"], r["lon_max"], r["gid"]) for r in rows]

    # ---- 한국 항만 입출항 색인(ADR-022 개정 · V15) — 큐를 거치지 않는 직접 읽기 · 트랜잭션 ---------------------------------------------------------
    async def read_port_call_coverage(self) -> dict[str, Coverage] | None:
        """항만청 → 색인 범위. DB 에 닿지 못하면 None(모름 — 빈 dict 는 '아직 색인한 것이 없다')."""
        pool = await self._ensure_pool()
        if pool is None:
            return None
        try:
            rows = await asyncio.wait_for(pool.fetch(_PORT_CALL_COVERAGE_SELECT), OP_TIMEOUT_S)
        except Exception as e:  # noqa: BLE001
            self.failures += 1
            self._warn("db: port_call_coverage read failed (%s) — port-call index waits for the database", type(e).__name__)
            return None
        return {r["prt_ag_cd"]: _coverage(r) for r in rows}

    async def apply_port_call_day(
        self,
        pa: str,
        day: date,
        rows: list[PortCallRow],
        fetched_at: datetime,
        *,
        reset: bool = False,
        refreshed_at: datetime | None = None,
        refuse_empty_over: int | None = None,
        hole: bool = False,
    ) -> DayApplied | None:
        """(항만청, 하루)를 받은 결과를 한 트랜잭션으로: 행 upsert · 그 날 목록에서 빠진 행 삭제 · 범위 넓히기(merge_day — 이어질 때만) ·
        refreshed_at(꼬리 갱신이 끝났을 때 — 범위가 이어졌을 때만). refuse_empty_over: 원천이 0건인데 저장된 행이 이 수 이상이면 바꾸지 않는다
        (일시적인 빈 응답으로 색인을 지우지 않게 — 작업이 다시 확인한 뒤 None 으로 부른다).
        hole = 그 날을 끝까지 색인하지 못했다: rows(있으면 — 키가 있는 기록)만 upsert 하고 지우지 않는다(목록이 모자라 철회를 알 수 없다), 범위는 넓히되
        그 날을 hole_days 에 넣는다(api 는 창 안에 빈 곳이 있으면 'none' 을 말하지 않는다). 끝까지 색인한 날은 hole_days 에서 뺀다.
        DB 가 행을 거절하면(제약 · 자료형) rejected 로 알린다(되돌려졌다 — 다시 보내도 같다). DB 에 닿지 못하거나 그 밖의 실패면 None(아무것도 바뀌지 않았다)."""
        pool = await self._ensure_pool()
        if pool is None:
            return None
        args = [(*(getattr(r, c) for c in _PORT_CALL_COLS), fetched_at) for r in rows]
        keys = ([r.clsgn for r in rows], [r.etrypt_year for r in rows], [r.etrypt_co for r in rows])

        async def txn() -> DayApplied:
            async with pool.acquire() as conn, conn.transaction():
                cur = await conn.fetchrow(
                    "SELECT covered_from, covered_to, refreshed_at, hole_days FROM port_call_coverage WHERE prt_ag_cd = $1 FOR UPDATE",
                    pa,
                )
                cov = None if cur is None else _coverage(cur)
                if not rows and not hole and refuse_empty_over is not None:
                    stored = await conn.fetchval(
                        "SELECT count(*) FROM port_call WHERE prt_ag_cd = $1 AND listed_date = $2", pa, day
                    )
                    if stored >= refuse_empty_over:
                        return DayApplied(False, cov, stored=int(stored), suspect_empty=True)
                if args:
                    await conn.executemany(_PORT_CALL_UPSERT, args)
                deleted = 0
                if not hole:
                    status = await conn.execute(_PORT_CALL_DELETE_WITHDRAWN, pa, day, *keys)
                    deleted = int(status.rsplit(" ", 1)[-1]) if isinstance(status, str) and status.startswith("DELETE") else 0
                new = merge_day(cov, day, reset=reset, hole=hole)
                if new is None:
                    return DayApplied(True, cov, False, len(args), deleted)
                if refreshed_at is not None:
                    new = Coverage(new.covered_from, new.covered_to, refreshed_at, new.holes)
                await conn.execute(
                    _PORT_CALL_COVERAGE_UPSERT,
                    pa,
                    new.covered_from,
                    new.covered_to,
                    new.refreshed_at,
                    sorted(new.holes),
                    datetime.now(UTC),
                )
                return DayApplied(True, new, True, len(args), deleted)

        try:
            return await asyncio.wait_for(txn(), OP_TIMEOUT_S)
        except (
            _PORT_CALL_REFUSED
        ) as e:  # 되돌려졌다 — 장애가 아니라 자료가 스키마와 어긋났다: 작업이 그 날을 빈 곳으로 적고 넘어간다
            self.failures += 1
            self._warn("db: port_call day %s/%s refused (%s: %s)", pa, day, type(e).__name__, (mask(str(e)) or "")[:160])
            return DayApplied(False, None, rejected=type(e).__name__)
        except Exception as e:  # noqa: BLE001 — 되돌려졌다(트랜잭션): 이 날은 다음에 다시 받는다
            self.failures += 1
            self._warn("db: port_call day %s/%s not applied (%s: %s)", pa, day, type(e).__name__, (mask(str(e)) or "")[:160])
            return None

    def purge_port_calls(self, cutoff: date) -> None:
        """보존(ADR-022 개정 — 목록 날짜 기준): cutoff 이전 행을 지우고, 범위의 시작을 cutoff 로 올린다(지운 날을 덮는다고 말하지 않게 — 그 앞의
        빈 곳도 뺀다) — 한 트랜잭션. 범위 전체가 cutoff 이전이면 범위는 그대로 둔다(작업이 창 밖의 범위로 보고 새로 시작한다). 멱등(큐 — 재시도해도 같다)."""

        async def fn(pool: Any) -> None:
            async with pool.acquire() as conn, conn.transaction():
                await conn.execute("DELETE FROM port_call WHERE listed_date < $1", cutoff)
                await conn.execute(
                    """UPDATE port_call_coverage SET covered_from = $1, updated_at = now(),
                           hole_days = ARRAY(SELECT d FROM unnest(hole_days) AS h(d) WHERE d >= $1 ORDER BY d)
                       WHERE covered_from < $1 AND covered_to >= $1""",
                    cutoff,
                )

        self._submit("port_call_retention", fn)
