"""공급자 폴백 체인(FR-16): 1순위 3회 연속 실패 → 다음 순위, 10분 뒤 복귀 시도. 전환은 provider_switch 이벤트로 기록.

'3회 연속 실패' 쉼도 차단이 아니라 선호도다(운영 로그 2026-09-30 — 아래 429 미룸과 같은 규칙): 쓸 수 있는 공급자가 하나도 없으면(미룸 중인
공급자도 없으면) 쉬는 공급자를 작업 주기 그대로 다시 시도한다(여럿이면 오래 시도하지 않은 것부터). 다시 시도가 실패해도 쉼 끝을 늘리지 않고
새 '3회'를 세지 않는다(WARN 되풀이 없음) — 성공하면 쉼을 끝낸다. 운영자가 끈 · 일시정지 · 설정 안 된 공급자는 다시 시도하지 않는다.
전에는 adsb_fi 가 연결 실패(SSLEOFError) 3번으로 10분 쉬는 동안 adsb_lol 까지 429 로 쉬면 관심 지역에 공급자가 없었다 — 12:16:22 → 12:21:22 ·
12:22:18 → 12:24:50 KST, 합 452 s(쉼 600 s · 429 쉼 300 s 와 로그 시각으로 계산).

공급자 없음은 이름 붙인 상태다: 처음 없어진 순간 set_none(시작 시각 · 건너뛴 까닭 · 체인 상태로 정해지는 가장 이른 풀림 시각 — 운영자가 켜야 하거나
설정이 없어 때를 모르면 없음)과 전환 기록(쓰던 공급자 → none)을 남긴다. 다시 고르면 none → 공급자 전환('recovery — 공급자 없음 N s 끝 · …')과
set_active(없음 필드를 비운다). 쓰던 공급자 이름(wakeline:active 의 {job})은 마지막으로 쓴 것으로 남는다 — 지금 상태는 {job}_none_* 가 말한다.

429 이력(R-17): 429 가 RATE_LIMIT_RESET_S(15분) 안에 되풀이되면 백오프(최대 300 s)가 끝난 뒤에도 그 공급자를 한동안
뒤로 미룬다(hold: 10 → 20 → 40 → 60 → 120 → 240 → 360분, 상한 6 h). 그동안 다음 순위가 같은 주기로 맡는다. hold 는 차단이 아니라
선호도라서, 다른 공급자가 하나도 없으면 백오프가 끝난 공급자를 그대로 쓴다. 15분 동안 429 없이 쓰이면 단계가 초기화된다. 단계는
STAGE_MAX(8 — 쉼·미룸이 모두 가장 긴 값인 단계)에서 멈춘다. 공급자의 실제 한도 수치는 모르므로 호출 속도를 추정해 정하지 않는다.
사다리의 120 · 240 · 360분은 선택값이다(2026-09-29 관찰: adsb.lol 이 60분 미룸이 끝나고 약 1분 만에 다시 429 — ADR-011).

체인은 작업(region·global)마다 따로지만, 공급자 객체에 붙은 paused_until(UTC)은 두 체인이 함께 본다
(예: OpenSky 남은 크레딧이 예비분 아래로 내려가면 자정까지 어느 체인도 쓰지 않는다).
상태 기록(set_active·switch_event·is_disabled)은 ProviderStatus 가 Redis 오류를 삼키므로 선택을 막지 않는다.

재시작(R-17 보존): store(ChainStateStore)를 주면 429 이력(단계·마지막 429·쉼 끝·미룸 끝·조용함 기준)을 429 마다 Redis 에 벽시계 epoch 초로
남기고(persist), 첫 선택 때 읽어 단조 시계로 바꿔 되살린다. 지난 기록(expires_at)·형식이 틀린 기록·상한보다 먼 미래를 가리키는 기록은
버린다. Redis 가 안 되면 메모리 이력만 쓴다(선택을 막지 않는다). 되살린 쉼·미룸의 전환 사유에는 '(재시작 전 기록)'을 붙인다.
읽기가 실패하면 읽힐 때까지 선택·429 마다 다시 읽는다. 그동안 받은 429 는 메모리에만 적고 저장하지 않는다(읽지 못한 기록을 1단계로
덮지 않게) — 읽기가 되면 저장된 단계에 이어 센 것으로 맞추고(되살리기가 제때 됐을 때와 같게) 저장한다.

전환 사유(set_active·switch_event 에 같은 글, 가린 뒤 REASON_MAX 자): 무엇을 왜 건너뛰었는지·왜 돌아왔는지를 적는다.
  "fallback — adsb_lol 429 쉼(60 s)" · "fallback — adsb_lol 429 반복 → 20분 뒤로 미룸" · "fallback — adsb_lol 3회 연속 실패(10분 쉼)" ·
  "fallback — adsb_lol 운영자 끔" · "fallback — adsb_lol 일시정지(크레딧/예산)" · "recovery — adsb_lol 쉼 끝(1순위 복귀)" ·
  "initial" (처음 고른 것이 1순위가 아니면 "initial — <건너뛴 공급자> <사유>"). 순위는 이 작업 범위(관심 지역·전세계)를 지원하는 공급자 사이의 순서다.
"""

