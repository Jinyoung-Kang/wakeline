"""연안 교통량 수집(ADR-023) — 한국해양교통안전공단 실시간 해양교통정보(5분 격자 집계)를 받아, 격자 기하(해양수산부 격자4단계 WFS)를
붙여 Redis wakeline:traffic_grid 에 싣는다. 개별 선박 위치가 아니라 0.025° 칸마다 척수 · 밀집도다.

틱(settings.traffic_grid_tick_s, 30 s)마다 부를 때가 됐는지만 본다 — 부르는 주기는 자료 시각(regDt)이 정한다:
- 교통(budget:komsa_traffic, 하루 400 — 포털 500 안): 다음 regDt 가 나올 때(마지막 regDt + 5분 + 배운 발행 지연)까지 부르지 않는다
  (regDt 가 바뀌지 않았으면 부를 까닭이 없다). 발행 지연(regDt 뒤 그 자료가 응답에 나오기까지)은 잰 적이 없어 관측으로 배운다(KomsaSchedule —
  처음 추정 PUBLISH_DELAY_S, [DELAY_MIN_S, DELAY_MAX_S]) — 고정값이면 공급자가 65 s 넘게 늦을 때 주기마다 두 번 불러 시간 상한에 막히고
  자료가 '멈춤'이 됐다(검토 지적). 배운 값은 heartbeat traffic_grid_publish_delay_s 에 싣고 재기동 뒤 다시 쓴다.
  같은 regDt 가 오면(unchanged — 더 이른 regDt 도: 지난 자료로 되돌리지 않는다) 새로 해석해 싣지 않고 60 → 60 → 60 s(늦은 발행) 뒤
  120 → 240 → 480 → 900 s(멈춘 공급자) 물러난다. 실패는 60 → 120 → 240 → 480 → 900 s. 수집기 시계보다 PUBLISH_FUTURE_SKEW_S 넘게 앞선
  regDt 는 받지 않는다(실패 · 품질 사례 traffic_grid_reg_dt_future — 한 번 받으면 뒤의 옳은 자료가 모두 '더 이른 것'이 되어 층이 얼어붙는다).
  상한 둘: 메모리 60분 창 HOURLY_CAP(15) · Redis 시간 창(budget:komsa_traffic:h:{UTC 시}, 같은 15 — 재기동 · 두 번째 수집기도 센다). KST 날은 UTC 시
  24개이므로 어느 날 경계로 세어도 하루 360번 이하 — 포털 한도(500) 안. 같은 주기 안 다시 부르기는 하지 않는다(다음 틱이 곧 다시 부른다).
  예산은 엄격(Redis 예산 저장소가 안 되면 부르지 않는다 — budget.DEFAULT_STRICT).
- 격자 기하(budget:mof_grid4, 하루 6,000 — 포털 10,000 안): 모르는 grid_id 만, 한 칸에 WFS 한 번, 처음 본 순서대로(같은 스냅샷 안에서는 척수가
  많은 칸 먼저), 틱마다 WFS_PER_TICK(15)개 · FILL_MAX_S 안에서, 호스트 버킷(1 req/s)과 가장 낮은 우선순위(PRIORITY_BACKFILL)로.
  첫 스냅샷(약 5,100칸)은 몇 시간에 걸쳐 채워진다 — 그동안 스냅샷 값의 resolved/unresolved 가 그대로 보인다.
  * found: 0.025° 격자 검사를 통과한 칸 → 메모리 + DB marine_grid4(V14 — 다시 시작해도 다시 묻지 않는다).
  * not_found(numberOfFeatures 0) · off_grid(격자 검사 실패 — 격리, 품질 사례 · 원본 보관): 부정 캐시 Redis wakeline:traffic_grid:negative
    (grid_no → {"reason","at"}) — NEGATIVE_TTL_S(7일) 뒤 다시 묻는다.
  * 오류(HTTP · 응답 모양 · 시간 초과): 그 칸만 5분 → 30분 → 2시간 → 6시간 뒤 다시. ID_MAX_FAILURES(5)번 연달아 실패하면 failed —
    부정 캐시에 적고(FAILED_TTL_S, 1일 뒤 처음부터 다시) 스냅샷에 pending 이 아니라 failed 로 센다(품질 사례 traffic_grid_lookup_failed).
    실패한 적이 있는 칸은 새 칸 뒤에 묻는다. 한 틱에서 연달아 FILL_BREAKER_ERRORS(3)번 실패하면 채우기 전체를 5분 → 10분 → 30분 → 1시간
    쉰다(키 · 서비스 장애에 예산을 쓰지 않게).
  * 보내지 않은 호출(속도 상한 · 운영자 끔 · 연결 전 실패 · 종료 취소)은 예산을 돌려주고 그 틱의 채우기를 멈춘다.
  * DB 캐시를 아직 읽지 못했으면 기동 뒤 DB_WAIT_S(10분)까지는 채우지 않는다(이미 아는 칸을 다시 묻지 않게). 그 뒤에는 DB 없이 채우고, DB 가
    돌아오면 읽어 합친다(실시간 경로는 DB 에 의존하지 않는다).
- 발행: 새 regDt 이거나 기하가 늘어 수가 바뀌면(PUBLISH_MIN_INTERVAL_S 에 한 번) SET wakeline:traffic_grid EX 1200. 값은 traffic_grid.build_payload.
  오래됨(regDt 15분 초과) 판정은 api 가 한다. 수집기가 멈추면 20분 뒤 키가 사라진다.
- heartbeat(wakeline:collector): traffic_grid_at · traffic_grid_lag_s(regDt 나이) · traffic_grid_state(active · no_key · fixture ·
  operator_off) · traffic_grid_last_ok · traffic_grid_reg_dt · resolved/unresolved · 알고 있는 칸 수 · pending · failed · 오늘 쓴 호출 수(두 예산) ·
  traffic_grid_publish_delay_s(배운 발행 지연 — 배우기 전에는 빈 값).
- 서비스 키는 공급자 안에만 있다. 오류 문구는 describe_error(가림)를 거친다. fixture 모드는 외부 호출이 없으므로 끈다(state fixture).
PUBLISH_DELAY_S · DELAY_* · LEARN_SLACK_S · HOURLY_CAP · 물러나기 단계 · WFS_PER_TICK · 부정 캐시 7일 · 연달아 실패 5번 · failed 1일 · 미래 허용 120 s 는
선택값이다(잰 값이 아니다). 발행 지연은 배운 값(heartbeat)으로만 말한다.
"""

