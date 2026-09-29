"""공급자 폴백 체인(FR-16): 1순위 3회 연속 실패 → 다음 순위, 10분 뒤 복귀 시도. 전환은 provider_switch 이벤트로 기록.

429 이력(R-17): 429 가 RATE_LIMIT_RESET_S(15분) 안에 되풀이되면 백오프(최대 300 s)가 끝난 뒤에도 그 공급자를 한동안
뒤로 미룬다(hold: 10 → 20 → 40 → 60분). 그동안 다음 순위가 같은 주기로 맡는다. hold 는 차단이 아니라 선호도라서, 다른 공급자가
하나도 없으면 백오프가 끝난 공급자를 그대로 쓴다. 15분 동안 429 없이 쓰이면 단계가 초기화된다. 공급자의 실제 한도 수치는 모르므로
호출 속도를 추정해 정하지 않는다.

체인은 작업(region·global)마다 따로지만, 공급자 객체에 붙은 paused_until(UTC)은 두 체인이 함께 본다
(예: OpenSky 남은 크레딧이 예비분 아래로 내려가면 자정까지 어느 체인도 쓰지 않는다).
상태 기록(set_active·switch_event·is_disabled)은 ProviderStatus 가 Redis 오류를 삼키므로 선택을 막지 않는다.

전환 사유(set_active·switch_event 에 같은 글, 가린 뒤 REASON_MAX 자): 무엇을 왜 건너뛰었는지·왜 돌아왔는지를 적는다.
  "fallback — adsb_lol 429 쉼(60 s)" · "fallback — adsb_lol 429 반복 → 20분 뒤로 미룸" · "fallback — adsb_lol 3회 연속 실패(10분 쉼)" ·
  "fallback — adsb_lol 운영자 끔" · "fallback — adsb_lol 일시정지(크레딧/예산)" · "recovery — adsb_lol 쉼 끝(1순위 복귀)" ·
  "initial" (처음 고른 것이 1순위가 아니면 "initial — <건너뛴 공급자> <사유>"). 순위는 이 작업 범위(관심 지역·전세계)를 지원하는 공급자 사이의 순서다.
"""

from __future__ import annotations

import math
import time
from datetime import UTC, datetime
from typing import Any

from wakeline_collector.masking import mask
from wakeline_collector.status import ProviderStatus

RATE_LIMIT_RESET_S = 900.0  # 마지막 429 로부터 이만큼 조용하면 백오프 단계를 초기화
RATE_LIMIT_HOLD_S = (600.0, 1200.0, 2400.0, 3600.0)  # 15분 안에 되풀이된 429 뒤 복귀를 늦추는 시간(R-17)
REASON_MAX = 120  # 전환 사유 글자 수 상한

# 건너뛴 까닭의 종류 → 돌아올 때의 말. 종류: down(쉼: 429·실패·예산·속도 상한) · hold · disabled · paused · config
_RECOVERED = {"hold": "미룸 끝", "disabled": "운영자 켬", "paused": "일시정지 끝", "config": "설정됨"}


def _dur(seconds: float) -> str:
    """600 → '10분', 60 → '60 s', 0.05 → '0.05 s'. 1분으로 떨어지는 2분 이상만 분으로 쓴다."""
    if seconds >= 120 and seconds % 60 == 0:
        return f"{seconds / 60:.0f}분"
    return f"{seconds:g} s" if seconds < 10 else f"{seconds:.0f} s"


def _hold_text(hold_s: float) -> str:
    return f"429 반복 → {_dur(hold_s)} 뒤로 미룸"


