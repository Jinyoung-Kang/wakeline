"""기상청 레이더 합성 수집(jobs/kma_radar.py)의 순수 규칙 — 입출력 없음(Redis · HTTP · 설정 · 시계를 읽지 않는다: 시각 · 주기는 인자로 받는다).

후보 고르기(보관 창 · 옛 tm), '파일 없음' 연속(MissingStreak — 확인할 tm · 확인 간격 · 이어받기 상한 · 하루 호출 상한), 목록이 보인 것(ListCheck ·
ListIdle), 부분 합성 판정과 다시 받기 고르기(annotate_partial · select_refetch · refetch_headroom), 실행 상태(outcome)를 여기서 정한다.
규칙의 뜻과 까닭(운영 사례 · 선택값)은 작업 모듈 설명에 있다 — 값은 그대로 옮겼다. tm 은 기상청 KST 벽시계(YYYYMMDDHHMM), 시각은 UTC.
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta

from wakeline_collector.budget_rules import regular_headroom
from wakeline_collector.http_errors import ProviderHttpError
from wakeline_collector.ratelimit import Throttled

KEEP_FRAMES = 12
MAX_PER_CYCLE = 4
FRAME_TTL_S = 3 * 3600
MAX_BAD = 64  # 해석 불가로 건너뛴 tm 기억 상한
MAX_NOT_READY_TRIES = 3  # 목록에 있으나 아직 받을 수 없는 tm 을 다시 시도하는 횟수(주기마다 1번 ≈ 15분)
PREV_DAY_LIST_MIN = 15  # KST 00:00 부터 이 분 동안은 전날 목록도 조회
REF_WINDOW_S = 60 * 60  # 기준 지점 수(stations_ref)를 세는 창 — 가장 새 저장 tm 에서 거꾸로(선택값, ADR-021)
REF_MIN_SUPPORT = 2  # '기준 도달'(partial=False) 판정에 필요한, 창 안에서 기준 지점 수에 닿은 프레임 수(선택값 — 자기 자신만으로는 판정하지 않는다)
REFETCH_MAX_AGE_S = 30 * 60  # 부분 합성 프레임을 다시 받는 tm 나이 상한(선택값, ADR-021)
REFETCH_SPACING_S = 4 * 60  # 같은 프레임의 마지막 시도(처음 받기 포함) 뒤 이만큼은 기다린다(선택값)
REFETCH_MAX_PER_CYCLE = 2  # 주기마다 다시 받는 프레임 수 상한(선택값)
REGULAR_CALLS_PER_CYCLE = 3  # 다시 받기가 남겨 둘 정규 주기 몫: 목록 1 + 새 프레임 바이너리 1 + 일시 오류 다시 부르기 1(선택값)
# '파일 없음' 연속 동안 WARN 을 다시 남기는 간격(선택값 — 잰 값이 아니다. 로그 화면을 5분마다 채우지 않게)
MISSING_REMIND_S = 60 * 60
# 연속 동안 가장 새 tm 과 함께 다시 확인하는 tm 의 나이 하한(선택값 — R-03 이 기본 주기 300 s 로 한 tm 을 마지막(MAX_NOT_READY_TRIES 번째)으로
# 시도하는 나이와 같게 골랐다. 잰 값이 아니다). 목록이 먼저 싣고 파일은 늦게 생기는 tm 도 회복을 알린다
MISSING_RECHECK_S = 10 * 60
# 다시 띄운 수집기가 Redis 의 연속을 이어받는 상한 — 마지막 확인이 이만큼 안일 때만(선택값, 주기 5분의 3배)
MISSING_CARRY_S = 15 * 60
# 긴 연속의 확인 간격(모듈 설명 '긴 연속의 확인 간격'): 연속의 나이(첫 tm 부터 지금까지)가 이 이상이면(선택값 — 짧은 공백은 5분마다 보아 빨리 잡고,
# 긴 공백은 예산을 아낀다. 잰 값이 아니다)
MISSING_SLOW_AFTER_S = 60 * 60
# 그때의 확인 간격(선택값 — 기본 주기 5분의 3배. 주기가 이보다 길면 주기). 그 사이 주기는 기상청을 부르지 않는다(실행 'waiting')
MISSING_SLOW_EVERY_S = 15 * 60
# 마지막 확인이 확인 간격 × 이 수보다 오래되면 연속을 '확인 멈춤'으로 본다(웹) · 다시 띄운 수집기가 이어받지 않는다(선택값 — 전의 15분 = 5분 × 3)
MISSING_STALE_PROBES = 3
# 연속 동안 확인하는 주기의 정규 호출: 목록 1 + 확인 ≤ 2(streak_probes)
STREAK_CALLS_PER_PROBE = 3
# 연속 밖의 목록 멈춤(ListIdle — 리뷰 2026-10-01 · 레인 kma 8차): 저장한 최신 tm 을 처음 저장한 뒤(meta fetched_at — STALE 시계) 이만큼 넘게 목록이 그보다 새 tm 을
# 싣지 않으면 'ok' 가 아니다(선택값 — 웹 · api 의 KMA STALE 기준 REL-19 meta.stale 900 s 와 같은 값: 웹이 STALE 을 적는 때부터 실행도 'missing')
LIST_IDLE_AFTER_S = 15 * 60
# 연속이 센 tm 을 기억하는 범위(마지막 tm 에서 거꾸로 3 h — 확인하는 tm 은 늘 그 안이다, 선택값)
MISSING_SEEN_KEEP_S = FRAME_TTL_S
MISSING_KEYS = (
    "missing_since_tm",
    "missing_last_tm",
    "missing_tms",
    "missing_checked_at",
    "missing_file",
    "missing_listed",
    "missing_probe_every_s",  # 지금 확인 간격(초 — 선택값에서 정해진 값, 계약 v5 §G26)
    # 마지막 확인에서 읽은 목록(계약 v5 §G26 개정 2026-10-01): 가장 새 tm(그 시각 이하 — 없으면 빈 값) · 확인 전 마지막 tm 뒤로 실은 tm 수(0 = 목록도 자라지
    # 않았다 — 목록이 마지막 tm 의 날을 덮지 못했으면 빈 값)
    "missing_list_tm",
    "missing_list_newer",
)
# 알린 공백(닫은 연속 [첫 tm, 파일이 다시 온 tm)) — meta 해시에만(수집기 내부 값: api 는 싣지 않는다). 다시 띄운 수집기가 그 안의 빈 tm 을 포기할 때
# 다시 WARN 하지 않게(리뷰 2026-09-30). 끝 tm 이 MISSING_GAP_KEEP_S 보다 오래되면 버린다 — 그보다 옛 tm 은 보관 창(최근 12 tm)에 들지 않는다
GAP_KEYS = ("missing_gap_from", "missing_gap_to")
MISSING_GAP_KEEP_S = FRAME_TTL_S  # 영상 TTL 3 h — 보관 창(약 1 h)보다 넉넉한 상한(선택값)
MISSING_FILE_RE = re.compile(r"RDR_CMP_[A-Z]+_[A-Z]+_\d{12}\.bin\.gz")  # '파일 없음' 답에 기상청이 적은 파일 이름


def iso(dt: datetime) -> str:
    return dt.astimezone(UTC).isoformat().replace("+00:00", "Z")


def streak_probes(
    listing: list[str], stored: list[str], now_tm: str, since_tm: str, skip: set[str] | frozenset[str] = frozenset()
) -> list[str]:
    """'파일 없음' 연속 동안 주기마다 확인할 tm(오름차순, 최대 2개): 현재 시각 이하 목록에서 저장되지 않은 tm(skip — 해석 불가 — 제외) 중
    ① 가장 새 tm ② 연속의 첫 tm(since_tm) 이후이면서 now_tm 보다 MISSING_RECHECK_S 이상 앞선 가장 새 tm. ②는 목록이 먼저 싣고 파일은 몇 분 뒤에
    생기는 tm(R-03)을 위한 것이다 — 회복 직후에도 가장 새 tm 은 아직 받을 수 없어서 ①만 보면 연속이 닫히지 않았다(리뷰 2026-09-30).
    ②를 첫 tm 이후로 두는 까닭: 그보다 옛 tm 의 gzip 은 연속을 닫지 않고(_file_back), 보관 창 밖이면 받자마자 밀려난다. 없으면 []."""
    have = set(stored)
    open_tms = [tm for tm in listing if tm <= now_tm and tm not in have and tm not in skip]
    if not open_tms:
        return []
    now = tm_dt(now_tm)
    cut = (now - timedelta(seconds=MISSING_RECHECK_S)).strftime("%Y%m%d%H%M") if now is not None else ""
    older = max((tm for tm in open_tms if since_tm <= tm <= cut), default=None)
    return sorted({max(open_tms)} | ({older} if older is not None else set()))


def slow_probe_every_s(poll_s: int) -> int:
    """늦춘 확인 간격(초) = MISSING_SLOW_EVERY_S 이상인 주기의 가장 작은 배수. 스케줄러는 실행 뒤 주기 + 지터(≥ 0)를 쉬므로 확인은 마지막 확인에서 15분이
    지난 뒤 첫 주기에 된다 — 주기가 15분을 나누지 못하면 15분보다 길다(600 s → 1,200 s · 400 s → 1,200 s). 웹의 'N분마다 확인' · 예산 계산이 실제 간격과
    같게 이 값을 쓴다(리뷰 2026-09-30 밤 — 전에는 max(900, 주기)라 600 s 주기에서 '15분마다'라 적고 실제로는 20분마다였다). 기본 300 s 는 900 그대로."""
    poll = max(1, poll_s)
    return math.ceil(MISSING_SLOW_EVERY_S / poll) * poll


def streak_probe_every_s(since_tm: str, now_kst: datetime, poll_s: int) -> int:
    """'파일 없음' 연속의 확인 간격(초): 연속의 나이(첫 tm 부터 now_kst 까지, KST 벽시계)가 MISSING_SLOW_AFTER_S 이상이면 slow_probe_every_s(주기의 배수 —
    주기가 15분보다 길면 주기), 아니면 주기(poll_s). 첫 tm 을 읽지 못하면 주기(늦추지 않는다)."""
    since = tm_dt(since_tm)
    if since is None or (now_kst.replace(tzinfo=None) - since).total_seconds() < MISSING_SLOW_AFTER_S:
        return poll_s
    return slow_probe_every_s(poll_s)


def missing_carry_s(every_s: int) -> float:
    """연속을 이어받는 상한 · '확인 멈춤' 기준(초): 확인 간격 × MISSING_STALE_PROBES, 아래로는 MISSING_CARRY_S(전의 고정 15분 — 5분마다 확인할 때와 같다)."""
    return float(max(MISSING_CARRY_S, MISSING_STALE_PROBES * every_s))


def streak_calls_per_day(poll_s: int, *, slow: bool, retries: bool = False) -> int:
    """연속만 이어지는 UTC 하루의 정규 호출 상한(설정값 계산 — 잰 값이 아니다): 확인하는 주기 수(하루 ÷ 확인 간격) × STREAK_CALLS_PER_PROBE
    + KST 자정 직후 창(PREV_DAY_LIST_MIN 분 — UTC 하루에 한 번, 15:00Z) 안의 확인 주기(⌈창 ÷ 확인 간격⌉)마다 1: 그 주기는 전날 목록을 더 읽고 확인도 둘일
    수 있다(목록 2 + 확인 2 = 4 — 지금 − 10분이 아직 전날 tm 을 다 넘지 않았다). 창 밖에서 확인에 필요한 전날 목록을 읽는 주기는 확인이 하나라 3 그대로다
    (_streak_needs_prev_day). slow = 늦춘 확인 간격(slow_probe_every_s — 주기의 배수), 아니면 주기마다. retries = 일시 오류 다시 부르기(호출마다 한 번 —
    확인에 필요한 전날 목록 포함, 레인 kma 7차)까지 — 최악 두 배. 기본 300 s: 5분마다 288 × 3 + 3 = 867(최악 1,734), 늦춘 뒤 96 × 3 + 1 = 289(최악 578 < 1,000).
    (전에는 창의 +1 · +3 을 빠뜨려 864 · 288(최악 576)이라 적었다 — 리뷰 2026-10-01.)"""
    every = slow_probe_every_s(poll_s) if slow else poll_s
    midnight = math.ceil(PREV_DAY_LIST_MIN * 60 / every)
    return ((86_400 // every) * STREAK_CALLS_PER_PROBE + midnight) * (2 if retries else 1)


def tm_span(a: str, b: str) -> str:
    """두 tm(KST 벽시계) 사이 길이 "1 h 25 min". 틀리면 "—"."""
    ta, tb = tm_dt(a), tm_dt(b)
    if ta is None or tb is None:
        return "—"
    m = max(0, int((tb - ta).total_seconds() // 60))
    return f"{m // 60} h {m % 60} min" if m >= 60 else f"{m} min"


@dataclass(frozen=True)
class Exhausted:
    """이 주기에 MAX_NOT_READY_TRIES 번째도 '파일 없음'이던 tm — 주기 끝에 한 tm 만 빠졌는지 연속인지 가린다."""

    tm: str
    tries: int
    answer: str  # 기상청 답 앞부분(원문)
    listed: str  # 목록이 그 tm 에 싣는 종류("EXT,KMA", 모르면 빈 값)


@dataclass
class MissingStreak:
    """목록에는 있는데 기상청 내려받기가 '파일 없음'(gzip 아닌 답)으로 답하는 연속. tm 은 기상청 KST 벽시계, 시각은 UTC.
    값은 모두 기상청 답 · 목록에서 읽은 것이다 — 파일 이름을 답에서 읽지 못하거나 목록 종류를 모르면 빈 값(짓지 않는다)."""

    since_tm: str  # 없다는 답을 받은 가장 이른 tm(이 프로세스가 받은 답 — 이어받은 연속이면 앞 프로세스의 값)
    last_tm: str  # 없다는 답을 받은 가장 새 tm
    tms: int  # 없다는 답을 받은 서로 다른 tm 수(확인한 tm 마다 한 번 — 같은 tm 을 다시 확인하면 세지 않는다)
    checked_at: datetime  # 마지막 확인(UTC)
    warned_at: datetime  # 마지막 WARN(UTC) — MISSING_REMIND_S
    file: str = ""  # 마지막 답이 없다고 적은 파일 이름(RDR_CMP_HSR_PUB_<tm>.bin.gz)
    listed: str = ""  # 목록이 그 tm 에 싣는 종류("EXT" · "EXT,KMA")
    answer: str = ""  # 마지막 답 앞부분(원문 — 로그에만)
    # 이 프로세스가 센 tm(last_tm 에서 MISSING_SEEN_KEEP_S 안만 — 확인은 늘 가장 새 tm 근처다)
    seen: set[str] = field(default_factory=set)
    # 이어받은 연속의 [첫 tm, 마지막 tm] — 앞 프로세스가 그 안의 무엇을 셌는지 모르므로 다시 세지 않는다(적게 셀 수는 있어도 두 번 세지 않는다)
    carried: tuple[str, str] | None = None
    # 지금 확인 간격(초 — streak_probe_every_s, 0 = 아직 모름 → 빈 값)
    every_s: int = 0
    # 마지막 확인에서 읽은 목록(ListCheck — 여는 주기는 모른다: 첫 확인이 채운다). list_tm = 그 목록의 가장 새 tm(그 시각 이하, 없으면 빈 값),
    # list_newer = 확인 전 last_tm 뒤로 실은 tm 수(0 = 목록도 자라지 않았다 — 확인할 새 tm 이 없었다). 목록이 last_tm 의 날을 덮지 못했으면 None(모름)
    list_tm: str = ""
    list_newer: int | None = None

    def count(self, tm: str) -> None:
        """없다는 답을 받은 tm 을 센다(처음 확인한 tm 만) · 범위를 넓힌다."""
        self.since_tm, self.last_tm = min(self.since_tm, tm), max(self.last_tm, tm)
        c = self.carried
        if tm in self.seen or (c is not None and c[0] <= tm <= c[1]):
            return
        self.seen.add(tm)
        self.tms += 1
        last = tm_dt(self.last_tm)
        if last is not None:  # 기억 상한 — 확인하는 tm 은 가장 새 tm 과 MISSING_RECHECK_S 남짓 앞선 tm 뿐이다
            keep = (last - timedelta(seconds=MISSING_SEEN_KEEP_S)).strftime("%Y%m%d%H%M")
            self.seen = {t for t in self.seen if t >= keep}

    def fields(self) -> dict[str, str]:
        return {
            "missing_since_tm": self.since_tm,
            "missing_last_tm": self.last_tm,
            "missing_tms": str(self.tms),
            "missing_checked_at": iso(self.checked_at),
            "missing_file": self.file,
            "missing_listed": self.listed,
            "missing_probe_every_s": str(self.every_s) if self.every_s > 0 else "",
            "missing_list_tm": self.list_tm,
            "missing_list_newer": "" if self.list_newer is None else str(self.list_newer),
        }

    def list_idle(self) -> str:
        """마지막 확인의 목록이 last_tm 뒤로 새 tm 을 싣지 않았으면 그 한 줄(로그 · 실행 오류 글자), 아니면 빈 글자."""
        if self.list_newer != 0:
            return ""
        return f"the KMA listing has no tm after tm={self.last_tm} either (newest listed tm={self.list_tm or 'none'})"


@dataclass(frozen=True)
class ListCheck:
    """연속 중 확인하는 주기가 읽은 목록(목록이 답했을 때만 — 실패한 목록은 확인이 아니다). tm 은 KST 벽시계."""

    days: tuple[str, ...]  # 읽은 목록의 날(YYYYMMDD, 오름차순 — 오늘, 자정 직후 창이나 새 날 목록이 빈 연속이면 전날도)
    newest: str  # 그 목록의 가장 새 tm(그 시각 이하 — 없으면 빈 값)
    # 확인 전 last_tm 뒤로 실은 tm 수. 목록이 last_tm 의 날을 덮지 못했으면 None(모름 — '새 tm 없음'이라 하지 않는다: last_tm 이 그저께 이전인 연속 —
    # 수집기는 전날 · 오늘 목록만 읽는다. 확인에 필요한 전날 목록을 읽지 못한 주기는 확인이 아니다 — _listing 이 'error' · 예산 상태로 끝낸다)
    newer: int | None

    @staticmethod
    def of(listing: list[str], days: tuple[str, ...], now_tm: str, last_tm: str) -> ListCheck:
        listed = [tm for tm in listing if tm <= now_tm]
        covered = bool(days) and min(days) <= last_tm[:8]
        newer = sum(1 for tm in listed if tm > last_tm) if covered else None
        return ListCheck(days, max(listed, default=""), newer)

    def text(self, last_tm: str) -> str:
        """확인할 tm 이 없던 확인의 한 줄(실행 오류 글자 — 목록이 보인 것만)."""
        days = "+".join(self.days)
        shown = f"newest listed tm={self.newest}" if self.newest else f"the listing {days} lists no tm"
        if self.newer is not None:
            return f"the KMA listing has no tm after tm={last_tm} either ({shown})"
        has = f"has newest tm={self.newest}" if self.newest else "lists no tm"
        return f"the KMA listing {days} {has} (tm={last_tm} is on {last_tm[:8]} — that listing was not read)"


@dataclass(frozen=True)
class ListIdle:
    """연속 밖의 목록 멈춤(리뷰 2026-10-01 · 레인 kma 8차 — 계약 v5 §G26): 읽은 목록이 tm 뒤로 새 tm 을 싣지 않고, 저장한 최신 tm 을 처음 저장한 뒤(meta
    fetched_at — STALE 시계) LIST_IDLE_AFTER_S 넘게 지났다. 값은 모두 읽은 목록 · meta 해시에서 온다(짓지 않는다)."""

    tm: str  # 이 작업이 저장했거나 파일을 받아 본 가장 새 tm — 목록이 그 뒤로 새 tm 을 싣지 않는다
    newest: str  # 읽은 목록의 가장 새 tm(그 시각 이하 — 없으면 빈 값)
    days: tuple[str, ...]  # 읽은 목록의 날
    latest: str  # meta latest_tm(저장한 가장 새 tm)
    age_s: float  # meta fetched_at(latest 를 처음 저장한 시각) 뒤 지난 초

    def text(self) -> str:
        """실행 오류 글자 · WARN 한 줄(목록 · meta 가 보인 것만)."""
        shown = f"newest listed tm={self.newest}" if self.newest else "no tm listed"
        s = (
            f"the KMA listing {'+'.join(self.days)} has no tm after tm={self.tm} ({shown}); "
            f"newest frame tm={self.latest} first stored {self.age_s / 60:.0f} min ago"
        )
        if self.tm > self.latest:
            s += f"; tm={self.tm} has a file but is older than the {FRAME_TTL_S // 3600} h image retention — not stored"
        return s

    def note(self) -> str:
        """meta note(웹 패널 · 상세 표가 '사용 불가 — <note>' 로 싣는다). tm 만 싣는다 — 주기마다 바뀌는 값(분)은 넣지 않는다."""
        return f"기상청 목록에 tm {self.tm}(KST) 뒤 새 tm 없음"


def gap_expired(to_tm: str, now_kst: datetime) -> bool:
    """알린 공백의 끝 tm(KST 벽시계)이 now_kst(KST 벽시계) 기준 MISSING_GAP_KEEP_S 보다 오래됐는가(형식이 틀려도 참 — 버린다)."""
    t = tm_dt(to_tm)
    return t is None or (now_kst.replace(tzinfo=None) - t).total_seconds() > MISSING_GAP_KEEP_S


def listed_text(listed: str) -> str:
    return listed.replace(",", "/") if listed else "kinds unknown"


def old_tm_cut(now_tm: str) -> str:
    """영상 보관 한계의 tm: 지금(KST 벽시계)에서 FRAME_TTL_S(3 h) 전. 이 tm 이하는 '옛 tm' — 영상 TTL 이 지나 만료됐을 나이다(저장한 때 ≥ tm).
    지금을 읽지 못하면 빈 글자(아무 tm 도 옛 tm 이 아니다)."""
    now = tm_dt(now_tm)
    return (now - timedelta(seconds=FRAME_TTL_S)).strftime("%Y%m%d%H%M") if now is not None else ""


def select_candidates(
    listing: list[str], stored: list[str], now_tm: str, bad: set[str] | frozenset[str] = frozenset(), known: str = ""
) -> list[str]:
    """보관 창(현재 시각 이하 목록의 최신 KEEP_FRAMES 개) 안에서 아직 저장되지 않은 tm 중 최신 MAX_PER_CYCLE 개(오름차순).
    창보다 오래된 tm 은 받아도 곧바로 밀려나므로 고르지 않는다. 옛 tm(old_tm_cut 이하) 중 known(파일이 있던 가장 새 tm — meta latest_tm · 이 프로세스가
    받아 본 옛 tm) 이하도 고르지 않는다: 목록이 멈췄는데 파일은 있으면 만료된 옛 프레임을 3 h 마다 다시 받아 새것처럼 보였다(도전 2026-10-01). known 보다
    새 옛 tm 은 고른다 — 받아 본 적이 없는 tm 이라 '파일 없음'이면 R-03 이 연속을 연다(다시 띄운 수집기가 버린 연속을 다시 여는 길, _behind_prev_day)."""
    window = sorted({tm for tm in listing if tm <= now_tm})[-KEEP_FRAMES:]
    have = set(stored)
    cut = old_tm_cut(now_tm)
    return [tm for tm in window if tm not in have and tm not in bad and not (tm <= cut and tm <= known)][-MAX_PER_CYCLE:]


def tm_dt(tm: object) -> datetime | None:
    """tm(YYYYMMDDHHMM, KST 벽시계) → 시간대 없는 datetime. 틀리면 None."""
    if not isinstance(tm, str):
        return None
    try:
        return datetime.strptime(tm, "%Y%m%d%H%M")
    except ValueError:
        return None


def site_count(f: dict) -> int | None:
    """항목의 지점 수. 없거나 형식이 틀리면 None(모름 — 0 으로 보지 않는다)."""
    v = f.get("stations")
    return v if isinstance(v, int) and not isinstance(v, bool) and v >= 0 else None


def annotate_partial(frames: list[dict]) -> list[dict]:
    """stations_ref · partial 을 다시 계산한다(저장할 때마다 — 늦게 온 더 많은 지점의 프레임 · 다시 받아 늘어난 프레임이 반영된다).
    기준 = 가장 새 tm 에서 REF_WINDOW_S 안(경계 포함)의 항목 중 가장 많은 지점 수(자기 자신 포함) — 창 안 항목 모두에 같은 값.
    partial=True(stations < 기준)는 더 많은 지점의 다른 프레임이 근거다. partial=False('기준 도달' — 완전하다는 뜻이 아니다)는 기준에 닿은
    프레임이 REF_MIN_SUPPORT 개 이상일 때만 둔다 — 기준이 이 프레임 하나뿐이면(첫 기동 · 공백 뒤 · 가장 많은 프레임이 하나) 비교할 근거가
    없으므로 partial 을 두지 않는다(판정 없음). 기준 값은 둔다(창 안 최대 — 자료 그대로).
    창보다 오래된 항목(보관 창에 공백이 있을 때만 생긴다)은 창 안에 있을 때 받은 값을 그대로 둔다.
    지점 수를 모르는 항목은 세지 않고 stations_ref · partial 을 두지 않는다(모르는 값에서 판정을 만들지 않는다)."""
    times = [(f, tm_dt(f.get("tm"))) for f in frames]
    newest = max((t for _f, t in times if t is not None), default=None)
    if newest is None:
        return frames
    lo = newest - timedelta(seconds=REF_WINDOW_S)
    window = [f for f, t in times if t is not None and t >= lo]
    counts = [n for f in window if (n := site_count(f)) is not None]
    ref = max(counts, default=None)
    support = counts.count(ref) if ref is not None else 0  # 기준에 닿은 프레임 수
    for f in window:
        n = site_count(f)
        if n is None or ref is None:
            f.pop("stations_ref", None)
            f.pop("partial", None)
            continue
        f["stations_ref"] = ref
        if n < ref:
            f["partial"] = True
        elif support >= REF_MIN_SUPPORT:
            f["partial"] = False
        else:
            f.pop("partial", None)  # 기준이 자기 자신뿐 — 판정 없음
    for f, t in times:
        if t is None or site_count(f) is None:  # 창 밖이어도 모르는 값의 판정은 남기지 않는다
            f.pop("stations_ref", None)
            f.pop("partial", None)
    return frames


def parse_iso(v: object) -> datetime | None:
    if not isinstance(v, str) or not v:
        return None
    try:
        t = datetime.fromisoformat(v.replace("Z", "+00:00"))
    except ValueError:
        return None
    return t if t.tzinfo is not None else None


_NEVER = datetime.min.replace(tzinfo=UTC)


def select_refetch(frames: list[dict], now_kst: datetime, now_utc: datetime) -> list[str]:
    """다시 받을 부분 합성 프레임(최대 REFETCH_MAX_PER_CYCLE 개): partial 이 참이고, tm 이 REFETCH_MAX_AGE_S 안이고(now_kst — KST 벽시계),
    마지막 시도(fetched_at · refetched_at 중 늦은 것)가 REFETCH_SPACING_S 이상 지난 것. 시도 시각을 모르면 막지 않는다.
    순서: 다시 받은 횟수(refetches)가 적은 것 → 마지막 시도가 오래된 것 → 오래된 tm. 오래된 tm 부터만 고르면 계속 부분 합성인 프레임
    (레이더 장애 등) 둘이 주기마다 두 자리를 차지해 새 부분 합성 프레임이 기한 끝 무렵에야 처음 다시 받혔다(리뷰 모의)."""
    now_kst = now_kst.replace(tzinfo=None)
    eligible: list[tuple[int, datetime, str]] = []
    for f in frames:
        t = tm_dt(f.get("tm"))
        if f.get("partial") is not True or t is None:
            continue
        if (now_kst - t).total_seconds() > REFETCH_MAX_AGE_S:
            continue
        last = max((d for d in (parse_iso(f.get("fetched_at")), parse_iso(f.get("refetched_at"))) if d), default=None)
        if last is not None and (now_utc - last).total_seconds() < REFETCH_SPACING_S:
            continue
        tries = f.get("refetches")
        tries = tries if isinstance(tries, int) and not isinstance(tries, bool) and tries >= 0 else 0
        eligible.append((tries, last or _NEVER, f["tm"]))
    return [tm for _n, _last, tm in sorted(eligible)[:REFETCH_MAX_PER_CYCLE]]


def refetch_headroom(now: datetime, poll_s: float) -> int:
    """다시 받기 예약이 남겨 둘 몫: 예산 날(UTC)이 끝날 때까지의 정규 주기(poll_s 초) × REGULAR_CALLS_PER_CYCLE(기상 작업과 같은 규칙)."""
    return regular_headroom(((poll_s, REGULAR_CALLS_PER_CYCLE),), now)


def refetch_until(tm: str) -> str | None:
    """이 tm 을 다시 받을 수 있는 마지막 순간(UTC ISO): tm(KST) + REFETCH_MAX_AGE_S. 웹이 '기한까지 다시 받기 대상'과 '기한 지남'을 가른다."""
    t = tm_dt(tm)
    return None if t is None else iso((t - timedelta(hours=9)).replace(tzinfo=UTC) + timedelta(seconds=REFETCH_MAX_AGE_S))


def latest_station_fields(frames: list[dict]) -> dict[str, str]:
    """meta 해시의 지점 필드 — latest_tm(목록의 마지막) 프레임을 설명한다. 모르면 빈 값(0 으로 채우지 않는다)."""
    f = frames[-1] if frames else {}
    n = site_count(f)
    ids = f.get("station_ids")
    ref = f.get("stations_ref")
    partial = f.get("partial")
    return {
        "stations": "" if n is None else str(n),
        "station_ids": ",".join(ids) if n is not None and isinstance(ids, list) else "",
        "stations_ref": str(ref) if isinstance(ref, int) and not isinstance(ref, bool) else "",
        "partial": ("1" if partial else "0") if isinstance(partial, bool) else "",
    }


def outcome(stored_n: int, missing_n: int, quality: list[tuple[str, str | None, dict]], note: str) -> tuple[str, str | None]:
    """실행 기록의 (상태, 오류 글자): 프레임을 저장했거나 새로 받을 tm 이 없으면 'ok'. 새 tm 이 있었는데 하나도 저장하지 못했으면 —
    '파일 없음' 답이 있었으면 'missing'(note = 마지막 답의 한 줄), 해석 불가만이면 'quarantined'."""
    if stored_n or (not missing_n and not quality):
        return "ok", None
    if missing_n:
        return "missing", f"no new frame stored — {note}"
    bad = "; ".join(f"tm={d.get('tm')} {rule}: {d.get('error', '')}" for rule, _hex, d in quality)
    return "quarantined", f"no new frame stored — could not read {bad}"


def is_throttle(e: BaseException) -> bool:
    """429(공급자가 거절) 또는 속도 상한(Throttled — 보내지 않았다)."""
    return isinstance(e, Throttled) or (isinstance(e, ProviderHttpError) and e.status == 429)
