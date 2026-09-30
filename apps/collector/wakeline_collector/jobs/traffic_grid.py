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
- 격자 기하 — bbox 타일 먼저(ADR-023 2026-10-01 bbox 개정, grid_tiles): WFS bbox 한 번이 32 km 상자 안의 칸을 모두 준다(모형 약 200칸 — 한 칸
  조회의 수백 배). 물을 타일이 있으면 채우기 몫을 타일에 먼저 쓰고(호출 하나 = 예산 1 — 하루 예산과 해양수산부 시간 창 모두, 한 칸 조회와 같다),
  타일이 준 칸은 한 칸 조회 대기열에서 빠진다. 타일은 아는 칸(marine_grid4) · 한 칸 조회로 찾은 칸 · 받은 타일의 가장자리에 걸친(지금 스냅샷에서
  모르던) 칸의 기하에서만 정한다 — 칸 번호로 위치를 짐작하지 않는다. 잘렸을 수 있는 응답(maxFeatures 에 닿음 · numberOfFeatures 와 다름 · 크기 상한
  초과 · 칸 전체가 상자 안인 아는 칸이나 이 타일 안에서 한 칸 조회가 찾은 칸이 답에 없음 — 2026-10-01 검토 지적: 수만 보면 조용한 상한을 끝났다고
  적는다)은 넷으로 나눠 다시(가장 작은 4 km 도 그러면 incomplete — 1일 뒤. 부모보다 적은 지물로도 여전히 그러면 상한 탓이 아니므로 더 나누지 않고
  incomplete). 타일은 어느 번호도 부정 캐시에 적지 않는다 — '해양격자에 없음'(묻지 않은
  번호다)도, '격자 밖'도(타일의 격자 밖 지물은 품질 사례 · 원본만 남기고 그 번호는 한 칸 조회가 판정한다 — 2026-10-01 검토 지적).
  끝난 타일은 Redis wakeline:traffic_grid:tiles 에 적어 재기동 뒤 다시 묻지 않는다(읽지 못하면 DB 캐시처럼 DB_WAIT_S 기다린 뒤 메모리로만 — WARN).
  한 타일의 칸은 DB 쓰기 한 번(쓰기 큐의 작업 하나). 해석은 공급자가 스레드에서, 아는 칸 읽기 · 타일 셈도 스레드에서(이벤트 루프를 막지 않는다).
- 격자 기하 — 한 칸 조회(budget:mof_grid4, UTC 날 6,000): 물을 타일이 없을 때 모르는 grid_id 만, 한 칸에 WFS 한 번, 처음 본 순서대로(같은 스냅샷 안에서는 척수가
  많은 칸 먼저), 틱마다 WFS_PER_TICK(15)개 · FILL_MAX_S 안에서, 호스트 버킷(1 req/s — 교통 폴링 · 항만 입출항 색인(ADR-022)과 하나)과
  가장 낮은 우선순위(PRIORITY_BACKFILL — 입출항 색인보다도 낮다)로. 교통 폴링은 PRIORITY_FIXED 라 입출항 색인이 이어져도 먼저 받는다.
  호출마다 해양수산부 시간 창(budget:mof:h:{UTC 시} — 입출항 색인과 함께 센다, providers/data_go_kr.MOF_*)을 먼저 예약하되 입출항 색인 몫
  (MOF_GRID4_HOURLY_HEADROOM)을 남긴다 — 어느 날 경계로 세어도 두 API 합계가 포털 한도(10,000) 안(검토 지적: UTC 날 예산만으로는 KST 하루에
  두 몫을 쓸 수 있었다). 창이나 하루 예산에 막히면 그 까닭을 실행 기록에 한 번 적고 다음 UTC 시 · 다음 UTC 날까지 채우지 않는다(틱마다 적지 않는다).
  채우기는 시간당 많아야 MOF_HOURLY_CAP − MOF_GRID4_HOURLY_HEADROOM(290)칸 · UTC 날 6,000칸(24 × 290 = 6,960 — 쉬지 않고 채우면 UTC 날마다
  하루 예산에서도 멈춘다). 끝나는 때는 말하지 않는다(ADR-023 2026-10-01 개정): 배가 있는 칸은 스냅샷마다 바뀌어, 2026-09-30 에 이미 확인한
  칸(7,303) + 부정 캐시(502)가 스냅샷 하나(많아야 6,422칸)보다 많았다 — 배가 들어설 수 있는 칸 전체의 수는 잰 적이 없다.
  대기열(_pending)은 메모리다 — 다시 시작하면 비고, 결과(칸 → DB · 부정 → Redis)만 남는다. 그래서 재기동 뒤 첫 스냅샷은 결과가 없는 칸을
  모두 '새로 넣은 칸'으로 센다(같은 칸을 다시 묻는 것이 아니다 — 결과가 있는 칸은 넣지 않는다).
  * found: 0.025° 격자 검사를 통과한 칸 → 메모리 + DB marine_grid4(V14 — 다시 시작해도 다시 묻지 않는다).
  * not_found(numberOfFeatures 0) · off_grid(격자 검사 실패 — 격리, 품질 사례 · 원본 보관): 부정 캐시 Redis wakeline:traffic_grid:negative
    (grid_no → {"reason","at"}) — NEGATIVE_TTL_S(7일) 뒤 다시 묻는다. 메모리가 MAX_TRACKED 에 닿으면 기한이 지난 항목만 비운다(유효한
    결과는 잊지 않는다 — 크기는 Redis 해시만큼). Redis 해시는 줄지 않는다(수집기 ACL 에 HDEL 이 없다 — 다시 물으면 덮어쓴다).
  * 오류(HTTP · 응답 모양 · 시간 초과): 그 칸만 5분 → 30분 → 2시간 → 6시간 뒤 다시. ID_MAX_FAILURES(5)번 연달아 실패하면 failed —
    부정 캐시에 적고(FAILED_TTL_S, 1일 뒤 처음부터 다시) 스냅샷에 pending 이 아니라 failed 로 센다(품질 사례 traffic_grid_lookup_failed).
    실패한 적이 있는 칸은 새 칸 뒤에 묻는다. 한 틱에서 연달아 FILL_BREAKER_ERRORS(3)번 실패하면 채우기 전체를 5분 → 10분 → 30분 → 1시간
    쉰다(키 · 서비스 장애에 예산을 쓰지 않게).
  * 보내지 않은 호출(속도 상한 · 운영자 끔 · 연결 전 실패 · 종료 취소)은 예산을 돌려주고 그 틱의 채우기를 멈춘다.
  * DB 캐시를 아직 읽지 못했으면 기동 뒤 DB_WAIT_S(10분)까지는 채우지 않는다(이미 아는 칸을 다시 묻지 않게). 그 뒤에는 DB 없이 채우고, DB 가
    돌아오면 읽어 합친다(실시간 경로는 DB 에 의존하지 않는다).
  * 로그(INFO — /logs 에는 WARN 이상만 오른다): 새 regDt 마다 한 줄 — 스냅샷의 몇 칸에 기하가 있는가 · 없는 칸의 까닭(대기 · 해양격자에 없음 ·
    격자 밖 · 조회 실패 · 대기열이 가득 차 넣지 못함) · 대기열 크기와 앞 줄 뒤에 새로 넣은 수(같은 regDt 호출에서 넣은 칸 포함). 채우기 한 번(다시 시작한 틱 → 멈춘 틱: 시간 창 · 하루 예산 ·
    차단기 · 운영자 끔 · 물을 칸이 없음)마다 요약 한 줄 — 조회 수 · 결과 · 아는 칸 · 기다리는 칸 · 오늘 쓴 호출 · 멈춘 까닭과 다시 시작하는 때.
