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
from datetime import UTC, datetime
from typing import Any

import asyncpg
import orjson

from wakeline_collector.config import settings
from wakeline_collector.masking import mask

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
            try:
                self._pool = await asyncio.wait_for(self._factory(), OP_TIMEOUT_S)
            except Exception as e:  # noqa: BLE001
                self.failures += 1
                self._ok = False
                self._warn("db: connect failed (%s) — live path continues, writes queued (%d)", type(e).__name__, len(self._q))
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