from __future__ import annotations

import asyncio
import itertools
import logging
import time
from collections import deque
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any, Protocol

import orjson

from wakeline_collector.budget import UNKNOWN
from wakeline_collector.errors import describe_error
from wakeline_collector.http import BeforeSend, FetchResponse, ProviderHttpError, SendCancelled
from wakeline_collector.jobs.context import JobContext
from wakeline_collector.marine_grid import CELL_DEG, SNAP_TOL_DEG, Cell, snap
from wakeline_collector.providers.data_go_kr import WfsLookup
from wakeline_collector.raw_store import archive
from wakeline_collector.retry import NOT_SENT
from wakeline_collector.traffic_grid import GRID_ID_RE, KomsaSnapshot, build_payload, iso_z

log = logging.getLogger("job.traffic_grid")

SNAPSHOT_KEY = "wakeline:traffic_grid"
NEGATIVE_KEY = "wakeline:traffic_grid:negative"
HEARTBEAT_KEY = "wakeline:collector"
DELAY_FIELD = "traffic_grid_publish_delay_s"  # 배운 발행 지연(위쪽 끝 추정, 초) — 운영 확인 · 재기동 뒤 다시 쓴다
SNAPSHOT_TTL_S = 1200
PERIOD_S = 300  # 공급자 갱신 주기(확인: 5분마다 새 자료)
# 발행 지연(regDt 뒤 그 자료가 응답에 나오기까지) — 잰 적이 없어 관측으로 배운다. 아래 넷은 선택값이다.
PUBLISH_DELAY_S = 60  # 처음 추정(배운 값이 없을 때)
DELAY_MIN_S = 30  # 배운 값의 아래 끝
# 위 끝: regDt + 주기 + 이 값 + 틱이 오래됨(900 s) 안에 들게. 이보다 늦게 나오는 공급자는 어차피 자주 '멈춤'이다
DELAY_MAX_S = 540
# 한 번에 받은 주기마다 추정을 이만큼 줄여 본다(공급자가 빨라지면 따라간다 — 틀리면 이른 호출 한 번으로 다시 잰다)
DELAY_DECAY_S = 3
# 이른 호출 뒤 받은 때까지의 폭이 이보다 넓으면 (아래 끝 + 이 값)으로 좁힌다(긴 물러나기 · 실패가 끼면 위쪽 끝이 헐겁다)
LEARN_SLACK_S = 90
MIN_SPACING_S = 120  # 새 regDt 를 받은 뒤 다음 호출까지 최소 간격
HOURLY_CAP = 15  # 어느 한 시간이든(메모리 — 60분 창) · 어느 UTC 시든(Redis — 재기동을 넘어) 교통 호출 상한
UNCHANGED_BACKOFF_S = (60, 60, 60, 120, 240, 480, 900)  # 같은 regDt: 처음 세 번은 짧게(발행이 늦을 뿐), 그 뒤는 멈춘 공급자
FAIL_BACKOFF_S = (60, 120, 240, 480, 900)
PUBLISH_FUTURE_SKEW_S = 120  # 수집기 시계보다 이보다 더 앞선 regDt 는 받지 않는다(시계 차이는 허용)
SKIP_RETRY_S = 600  # 예산 소진 · 예산 저장소 장애 뒤 다시 볼 때
WFS_PER_TICK = 15
FILL_MAX_S = 15.0  # 한 틱의 채우기 시간 상한(종료 유예 18 s 안)
FILL_BREAKER_ERRORS = 3
FILL_PAUSE_S = (300, 600, 1800, 3600)
ID_RETRY_S = (300, 1800, 7200, 21600)
ID_MAX_FAILURES = 5  # 한 칸이 연달아 이만큼 실패하면 failed — FAILED_TTL_S 동안 묻지 않는다(약 8.6시간에 걸친 다섯 번)
NEGATIVE_TTL_S = 7 * 86400
FAILED_TTL_S = 86400
NEGATIVE_REASONS = ("not_found", "off_grid", "failed")
MAX_TRACKED = 20_000  # 기다리는 칸 · 부정 캐시 상한(메모리 · Redis 해시)
DB_RETRY_S = 60
DB_WAIT_S = 600
PUBLISH_MIN_INTERVAL_S = 30
REDIS_TIMEOUT_S = 3.0
STATE_ACTIVE, STATE_NO_KEY, STATE_FIXTURE, STATE_OPERATOR_OFF = "active", "no_key", "fixture", "operator_off"


