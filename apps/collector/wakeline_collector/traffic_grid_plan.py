"""연안 교통량 수집(jobs/traffic_grid.py)의 순수 규칙 — 입출력 없음(Redis · HTTP · DB · 시계를 읽지 않는다: 시각은 인자로 받는다).

교통 호출 일정(KomsaSchedule — 발행 지연 배우기 · 물러나기 · 시간당 상한), 격자 기하 대기열과 부정 캐시(GridGeometry · Negative), 채우기 셈(FillPass ·
Tick), 채우기 차단기 사다리(Breaker)를 여기서 정한다. 규칙의 뜻과 까닭(검토 지적 · 선택값)은 작업 모듈 설명에 있다 — 값은 그대로 옮겼다.
"""

from __future__ import annotations

import itertools
from collections import deque
from collections.abc import Iterable
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any

import orjson

from wakeline_collector.marine_grid import CELL_DEG, SNAP_TOL_DEG, Cell, lattice_step, snap
from wakeline_collector.traffic_grid import GRID_ID_RE

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
SKIP_RETRY_S = 600  # 예산 소진 · 예산 저장소 장애 뒤 다시 볼 때
FILL_BREAKER_ERRORS = 3
FILL_PAUSE_S = (300, 600, 1800, 3600)
ID_RETRY_S = (300, 1800, 7200, 21600)
ID_MAX_FAILURES = 5  # 한 칸이 연달아 이만큼 실패하면 failed — FAILED_TTL_S 동안 묻지 않는다(약 8.6시간에 걸친 다섯 번)
NEGATIVE_TTL_S = 7 * 86400
FAILED_TTL_S = 86400
NEGATIVE_REASONS = ("not_found", "off_grid", "failed")
MAX_TRACKED = 20_000  # 조회 대기열 상한 · 부정 캐시(메모리)가 이만큼이면 기한이 지난 항목을 비운다(유효한 항목은 남긴다)


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

    def __init__(self, unchanged_backoff_s: tuple[int, ...] = UNCHANGED_BACKOFF_S) -> None:
        self.unchanged_backoff_s = unchanged_backoff_s  # 같은 regDt 뒤 물러나기 단계
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
        self.next_due = now + timedelta(seconds=_step(self.unchanged_backoff_s, self._unchanged))
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

    @property
    def expires(self) -> datetime:
        return self.at + timedelta(seconds=FAILED_TTL_S if self.reason == "failed" else NEGATIVE_TTL_S)

    def valid(self, now: datetime) -> bool:
        return now < self.expires


