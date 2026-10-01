"""공급자 폴백 체인(FR-16 · R-17)의 상태기계 — 순수 규칙(Redis · HTTP 입출력 없음: 시계 · 운영자가 끈 공급자는 인자로 받는다. 전환은 INFO 로그로 남긴다). 규칙과 까닭은 fallback 모듈 설명에 있다.
fallback.ProviderChain 이 이 상태기계 위에 Redis 상태 쓰기(wakeline:active · 전환 기록) · 429 이력 저장(chain_store) · 되살리기를 얹는다.
"""

from __future__ import annotations

import logging
import math
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime
from typing import Any

log = logging.getLogger("fallback")  # 되살린 429 이력의 INFO — fallback 과 같은 로거

VERSION = "1"  # 저장한 429 이력의 형식(chain_store 해시의 v)
RATE_LIMIT_RESET_S = 900.0  # 마지막 429 로부터 이만큼 조용하면 백오프 단계를 초기화
# 15분 안에 되풀이된 429 뒤 복귀를 늦추는 시간(R-17): 10 → 20 → 40 → 60 → 120 → 240 → 360분(상한 6 h, 선택값 — ADR-011)
RATE_LIMIT_HOLD_S = (600.0, 1200.0, 2400.0, 3600.0, 7200.0, 14400.0, 21600.0)
REASON_MAX = 120  # 전환 사유 글자 수 상한
BACKOFF_MAX_S = 300.0
# 단계 상한: 쉼(4단계에서 300 s)·미룸(8단계에서 360분)이 모두 가장 긴 값에 닿는 단계. 그 뒤로는 단계가 늘어도 동작이 같으므로 더 세지 않는다
# (이력이 재시작을 넘어 이어지므로 상한이 없으면 끝없이 커져 60 × 2**1024 에서 OverflowError 가 났다).
STAGE_MAX = len(RATE_LIMIT_HOLD_S) + 1
# 저장된 이력이 가리킬 수 있는 가장 먼 미래: 가장 긴 미룸(360분) + 여유 60 s. 더 먼 값은 벽시계가 뒤로 갔거나 망가진 기록이다.
SAVED_MAX_AHEAD_S = max(BACKOFF_MAX_S, *RATE_LIMIT_HOLD_S) + 60.0
RESTORED = "(재시작 전 기록)"

# 건너뛴 까닭의 종류 → 돌아올 때의 말. 종류: down(쉼: 429·실패·예산·속도 상한) · hold · disabled · paused · config
_RECOVERED = {"hold": "미룸 끝", "disabled": "운영자 켬", "paused": "일시정지 끝", "config": "설정됨"}


def dur(seconds: float) -> str:
    """600 → '10분', 60 → '60 s', 0.05 → '0.05 s'. 1분으로 떨어지는 2분 이상만 분으로 쓴다."""
    if seconds >= 120 and seconds % 60 == 0:
        return f"{seconds / 60:.0f}분"
    return f"{seconds:g} s" if seconds < 10 else f"{seconds:.0f} s"


def _hold_text(hold_s: float) -> str:
    return f"429 반복 → {dur(hold_s)} 뒤로 미룸"


def backoff_s(stage: int) -> float:
    """stage 번째 429 의 쉼(60 → 120 → 240 → 300 s). 지수는 STAGE_MAX 에서 자른다(큰 단계에서도 넘치지 않게)."""
    return min(BACKOFF_MAX_S, 60.0 * (2 ** (min(max(1, stage), STAGE_MAX) - 1)))


def _hold_for(stage: int) -> float:
    """stage 번째 429 뒤의 미룸(첫 429 는 없음, 그 뒤 10 → 20 → 40 → 60 → 120 → 240 → 360분)."""
    return RATE_LIMIT_HOLD_S[min(stage - 2, len(RATE_LIMIT_HOLD_S) - 1)] if stage >= 2 else 0.0