class ProviderChain:
    def __init__(
        self, job: str, providers: dict[str, Any], status: ProviderStatus, fail_threshold: int = 3, cooldown_s: float = 600.0
    ):
        self.job = job
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
        self._current: str | None = None

    def mark_down(self, name: str, seconds: float, *, why: str | None = None) -> None:
        """name 을 seconds 동안 쉬게 한다. why 는 전환 사유에 실리는 짧은 글(없으면 '쉼(N s)')."""
        self._down_until[name] = time.monotonic() + seconds
        self._down_why[name] = why or f"쉼({_dur(seconds)})"

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

    async def _evaluate(self, order: list[str], need_global: bool) -> tuple[str | None, list[tuple[str, str, str]], bool]:
        """(고를 공급자 | None, 건너뛴 [(이름, 종류, 까닭)], 미룸 중인 공급자를 대안이 없어 골랐는가). 상태를 바꾸지 않는다."""
        now = time.monotonic()
        skipped: list[tuple[str, str, str]] = []
        held: list[str] = []
        for name in self._candidates(order, need_global):
            p = self._providers[name]
            if getattr(p, "configured", True) is False:
                skipped.append((name, "config", "설정 안 됨"))
                continue
            if self._down_until.get(name, 0.0) > now:
                in_hold = self._hold_until.get(name, 0.0) > now
                skipped.append((name, "hold" if in_hold else "down", self._down_why.get(name, "쉼")))
                continue
            if self.paused(p):
                skipped.append((name, "paused", "일시정지(크레딧/예산)"))
                continue
            if await self._status.is_disabled(name):
                skipped.append((name, "disabled", "운영자 끔"))
                continue
            if self._hold_until.get(name, 0.0) > now:
                held.append(name)  # 되풀이된 429 — 다른 공급자가 없을 때만
                skipped.append((name, "hold", self._hold_why.get(name, "429 반복 → 뒤로 미룸")))
                continue
            return name, skipped, False
        if held:
            return held[0], [s for s in skipped if s[0] != held[0]], True
        return None, skipped, False

    async def peek(self, order: list[str], *, need_global: bool = False) -> str | None:
        """다음 pick 이 고를 공급자 이름(상태·사유를 기록하지 않는다). 로그에 '다음에 무엇을 하는지'를 적을 때 쓴다."""
        return (await self._evaluate(order, need_global))[0]

    def hold_s(self, name: str) -> float:
        """name 에 걸린 429 미룸의 길이(초). 미룸이 없거나 끝났으면 0."""
        if self._hold_until.get(name, 0.0) <= time.monotonic():
            return 0.0
        return self._hold_len.get(name, 0.0)

    async def pick(self, order: list[str], *, need_global: bool = False) -> Any | None:
        name, skipped, from_held = await self._evaluate(order, need_global)
        for n, kind, _why in skipped:
            self._last_skip[n] = kind
        if name is None:
            return None
        if self._current != name:
            reason = self._reason(name, self._candidates(order, need_global), skipped, from_held)
            await self._use(name, reason)
        return self._providers[name]

    def _reason(self, name: str, ranked: list[str], skipped: list[tuple[str, str, str]], from_held: bool) -> str:
        prev = self._current
        why = {n: w for n, _k, w in skipped}
        if from_held:
            tail = f"{name} 429 미룸 중이나 다른 공급자 없음"
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
        prev = self._current
        text = (mask(reason, None) or "")[:REASON_MAX]  # 두 곳에 같은 글
        self._current = name
        await self._status.set_active(self.job, name, reason=text)
        if prev is not None:
            await self._status.switch_event(self.job, prev, name, text)

    def _quiet(self, name: str, now: float) -> bool:
        """429 로 쉬거나 미뤄 둔 기간이 끝난 뒤 RATE_LIMIT_RESET_S 동안 429 가 없었는가.
        쉬는·미루는 시간은 '조용함'으로 세지 않는다 — 세면 hold 가 끝나자마자 단계가 초기화되어 반복이 다시 시작된다."""
        return now - self._rl_until.get(name, -math.inf) > RATE_LIMIT_RESET_S

    def record_success(self, name: str) -> None:
        self._fails[name] = 0
        # 성공 한 번으로 단계를 초기화하면 60 s 마다 429 ↔ 복귀가 반복된다(실측). 15분 조용해야 초기화.
        if self._quiet(name, time.monotonic()):
            self._rate_limited[name] = 0
            self._hold_until.pop(name, None)

    def record_rate_limited(self, name: str) -> float:
        """429: 지수 백오프(60 → 120 → 240 → 300 s)로 쉬게 한다. 반환값은 쉬는 시간(초).
        15분 안에 되풀이된 429 면 그 뒤로도 RATE_LIMIT_HOLD_S 만큼 뒤로 미룬다(R-17)."""
        now = time.monotonic()
        if self._quiet(name, now):
            self._rate_limited[name] = 0  # 조용했던 뒤의 첫 429
        n = self._rate_limited.get(name, 0)
        self._rate_limited[name] = n + 1
        self._last_429[name] = now
        wait = min(300.0, 60.0 * (2**n))
        hold = RATE_LIMIT_HOLD_S[min(n - 1, len(RATE_LIMIT_HOLD_S) - 1)] if n >= 1 else 0.0
        self.mark_down(name, wait, why=_hold_text(hold) if hold else f"429 쉼({wait:.0f} s)")
        if hold:
            self._hold_until[name] = now + hold
            self._hold_why[name] = _hold_text(hold)
            self._hold_len[name] = hold
        self._rl_until[name] = now + max(wait, hold)
        return wait

    def record_failure(self, name: str) -> bool:
        """True 면 임계치 도달 → 쿨다운 진입(다음 pick 에서 전환)."""
        n = self._fails.get(name, 0) + 1
        self._fails[name] = n
        if n >= self._threshold:
            self._fails[name] = 0
            self.mark_down(name, self._cooldown, why=f"{n}회 연속 실패({_dur(self._cooldown)} 쉼)")
            return True
        return False

    @property
    def current(self) -> str | None:
        return self._current