class KomsaSource(Protocol):
    name: str
    cost: int

    @property
    def configured(self) -> bool: ...

    async def fetch(self, *, before_send: BeforeSend | None = None) -> tuple[FetchResponse, KomsaSnapshot]: ...


class WfsSource(Protocol):
    name: str
    cost: int

    @property
    def configured(self) -> bool: ...

    async def lookup(self, grid_no: str, *, wait_s: float = ..., before_send: BeforeSend | None = None) -> WfsLookup: ...


def _utcnow() -> datetime:
    return datetime.now(UTC)


def _step(steps: tuple[int, ...], n: int) -> int:
    return steps[min(n, len(steps) - 1)]


# ---- 교통 호출 일정 ----------------------------------------------------------------------------------------------------


class KomsaSchedule:
    """다음에 부를 시각(regDt + 주기 + 배운 발행 지연) · 물러나기 · 시간당 상한(메모리 60분 창 — Redis 시간 창은 작업이 따로 센다).

    발행 지연 배우기: 이른 호출(같은 regDt — unchanged) 뒤 새 regDt 를 받으면 그 regDt 의 지연은 (마지막 이른 호출 − regDt, 받은 때 − regDt] 안이다.
    위쪽 끝(받은 때 − regDt)을 쓰되 max(아래 끝, 지금 추정) + LEARN_SLACK_S 를 넘지 않게 좁히고(폭이 넓으면 위쪽 끝이 헐겁다), 지금 추정보다 줄이지는
    않는다(이른 호출은 추정이 짧았다는 증거). 이른 호출 없이 받은 주기는 추정을 DELAY_DECAY_S 씩 줄여 보기만 한다 — 첫 호출 · 실패 뒤 받은 regDt 의
    나이는 지연이 아니므로(그 regDt 가 언제 나왔는지 모른다) 추정을 늘리는 데 쓰지 않는다. 24시간 공급자 모형 시험: test_traffic_grid_job.
    """

    def __init__(self) -> None:
        self.next_due: datetime | None = None  # None = 지금
        self.last_reg_dt: datetime | None = None
        self.delay_s = float(PUBLISH_DELAY_S)
        self.delay_learned = False  # 관측(이른 호출 뒤 받음)이나 재기동 전 값에서 왔는가 — 아니면 처음 추정(선택값)일 뿐
        self._early_at: datetime | None = None  # 이 주기의 마지막 이른 호출(unchanged) 시각
        self._calls: deque[datetime] = deque()
        self._fails = 0
        self._unchanged = 0

    def due(self, now: datetime) -> bool:
        return (self.next_due is None or now >= self.next_due) and self.calls_last_hour(now) < HOURLY_CAP

    def calls_last_hour(self, now: datetime) -> int:
        while self._calls and (now - self._calls[0]).total_seconds() >= 3600:
            self._calls.popleft()
        return len(self._calls)

    def called(self, now: datetime) -> None:
        self._calls.append(now)

    def restore_delay(self, value: float) -> bool:
        """재기동 뒤 heartbeat 에 남은 배운 지연을 다시 쓴다. 범위 밖이면 쓰지 않는다."""
        if DELAY_MIN_S <= value <= DELAY_MAX_S:
            self.delay_s = float(value)
            self.delay_learned = True
            return True
        return False

    def on_new(self, reg_dt: datetime, now: datetime) -> None:
        reg = reg_dt.astimezone(UTC)
        seen = (now - reg).total_seconds()  # 이 regDt 를 처음 본 나이 — 발행 지연의 위쪽 끝
        if self.last_reg_dt is not None:
            if self._early_at is not None:
                # 이른 호출은 지금 추정이 짧았다는 증거 — 줄이지 않는다. 받은 regDt 가 기다리던 것보다 뒤의 것이면(상한 · 실패로 한 주기를 건너뜀)
                # 아래 끝이 약하므로 max(아래 끝, 지금 추정) + LEARN_SLACK_S 로 좁힌다
                low = max(0.0, (self._early_at - reg).total_seconds())  # 그때는 아직 없었다
                est = min(seen, max(low, self.delay_s) + LEARN_SLACK_S)
                self.delay_s = min(max(est, self.delay_s, float(DELAY_MIN_S)), float(DELAY_MAX_S))
                self.delay_learned = True
            else:
                self.delay_s = max(float(DELAY_MIN_S), min(self.delay_s, seen) - DELAY_DECAY_S)
        self._early_at = None
        self._fails = self._unchanged = 0
        self.last_reg_dt = reg_dt
        expected = reg + timedelta(seconds=PERIOD_S + self.delay_s)
        # 시계가 어긋나 regDt 가 미래이거나 아주 오래됐어도 [지금 + 최소 간격, 지금 + 주기 × 2] 안에서
        self.next_due = min(max(expected, now + timedelta(seconds=MIN_SPACING_S)), now + timedelta(seconds=2 * PERIOD_S))

    def on_unchanged(self, now: datetime) -> None:
        self._fails = 0
        self._early_at = now
        self.next_due = now + timedelta(seconds=_step(UNCHANGED_BACKOFF_S, self._unchanged))
        self._unchanged += 1

    def on_failure(self, now: datetime) -> None:
        self.next_due = now + timedelta(seconds=_step(FAIL_BACKOFF_S, self._fails))
        self._fails += 1

    def on_skipped(self, now: datetime, until: datetime | None = None) -> None:
        self.next_due = until if until is not None and until > now else now + timedelta(seconds=SKIP_RETRY_S)