@dataclass(frozen=True)
class _Saved:
    """Redis 에 남긴 429 이력(벽시계 epoch 초)."""

    stage: int
    last_429: float
    backoff_until: float
    hold_until: float  # 0 = 미룸 없음
    hold_s: float
    quiet_from: float
    expires_at: float


def parse_saved(row: dict[str, str], now_wall: float) -> tuple[_Saved | None, str]:
    """(이력 | None, 버린 까닭 'format' · 'expired' · 'future' | '')."""
    if row.get("v") != VERSION:
        return None, "format"
    try:
        stage = int(row["stage"])
        vals = [float(row[k]) for k in ("last_429_at", "backoff_until", "quiet_from", "expires_at")]
        hold = float(row["hold_until"]) if row.get("hold_until") else 0.0
        hold_s = float(row.get("hold_s") or 0.0)
    except (KeyError, ValueError):
        return None, "format"
    if stage < 1 or not all(math.isfinite(v) for v in (*vals, hold, hold_s)) or not 0.0 <= hold_s <= max(RATE_LIMIT_HOLD_S):
        return None, "format"
    stage = min(stage, STAGE_MAX)  # 상한보다 큰 단계(망가진 기록 · 상한 전 코드가 남긴 기록)는 상한 단계와 동작이 같다
    last, backoff, quiet, expires = vals
    if expires <= now_wall:
        return None, "expired"
    if max(last, backoff, hold, quiet) > now_wall + SAVED_MAX_AHEAD_S:
        return None, "future"
    return _Saved(stage, last, backoff, hold, hold_s or _hold_for(stage), quiet, expires), ""


@dataclass(frozen=True)
class Choice:
    """choose 의 결과: 고를 공급자(없으면 None) · 건너뛴 [(이름, 종류, 까닭)](고른 것 제외) · 고른 방식(None 정상 · "held" 429 미룸 중이나
    다른 공급자 없음 · "probe" 3회 연속 실패로 쉬는 중이나 다른 공급자 없음 — 공급자 없음 상태) · probe 면 그 공급자를 포함한 건너뛴 목록(순위 순)."""

    name: str | None
    skipped: list[tuple[str, str, str]]
    mode: str | None = None
    full: tuple[tuple[str, str, str], ...] = ()