from __future__ import annotations

import logging
import math
import time
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

from wakeline_collector.chain_store import VERSION, ChainStateStore
from wakeline_collector.masking import mask
from wakeline_collector.status import ProviderStatus

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

log = logging.getLogger("fallback")

# 건너뛴 까닭의 종류 → 돌아올 때의 말. 종류: down(쉼: 429·실패·예산·속도 상한) · hold · disabled · paused · config
_RECOVERED = {"hold": "미룸 끝", "disabled": "운영자 켬", "paused": "일시정지 끝", "config": "설정됨"}


def _dur(seconds: float) -> str:
    """600 → '10분', 60 → '60 s', 0.05 → '0.05 s'. 1분으로 떨어지는 2분 이상만 분으로 쓴다."""
    if seconds >= 120 and seconds % 60 == 0:
        return f"{seconds / 60:.0f}분"
    return f"{seconds:g} s" if seconds < 10 else f"{seconds:.0f} s"


def _hold_text(hold_s: float) -> str:
    return f"429 반복 → {_dur(hold_s)} 뒤로 미룸"


def _backoff_s(stage: int) -> float:
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
class _Choice:
    """_evaluate 의 결과: 고를 공급자(없으면 None) · 건너뛴 [(이름, 종류, 까닭)](고른 것 제외) · 고른 방식(None 정상 · "held" 429 미룸 중이나
    다른 공급자 없음 · "probe" 3회 연속 실패로 쉬는 중이나 다른 공급자 없음) · probe 면 그 공급자가 쉬는 까닭."""

    name: str | None
    skipped: list[tuple[str, str, str]]
    mode: str | None = None
    why: str = ""