class GridGeometry:
    """grid_id → 칸. 모르는 칸은 처음 본 순서로 기다리고(실패한 적이 있는 칸은 뒤로), 없는 칸 · 격자에 맞지 않는 칸은 부정 캐시(기한
    NEGATIVE_TTL_S), 조회가 ID_MAX_FAILURES 번 연달아 실패한 칸은 failed(기한 FAILED_TTL_S — 확인 중으로 세지 않는다).
    대기열(_pending)은 이 프로세스의 메모리다 — 다시 시작하면 비고, 결과(칸 → DB marine_grid4, 부정 → Redis)만 남는다."""

    def __init__(self, max_tracked: int = MAX_TRACKED) -> None:
        self.max_tracked = max_tracked  # 조회 대기열 상한 · 부정 캐시(메모리)를 비우는 크기
        self.cells: dict[str, Cell] = {}
        self.negative: dict[str, Negative] = {}
        self._pending: dict[str, _Pending] = {}
        self._seq = itertools.count()
        # 마지막 observe(스냅샷 한 번 읽기 — 새 regDt 든 같은 regDt 든)에서 대기열이 가득 차(MAX_TRACKED) 넣지 못한 서로 다른 칸 수. 읽은 적이
        # 없으면 None. 누계가 아니다(검토 지적: 예전 dropped 는 부를 때마다 거절을 더해 '칸'이 아니라 '거절 횟수'였다) — 다음에 보일 때 자리가 있으면 넣는다
        self.not_queued: int | None = None

    @property
    def pending(self) -> int:
        return len(self._pending)

    def is_pending(self, g: str) -> bool:
        return g in self._pending

    def _negative_valid(self, g: str, now: datetime) -> bool:
        n = self.negative.get(g)
        return n is not None and n.valid(now)

    def observe(self, items: Iterable[tuple[str, int]], now: datetime) -> int:
        """스냅샷의 (grid_id, 척수) — 기하도 유효한 부정 캐시도 없고 대기열에도 없는 칸을 대기열에 넣는다(척수가 많은 칸 먼저 번호).
        새로 넣은 수 — '처음 본 칸'이 아니라 '이 프로세스가 새로 넣은 칸'이다(재기동하면 대기열이 비어 다시 센다)."""
        added = 0
        refused: set[str] = set()
        for g, _v in sorted(items, key=lambda t: (-t[1], t[0])):
            if g in self.cells or g in self._pending or self._negative_valid(g, now):
                continue
            if len(self._pending) >= self.max_tracked:
                refused.add(g)
                continue
            self._pending[g] = _Pending(next(self._seq))
            added += 1
        self.not_queued = len(refused)
        return added

    def due(self, now: datetime, limit: int) -> list[str]:
        """묻을 때가 된 칸 — 실패 횟수가 적은 칸 먼저(오래 실패한 칸이 새 칸 앞에서 차단기를 걸지 않게), 같으면 처음 본 순서."""
        ready = [(p.failures, p.seq, g) for g, p in self._pending.items() if p.next_try is None or p.next_try <= now]
        return [g for _f, _s, g in sorted(ready)[:limit]]

    def has_due(self, now: datetime) -> bool:
        return any(p.next_try is None or p.next_try <= now for p in self._pending.values())

    def retries(self) -> tuple[int, datetime | None]:
        """오류 뒤 다시 물을 차례를 기다리는 칸 수와 그중 가장 이른 때."""
        waits = [p.next_try for p in self._pending.values() if p.failures and p.next_try is not None]
        return sum(1 for p in self._pending.values() if p.failures), min(waits, default=None)

    def coverage(self, grid_ids: Iterable[str], now: datetime) -> dict[str, int]:
        """스냅샷 칸들을 나눈다: cells(기하 있음) · pending(대기열) · not_found · off_grid · failed(유효한 부정 캐시) ·
        not_queued(대기열이 가득 차 넣지 못함)."""
        out = dict.fromkeys(("cells", "pending", "not_found", "off_grid", "failed", "not_queued"), 0)
        for g in grid_ids:
            if g in self.cells:
                out["cells"] += 1
            elif g in self._pending:
                out["pending"] += 1
            elif (n := self.negative.get(g)) is not None and n.valid(now):
                out[n.reason] += 1
            else:
                out["not_queued"] += 1
        return out

    def resolved(self, cell: Cell) -> None:
        self.cells[cell.grid_no] = cell
        self._pending.pop(cell.grid_no, None)
        self.negative.pop(cell.grid_no, None)

    def mark_negative(self, grid_no: str, reason: str, now: datetime) -> None:
        """부정 결과는 늘 적는다. 메모리가 MAX_TRACKED 에 닿으면 기한이 지난 항목만 모두 비운다(보이면 어차피 다시 묻는다) — 유효한 항목은 상한을
        넘어도 남긴다: 크기는 Redis 해시만큼이다(load_negative 도 상한 없이 읽는다). 전에는 상한에서 적지 않고 대기열에서만 뺐고(다음에 보일
        때마다 다시 물었다), 첫 고침은 가장 먼저 끝나는 유효한 항목을 비웠다(그 칸을 다시 물었다). 운영에서는 닿지 않는 경로다
        (2026-09-30 기동 때 502항목 — ADR-023 2026-10-01 개정)."""
        self._pending.pop(grid_no, None)
        if grid_no not in self.negative and len(self.negative) >= self.max_tracked:
            for g in [g for g, n in self.negative.items() if not n.valid(now)]:
                del self.negative[g]
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

    def negative_counts(self, now: datetime) -> dict[str, int]:
        """유효한 부정 캐시 — 까닭별 수(not_found · off_grid · failed)."""
        out = dict.fromkeys(NEGATIVE_REASONS, 0)
        for n in self.negative.values():
            if n.valid(now):
                out[n.reason] += 1
        return out

    def failed_count(self, now: datetime) -> int:
        return self.negative_counts(now)["failed"]

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
            self.resolved(Cell(g, sl, so, lattice_step(sl), lattice_step(so), gid if isinstance(gid, int) else None))
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