- 발행: 새 regDt 이거나 기하가 늘어 수가 바뀌면(PUBLISH_MIN_INTERVAL_S 에 한 번) SET wakeline:traffic_grid EX 1200. 값은 traffic_grid.build_payload.
  오래됨(regDt 15분 초과) 판정은 api 가 한다. 수집기가 멈추면 20분 뒤 키가 사라진다.
- heartbeat(wakeline:collector): traffic_grid_at · traffic_grid_lag_s(regDt 나이) · traffic_grid_state(active · no_key · fixture ·
  operator_off) · traffic_grid_last_ok · traffic_grid_reg_dt · resolved/unresolved · 알고 있는 칸 수 · pending · failed · 오늘 쓴 호출 수(두 예산) ·
  traffic_grid_publish_delay_s(배운 발행 지연 — 배우기 전에는 빈 값) · 채우기 진행(ADR-023 2026-10-01 개정 — DB 없이 수렴을 본다):
  traffic_grid_not_found · traffic_grid_off_grid(유효한 부정 캐시) · traffic_grid_not_queued(마지막으로 읽은 스냅샷의 칸 가운데
  대기열이 가득 차 넣지 못한 칸 — 서로 다른 칸 수, 누계가 아니다. 읽기 전 빈 값) ·
  traffic_grid_fill_state(filling · idle · retry_wait · waiting_db · waiting_tiles · hour_window · daily_budget · breaker · operator_off) ·
  traffic_grid_fill_resume_at(다음에 움직이는 때 — 없으면 빈 값) · traffic_grid_fill_pass_at 과 _lookups · _found · _not_found · _off_grid ·
  _errors(이 프로세스에서 마지막으로 끝난 채우기 한 번 — 없으면 빈 값) · bbox 타일(타일 공급자가 없으면 빈 값): traffic_grid_tiles_done ·
  traffic_grid_tiles_queued · traffic_grid_fill_pass_tiles · _tile_cells · _tile_new · _tile_stored · _tile_splits · _tile_incomplete · _tile_errors.