class ProviderChain:
    def __init__(
        self,
        job: str,
        providers: dict[str, Any],
        status: ProviderStatus,
        fail_threshold: int = 3,
        cooldown_s: float = 600.0,
        *,
        store: ChainStateStore | None = None,
    ):
        self.job = job
        self._store = store
        self._restored = store is None
        self._providers = providers
        self._status = status
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
        self._probed_at: dict[str, float] = {}  # 쉬는 중 다시 시도한 마지막 때(여럿이면 오래된 것부터)
        self._current: str | None = None
        self._none_since: float | None = None  # 공급자 없음이 시작된 때(단조 시계) — 없으면 None
        self.none_reason = ""  # 공급자 없음의 까닭(건너뛴 공급자와 까닭, 가린 글)
        self.none_next: tuple[str, float] | None = None  # (가장 먼저 풀리는 공급자, 그때까지 초) — 체인 상태로 정해진 값만

    def mark_down(self, name: str, seconds: float, *, why: str | None = None, kind: str = "other") -> None:
        """name 을 seconds 동안 쉬게 한다. why 는 전환 사유에 실리는 짧은 글(없으면 '쉼(N s)'). kind 는 쉼의 종류(record_failure 는 "fail")."""
        self._down_until[name] = time.monotonic() + seconds
        self._down_why[name] = why or f"쉼({_dur(seconds)})"
        self._down_kind[name] = kind

    @staticmethod
    def paused(p: Any, now: datetime | None = None) -> bool:
        until = getattr(p, "paused_until", None)
        return isinstance(until, datetime) and until > (now or datetime.now(UTC))

    def _candidates(self, order: list[str], need_global: bool) -> list[str]:
        """이 작업 범위를 지원하는 공급자(순서대로) — 순위는 이 목록에서 센다."""
        out = []
        for name in order:
            p = self._providers.get(name)
            if p is not None and getattr(p, "supports_global" if need_global else "supports_region", False):
                out.append(name)
        return out

    async def _evaluate(self, order: list[str], need_global: bool) -> _Choice:
        """고를 공급자와 건너뛴 [(이름, 종류, 까닭)]. 상태를 바꾸지 않는다(처음 한 번은 저장된 429 이력을 되살린다).
        까닭의 순서: 설정 안 됨 → 운영자 끔 → 일시정지 → 쉼(429 · 실패 · 예산 …) → 429 미룸. 모두 건너뛰면 미룸 중인 공급자(mode "held"),
        그것도 없으면 3회 연속 실패로 쉬는 공급자(mode "probe" — 오래 시도하지 않은 것부터)를 고른다."""
        if not self._restored:
            await self._restore()
        now = time.monotonic()
        skipped: list[tuple[str, str, str]] = []
        held: list[str] = []
        probes: list[str] = []
        ranked = self._candidates(order, need_global)
        for name in ranked:
            p = self._providers[name]
            if getattr(p, "configured", True) is False:
                skipped.append((name, "config", "설정 안 됨"))
                continue
            if await self._status.is_disabled(name):
                skipped.append((name, "disabled", "운영자 끔"))
                continue
            if self.paused(p):
                skipped.append((name, "paused", "일시정지(크레딧/예산)"))
                continue
            if self._down_until.get(name, 0.0) > now:
                in_hold = self._hold_until.get(name, 0.0) > now
                skipped.append((name, "hold" if in_hold else "down", self._down_why.get(name, "쉼")))
                if self._down_kind.get(name) == "fail":
                    probes.append(name)  # 3회 연속 실패 쉼 — 다른 공급자가 하나도 없을 때만 다시 시도
                continue
            if self._hold_until.get(name, 0.0) > now:
                held.append(name)  # 되풀이된 429 — 다른 공급자가 없을 때만
                skipped.append((name, "hold", self._hold_why.get(name, "429 반복 → 뒤로 미룸")))
                continue
            return _Choice(name, skipped)
        if held:
            return _Choice(held[0], [x for x in skipped if x[0] != held[0]], "held")
        if probes:
            name = min(probes, key=lambda n: (self._probed_at.get(n, -math.inf), ranked.index(n)))
            why = next(w for n, _k, w in skipped if n == name)
            return _Choice(name, [x for x in skipped if x[0] != name], "probe", why)
        return _Choice(None, skipped)

    async def peek(self, order: list[str], *, need_global: bool = False) -> str | None:
        """다음 pick 이 고를 공급자 이름(상태·사유를 기록하지 않는다). 로그에 '다음에 무엇을 하는지'를 적을 때 쓴다."""
        return (await self._evaluate(order, need_global)).name

    def probing(self, name: str) -> bool:
        """name 이 3회 연속 실패로 쉬는 중인가 — 그래도 불렸다면 다른 공급자가 없어 다시 시도한 것이다."""
        return self._down_kind.get(name) == "fail" and self._down_until.get(name, 0.0) > time.monotonic()

    @property
    def none_since(self) -> float | None:
        """공급자 없음이 시작된 때(단조 시계). 공급자가 있으면 None."""
        return self._none_since

    def none_elapsed_s(self) -> float | None:
        return None if self._none_since is None else time.monotonic() - self._none_since

    def hold_s(self, name: str) -> float:
        """name 에 걸린 429 미룸의 길이(초). 미룸이 없거나 끝났으면 0."""
        if self._hold_until.get(name, 0.0) <= time.monotonic():
            return 0.0
        return self._hold_len.get(name, 0.0)

    async def pick(self, order: list[str], *, need_global: bool = False) -> Any | None:
        c = await self._evaluate(order, need_global)
        for n, kind, _why in c.skipped:
            self._last_skip[n] = kind
        if c.name is None:
            await self._enter_none(c.skipped)
            return None
        if c.mode == "probe":
            self._probed_at[c.name] = time.monotonic()
        if self._none_since is not None or self._current != c.name:
            reason = self._reason(c, self._candidates(order, need_global))
            await self._use(c.name, reason)
        return self._providers[c.name]

    async def _enter_none(self, skipped: list[tuple[str, str, str]]) -> None:
        """공급자 없음의 시작(같은 공백에는 한 번): set_none(시작 · 까닭 · 가장 이른 풀림 시각)과 전환 기록(쓰던 공급자 → none)."""
        if self._none_since is not None:
            return
        now_m, now_w = time.monotonic(), datetime.now(UTC)
        self._none_since = now_m
        text = " · ".join(f"{n} {w}" for n, _k, w in skipped) or "이 범위를 지원하는 공급자가 순서에 없음"
        self.none_reason = (mask(text, None) or "")[:REASON_MAX]
        self.none_next = self._next_release(skipped, now_m, now_w)
        next_at = now_w + timedelta(seconds=self.none_next[1]) if self.none_next else None
        await self._status.set_none(self.job, since=now_w, reason=self.none_reason, next_at=next_at)
        if self._current is not None:
            await self._status.switch_event(self.job, self._current, "none", f"none — {self.none_reason}"[:REASON_MAX])

    def _next_release(self, skipped: list[tuple[str, str, str]], now_m: float, now_w: datetime) -> tuple[str, float] | None:
        """건너뛴 공급자 중 가장 먼저 풀리는 것과 남은 초 — 쉼 끝 · 일시정지 끝(체인 상태 그대로). 운영자 끔 · 설정 안 됨은 때가 없다(None)."""
        best: tuple[str, float] | None = None
        for n, kind, _w in skipped:
            left: float | None = None
            if kind in ("down", "hold"):
                left = self._down_until.get(n, 0.0) - now_m
            elif kind == "paused":
                until = getattr(self._providers[n], "paused_until", None)
                left = (until - now_w).total_seconds() if isinstance(until, datetime) else None
            if left is not None and left > 0 and (best is None or left < best[1]):
                best = (n, left)
        return best

    def _reason(self, c: _Choice, ranked: list[str]) -> str:
        name, skipped = c.name, c.skipped
        assert name is not None
        prev = self._current
        why = {n: w for n, _k, w in skipped}
        tail = ""
        if c.mode == "held":
            tail = f"{name} 429 미룸 중이나 다른 공급자 없음"
        elif c.mode == "probe":
            tail = f"{name} 다시 시도 — {c.why} 중, 다른 공급자 없음"
        if self._none_since is not None:  # 공급자 없음이 끝났다
            back = tail or f"{name} {_RECOVERED.get(self._last_skip.get(name, ''), '쉼 끝')}"
            return f"recovery — 공급자 없음 {_dur(round(time.monotonic() - self._none_since))} 끝 · {back}"
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
        if rank < ranked.index(prev):
            back = _RECOVERED.get(self._last_skip.get(name, ""), "쉼 끝")
            return f"recovery — {name} {back}({rank + 1}순위 복귀)"
        return f"fallback — {prev} → {name}"

    async def _use(self, name: str, reason: str) -> None:
        prev = "none" if self._none_since is not None else self._current
        text = (mask(reason, None) or "")[:REASON_MAX]  # 두 곳에 같은 글
        self._current = name
        self._none_since, self.none_reason, self.none_next = None, "", None
        await self._status.set_active(self.job, name, reason=text)  # 공급자 없음 필드도 비운다
        if prev is not None:
            await self._status.switch_event(self.job, prev, name, text)

    def _quiet(self, name: str, now: float) -> bool:
        """429 로 쉬거나 미뤄 둔 기간이 끝난 뒤 RATE_LIMIT_RESET_S 동안 429 가 없었는가.
        쉬는·미루는 시간은 '조용함'으로 세지 않는다 — 세면 hold 가 끝나자마자 단계가 초기화되어 반복이 다시 시작된다."""
        return now - self._rl_until.get(name, -math.inf) > RATE_LIMIT_RESET_S

    def record_success(self, name: str) -> None:
        self._fails[name] = 0
        if self._down_kind.get(name) == "fail":  # 3회 연속 실패 쉼 중 다시 시도가 성공 — 쉼을 끝낸다
            self._down_until.pop(name, None)
            self._down_why.pop(name, None)
            self._down_kind.pop(name, None)
        # 성공 한 번으로 단계를 초기화하면 60 s 마다 429 ↔ 복귀가 반복된다(실측). 15분 조용해야 초기화.
        if self._quiet(name, time.monotonic()):
            self._rate_limited[name] = 0
            self._hold_until.pop(name, None)

    def record_rate_limited(self, name: str) -> float:
        """429: 지수 백오프(60 → 120 → 240 → 300 s)로 쉬게 한다. 반환값은 쉬는 시간(초).
        15분 안에 되풀이된 429 면 그 뒤로도 RATE_LIMIT_HOLD_S 만큼 뒤로 미룬다(R-17). 단계는 STAGE_MAX 에서 멈춘다.
        저장하지 않는다 — 작업은 on_rate_limited(적고 저장)를 쓴다."""
        return self._record_429(name, time.monotonic())

    async def on_rate_limited(self, name: str) -> float:
        """429 를 적고 저장한다. 반환값은 쉬는 시간(초). 저장된 이력을 아직 읽지 못했으면 먼저 다시 읽는다 —
        읽지 못한 채 적으면 재시작 전 단계를 모르고 1단계부터 센다."""
        if not self._restored:
            await self._restore()
        self._record_429(name, time.monotonic())
        await self.persist(name)  # 여기서야 읽기가 되면 저장된 단계에 이어 센 값으로 맞춰진다
        return _backoff_s(self._rate_limited[name])

    def _record_429(self, name: str, now: float) -> float:
        if self._quiet(name, now):
            self._rate_limited[name] = 0  # 조용했던 뒤의 첫 429
        n = min(self._rate_limited.get(name, 0) + 1, STAGE_MAX)
        self._rate_limited[name] = n
        self._last_429[name] = now
        wait = _backoff_s(n)
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

    # ---- 재시작 보존(ChainStateStore) ---------------------------------------------------------------------------------
    async def persist(self, name: str) -> None:
        """name 의 429 이력을 저장한다(429 를 기록한 뒤 부른다). 저장소가 없거나 이력이 없으면 아무것도 하지 않는다.
        저장된 이력을 아직 읽지 못했으면 먼저 읽고(되면 맞춰서 저장한다), 여전히 못 읽으면 쓰지 않는다 — 읽지 못한 기록을 덮지 않는다.
        Redis 오류는 저장소가 삼킨다(메모리 이력으로 계속)."""
        if self._store is None or not self._rate_limited.get(name):
            return
        if not self._restored:
            await self._restore()  # 읽기가 되면 메모리에만 있던 429 이력(이 공급자 포함)을 맞춰 저장한다
            return
        await self._write(name)

    async def _write(self, name: str) -> None:
        if self._store is None:
            return
        now_m, now_w = time.monotonic(), self._store.wall()

        def wall(m: float) -> str:
            return f"{now_w + (m - now_m):.3f}"

        held = self._hold_until.get(name, 0.0) > now_m
        quiet_from = self._rl_until.get(name, now_m)
        expires_in = quiet_from + RATE_LIMIT_RESET_S - now_m
        fields = {
            "v": VERSION,
            "stage": str(self._rate_limited[name]),
            "last_429_at": wall(self._last_429.get(name, now_m)),
            "backoff_until": wall(self._backoff_until.get(name, now_m)),
            "hold_until": wall(self._hold_until[name]) if held else "",
            "hold_s": f"{self._hold_len.get(name, 0.0):.0f}" if held else "0",
            "quiet_from": wall(quiet_from),
            "expires_at": wall(quiet_from + RATE_LIMIT_RESET_S),  # 논리 만료 — 이 뒤에는 이력이 초기화된 것과 같다
            "saved_at": f"{now_w:.3f}",
        }
        await self._store.save(self.job, name, fields, ttl_s=math.ceil(expires_in))  # Redis TTL 도 같은 때

    async def _restore(self) -> None:
        """저장된 429 이력을 되살린다. Redis 오류로 읽지 못하면 그대로 두고(_restored=False) 다음 선택·429 때 다시 읽는다.
        읽기 전에 메모리에만 적은 429 는 저장된 단계에 이어 센 것으로 맞추고(_apply_saved) 저장한다."""
        store = self._store
        if store is None:
            self._restored = True
            return
        rows = await store.load(self.job, list(self._providers))
        if rows is None:
            return  # 모름 — 다음에 다시 읽는다
        self._restored = True
        now_m, now_w = time.monotonic(), store.wall()
        unsaved = [n for n, k in self._rate_limited.items() if k and not self._quiet(n, now_m)]  # 읽기 전에 메모리에만 적은 429
        for name, row in rows.items():
            saved, why = parse_saved(row, now_w)
            if saved is None:
                if why != "expired":
                    log.info("%s: %s 429 history ignored (%s)", self.job, name, why)
                await store.drop(self.job, name)
                continue
            self._apply_saved(name, saved, now_m, now_w)
        for name in unsaved:
            await self._write(name)

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
            self._down_why[name] = (_hold_text(s.hold_s) if held else f"429 쉼({_backoff_s(s.stage):.0f} s)") + RESTORED
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
            self.mark_down(name, self._cooldown, why=f"{n}회 연속 실패({_dur(self._cooldown)} 쉼)", kind="fail")
            return True
        return False

    @property
    def current(self) -> str | None:
        return self._current