@dataclass
class FillPass:
    """채우기 한 번 — 다시 시작한 틱부터 멈춘 틱(시간 창 · 하루 예산 · 차단기 · 운영자 끔 · 물을 칸이 없음)까지 보낸 조회와 결과."""

    started: datetime
    lookups: int = 0
    found: int = 0
    not_found: int = 0
    off_grid: int = 0
    errors: int = 0
    set_aside: int = 0  # 연달아 ID_MAX_FAILURES 번 실패해 failed 로 뺀 칸
    # bbox 타일(ADR-023 2026-10-01 bbox 개정) — 한 칸 조회(lookups …)와 따로 센다
    tiles: int = 0  # 보낸 타일 호출
    tile_cells: int = 0  # 타일 응답이 준 칸(검사 통과 — 겹치는 타일의 같은 칸은 두 번 센다)
    tile_new: int = 0  # 그 가운데 처음 안 칸
    tile_stored: int = (
        0  # DB(marine_grid4) 쓰기 큐에 넣은 칸 — 새 칸 · 기하가 바뀐 칸(쓰기는 비동기 — 버려지면 heartbeat db_dropped)
    )
    tile_splits: int = 0  # 잘렸을 수 있어 넷으로 나눈 타일
    # 잘렸을 수 있지만 더 나누지 않고 incomplete 로 둔 타일(가장 작은 4 km · 부모보다 적은 지물로도 여전히)
    tile_incomplete: int = 0
    tile_errors: int = 0


@dataclass
class Tick:
    """틱 하나의 채우기 셈(한 칸 조회 · 타일)과 멈춘 까닭."""

    calls: int = 0
    lookups: int = 0
    found: list[Cell] = field(default_factory=list)  # 한 칸 조회로 찾은 칸(틱 끝에 한 번 쓴다)
    not_found: int = 0
    off_grid: int = 0  # 한 칸 조회
    gave_up: int = 0
    tiles: int = 0
    tile_cells: int = 0
    tile_new: int = 0
    tile_stored: int = 0
    tile_off_grid: int = 0
    tile_splits: int = 0
    tile_incomplete: int = 0
    tile_errors: int = 0
    errors_in_row: int = 0  # 한 칸 조회의 연달은 오류(이 틱)
    tile_errors_in_row: int = 0  # 타일의 연달은 오류(이 틱) — 차단기는 따로(검토 지적 2026-10-01)
    last_error: str | None = None
    http_status: int | None = None
    latency: list[int] = field(default_factory=list)
    quality: list[tuple[str, str | None, dict[str, Any]]] = field(default_factory=list)
    stop_reason: str | None = None
    hold_until: datetime | None = None
    hold_kind: str = ""
    paused: bool = False  # 이 틱에 한 칸 조회 차단기가 걸렸다
    tile_paused: bool = False  # 이 틱에 타일 차단기가 걸렸다

    @property
    def received(self) -> int:
        return len(self.found) + self.tile_cells

    @property
    def succeeded(self) -> int:
        return self.calls - (self.lookups - len(self.found) - self.not_found - self.off_grid) - self.tile_errors


@dataclass
class Breaker:
    """채우기 한 종류(한 칸 조회 · bbox 타일)의 차단기 사다리: 걸릴 때마다 FILL_PAUSE_S 를 한 단계씩 올라 쉰다(5분 → 10분 → 30분 → 1시간, 그 뒤
    1시간 그대로). 그 종류가 답을 받은 틱이 있으면 처음 단계부터(reset — 쉼 끝은 그대로 둔다). 언제 거는지(한 틱에서 연달아 FILL_BREAKER_ERRORS 번)는
    작업이 센다(종류마다 따로 — 검토 지적 2026-10-01, high: 함께 세면 bbox 만 고장 나도 한 칸 조회가 굶었다)."""

    until: datetime | None = None  # 쉼 끝(없으면 쉰 적 없음)
    pauses: int = 0  # 처음 단계부터 걸린 수

    def paused(self, now: datetime) -> bool:
        return self.until is not None and now < self.until

    def trip(self, now: datetime) -> datetime:
        """한 단계 올라 쉰다 — 쉼 끝을 돌려준다."""
        self.until = now + timedelta(seconds=_step(FILL_PAUSE_S, self.pauses))
        self.pauses += 1
        return self.until

    def reset(self) -> None:
        self.pauses = 0