class ChainState:
    """공급자 폴백 체인의 상태기계(fallback 모듈 설명의 규칙 — 3회 연속 실패 쉼 · 429 백오프와 미룸 · 공급자 없음 · 전환 사유). 입출력이 없다:
    운영자가 끈 공급자는 고를 때 인자(disabled)로 받고, 시계는 mono(단조) · now_w(UTC 벽시계)로 받는다. 운영자 끔 읽기 · Redis 쓰기 · 429 이력
    저장 · 되살리기는 fallback.ProviderChain 이 맡는다."""

    def __init__(
        self,
        job: str,
        providers: dict[str, Any],
        fail_threshold: int,
        cooldown_s: float,
        *,
        mono: Callable[[], float],
    ):
        """mono = 단조 시계(초) — 부르는 쪽이 준다(ProviderChain 은 fallback.time.monotonic 을 부를 때마다 읽는다: 시험이 그 시계를 바꿔 끼운다)."""
        self.job = job
        self._mono = mono
        self._providers = providers
        self._threshold = fail_threshold
        self._cooldown = cooldown_s
        self._fails: dict[str, int] = {}
        self._down_until: dict[str, float] = {}
        self._rate_limited: dict[str, int] = {}  # 429 단계(최근 15분 내)
        self._last_429: dict[str, float] = {}
        self._hold_until: dict[str, float] = {}  # 되풀이된 429 → 이 시각까지 뒤로 미룸(다른 공급자가 없으면 씀)
        self._rl_until: dict[str, float] = {}  # 429 로 쉬거나 미뤄 둔 기간의 끝(조용함은 여기서부터 센다)
        self._down_why: dict[str, str] = {}  # 쉬는 까닭(전환 사유에 싣는다)
        self._hold_why: dict[str, str] = {}
        self._hold_len: dict[str, float] = {}
        self._last_skip: dict[str, str] = {}  # 마지막으로 건너뛴 까닭의 종류(돌아올 때의 말)
        self._backoff_until: dict[str, float] = {}  # 429 쉼의 끝(mark_down 의 다른 쉼과 따로 — 저장용)
        # 쉬는 까닭의 종류: "fail"(3회 연속 실패 — 다른 공급자가 없으면 다시 시도한다) · "429" · "other"(예산 · 속도 상한 쿨다운 등)
        self._down_kind: dict[str, str] = {}
        # 3회 연속 실패 쉼(FR-16)의 끝 · 까닭 — 그 위에 짧은 쉼(429 · 속도 상한 쿨다운 · 예산)이 얹혀도 따로 남는다(_rest)
        self._fail_until: dict[str, float] = {}
        self._fail_why: dict[str, str] = {}
        self._probed_at: dict[str, float] = {}  # 쉬는 중 다시 시도한 마지막 때(여럿이면 오래된 것부터)
        # 지난 선택의 순위(이 범위를 지원하는 공급자 순서)와 그때 건너뛴 공급자 — 순서가 바뀌어 고른 공급자를 '쉼 끝'으로 적지 않게(_reason)
        self._ranked: list[str] | None = None
        self._skipped_prev: frozenset[str] = frozenset()
        self._current: str | None = None
        self._none_since: float | None = None  # 공급자 없음이 시작된 때(단조 시계) — 없으면 None
        self._none_at: datetime | None = None  # 같은 때(UTC 벽시계 — set_none 에 싣는다)
        self._none_retry: str | None = None  # 공급자 없음 동안 다시 시도하는 쉬는 공급자(없으면 None)
        self.none_reason = ""  # 공급자 없음의 까닭(건너뛴 공급자와 까닭, 가린 글)
        self.none_next: tuple[str, float] | None = None  # (가장 먼저 풀리는 공급자, 그때까지 초) — 체인 상태로 정해진 값만
        # wakeline:active 에 지금 상태를 썼는가(False = 마지막 쓰기가 Redis 오류 — 다음 선택 때 다시 쓴다) · 다시 쓸 set_active 의 (그때, 까닭)
        self._state_saved = True
        self._active_at: datetime | None = None
        self._active_reason = ""

    def mark_down(self, name: str, seconds: float, *, why: str | None = None, kind: str = "other") -> None:
        """name 을 seconds 동안 쉬게 한다. why 는 전환 사유에 실리는 짧은 글(없으면 '쉼(N s)'). kind 는 쉼의 종류(record_failure 는 "fail").
        3회 연속 실패 쉼 중에 얹힌 다른 쉼은 그 쉼을 지우지 않는다 — 끝나면 남은 실패 쉼이 이어진다(_rest)."""
        until, text = self._mono() + seconds, why or f"쉼({dur(seconds)})"
        self._down_until[name] = until
        self._down_why[name] = text
        self._down_kind[name] = kind
        if kind == "fail":
            self._fail_until[name], self._fail_why[name] = until, text

    def _rest(self, name: str, now: float) -> tuple[float, str, str] | None:
        """지금 걸린 쉼 (끝, 종류, 까닭) — 없으면 None. 짧은 쉼(다시 시도가 받은 429 · 호출 제한기 쿨다운 · 예산)이 3회 연속 실패 쉼 안에
        얹히면 그 쉼이 먼저이고, 끝나면 실패 쉼이 남은 만큼 이어진다(종류 "fail" — 다른 공급자가 없으면 다시 시도한다)."""
        until = self._down_until.get(name, 0.0)
        if until > now:
            return until, self._down_kind.get(name, "other"), self._down_why.get(name, "쉼")
        fail = self._fail_until.get(name, 0.0)
        if fail > now:
            return fail, "fail", self._fail_why.get(name, "쉼")
        return None

    @staticmethod
    def paused(p: Any, now: datetime) -> bool:
        until = getattr(p, "paused_until", None)
        return isinstance(until, datetime) and until > now

    def _candidates(self, order: list[str], need_global: bool) -> list[str]:
        """이 작업 범위를 지원하는 공급자(순서대로) — 순위는 이 목록에서 센다."""
        out = []
        for name in order:
            p = self._providers.get(name)
            if p is not None and getattr(p, "supports_global" if need_global else "supports_region", False):
                out.append(name)
        return out

    def probing(self, name: str) -> bool:
        """name 이 3회 연속 실패로 쉬는 중인가(그 위에 얹힌 짧은 쉼은 없다) — 그래도 불렸다면 다른 공급자가 없어 다시 시도한 것이다."""
        rest = self._rest(name, self._mono())
        return rest is not None and rest[1] == "fail"

    @property
    def none_since(self) -> float | None:
        """공급자 없음이 시작된 때(단조 시계). 공급자가 있으면 None."""
        return self._none_since

    @property
    def none_retry(self) -> str | None:
        """공급자 없음 동안 다시 시도하는 쉬는 공급자 — 없으면 None."""
        return self._none_retry

    def none_elapsed_s(self) -> float | None:
        return None if self._none_since is None else self._mono() - self._none_since

    def hold_s(self, name: str) -> float:
        """name 에 걸린 429 미룸의 길이(초). 미룸이 없거나 끝났으면 0."""
        if self._hold_until.get(name, 0.0) <= self._mono():
            return 0.0
        return self._hold_len.get(name, 0.0)

    def _next_release(self, skipped: list[tuple[str, str, str]], now_m: float, now_w: datetime) -> tuple[str, float] | None:
        """건너뛴 공급자 중 가장 먼저 풀리는 것과 남은 초 — 쉼 끝 · 일시정지 끝(체인 상태 그대로). 운영자 끔 · 설정 안 됨은 때가 없다(None)."""
        best: tuple[str, float] | None = None
        for n, kind, _w in skipped:
            left: float | None = None
            if kind in ("down", "hold"):
                rest = self._rest(n, now_m)
                left = rest[0] - now_m if rest else None
            elif kind == "paused":
                until = getattr(self._providers[n], "paused_until", None)
                left = (until - now_w).total_seconds() if isinstance(until, datetime) else None
            if left is not None and left > 0 and (best is None or left < best[1]):
                best = (n, left)
        return best

    def _reason(self, c: Choice, ranked: list[str], by_order: bool = False) -> str:
        """by_order: 운영 설정(aircraft_providers)의 순서가 지난 선택 뒤 바뀌었고, 고른 공급자는 지난 선택 때 건너뛰지 않았다 — '쉼 끝 · 복귀'가 아니라
        'order — 공급자 순서 변경'으로 적는다(전에는 V17 배포 · /ops 변경 때 쉰 적 없는 adsb_fi 를 'recovery — adsb_fi 쉼 끝(1순위 복귀)'로 적었다)."""
        name, skipped = c.name, c.skipped
        assert name is not None
        prev = self._current
        why = {n: w for n, _k, w in skipped}
        tail = f"{name} 429 미룸 중이나 다른 공급자 없음" if c.mode == "held" else ""
        changed = f"공급자 순서 변경(aircraft_providers — {name} {ranked.index(name) + 1}순위)"
        if self._none_since is not None:  # 공급자 없음이 끝났다
            back = tail or (
                f"{name} {changed}" if by_order else f"{name} {_RECOVERED.get(self._last_skip.get(name, ''), '쉼 끝')}"
            )
            return f"recovery — 공급자 없음 {dur(round(self._mono() - self._none_since))} 끝 · {back}"
        if tail:
            head = "initial" if prev is None else "fallback"
            return f"{head} — {prev} {why[prev]} · {tail}" if prev in why else f"{head} — {tail}"
        if prev is None:
            first = skipped[0] if skipped else None
            return f"initial — {first[0]} {first[2]}" if first else "initial"
        if prev in why:  # 쓰던 공급자를 이번에 건너뛰었다
            return f"fallback — {prev} {why[prev]}"
        if prev not in ranked:
            return f"order — {prev} 이(가) 공급자 순서에 없음"
        rank = ranked.index(name)
        if by_order:
            return f"order — {changed}"
        if rank < ranked.index(prev):
            back = _RECOVERED.get(self._last_skip.get(name, ""), "쉼 끝")
            return f"recovery — {name} {back}({rank + 1}순위 복귀)"
        return f"fallback — {prev} → {name}"

    def _quiet(self, name: str, now: float) -> bool:
        """429 로 쉬거나 미뤄 둔 기간이 끝난 뒤 RATE_LIMIT_RESET_S 동안 429 가 없었는가.
        쉬는·미루는 시간은 '조용함'으로 세지 않는다 — 세면 hold 가 끝나자마자 단계가 초기화되어 반복이 다시 시작된다."""
        return now - self._rl_until.get(name, -math.inf) > RATE_LIMIT_RESET_S

    def record_success(self, name: str) -> None:
        self._fails[name] = 0
        if self._fail_until.pop(name, None) is not None:  # 3회 연속 실패 쉼 중 다시 시도가 성공 — 쉼을 끝낸다
            self._fail_why.pop(name, None)
            if self._down_kind.get(name) == "fail":
                self._down_until.pop(name, None)
                self._down_why.pop(name, None)
                self._down_kind.pop(name, None)
        # 성공 한 번으로 단계를 초기화하면 60 s 마다 429 ↔ 복귀가 반복된다(실측). 15분 조용해야 초기화.
        if self._quiet(name, self._mono()):
            self._rate_limited[name] = 0
            self._hold_until.pop(name, None)

    def record_rate_limited(self, name: str) -> float:
        """429: 지수 백오프(60 → 120 → 240 → 300 s)로 쉬게 한다. 반환값은 쉬는 시간(초).
        15분 안에 되풀이된 429 면 그 뒤로도 RATE_LIMIT_HOLD_S 만큼 뒤로 미룬다(R-17). 단계는 STAGE_MAX 에서 멈춘다.
        저장하지 않는다 — 작업은 on_rate_limited(적고 저장)를 쓴다."""
        return self._record_429(name, self._mono())

    def _record_429(self, name: str, now: float) -> float:
        if self._quiet(name, now):
            self._rate_limited[name] = 0  # 조용했던 뒤의 첫 429
        n = min(self._rate_limited.get(name, 0) + 1, STAGE_MAX)
        self._rate_limited[name] = n
        self._last_429[name] = now
        wait = backoff_s(n)
        hold = _hold_for(n)
        self._down_until[name] = now + wait
        self._down_why[name] = _hold_text(hold) if hold else f"429 쉼({wait:.0f} s)"
        self._down_kind[name] = "429"
        self._backoff_until[name] = now + wait
        if hold:
            self._hold_until[name] = now + hold
            self._hold_why[name] = _hold_text(hold)
            self._hold_len[name] = hold
        self._rl_until[name] = now + max(wait, hold)
        return wait

    def _apply_saved(self, name: str, s: _Saved, now_m: float, now_w: float) -> None:
        # 읽기 전에 메모리에만 적은 429(재시작 뒤 — 저장된 것보다 나중이고, 기록이 아직 지나지 않았으니 조용함도 없었다)
        pending, last_mem = self._rate_limited.get(name, 0), self._last_429.get(name)
        off = now_m - now_w  # 벽시계 → 단조 시계
        self._rate_limited[name] = s.stage
        self._last_429[name] = s.last_429 + off
        self._rl_until[name] = s.quiet_from + off
        self._backoff_until[name] = s.backoff_until + off
        held = s.hold_until > now_w
        if held:
            self._hold_until[name] = s.hold_until + off
            self._hold_len[name] = s.hold_s
            self._hold_why[name] = _hold_text(s.hold_s) + RESTORED
        if s.backoff_until > now_w and s.backoff_until + off > self._down_until.get(name, 0.0):
            self._down_until[name] = s.backoff_until + off
            self._down_why[name] = (_hold_text(s.hold_s) if held else f"429 쉼({backoff_s(s.stage):.0f} s)") + RESTORED
            self._down_kind[name] = "429"
        if pending and last_mem is not None:  # 되살리기가 제때 됐을 때처럼 저장된 단계에 이어 센다(쉼·미룸은 그 429 시각부터)
            for _ in range(pending):
                self._record_429(name, last_mem)
        log.info(
            "%s: %s 429 history restored — stage %d, backoff %.0f s left, deferred %.0f s left (saved %.0f s ago%s)",
            self.job,
            name,
            self._rate_limited[name],
            max(0.0, self._backoff_until[name] - now_m),
            max(0.0, self._hold_until.get(name, 0.0) - now_m),
            max(0.0, now_w - s.last_429),
            f"; {pending} 429 before the read counted on top" if pending else "",
        )

    def record_failure(self, name: str) -> bool:
        """True 면 임계치 도달 → 쿨다운 진입(다음 pick 에서 전환). 쉬는 중 다시 시도(다른 공급자가 없어 부름)가 실패하면 False —
        쉼 끝을 늘리지 않고 새 '3회'를 세지 않는다(쉼마다 WARN 한 번 — 전과 같다)."""
        if self.probing(name):
            return False
        n = self._fails.get(name, 0) + 1
        self._fails[name] = n
        if n >= self._threshold:
            self._fails[name] = 0
            self.mark_down(name, self._cooldown, why=f"{n}회 연속 실패({dur(self._cooldown)} 쉼)", kind="fail")
            return True
        return False

    @property
    def current(self) -> str | None:
        return self._current

    def choose(self, order: list[str], need_global: bool, disabled: frozenset[str], now_w: datetime) -> Choice:
        """고를 공급자와 건너뛴 [(이름, 종류, 까닭)]. 상태를 바꾸지 않는다. disabled = 운영자가 끈 공급자(부르는 쪽이 읽었다), now_w = 지금(UTC).
        까닭의 순서: 설정 안 됨 → 운영자 끔 → 일시정지 → 쉼(429 · 실패 · 예산 …) → 429 미룸. 모두 건너뛰면 미룸 중인 공급자(mode "held"),
        그것도 없으면 3회 연속 실패로 쉬는 공급자(mode "probe" — 오래 시도하지 않은 것부터, 관심 지역만)를 고른다."""
        now = self._mono()
        skipped: list[tuple[str, str, str]] = []
        held: list[str] = []
        probes: list[str] = []
        ranked = self._candidates(order, need_global)
        for name in ranked:
            p = self._providers[name]
            if getattr(p, "configured", True) is False:
                skipped.append((name, "config", "설정 안 됨"))
                continue
            if name in disabled:
                skipped.append((name, "disabled", "운영자 끔"))
                continue
            if self.paused(p, now_w):
                skipped.append((name, "paused", "일시정지(크레딧/예산)"))
                continue
            rest = self._rest(name, now)
            if rest is not None:
                in_hold = self._hold_until.get(name, 0.0) > now
                skipped.append((name, "hold" if in_hold else "down", rest[2]))
                # 3회 연속 실패 쉼 — 다른 공급자가 하나도 없을 때만 다시 시도(전세계는 쉼 그대로 — 모듈 설명). 그 위에 얹힌 짧은 쉼 동안은 부르지 않는다
                if rest[1] == "fail" and not need_global:
                    probes.append(name)
                continue
            if self._hold_until.get(name, 0.0) > now:
                held.append(name)  # 되풀이된 429 — 다른 공급자가 없을 때만
                skipped.append((name, "hold", self._hold_why.get(name, "429 반복 → 뒤로 미룸")))
                continue
            return Choice(name, skipped)
        if held:
            return Choice(held[0], [x for x in skipped if x[0] != held[0]], "held")
        if probes:
            name = min(probes, key=lambda n: (self._probed_at.get(n, -math.inf), ranked.index(n)))
            return Choice(name, [x for x in skipped if x[0] != name], "probe", tuple(skipped))
        return Choice(None, skipped)