# ---- 격자 기하 ---------------------------------------------------------------------------------------------------------


@dataclass
class _Pending:
    seq: int
    next_try: datetime | None = None
    failures: int = 0


@dataclass(frozen=True)
class Negative:
    reason: str  # not_found · off_grid(NEGATIVE_TTL_S) · failed(FAILED_TTL_S)
    at: datetime

    def valid(self, now: datetime) -> bool:
        ttl = FAILED_TTL_S if self.reason == "failed" else NEGATIVE_TTL_S
        return (now - self.at).total_seconds() < ttl


class GridGeometry:
    """grid_id → 칸. 모르는 칸은 처음 본 순서로 기다리고(실패한 적이 있는 칸은 뒤로), 없는 칸 · 격자에 맞지 않는 칸은 부정 캐시(기한
    NEGATIVE_TTL_S), 조회가 ID_MAX_FAILURES 번 연달아 실패한 칸은 failed(기한 FAILED_TTL_S — 확인 중으로 세지 않는다)."""

    def __init__(self) -> None:
        self.cells: dict[str, Cell] = {}
        self.negative: dict[str, Negative] = {}
        self._pending: dict[str, _Pending] = {}
        self._seq = itertools.count()
        self.dropped = 0  # MAX_TRACKED 를 넘어 기다리지 못한 칸 수(누계)

    @property
    def pending(self) -> int:
        return len(self._pending)

    def _negative_valid(self, g: str, now: datetime) -> bool:
        n = self.negative.get(g)
        return n is not None and n.valid(now)

    def observe(self, items: Iterable[tuple[str, int]], now: datetime) -> int:
        """스냅샷의 (grid_id, 척수) — 모르는 칸을 기다림에 넣는다(척수가 많은 칸 먼저 번호). 새로 넣은 수."""
        added = 0
        for g, _v in sorted(items, key=lambda t: (-t[1], t[0])):
            if g in self.cells or g in self._pending or self._negative_valid(g, now):
                continue
            if len(self._pending) >= MAX_TRACKED:
                self.dropped += 1
                continue
            self._pending[g] = _Pending(next(self._seq))
            added += 1
        return added

    def due(self, now: datetime, limit: int) -> list[str]:
        """묻을 때가 된 칸 — 실패 횟수가 적은 칸 먼저(오래 실패한 칸이 새 칸 앞에서 차단기를 걸지 않게), 같으면 처음 본 순서."""
        ready = [(p.failures, p.seq, g) for g, p in self._pending.items() if p.next_try is None or p.next_try <= now]
        return [g for _f, _s, g in sorted(ready)[:limit]]

    def resolved(self, cell: Cell) -> None:
        self.cells[cell.grid_no] = cell
        self._pending.pop(cell.grid_no, None)
        self.negative.pop(cell.grid_no, None)

    def mark_negative(self, grid_no: str, reason: str, now: datetime) -> None:
        self._pending.pop(grid_no, None)
        if len(self.negative) < MAX_TRACKED or grid_no in self.negative:
            self.negative[grid_no] = Negative(reason, now)

    def failed(self, grid_no: str, now: datetime) -> bool:
        """조회 오류 한 번. ID_MAX_FAILURES 번째면 failed 로 옮기고 True(호출자가 Redis 에 적는다), 아니면 물러나기만."""
        p = self._pending.get(grid_no)
        if p is None:
            return False
        p.failures += 1
        if p.failures >= ID_MAX_FAILURES:
            self.mark_negative(grid_no, "failed", now)
            return True
        p.next_try = now + timedelta(seconds=_step(ID_RETRY_S, p.failures - 1))
        return False

    def failed_count(self, now: datetime) -> int:
        return sum(1 for n in self.negative.values() if n.reason == "failed" and n.valid(now))

    def reasons(self, now: datetime) -> dict[str, str]:
        return {g: n.reason for g, n in self.negative.items() if n.valid(now)}

    def load_cells(self, rows: Iterable[tuple[Any, ...]]) -> tuple[int, int]:
        """DB 행(grid_no, lat_min, lon_min, lat_max, lon_max, gid) → 칸. 격자 검사를 다시 한다(틀린 행은 쓰지 않는다). (넣은 수, 버린 수)."""
        ok = bad = 0
        for row in rows:
            try:
                g, la0, lo0, la1, lo1, gid = row
                sl, so = snap(float(la0)), snap(float(lo0))
                valid = (
                    isinstance(g, str)
                    and GRID_ID_RE.fullmatch(g) is not None
                    and sl is not None
                    and so is not None
                    and abs(float(la1) - float(la0) - CELL_DEG) <= SNAP_TOL_DEG
                    and abs(float(lo1) - float(lo0) - CELL_DEG) <= SNAP_TOL_DEG
                )
            except (TypeError, ValueError):
                valid = False
            if not valid:
                bad += 1
                continue
            assert sl is not None and so is not None
            self.resolved(
                Cell(g, sl, so, round(sl + CELL_DEG, 3), round(so + CELL_DEG, 3), gid if isinstance(gid, int) else None)
            )
            ok += 1
        return ok, bad

    def load_negative(self, fields: dict[Any, Any]) -> int:
        """Redis 해시(grid_no → {"reason","at"}) → 부정 캐시. 형식이 틀린 항목은 버린다(다시 물으면 된다)."""
        n = 0
        for key, raw in fields.items():
            g = key.decode() if isinstance(key, bytes) else str(key)
            try:
                v = orjson.loads(raw)
                reason, at = v["reason"], datetime.fromisoformat(str(v["at"]).replace("Z", "+00:00"))
            except (orjson.JSONDecodeError, KeyError, TypeError, ValueError):
                continue
            if reason in NEGATIVE_REASONS and at.tzinfo is not None and GRID_ID_RE.fullmatch(g) and g not in self.cells:
                self.negative[g] = Negative(reason, at)
                self._pending.pop(g, None)
                n += 1
        return n