- 서비스 키는 공급자 안에만 있다. 오류 문구는 describe_error(가림)를 거친다. fixture 모드는 외부 호출이 없으므로 끈다(state fixture).
PUBLISH_DELAY_S · DELAY_* · LEARN_SLACK_S · HOURLY_CAP · 물러나기 단계 · WFS_PER_TICK · 부정 캐시 7일 · 연달아 실패 5번 · failed 1일 · 미래 허용 120 s 는
선택값이다(잰 값이 아니다). 발행 지연은 배운 값(heartbeat)으로만 말한다.
"""

from __future__ import annotations

import asyncio
import itertools
import logging
import time
from collections import Counter, deque
from collections.abc import Awaitable, Callable, Iterable
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any, Protocol

import orjson

from wakeline_collector import grid_tiles as gt
from wakeline_collector.budget import UNKNOWN
from wakeline_collector.errors import describe_error
from wakeline_collector.grid_tiles import Tile, TilePlan, TileState, cell_corners_xy, cell_xy, encode_state
from wakeline_collector.http import BeforeSend, FetchResponse, ProviderHttpError, SendCancelled
from wakeline_collector.jobs.context import JobContext
from wakeline_collector.marine_grid import CELL_DEG, SNAP_TOL_DEG, Cell, WfsTooLarge, lattice_step, snap
from wakeline_collector.providers.data_go_kr import (
    MOF_GRID4_HOURLY_HEADROOM,
    MOF_HOUR_WINDOW,
    MOF_HOURLY_CAP,
    WfsLookup,
    WfsTileLookup,
)
from wakeline_collector.raw_store import archive
from wakeline_collector.retry import NOT_SENT
from wakeline_collector.traffic_grid import GRID_ID_RE, KomsaSnapshot, build_payload, iso_z

log = logging.getLogger("job.traffic_grid")

SNAPSHOT_KEY = "wakeline:traffic_grid"
NEGATIVE_KEY = "wakeline:traffic_grid:negative"
TILES_KEY = "wakeline:traffic_grid:tiles"  # bbox 타일 상태(grid_tiles — 키 "level/ix/iy" → {"status","at","cells"}) — ADR-023 2026-10-01 bbox 개정
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
MAX_TRACKED = 20_000  # 조회 대기열 상한 · 부정 캐시(메모리)가 이만큼이면 기한이 지난 항목을 비운다(유효한 항목은 남긴다)
DB_RETRY_S = 60
DB_WAIT_S = 600
PUBLISH_MIN_INTERVAL_S = 30
REDIS_TIMEOUT_S = 3.0
# 타일 답이 온전한지 아는 칸으로 본다(ADR-023 2026-10-01 bbox 개정 · 검토 지적): 중심이 상자 가장자리에서 이만큼 넘게 안쪽인 아는 칸은 칸 전체가
# 상자 안이다 — 0.025° 칸의 EPSG:5179 반폭은 동서 ≤ 1.24 km · 남북 ≤ 1.45 km(33–39 N, 중앙 경선에서 ±5° 의 자오선 수렴 포함 — 계산). 그런 칸은
# 서버가 '겹치는 칸'을 주든 '안에 든 칸'만 주든 답에 있어야 한다. 선택값(계산한 반폭 위의 여유)
KNOWN_MARGIN_M = 1_600
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


class TileSource(Protocol):
    """bbox 타일(ADR-023 2026-10-01 bbox 개정) — 한 칸 조회와 같은 서비스 · 같은 예산(이름이 같아야 한다)."""

    name: str
    cost: int

    @property
    def configured(self) -> bool: ...

    async def bbox(
        self, box: tuple[int, int, int, int], *, wait_s: float = ..., before_send: BeforeSend | None = None
    ) -> WfsTileLookup: ...


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

    @property
    def expires(self) -> datetime:
        return self.at + timedelta(seconds=FAILED_TTL_S if self.reason == "failed" else NEGATIVE_TTL_S)

    def valid(self, now: datetime) -> bool:
        return now < self.expires


class GridGeometry:
    """grid_id → 칸. 모르는 칸은 처음 본 순서로 기다리고(실패한 적이 있는 칸은 뒤로), 없는 칸 · 격자에 맞지 않는 칸은 부정 캐시(기한
    NEGATIVE_TTL_S), 조회가 ID_MAX_FAILURES 번 연달아 실패한 칸은 failed(기한 FAILED_TTL_S — 확인 중으로 세지 않는다).
    대기열(_pending)은 이 프로세스의 메모리다 — 다시 시작하면 비고, 결과(칸 → DB marine_grid4, 부정 → Redis)만 남는다."""

    def __init__(self) -> None:
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
            if len(self._pending) >= MAX_TRACKED:
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
        if grid_no not in self.negative and len(self.negative) >= MAX_TRACKED:
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
    tile_incomplete: int = (
        0  # 잘렸을 수 있지만 더 나누지 않고 incomplete 로 둔 타일(가장 작은 4 km · 부모보다 적은 지물로도 여전히)
    )
    tile_errors: int = 0


@dataclass
class _Tick:
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
    errors_in_row: int = 0
    last_error: str | None = None
    http_status: int | None = None
    latency: list[int] = field(default_factory=list)
    quality: list[tuple[str, str | None, dict[str, Any]]] = field(default_factory=list)
    stop_reason: str | None = None
    hold_until: datetime | None = None
    hold_kind: str = ""
    paused: bool = False

    @property
    def received(self) -> int:
        return len(self.found) + self.tile_cells

    @property
    def succeeded(self) -> int:
        return self.calls - (self.lookups - len(self.found) - self.not_found - self.off_grid) - self.tile_errors


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
        tiles: TileSource | None = None,
        now: Callable[[], datetime] = _utcnow,
        mono: Callable[[], float] = time.monotonic,
    ) -> None:
        """tiles: bbox 타일을 묻는 공급자(운영은 wfs 와 같은 Grid4WfsProvider — 같은 예산). 없으면 한 칸 조회만 한다."""
        if tiles is not None and (tiles.name != wfs.name or tiles.cost != wfs.cost):
            raise ValueError("bbox tiles must be the same provider and budget as the one-id lookup")
        self.komsa, self.wfs, self.ctx = komsa, wfs, ctx
        self.tile_src = tiles
        self.tiles = TilePlan()
        self._tiles_loaded = False  # Redis 의 타일 상태를 읽었다
        self._tiles_seeded = False  # 아는 칸(marine_grid4)으로 타일을 넣었다
        self._tiles_warned = False
        self._tiles_error = ""  # 타일 상태를 읽지 못한 마지막 까닭(예외 이름)
        self._tile_write_error = ""  # 타일 상태를 쓰지 못한 마지막 까닭(성공하면 비운다)
        # 타일이 격자 밖으로 준 번호(이 프로세스) — 한 칸 조회가 그 번호를 찾아도 타일을 다시 묻지 않는다(타일은 그 번호를 주었다 — 기하가 다를 뿐)
        self._tile_off_grid_ids: set[str] = set()
        # 아는 칸 → 중심이 든 level 0 타일(받은 기하에서만). 타일 답에서 빠진 아는 칸을 찾는 데 쓴다(_known_inside) — 번호 참조만(칸 10만에 약 1 MB)
        self._known_at: dict[Tile, list[str]] = {}
        self._pass_warned: set[str] = set()  # 이 채우기에서 이미 WARN 한 종류(incomplete) — 채우기가 끝나면 비운다
        # 마지막으로 읽은 스냅샷의 칸 — 가장자리 칸이 '지금 배가 있는 모르는 칸'인지 본다
        self._snapshot_ids: frozenset[str] = frozenset()
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
        self._fill_hold_until: datetime | None = None  # 시간 창 · 하루 예산이 다시 셀 때(다음 UTC 시 · 날)까지 채우지 않는다
        self._fill_hold_kind = ""  # hour_window · daily_budget
        self._pass: FillPass | None = None  # 열린 채우기 한 번
        self._last_pass: tuple[datetime, FillPass] | None = None  # 이 프로세스에서 마지막으로 끝난 채우기(끝난 때)
        self._new_snapshots = 0  # 이 프로세스가 받은 새 regDt 수(첫 스냅샷 줄에만 대기열이 남지 않는다는 설명을 붙인다)
        self._queued_unlogged = 0  # 같은 regDt 호출에서 대기열에 넣은 칸 — 다음 스냅샷 줄의 +K 에 더한다
        self._logged_disabled: str | None = None
        self._waiting_logged = False
        self.counts = {"komsa_calls": 0, "wfs_calls": 0, "wfs_tiles": 0, "published": 0}

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
                    # Redis 해시는 줄지 않는다(수집기 ACL 에 HDEL 이 없다 — 다시 물으면 같은 칸을 덮어쓴다): 기한이 지난 항목도 실려 있다
                    valid = self.geometry.negative_counts(now)
                    log.info(
                        "traffic grid: negative cache — %d entries loaded: %d not in the MOF grid, %d off grid, %d failed still valid; "
                        "%d expired (asked again when seen)",
                        n,
                        valid["not_found"],
                        valid["off_grid"],
                        valid["failed"],
                        n - sum(valid.values()),
                    )
            except Exception as e:  # noqa: BLE001 — 다음 틱에 다시(부정 캐시는 부가 — 없어도 동작)
                log.info("traffic grid: negative cache not readable yet (%s)", type(e).__name__)
        if self.tile_src is not None and not self._tiles_loaded:
            await self._load_tiles(now)
        if not (self._db_loaded or (self._db_next_try is not None and now < self._db_next_try)):
            rows = await self.ctx.db.read_marine_grid4()
            if rows is None:
                self._db_next_try = now + timedelta(seconds=DB_RETRY_S)
            else:
                # 아는 칸이 연안 전체(시뮬레이션 약 10만)로 늘면 읽기 · 검사가 약 0.3 s(잰 값) — 이벤트 루프 밖에서
                ok, bad = await asyncio.to_thread(self.geometry.load_cells, rows)
                self._db_loaded = True
                self._dirty = self._dirty or ok > 0
                log.info(
                    "traffic grid: %d grid cells loaded from marine_grid4%s", ok, f" ({bad} invalid rows ignored)" if bad else ""
                )
        if self.tile_src is not None and self._db_loaded and not self._tiles_seeded and self._tiles_ready(now):
            await self._seed_known_tiles(now)

    async def _load_tiles(self, now: datetime) -> None:
        """타일 상태(Redis 해시) 읽기. 못 읽으면 다음 틱에 다시 — 채우기는 기동 뒤 DB_WAIT_S 까지 기다리고(끝난 타일을 다시 묻지 않게) 그 뒤에는
        메모리로만 한다(WARN 한 번 — _tiles_ready)."""
        try:
            async with asyncio.timeout(REDIS_TIMEOUT_S):
                fields = await self.ctx.status.redis.hgetall(TILES_KEY)
        except Exception as e:  # noqa: BLE001 — 기다린 뒤 메모리로(아래)
            if type(e).__name__ != self._tiles_error:  # 틱마다 같은 실패를 쌓지 않는다 — 까닭이 바뀔 때만
                log.info("traffic grid: bbox tile states not readable yet (%s) — retried every tick", type(e).__name__)
            self._tiles_error = type(e).__name__
            return
        n = self.tiles.load(fields or {})
        self._tiles_loaded = True
        by = Counter(s.status for s in self.tiles.states.values() if s.valid(now))
        log.info(
            "traffic grid: bbox tiles — %d tile states loaded (%d done, %d split, %d incomplete, %d failed still valid)",
            n,
            by["done"],
            by["split"],
            by["incomplete"],
            by["failed"],
        )

    def _tiles_ready(self, now: datetime) -> bool:
        """타일을 물어도 되는가: 상태를 읽었거나, 기동 뒤 DB_WAIT_S 가 지났다(그때는 메모리로만 — WARN 한 번)."""
        if self.tile_src is None:
            return False
        if self._tiles_loaded:
            return True
        if self._started is not None and (now - self._started).total_seconds() < DB_WAIT_S:
            return False
        if not self._tiles_warned:
            self._tiles_warned = True
            log.warning(
                "traffic grid: bbox tile states (%s) not readable for %d s (%s) — tiles go on in memory only, so finished tiles "
                "are asked again after a restart; a NoPermissionError means the Redis ACL lacks the tiles selector "
                "(infra/redis/start.sh) — restart redis to load it",
                TILES_KEY,
                DB_WAIT_S,
                self._tiles_error or "unknown",
            )
        return True

    def known_tiles(self) -> Counter[Tile]:
        """아는 칸 중심이 든 가장 작은 타일(split 을 따라)마다 칸 수 — 끝나지 않은 타일만. 모서리 하나라도 끝난 타일 안인 칸은 세지 않는다(그 타일이
        준, 가장자리에 걸친 칸이다 — 세면 재기동마다 끝난 타일의 이웃을 모두 넣어 바깥으로 번진다). 칸마다 투영 한 번(약 3 µs), 남은 칸은 네 번 더 —
        스레드에서 부른다."""
        out: Counter[Tile] = Counter()
        now = self._now()
        plan = self.tiles
        any_state = bool(plan.states)
        index: dict[Tile, list[str]] = {}
        for c in list(self.geometry.cells.values()):
            xy = cell_xy(c)
            index.setdefault(gt.tile_at(*xy), []).append(c.grid_no)  # 아는 칸 색인도 같은 투영으로(따로 한 번 더 돌지 않는다)
            t = plan.leaf(*xy)
            if plan.covered(t, now):
                continue
            if any_state and any(plan.finished(plan.leaf(x, y), now) for x, y in cell_corners_xy(c)):
                continue
            out[t] += 1
        self._known_at = index
        return out

    def _index(self, grid_no: str, x: float, y: float) -> None:
        """새로 알게 된 칸(또는 기하가 바뀐 칸)을 색인에 — (x, y) 는 받은 기하의 중심(EPSG:5179). 옛 자리는 지우지 않는다(_known_inside 가 지금 기하로 다시 본다)."""
        if self.tile_src is not None:
            self._known_at.setdefault(gt.tile_at(x, y), []).append(grid_no)

    def _known_inside(self, tile: Tile) -> set[str]:
        """아는 칸 가운데 칸 전체가 이 타일 상자 안인 칸(중심이 가장자리에서 KNOWN_MARGIN_M 넘게 안쪽) — 이 타일의 답에 있어야 한다. 후보는 level 0
        조상의 색인(많아야 약 200칸)이고 칸마다 투영 한 번(약 3 µs)."""
        x0, y0, x1, y1 = tile.box
        m = KNOWN_MARGIN_M
        root = Tile(0, tile.ix >> tile.level, tile.iy >> tile.level)
        out: set[str] = set()
        for g in self._known_at.get(root, ()):
            c = self.geometry.cells.get(g)
            if c is None or g in out:
                continue
            x, y = cell_xy(c)
            if x0 + m < x < x1 - m and y0 + m < y < y1 - m:
                out.add(g)
        return out

    async def _seed_known_tiles(self, now: datetime) -> None:
        self._tiles_seeded = True
        counts = await asyncio.to_thread(self.known_tiles)
        added = sum(1 for t, n in counts.most_common() if self.tiles.add(t, "known", now, weight=n))
        log.info(
            "traffic grid: bbox tiles — %d tiles queued from %d known cells (%d tiles done)",
            added,
            len(self.geometry.cells),
            self.tiles.done_count(),
        )

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
            # 부정 캐시 기한이 지난 칸 · 채우기가 비운 자리에 넣지 못했던 칸을 다시 기다림에 — 넣은 수는 다음 스냅샷 줄이 센다
            self._queued_unlogged += self.geometry.observe(((i.grid_id, i.vmtc) for i in snap.items), now)
            self._dirty = True  # 같은 값을 다시 실어 TTL 만 늘린다 — api 가 regDt 나이로 '멈춤'을 밝힌다(값이 같아 ETag 도 같다)
            await self._success(resp, len(snap.items))
            return
        raw_ref = await archive(self.ctx.raw, p.name, resp.body, resp.fetched_at)
        self.snapshot, self.fetched_at, self.last_ok = snap, resp.fetched_at, resp.fetched_at
        self._snapshot_ids = frozenset(i.grid_id for i in snap.items)
        self.schedule.on_new(snap.reg_dt, now)
        self._new_snapshots += 1
        added = self.geometry.observe(((i.grid_id, i.vmtc) for i in snap.items), now) + self._queued_unlogged
        self._queued_unlogged = 0
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
        self._log_snapshot(snap, added, now)

    def _log_snapshot(self, snap: KomsaSnapshot, added: int, now: datetime) -> None:
        """새 regDt 한 줄: 이 스냅샷의 몇 칸에 기하가 있는가(지도에 그려지는 칸)와 없는 칸의 까닭, 조회 대기열. 대기열 증가(+K)는 '처음 본 칸'이
        아니라 '이 프로세스가 앞 스냅샷 줄 뒤에 새로 넣은 칸'이다(그 사이 같은 regDt 호출에서 넣은 칸 포함 — 줄마다 더하면 이 프로세스가 넣은 칸 수).
        대기열은 메모리라 재기동 뒤 첫 스냅샷은 결과(DB · 부정 캐시)가 없는 칸을 모두 다시 센다(운영 2026-09-30: 예전 줄 'N new unknown ids' 가
        재기동 직후 1,372 · 그 뒤 스냅샷마다 340–450)."""
        c = self.geometry.coverage((i.grid_id for i in snap.items), now)
        without = len(snap.items) - c["cells"]
        full = f", {c['not_queued']} not queued — queue full at {MAX_TRACKED}" if c["not_queued"] else ""
        note = (
            " — first snapshot since this process started: the queue is not kept across restarts, "
            "so ids queued before a restart are counted again"
            if self._new_snapshots == 1
            else ""
        )
        log.info(
            "traffic grid: regDt %s — %d cells (%d rejected): %d with geometry, %d without (%d waiting for a lookup, "
            "%d not in the MOF grid, %d off grid, %d lookup failed%s); lookup queue %d (+%d newly queued%s)",
            iso_z(snap.reg_dt),
            len(snap.items),
            len(snap.rejected),
            c["cells"],
            without,
            c["pending"],
            c["not_found"],
            c["off_grid"],
            c["failed"],
            full,
            self.geometry.pending,
            added,
            note,
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
    def _waiting_for_db(self, now: datetime) -> bool:
        return not self._db_loaded and self._started is not None and (now - self._started).total_seconds() < DB_WAIT_S

    def _waiting_for_caches(self, now: datetime) -> str:
        """채우기가 아직 기다리는 캐시 — "db"(marine_grid4) · "tiles"(타일 상태 해시) · ""(기다리지 않는다). 둘 다 기동 뒤 DB_WAIT_S 까지만."""
        if self._waiting_for_db(now):
            return "db"
        if self.tile_src is not None and not self._tiles_ready(now):
            return "tiles"
        return ""

    def _tiles_on(self, now: datetime) -> bool:
        return self.tile_src is not None and self.tile_src.configured and self._tiles_ready(now)

    def _fill_due(self, now: datetime) -> bool:
        return self.geometry.has_due(now) or (self._tiles_on(now) and self.tiles.has_due(now))

    async def _fill(self, now: datetime) -> None:
        w = self.wfs
        if not w.configured:
            return
        if not self.geometry.pending and not self.tiles.queued:
            await self._end_pass(self._idle_reason(now))
            return
        waiting = self._waiting_for_caches(now)
        if waiting:
            if not self._waiting_logged:
                self._waiting_logged = True
                what = "the marine_grid4 cache" if waiting == "db" else f"the bbox tile states ({TILES_KEY})"
                log.info("traffic grid: waiting up to %d s for %s before WFS lookups", DB_WAIT_S, what)
            return
        if self._fill_pause_until is not None and now < self._fill_pause_until:
            return
        if self._fill_hold_until is not None and now < self._fill_hold_until:
            return
        if await self.ctx.status.is_disabled(w.name):
            await self._end_pass("stopped: mof_grid4 switched off by the operator")
            return
        if not self._fill_due(now):
            await self._end_pass(self._idle_reason(now))
            return
        t0 = self._mono()
        tk = _Tick()
        started = now
        id_batch: list[str] | None = None
        for _ in range(WFS_PER_TICK):
            if self._mono() - t0 > FILL_MAX_S:
                break
            # 타일 먼저(한 번에 칸 수백 개) — 물을 타일이 없을 때만 한 칸 조회. 한 칸 조회가 찾은 칸의 타일은 곧바로 다음 차례다
            tile = self.tiles.next_due(now) if self._tiles_on(now) else None
            g: str | None = None
            if tile is None:
                if id_batch is None:
                    id_batch = self.geometry.due(now, WFS_PER_TICK)
                while id_batch and not self.geometry.is_pending(id_batch[0]):
                    id_batch.pop(0)  # 이 틱의 타일이 풀었다
                if not id_batch:
                    break
                g = id_batch.pop(0)
            at = self._now()  # 보내는 때의 UTC 시 창에 센다(채우기가 정시를 넘겨도)
            hour = await self._reserve(w, at, tk)
            if hour is None:
                break
            if tile is not None:
                go_on = await self._fetch_tile(tile, hour, now, tk)
            else:
                assert g is not None
                go_on = await self._lookup(g, hour, now, tk)
            if not go_on:
                break
        self.counts["wfs_calls"] += tk.calls
        self.counts["wfs_tiles"] += tk.tiles
        if tk.found:
            self.ctx.db.upsert_marine_grid4(tk.found, now)
        if tk.received or tk.not_found or tk.off_grid or tk.tile_off_grid:
            self._dirty = True
            self._fill_pauses = 0
        if tk.gave_up:
            self._dirty = True  # pending → failed: 수가 바뀌었다
        if tk.calls:
            await self._record_fill(w, started, tk)
        if tk.calls or tk.hold_until is not None:
            ps = self._pass = self._pass or FillPass(started)
            ps.lookups += tk.lookups
            ps.found += len(tk.found)
            ps.not_found += tk.not_found
            ps.off_grid += tk.off_grid
            ps.errors += tk.lookups - len(tk.found) - tk.not_found - tk.off_grid
            ps.set_aside += tk.gave_up
            ps.tiles += tk.tiles
            ps.tile_cells += tk.tile_cells
            ps.tile_new += tk.tile_new
            ps.tile_stored += tk.tile_stored
            ps.tile_splits += tk.tile_splits
            ps.tile_incomplete += tk.tile_incomplete
            ps.tile_errors += tk.tile_errors
        if tk.stop_reason is None:
            if tk.paused:
                await self._end_pass(
                    f"paused: {tk.errors_in_row} WFS errors in a row — geometry fill resumes at "
                    f"{iso_z(self._fill_pause_until or now)}"
                )
            elif not self._fill_due(self._now()):
                await self._end_pass(self._idle_reason(self._now()))
            return  # 그 밖(틱의 상한 · 시간 상한 · 속도 상한으로 보내지 못함)은 다음 틱에 이어서 — 같은 채우기다
        if tk.hold_until is not None:
            # 다시 셀 때까지 채우지 않는다 — 까닭은 이번에 한 번만, 이 채우기의 요약 줄에 적는다(전에는 틱(30 s)마다 같은 거절을 한 줄씩 쌓았다)
            self._fill_hold_until, self._fill_hold_kind = tk.hold_until, tk.hold_kind
            tk.stop_reason = f"{tk.stop_reason} — geometry fill resumes at {iso_z(tk.hold_until)}"
            await self._end_pass(f"stopped: {tk.stop_reason}")
        elif tk.calls:
            return  # 예산 저장소 장애 — 이번 틱은 보낸 호출만 적는다(다음 틱에 다시 본다)
        self.ctx.db.record_run(
            self.geom_job_name,
            w.name,
            started,
            status="budget_unavailable" if tk.hold_until is None else "budget_exhausted",
            error_text=tk.stop_reason,
        )

    async def _reserve(self, w: WfsSource, at: datetime, tk: _Tick) -> str | None:
        """호출 하나(한 칸 조회든 타일이든 예산 1)의 예약: 해양수산부 시간 창 먼저(입출항 색인 몫을 남기고) — 그다음 하루 예산. 하나라도 안 되면 부르지
        않고 None(까닭은 tk 에). 되면 시간 창 키."""
        ok, used, hour = await self.ctx.budget.reserve_hour(
            w.name, MOF_HOURLY_CAP, w.cost, now=at, window=MOF_HOUR_WINDOW, headroom=MOF_GRID4_HOURLY_HEADROOM
        )
        if not ok:
            if used == UNKNOWN:
                tk.stop_reason = "budget store unavailable (fail closed)"
            else:
                tk.hold_until = at.astimezone(UTC).replace(minute=0, second=0, microsecond=0) + timedelta(hours=1)
                tk.hold_kind = "hour_window"
                tk.stop_reason = (
                    f"MOF hourly window: grid share used ({used} of {MOF_HOURLY_CAP} in UTC hour {hour.rsplit(':', 1)[-1]}, "
                    f"{MOF_GRID4_HOURLY_HEADROOM} left for port calls)"
                )
            return None
        ok, used = await self.ctx.budget.reserve(w.name, w.cost)
        if not ok:
            await self.ctx.budget.release_key(hour, w.cost)
            if used == UNKNOWN:
                tk.stop_reason = "budget store unavailable (fail closed)"
            else:
                tk.hold_until = at.astimezone(UTC).replace(hour=0, minute=0, second=0, microsecond=0) + timedelta(days=1)
                tk.hold_kind = "daily_budget"
                tk.stop_reason = f"daily budget exhausted (used={used})"
            return None
        return hour

    async def _send[T](self, w: WfsSource, hour: str, call: Callable[[BeforeSend], Awaitable[T]]) -> T | None:
        """예약한 호출 하나를 보낸다. 보내지 않은 호출(속도 상한 · 운영자 끔 · 연결 전 실패)은 두 예약을 돌려주고 None, 종료 취소도 보내기 전이면
        돌려준다. 보낸 뒤의 실패는 예외 그대로(호출자가 센다)."""
        sent = False

        async def give_back() -> None:
            await self.ctx.budget.release(w.name, w.cost)
            await self.ctx.budget.release_key(hour, w.cost)

        async def before_send() -> bool:
            nonlocal sent
            if await self.ctx.status.is_disabled(w.name):
                return False
            sent = True
            return True

        try:
            return await call(before_send)
        except asyncio.CancelledError:
            if not sent:
                await asyncio.shield(give_back())
            raise
        except NOT_SENT:
            await give_back()
            return None

    def _call_failed(self, e: Exception, tk: _Tick, now: datetime) -> bool:
        """보낸 호출의 오류 한 번(한 칸 조회 · 타일 공통): 연달아 FILL_BREAKER_ERRORS 번이면 채우기 전체를 쉰다 — 그러면 False(이 틱을 멈춘다)."""
        tk.calls += 1
        tk.errors_in_row += 1
        tk.last_error = describe_error(e)
        tk.http_status = e.status if isinstance(e, ProviderHttpError) else tk.http_status
        if tk.errors_in_row >= FILL_BREAKER_ERRORS:
            self._fill_pause_until = now + timedelta(seconds=_step(FILL_PAUSE_S, self._fill_pauses))
            self._fill_pauses += 1
            tk.paused = True
            log.warning(
                "traffic grid: %d WFS errors in a row — geometry fill paused until %s (last: %s)",
                tk.errors_in_row,
                iso_z(self._fill_pause_until),
                tk.last_error,
            )
            return False
        return True

    async def _lookup(self, g: str, hour: str, now: datetime, tk: _Tick) -> bool:
        """한 칸 조회 하나. 이 틱을 이어 가면 True."""
        w = self.wfs
        try:
            got = await self._send(w, hour, lambda bs: w.lookup(g, before_send=bs))
        except Exception as e:  # noqa: BLE001 — HTTP · 응답 모양(WfsError) · 읽기 시간 초과
            tk.lookups += 1
            if self.geometry.failed(g, now):
                tk.gave_up += 1
                await self._store_negative(g, "failed", now)
                tk.quality.append(
                    (
                        "traffic_grid_lookup_failed",
                        None,
                        {"grid_no": g, "failures": ID_MAX_FAILURES, "last": describe_error(e)[:200]},
                    )
                )
                log.warning(
                    "traffic grid: %s failed %d lookups in a row — set aside for %d h (last: %s)",
                    g,
                    ID_MAX_FAILURES,
                    FAILED_TTL_S // 3600,
                    describe_error(e),
                )
            return self._call_failed(e, tk, now)
        if got is None:
            return False
        tk.calls += 1
        tk.lookups += 1
        tk.errors_in_row = 0
        if got.latency_ms is not None:
            tk.latency.append(got.latency_ms)
        r = got.result
        if r.kind == "found" and r.cell is not None:
            self.geometry.resolved(r.cell)
            tk.found.append(r.cell)
            if self.tile_src is not None:
                self._index(r.cell.grid_no, *cell_xy(r.cell))
            self._tile_from_lookup(r.cell, now)
        elif r.kind == "not_found":
            tk.not_found += 1
            self.geometry.mark_negative(g, "not_found", now)
            await self._store_negative(g, "not_found", now)
        else:
            tk.off_grid += 1
            self.geometry.mark_negative(g, "off_grid", now)
            await self._store_negative(g, "off_grid", now)
            ref = await archive(self.ctx.raw, w.name, got.body, now)
            tk.quality.append(("traffic_grid_off_grid", None, {"grid_no": g, "detail": (r.detail or "")[:200], "raw_ref": ref}))
        return True

    def _tile_from_lookup(self, cell: Cell, now: datetime) -> None:
        """한 칸 조회로 찾은 칸 → 그 칸(기하의 중심)이 든 타일을 곧바로 다음 차례로. 이미 끝난(done) 타일이면 그 타일이 이 칸을 주지 않았다는
        뜻이다(DB 쓰기를 잃었거나 서버가 조용히 뺐다) — 이 프로세스에서 한 번 다시 묻는다."""
        if not self._tiles_on(now):
            return
        t = self.tiles.leaf(*cell_xy(cell))
        if self.tiles.add(t, "lookup", now):
            return
        st = self.tiles.states.get(t)
        if cell.grid_no in self._tile_off_grid_ids:
            # 타일은 이 번호를 주었다(격자 밖 기하로 — 품질 사례 · 원본에 남았다). 확인한 한 칸 조회의 기하를 쓰고 타일은 다시 묻지 않는다
            return
        if st is not None and st.status == "done" and self.tiles.recheck(t, cell.grid_no, now):
            log.info("traffic grid: lookup found %s inside finished tile %s — asking that tile once more", cell.grid_no, t.key)

    async def _fetch_tile(self, tile: Tile, hour: str, now: datetime, tk: _Tick) -> bool:
        """bbox 타일 하나. 이 틱을 이어 가면 True."""
        src = self.tile_src
        assert src is not None
        try:
            got = await self._send(self.wfs, hour, lambda bs: src.bbox(tile.box, before_send=bs))
        except WfsTooLarge as e:
            tk.tiles += 1
            if tile.level == 0:
                # 크기 상한을 넘은 응답은 해석하지 않았다 — 오류가 아니라 '더 작은 상자로'(지물이 모형보다 많거나 크다). 한 번만: 0.025° 칸이면 32 km
                # 상자에 약 200칸(≈ 130 KB — 계산)뿐이라 나눈 16 km 상자가 또 넘으면 서버가 상자를 무시하거나 다른 것을 준다(검토 지적 2026-10-01 —
                # 예전에는 4 km 까지 21번을 쓰고서야 오류였다)
                tk.calls += 1
                tk.errors_in_row = 0
                await self._split(tile, str(e), 0, None, now, tk)
                return True
            tk.tile_errors += 1
            still = WfsTooLarge(
                f"{e} — still too large after a split ({tile.size} m box); the answer is not what the grid holds in this box"
            )
            return await self._tile_failed(tile, still, now, tk)
        except Exception as e:  # noqa: BLE001 — HTTP · 응답 모양(WfsError) · 읽기 시간 초과
            tk.tiles += 1
            tk.tile_errors += 1
            return await self._tile_failed(tile, e, now, tk)
        if got is None:
            return False
        tk.calls += 1
        tk.tiles += 1
        tk.errors_in_row = 0
        if got.latency_ms is not None:
            tk.latency.append(got.latency_ms)
        res = got.result
        x0, y0, x1, y1 = tile.box
        expected = self._known_inside(tile)  # 이 답 전에 알던 칸 가운데 칸 전체가 상자 안인 칸 — 답에 있어야 한다
        stored: list[Cell] = []
        edge: list[tuple[float, float]] = []
        new = 0
        for tc in res.cells:
            c = tc.cell
            prev = self.geometry.cells.get(c.grid_no)
            ex0, ey0, ex1, ey1 = tc.extent
            if prev != c:
                stored.append(c)
                self._index(c.grid_no, (ex0 + ex1) / 2, (ey0 + ey1) / 2)
            if prev is None:
                new += 1
                # 이웃 타일은 받은 기하에서만: 지금 스냅샷에서 위치를 모르던 칸이 이 타일의 가장자리에 걸치면 그 꼭짓점이 든 타일
                if c.grid_no in self._snapshot_ids and (ex0 <= x0 or ey0 <= y0 or ex1 >= x1 or ey1 >= y1):
                    edge.extend(((ex0, ey0), (ex0, ey1), (ex1, ey0), (ex1, ey1)))
            self.geometry.resolved(c)
        if stored:
            self.ctx.db.upsert_marine_grid4(stored, now)  # 한 타일 = 한 쓰기(쓰기 큐의 작업 하나 — 칸 수와 상관없이)
        ref: str | None = None
        if res.off_grid or res.rejected:
            ref = await archive(self.ctx.raw, self.wfs.name, got.body, now)
        for g, detail in res.off_grid:
            # 부정 캐시에 적지 않는다(검토 지적 2026-10-01): 타일의 격자 밖 판정은 품질 사례 · 원본 보관만 — 그 번호는 기다리게 두고 한 칸 조회(확인한
            # 길)가 판정한다. 한 번의 이상한 답(밀린 좌표 · 가장자리를 잘라 준 기하)이 번호 수백 개를 일주일 빼지 않게. 아는 칸은 아는 기하 그대로
            tk.tile_off_grid += 1
            if len(self._tile_off_grid_ids) < MAX_TRACKED:
                self._tile_off_grid_ids.add(g)
            tk.quality.append(
                ("traffic_grid_off_grid", None, {"grid_no": g, "detail": detail[:200], "tile": tile.key, "raw_ref": ref})
            )
        for rg, detail in res.rejected:
            tk.quality.append(
                (
                    "traffic_grid_tile_feature_rejected",
                    None,
                    {"grid_no": rg, "detail": detail[:200], "tile": tile.key, "raw_ref": ref},
                )
            )
        for x, y in edge:
            self.tiles.seed_at(x, y, "edge", now)
        tk.tile_cells += len(res.cells)
        tk.tile_new += new
        tk.tile_stored += len(stored)
        # 답이 온전한가 — 수(maxFeatures · numberOfFeatures)와, 이미 가진 자료: 칸 전체가 상자 안인 아는 칸 · 이 타일 안에서 한 칸 조회가 찾은 칸
        # (recheck)이 답에 없으면 잘렸을 수 있다(검토 지적 2026-10-01: 수가 맞는 조용한 상한 · 빠뜨림을 done 으로 적었다). 격자 밖 · 거절로라도
        # 답에 나온 번호는 빠진 것이 아니다(서버는 그 칸을 주었다 — 기하가 다를 뿐)
        lost = self.tiles.rechecking(tile)
        if lost is not None:
            expected.add(lost)
        listed = {tc.cell.grid_no for tc in res.cells} | {g for g, _d in res.off_grid} | {g for g, _d in res.rejected if g}
        missing = sorted(expected - listed)
        why = res.truncation
        if missing:
            tk.quality.append(
                ("traffic_grid_tile_missing_cell", None, {"tile": tile.key, "missing": len(missing), "grid_nos": missing[:5]})
            )
            gone = f"{len(missing)} known cells inside the box missing from the answer, e.g. {missing[0]}"
            why = gone if why is None else f"{why}; {gone}"
        if why is not None:
            await self._split(tile, why, len(res.cells), res.members, now, tk)
            return True
        state = self.tiles.finish(tile, "done", len(res.cells), now)
        await self._store_tile(tile, state)
        return True

    async def _split(self, tile: Tile, why: str, cells: int, members: int | None, now: datetime, tk: _Tick) -> None:
        """잘렸을 수 있는 타일: 넷으로 나눠 그 부분을 묻는다(받은 칸은 이미 썼다 — 지물마다 검사를 통과한 실제 기하). 가장 작은 타일이면 incomplete —
        TILE_FAILED_TTL_S 뒤 다시(그 사이 그 안의 칸은 한 칸 조회가 맡는다). 어느 쪽이든 어느 번호도 '없음'으로 적지 않는다.

        나누기의 값을 묶는다(검토 지적 2026-10-01: numberOfFeatures 의 뜻이 다르면 32 km 타일 하나가 4 km 까지 85번을 썼다): 나눈 부모가 검사를
        통과한 칸 N 개를 주었는데 이 자식의 답은 지물이 N 개보다 적은데도 여전히 잘렸을 수 있으면, 그것은 서버 상한 탓일 수 없다(같은 상한이 부모에게는
        더 많이 주었다) — 더 나눠도 나아지지 않으니 incomplete 로 둔다."""
        parent = tile.parent()
        ps = self.tiles.states.get(parent) if parent is not None else None
        not_a_cap = members is not None and ps is not None and ps.status == "split" and members < ps.cells
        if tile.level < gt.MAX_LEVEL and not not_a_cap:
            tk.tile_splits += 1
            state = self.tiles.finish(tile, "split", cells, now)
            log.info("traffic grid: tile %s possibly truncated (%s) — split into 4", tile.key, why)
        else:
            tk.tile_incomplete += 1
            if not_a_cap:
                assert parent is not None and ps is not None
                why = (
                    f"{why}; the parent tile {parent.key} gave {ps.cells} cells and this answer only {members} features, "
                    "so a server cap cannot explain it — splitting further would not help"
                )
            state = self.tiles.finish(tile, "incomplete", cells, now)
            # WARN 은 채우기 한 번에 하나(검토 지적 2026-10-01: 타일마다 WARN 이면 /logs 상한을 넘친다) — 나머지는 INFO, 요약 줄이 센다
            first = "incomplete" not in self._pass_warned
            self._pass_warned.add("incomplete")
            log.log(
                logging.WARNING if first else logging.INFO,
                "traffic grid: tile %s (%d m) still possibly truncated (%s) — marked incomplete for %d h; ids inside go on by one-id lookup%s",
                tile.key,
                tile.size,
                why,
                gt.TILE_FAILED_TTL_S // 3600,
                " (further incomplete tiles in this fill pass are logged at INFO and counted in its summary line)"
                if first
                else "",
            )
            tk.quality.append(("traffic_grid_tile_incomplete", None, {"tile": tile.key, "detail": why[:300]}))
        await self._store_tile(tile, state)

    async def _tile_failed(self, tile: Tile, e: Exception, now: datetime, tk: _Tick) -> bool:
        """보낸 타일 호출의 오류 한 번: 그 타일만 물러나고(TILE_RETRY_S) 연달아 TILE_MAX_FAILURES 번이면 failed(1일). 차단기는 한 칸 조회와 함께 센다."""
        if self.tiles.failed(tile, now):
            await self._store_tile(tile, self.tiles.states[tile])
            tk.quality.append(
                (
                    "traffic_grid_tile_failed",
                    None,
                    {"tile": tile.key, "failures": gt.TILE_MAX_FAILURES, "last": describe_error(e)[:200]},
                )
            )
            log.warning(
                "traffic grid: tile %s failed %d times in a row — set aside for %d h (last: %s)",
                tile.key,
                gt.TILE_MAX_FAILURES,
                gt.TILE_FAILED_TTL_S // 3600,
                describe_error(e),
            )
        return self._call_failed(e, tk, now)

    def _idle_reason(self, now: datetime) -> str:
        if not self.geometry.pending and not self.tiles.queued:
            base = "queue empty — every queued id has geometry or a negative-cache entry"
            return base if self.tile_src is None else f"{base}; no tile queued ({self.tiles.done_count()} done)"
        n, nxt = self.geometry.retries()
        if self.tile_src is None:
            return f"nothing due — {n} waiting for a retry after an error (next at {iso_z(nxt) if nxt else '—'})"
        tn, tnxt = self.tiles.retries()
        first = min((t for t in (nxt, tnxt) if t is not None), default=None)
        return (
            f"nothing due — {n} ids and {tn} tiles waiting for a retry after an error (next at {iso_z(first) if first else '—'})"
        )

    async def _end_pass(self, how: str) -> None:
        """열린 채우기를 닫고 INFO 한 줄(운영자가 DB 없이 수렴을 본다 — 틱마다가 아니라 채우기 한 번에 한 줄). 열린 채우기가 없으면 아무것도 하지 않는다.
        시각은 로그가 늘 쓰는 UTC 'Z' 그대로다(화면은 heartbeat 의 *_at 을 KST 로 보인다). 타일 절은 타일 공급자가 있을 때만."""
        ps = self._pass
        if ps is None:
            return
        at = self._now()
        self._pass, self._last_pass = None, (at, ps)
        self._pass_warned.clear()
        used, limit = await self.ctx.budget.usage(self.wfs.name)
        retrying, _ = self.geometry.retries()
        nq = self.geometry.not_queued
        tiles = (
            ""
            if self.tile_src is None
            else (
                f"{ps.tiles} tiles: {ps.tile_cells} cells listed ({ps.tile_new} new, {ps.tile_stored} queued for marine_grid4), "
                f"{ps.tile_splits} split and {ps.tile_incomplete} left incomplete as possibly truncated, "
                f"{ps.tile_errors} errors; tiles queued {self.tiles.queued}, done {self.tiles.done_count()}; "
            )
        )
        log.info(
            "traffic grid: geometry fill pass %s → %s — %d lookups: %d found, %d not in the MOF grid, %d off grid, %d errors "
            "(%d set aside as failed); %s%d cells known, %d ids waiting (%d after an error)%s; mof_grid4 today %s of %d (UTC day); %s",
            iso_z(ps.started),
            iso_z(at),
            ps.lookups,
            ps.found,
            ps.not_found,
            ps.off_grid,
            ps.errors,
            ps.set_aside,
            tiles,
            len(self.geometry.cells),
            self.geometry.pending,
            retrying,
            f", {nq} of the latest snapshot's cells not queued (queue limit {MAX_TRACKED})" if nq else "",
            "—" if used is None else used,
            limit,
            how,
        )

    async def _fill_state(self, now: datetime) -> tuple[str, str]:
        """(상태, 다음에 움직이는 때 ISO — 모르면 빈 값). heartbeat traffic_grid_fill_state · traffic_grid_fill_resume_at."""
        if not self.wfs.configured:
            return "", ""
        if await self.ctx.status.is_disabled(self.wfs.name):
            return "operator_off", ""
        if self._fill_hold_until is not None and now < self._fill_hold_until:
            return self._fill_hold_kind, iso_z(self._fill_hold_until)
        if self._fill_pause_until is not None and now < self._fill_pause_until:
            return "breaker", iso_z(self._fill_pause_until)
        if not self.geometry.pending and not self.tiles.queued:
            return "idle", ""
        waiting = self._waiting_for_caches(now)
        if waiting:
            return ("waiting_db" if waiting == "db" else "waiting_tiles"), ""
        if not self._fill_due(now):
            _n, nxt = self.geometry.retries()
            _tn, tnxt = self.tiles.retries()
            first = min((t for t in (nxt, tnxt) if t is not None), default=None)
            return "retry_wait", iso_z(first) if first else ""
        return "filling", ""

    async def _record_fill(self, w: WfsSource, started: datetime, tk: _Tick) -> None:
        """보낸 호출이 있던 채우기 한 번의 실행 기록 · 공급자 상태. records_in = 받은 칸(한 칸 조회로 찾은 칸 + 타일이 준 칸)."""
        succeeded = tk.succeeded
        self.ctx.db.record_run(
            self.geom_job_name,
            w.name,
            started,
            status="ok" if succeeded else "error",
            http_status=tk.http_status if not succeeded else 200,
            latency_ms=round(sum(tk.latency) / len(tk.latency)) if tk.latency else None,
            records_in=tk.received,
            records_quarantined=tk.off_grid + tk.tile_off_grid,
            error_text=f"{tk.calls - succeeded} of {tk.calls} calls failed; last: {tk.last_error}" if tk.last_error else None,
            quality=tk.quality,
        )
        if succeeded and tk.latency:
            u, lim = await self.ctx.budget.usage(w.name)
            await self.ctx.status.success(
                w.name, at=self._now(), latency_ms=tk.latency[-1], records=tk.received, used=u, limit=lim
            )
        if tk.last_error:
            await self.ctx.status.failure(w.name, at=self._now(), error=tk.last_error, http_status=tk.http_status)

    async def _store_tile(self, tile: Tile, state: TileState) -> None:
        try:
            async with asyncio.timeout(REDIS_TIMEOUT_S):
                await self.ctx.status.redis.hset(TILES_KEY, tile.key, encode_state(state))
            self._tile_write_error = ""
        except Exception as e:  # noqa: BLE001 — 메모리에는 남는다(다시 시작하면 그 타일을 다시 물을 뿐)
            if type(e).__name__ != self._tile_write_error:  # 타일마다 같은 실패를 쌓지 않는다 — 까닭이 바뀔 때만
                log.info(
                    "traffic grid: tile state write failed (%s) — finished tiles stay in memory and are asked again after a restart",
                    type(e).__name__,
                )
            self._tile_write_error = type(e).__name__

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
        neg = self.geometry.negative_counts(now)
        fill_state, resume_at = await self._fill_state(now)
        lp = self._last_pass
        tl = self.tile_src is None  # 타일 공급자 없음 — 타일 필드는 빈 값
        extra = {
            "traffic_grid_state": self.state,
            "traffic_grid_last_ok": iso_z(self.last_ok) if self.last_ok else "",
            "traffic_grid_reg_dt": iso_z(s.reg_dt) if s else "",
            "traffic_grid_resolved": "" if resolved is None else str(resolved),
            "traffic_grid_unresolved": "" if unresolved is None else str(unresolved),
            "traffic_grid_cells_known": str(len(self.geometry.cells)),
            "traffic_grid_pending": str(self.geometry.pending),
            "traffic_grid_failed": str(neg["failed"]),
            # 수렴을 DB 없이 보게(ADR-023 2026-10-01 개정): 유효한 부정 캐시(까닭별) · 마지막 스냅샷에서 대기열이 가득 차 넣지 못한 칸 ·
            # 채우기 상태와 다음에 움직이는 때 · 이 프로세스에서 마지막으로 끝난 채우기 한 번(끝난 때 · 조회 수 · 결과)
            "traffic_grid_not_found": str(neg["not_found"]),
            "traffic_grid_off_grid": str(neg["off_grid"]),
            "traffic_grid_not_queued": "" if self.geometry.not_queued is None else str(self.geometry.not_queued),
            "traffic_grid_fill_state": fill_state,
            "traffic_grid_fill_resume_at": resume_at,
            "traffic_grid_fill_pass_at": iso_z(lp[0]) if lp else "",
            "traffic_grid_fill_pass_lookups": str(lp[1].lookups) if lp else "",
            "traffic_grid_fill_pass_found": str(lp[1].found) if lp else "",
            "traffic_grid_fill_pass_not_found": str(lp[1].not_found) if lp else "",
            "traffic_grid_fill_pass_off_grid": str(lp[1].off_grid) if lp else "",
            "traffic_grid_fill_pass_errors": str(lp[1].errors) if lp else "",
            # bbox 타일(ADR-023 2026-10-01 bbox 개정 — 타일 공급자가 없으면 빈 값): 끝난 타일 · 대기 타일, 마지막 채우기의 타일 호출 · 받은 칸 ·
            # 새 칸 · 나눈 타일 · 오류
            "traffic_grid_tiles_done": "" if tl else str(self.tiles.done_count()),
            "traffic_grid_tiles_queued": "" if tl else str(self.tiles.queued),
            "traffic_grid_fill_pass_tiles": str(lp[1].tiles) if lp and not tl else "",
            "traffic_grid_fill_pass_tile_cells": str(lp[1].tile_cells) if lp and not tl else "",
            "traffic_grid_fill_pass_tile_new": str(lp[1].tile_new) if lp and not tl else "",
            "traffic_grid_fill_pass_tile_stored": str(lp[1].tile_stored) if lp and not tl else "",
            "traffic_grid_fill_pass_tile_splits": str(lp[1].tile_splits) if lp and not tl else "",
            "traffic_grid_fill_pass_tile_incomplete": str(lp[1].tile_incomplete) if lp and not tl else "",
            "traffic_grid_fill_pass_tile_errors": str(lp[1].tile_errors) if lp and not tl else "",
            "traffic_grid_calls_komsa": "" if used_k is None else str(used_k),
            "traffic_grid_calls_wfs": "" if used_w is None else str(used_w),
            # 처음 추정(선택값)은 싣지 않는다 — 배운 값만
            DELAY_FIELD: str(round(self.schedule.delay_s)) if self.schedule.delay_learned else "",
        }
        await self.ctx.status.heartbeat(self.job_name, lag_s=lag, fixture=self.ctx.fixture, extra=extra)