# ---- 작업 ----------------------------------------------------------------------------------------------------------


class TrafficGridJob:
    job_name = "traffic_grid"
    geom_job_name = "traffic_grid_geom"

    def __init__(
        self,
        komsa: KomsaSource,
        wfs: WfsSource,
        ctx: JobContext,
        *,
        now: Callable[[], datetime] = _utcnow,
        mono: Callable[[], float] = time.monotonic,
    ) -> None:
        self.komsa, self.wfs, self.ctx = komsa, wfs, ctx
        self._now, self._mono = now, mono
        self.schedule = KomsaSchedule()
        self.geometry = GridGeometry()
        self.snapshot: KomsaSnapshot | None = None
        self.fetched_at: datetime | None = None
        self.last_ok: datetime | None = None
        self.state = STATE_ACTIVE
        self._started: datetime | None = None
        self._db_loaded = False
        self._db_next_try: datetime | None = None
        self._neg_loaded = False
        self._delay_loaded = False
        self._dirty = False
        self._published_at: datetime | None = None
        self._force_publish = False
        self._fill_pause_until: datetime | None = None
        self._fill_pauses = 0
        self._logged_disabled: str | None = None
        self._waiting_logged = False
        self.counts = {"komsa_calls": 0, "wfs_calls": 0, "published": 0}

    # ---- 한 틱 --------------------------------------------------------------------------------------------------
    async def run_once(self) -> None:
        now = self._now()
        if self._started is None:
            self._started = now
        if self.ctx.fixture or not self.komsa.configured:
            await self._disabled(STATE_FIXTURE if self.ctx.fixture else STATE_NO_KEY)
            return
        await self._load(now)
        await self._maybe_fetch(now)
        await self._fill(now)
        await self._maybe_publish(self._now())
        await self._heartbeat(self._now())

    async def _disabled(self, state: str) -> None:
        self.state = state
        if self._logged_disabled != state:
            self._logged_disabled = state
            why = "fixture mode — no external calls" if state == STATE_FIXTURE else "DATA_GO_KR_SERVICE_KEY not set"
            log.info("traffic grid: %s — coastal traffic layer disabled", why)
        await self.ctx.status.heartbeat(self.job_name, lag_s=None, fixture=self.ctx.fixture, extra={"traffic_grid_state": state})

    # ---- 캐시 읽기 ------------------------------------------------------------------------------------------------
    async def _load(self, now: datetime) -> None:
        if not self._delay_loaded:
            self._delay_loaded = True  # 한 번만 본다(없거나 못 읽으면 처음 추정으로 — 다시 배운다)
            try:
                async with asyncio.timeout(REDIS_TIMEOUT_S):
                    raw = await self.ctx.status.redis.hget(HEARTBEAT_KEY, DELAY_FIELD)
                if raw and self.schedule.restore_delay(float(raw)):
                    log.info("traffic grid: publication delay estimate %.0f s restored from the heartbeat", self.schedule.delay_s)
            except Exception as e:  # noqa: BLE001 — 부가(없어도 다시 배운다)
                log.info("traffic grid: publication delay estimate not restored (%s)", type(e).__name__)
        if not self._neg_loaded:
            try:
                async with asyncio.timeout(REDIS_TIMEOUT_S):
                    fields = await self.ctx.status.redis.hgetall(NEGATIVE_KEY)
                n = self.geometry.load_negative(fields or {})
                self._neg_loaded = True
                if n:
                    log.info("traffic grid: %d negative-cached grid ids loaded", n)
            except Exception as e:  # noqa: BLE001 — 다음 틱에 다시(부정 캐시는 부가 — 없어도 동작)
                log.info("traffic grid: negative cache not readable yet (%s)", type(e).__name__)
        if self._db_loaded or (self._db_next_try is not None and now < self._db_next_try):
            return
        rows = await self.ctx.db.read_marine_grid4()
        if rows is None:
            self._db_next_try = now + timedelta(seconds=DB_RETRY_S)
            return
        ok, bad = self.geometry.load_cells(rows)
        self._db_loaded = True
        self._dirty = self._dirty or ok > 0
        log.info("traffic grid: %d grid cells loaded from marine_grid4%s", ok, f" ({bad} invalid rows ignored)" if bad else "")

    # ---- 교통 ---------------------------------------------------------------------------------------------------
    async def _maybe_fetch(self, now: datetime) -> None:
        p = self.komsa
        if await self.ctx.status.is_disabled(p.name):
            self.state = STATE_OPERATOR_OFF
            return
        self.state = STATE_ACTIVE
        if not self.schedule.due(now):
            return
        started = now
        # 시간 창(Redis, UTC 시) 먼저 — 재기동 · 두 번째 수집기도 같은 창을 센다. 그다음 하루 예산. 하나라도 안 되면 부르지 않는다.
        ok, used, hour = await self.ctx.budget.reserve_hour(p.name, HOURLY_CAP, p.cost, now=now)
        if not ok:
            unavailable = used == UNKNOWN
            self.ctx.db.record_run(
                self.job_name,
                p.name,
                started,
                status="budget_unavailable" if unavailable else "budget_exhausted",
                error_text="budget store unavailable (fail closed)"
                if unavailable
                else f"hourly cap reached (used={used} of {HOURLY_CAP} in UTC hour {hour.rsplit(':', 1)[-1]})",
            )
            nxt = now.astimezone(UTC).replace(minute=0, second=0, microsecond=0) + timedelta(hours=1)
            self.schedule.on_skipped(now, until=None if unavailable else nxt)
            return
        ok, used = await self.ctx.budget.reserve(p.name, p.cost)
        if not ok:
            await self.ctx.budget.release_key(hour, p.cost)
            unavailable = used == UNKNOWN
            self.ctx.db.record_run(
                self.job_name,
                p.name,
                started,
                status="budget_unavailable" if unavailable else "budget_exhausted",
                error_text="budget store unavailable (fail closed)" if unavailable else f"daily budget exhausted (used={used})",
            )
            self.schedule.on_skipped(now)
            return
        sent = False

        async def before_send() -> bool:
            nonlocal sent
            if await self.ctx.status.is_disabled(p.name):
                return False
            sent = True
            return True

        async def give_back() -> None:
            await self.ctx.budget.release(p.name, p.cost)
            await self.ctx.budget.release_key(hour, p.cost)

        try:
            resp, snap = await p.fetch(before_send=before_send)
        except asyncio.CancelledError:
            if not sent:
                await asyncio.shield(give_back())
            raise
        except NOT_SENT as e:
            await give_back()
            if isinstance(e, SendCancelled):
                self.state = STATE_OPERATOR_OFF
            else:
                self.schedule.on_failure(now)
                log.info("traffic grid: komsa call not sent (%s)", describe_error(e, content=False))
            return
        except Exception as e:  # noqa: BLE001 — HTTP · 응답 모양 · 공급자 오류(resultCode) · 읽기 시간 초과
            self._count_sent(now)
            http_status = e.status if isinstance(e, ProviderHttpError) else None
            why = describe_error(e)
            await self.ctx.status.failure(p.name, at=self._now(), error=why, http_status=http_status)
            self.ctx.db.record_run(self.job_name, p.name, started, status="error", http_status=http_status, error_text=why)
            self.schedule.on_failure(now)
            log.warning("traffic grid: komsa fetch failed — %s (next try %s)", why, iso_z(self.schedule.next_due or now))
            return
        self._count_sent(now)
        ahead = (snap.reg_dt - resp.fetched_at).total_seconds()
        if ahead > PUBLISH_FUTURE_SKEW_S:
            # 미래 regDt 를 받으면 뒤의 옳은 자료가 모두 '더 이른 것'이 되어 층이 얼어붙는다 — 받지 않는다(실패 · 원본 · 품질 사례)
            why = (
                f"regDt {iso_z(snap.reg_dt)} is {ahead:.0f} s ahead of the collector clock "
                f"(limit {PUBLISH_FUTURE_SKEW_S} s) — snapshot not used"
            )
            ref = await archive(self.ctx.raw, p.name, resp.body, resp.fetched_at)
            await self.ctx.status.failure(p.name, at=self._now(), error=why, http_status=None)
            self.ctx.db.record_run(
                self.job_name,
                p.name,
                started,
                status="error",
                http_status=resp.status,
                latency_ms=resp.latency_ms,
                error_text=why,
                raw_ref=ref,
                quality=[("traffic_grid_reg_dt_future", None, {"reg_dt": iso_z(snap.reg_dt), "ahead_s": round(ahead)})],
            )
            self.schedule.on_failure(now)
            log.warning("traffic grid: %s", why)
            return
        quality: list[tuple[str, str | None, dict[str, Any]]] = [("traffic_grid_item_rejected", None, r) for r in snap.rejected]
        if self.snapshot is not None and snap.reg_dt <= self.snapshot.reg_dt:
            # 같은 regDt(새 자료 아님) — 또는 더 이른 regDt(공급자 쪽 서버가 뒤처진 응답): 지난 자료로 되돌리지 않는다
            if snap.reg_dt < self.snapshot.reg_dt:
                log.info(
                    "traffic grid: regDt %s is older than the published %s — kept the newer one",
                    iso_z(snap.reg_dt),
                    iso_z(self.snapshot.reg_dt),
                )
            self.schedule.on_unchanged(now)
            self.last_ok = resp.fetched_at
            self.ctx.db.record_run(
                self.job_name, p.name, started, status="unchanged", http_status=resp.status, latency_ms=resp.latency_ms
            )
            self.geometry.observe(((i.grid_id, i.vmtc) for i in snap.items), now)  # 부정 캐시 기한이 지난 칸을 다시 기다림에
            self._dirty = True  # 같은 값을 다시 실어 TTL 만 늘린다 — api 가 regDt 나이로 '멈춤'을 밝힌다(값이 같아 ETag 도 같다)
            await self._success(resp, len(snap.items))
            return
        raw_ref = await archive(self.ctx.raw, p.name, resp.body, resp.fetched_at)
        self.snapshot, self.fetched_at, self.last_ok = snap, resp.fetched_at, resp.fetched_at
        self.schedule.on_new(snap.reg_dt, now)
        added = self.geometry.observe(((i.grid_id, i.vmtc) for i in snap.items), now)
        self._dirty = True
        self._force_publish = True
        self.ctx.db.record_run(
            self.job_name,
            p.name,
            started,
            status="ok",
            http_status=resp.status,
            latency_ms=resp.latency_ms,
            records_in=len(snap.items),
            records_quarantined=len(snap.rejected),
            raw_ref=raw_ref,
            quality=quality,
        )
        await self._success(resp, len(snap.items))
        if snap.total_count is not None and snap.total_count > len(snap.items) + len(snap.rejected) + snap.duplicates:
            log.warning("traffic grid: page holds %d of totalCount %d — published as partial", len(snap.items), snap.total_count)
        log.info(
            "traffic grid: regDt %s — %d cells (%d rejected, %d new unknown ids)",
            iso_z(snap.reg_dt),
            len(snap.items),
            len(snap.rejected),
            added,
        )

    def _count_sent(self, now: datetime) -> None:
        self.schedule.called(now)
        self.counts["komsa_calls"] += 1

    async def _success(self, resp: FetchResponse, records: int) -> None:
        used, limit = await self.ctx.budget.usage(self.komsa.name)
        await self.ctx.status.success(
            self.komsa.name, at=resp.fetched_at, latency_ms=resp.latency_ms, records=records, used=used, limit=limit
        )

    # ---- 격자 기하 채우기 ---------------------------------------------------------------------------------------------
    async def _fill(self, now: datetime) -> None:
        w = self.wfs
        if not w.configured or not self.geometry.pending:
            return
        if not self._db_loaded and self._started is not None and (now - self._started).total_seconds() < DB_WAIT_S:
            if not self._waiting_logged:
                self._waiting_logged = True
                log.info("traffic grid: waiting up to %d s for the marine_grid4 cache before WFS lookups", DB_WAIT_S)
            return
        if self._fill_pause_until is not None and now < self._fill_pause_until:
            return
        if await self.ctx.status.is_disabled(w.name):
            return
        batch = self.geometry.due(now, WFS_PER_TICK)
        if not batch:
            return
        t0 = self._mono()
        found: list[Cell] = []
        quality: list[tuple[str, str | None, dict[str, Any]]] = []
        calls = errors_in_row = off_grid = not_found = gave_up = 0
        last_error: str | None = None
        http_status: int | None = None
        latency: list[int] = []
        started = now
        stop_reason: str | None = None
        for g in batch:
            if self._mono() - t0 > FILL_MAX_S:
                break
            ok, used = await self.ctx.budget.reserve(w.name, w.cost)
            if not ok:
                stop_reason = (
                    "budget store unavailable (fail closed)" if used == UNKNOWN else f"daily budget exhausted (used={used})"
                )
                break
            sent = False

            async def before_send() -> bool:
                nonlocal sent
                if await self.ctx.status.is_disabled(w.name):
                    return False
                sent = True
                return True

            try:
                got = await w.lookup(g, before_send=before_send)
            except asyncio.CancelledError:
                if not sent:
                    await asyncio.shield(self.ctx.budget.release(w.name, w.cost))
                raise
            except NOT_SENT:
                await self.ctx.budget.release(w.name, w.cost)
                break
            except Exception as e:  # noqa: BLE001 — HTTP · 응답 모양(WfsError) · 읽기 시간 초과
                calls += 1
                errors_in_row += 1
                last_error = why = describe_error(e)
                http_status = e.status if isinstance(e, ProviderHttpError) else http_status
                if self.geometry.failed(g, now):
                    gave_up += 1
                    await self._store_negative(g, "failed", now)
                    quality.append(
                        ("traffic_grid_lookup_failed", None, {"grid_no": g, "failures": ID_MAX_FAILURES, "last": why[:200]})
                    )
                    log.warning(
                        "traffic grid: %s failed %d lookups in a row — set aside for %d h (last: %s)",
                        g,
                        ID_MAX_FAILURES,
                        FAILED_TTL_S // 3600,
                        last_error,
                    )
                if errors_in_row >= FILL_BREAKER_ERRORS:
                    self._fill_pause_until = now + timedelta(seconds=_step(FILL_PAUSE_S, self._fill_pauses))
                    self._fill_pauses += 1
                    log.warning(
                        "traffic grid: %d WFS errors in a row — geometry fill paused until %s (last: %s)",
                        errors_in_row,
                        iso_z(self._fill_pause_until),
                        last_error,
                    )
                    break
                continue
            calls += 1
            errors_in_row = 0
            if got.latency_ms is not None:
                latency.append(got.latency_ms)
            r = got.result
            if r.kind == "found" and r.cell is not None:
                self.geometry.resolved(r.cell)
                found.append(r.cell)
            elif r.kind == "not_found":
                not_found += 1
                self.geometry.mark_negative(g, "not_found", now)
                await self._store_negative(g, "not_found", now)
            else:
                off_grid += 1
                self.geometry.mark_negative(g, "off_grid", now)
                await self._store_negative(g, "off_grid", now)
                ref = await archive(self.ctx.raw, w.name, got.body, now)
                quality.append(("traffic_grid_off_grid", None, {"grid_no": g, "detail": (r.detail or "")[:200], "raw_ref": ref}))
        self.counts["wfs_calls"] += calls
        if found:
            self.ctx.db.upsert_marine_grid4(found, now)
        if found or not_found or off_grid:
            self._dirty = True
            self._fill_pauses = 0
        if gave_up:
            self._dirty = True  # pending → failed: 수가 바뀌었다
        if stop_reason and not calls:
            self.ctx.db.record_run(
                self.geom_job_name,
                w.name,
                started,
                status="budget_unavailable" if stop_reason.startswith("budget store") else "budget_exhausted",
                error_text=stop_reason,
            )
            return
        if not calls:
            return
        succeeded = len(found) + not_found + off_grid
        self.ctx.db.record_run(
            self.geom_job_name,
            w.name,
            started,
            status="ok" if succeeded else "error",
            http_status=http_status if not succeeded else 200,
            latency_ms=round(sum(latency) / len(latency)) if latency else None,
            records_in=len(found),
            records_quarantined=off_grid,
            error_text=f"{calls - succeeded} of {calls} lookups failed; last: {last_error}" if last_error else None,
            quality=quality,
        )
        if succeeded and latency:
            u, lim = await self.ctx.budget.usage(w.name)
            await self.ctx.status.success(w.name, at=self._now(), latency_ms=latency[-1], records=len(found), used=u, limit=lim)
        if last_error:
            await self.ctx.status.failure(w.name, at=self._now(), error=last_error, http_status=http_status)

    async def _store_negative(self, g: str, reason: str, now: datetime) -> None:
        try:
            async with asyncio.timeout(REDIS_TIMEOUT_S):
                await self.ctx.status.redis.hset(NEGATIVE_KEY, g, orjson.dumps({"reason": reason, "at": iso_z(now)}).decode())
        except Exception as e:  # noqa: BLE001 — 메모리에는 남는다(다시 시작하면 다시 물을 뿐)
            log.info("traffic grid: negative cache write failed (%s)", type(e).__name__)

    # ---- 발행 ---------------------------------------------------------------------------------------------------
    def payload(self, now: datetime) -> dict[str, Any] | None:
        if self.snapshot is None or self.fetched_at is None:
            return None
        return build_payload(self.snapshot, self.fetched_at, self.geometry.cells, self.geometry.reasons(now))

    async def _maybe_publish(self, now: datetime) -> None:
        if not self._dirty or self.snapshot is None:
            return
        if (
            not self._force_publish
            and self._published_at is not None
            and (now - self._published_at).total_seconds() < PUBLISH_MIN_INTERVAL_S
        ):
            return
        p = self.payload(now)
        assert p is not None
        try:
            async with asyncio.timeout(REDIS_TIMEOUT_S):
                await self.ctx.status.redis.set(SNAPSHOT_KEY, orjson.dumps(p).decode(), ex=SNAPSHOT_TTL_S)
        except Exception as e:  # noqa: BLE001 — 다음 틱에 다시(dirty 유지)
            log.warning("traffic grid: publish failed (%s) — retrying next tick", type(e).__name__)
            return
        self._dirty = self._force_publish = False
        self._published_at = now
        self.counts["published"] += 1

    async def _heartbeat(self, now: datetime) -> None:
        s = self.snapshot
        lag = None if s is None else max(0.0, (now - s.reg_dt).total_seconds())
        used_k, _ = await self.ctx.budget.usage(self.komsa.name)
        used_w, _ = await self.ctx.budget.usage(self.wfs.name)
        resolved = unresolved = None
        if s is not None:
            resolved = sum(1 for i in s.items if i.grid_id in self.geometry.cells)
            unresolved = len(s.items) - resolved
        extra = {
            "traffic_grid_state": self.state,
            "traffic_grid_last_ok": iso_z(self.last_ok) if self.last_ok else "",
            "traffic_grid_reg_dt": iso_z(s.reg_dt) if s else "",
            "traffic_grid_resolved": "" if resolved is None else str(resolved),
            "traffic_grid_unresolved": "" if unresolved is None else str(unresolved),
            "traffic_grid_cells_known": str(len(self.geometry.cells)),
            "traffic_grid_pending": str(self.geometry.pending),
            "traffic_grid_failed": str(self.geometry.failed_count(now)),
            "traffic_grid_calls_komsa": "" if used_k is None else str(used_k),
            "traffic_grid_calls_wfs": "" if used_w is None else str(used_w),
            # 처음 추정(선택값)은 싣지 않는다 — 배운 값만
            DELAY_FIELD: str(round(self.schedule.delay_s)) if self.schedule.delay_learned else "",
        }
        await self.ctx.status.heartbeat(self.job_name, lag_s=lag, fixture=self.ctx.fixture, extra=extra)
