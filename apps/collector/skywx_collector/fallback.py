"""공급자 폴백 체인(FR-16): 1순위 3회 연속 실패 → 다음 순위, 10분 뒤 복귀 시도. 전환은 provider_switch 이벤트로 기록."""

from __future__ import annotations

import time
from typing import Any

from skywx_collector.status import ProviderStatus

RATE_LIMIT_RESET_S = 900.0  # 마지막 429 로부터 이만큼 조용하면 백오프 단계를 초기화


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
        self._current: str | None = None

    def mark_down(self, name: str, seconds: float) -> None:
        self._down_until[name] = time.monotonic() + seconds

    async def pick(self, order: list[str], *, need_global: bool = False) -> Any | None:
        now = time.monotonic()
        for name in order:
            p = self._providers.get(name)
            if p is None:
                continue
            if need_global and not getattr(p, "supports_global", False):
                continue
            if not need_global and not getattr(p, "supports_region", False):
                continue
            if getattr(p, "configured", True) is False:
                continue
            if self._down_until.get(name, 0.0) > now:
                continue
            if await self._status.is_disabled(name):
                continue
            if self._current != name:
                prev = self._current or "-"
                reason = "initial" if prev == "-" else "fallback/recovery"
                self._current = name
                await self._status.set_active(self.job, name, reason=reason)
                if prev != "-":
                    await self._status.switch_event(self.job, prev, name, reason)
            return p
        return None

    def record_success(self, name: str) -> None:
        self._fails[name] = 0
        # 성공 한 번으로 단계를 초기화하면 60 s 마다 429 ↔ 복귀가 반복된다(실측). 15분 조용해야 초기화.
        if time.monotonic() - self._last_429.get(name, 0.0) > RATE_LIMIT_RESET_S:
            self._rate_limited[name] = 0

    def record_rate_limited(self, name: str) -> float:
        """429: 지수 백오프(60 → 120 → 240 → 300 s)로 쉬게 한다. 반환값은 쉬는 시간(초)."""
        n = self._rate_limited.get(name, 0)
        self._rate_limited[name] = n + 1
        self._last_429[name] = time.monotonic()
        wait = min(300.0, 60.0 * (2**n))
        self.mark_down(name, wait)
        return wait

    def record_failure(self, name: str) -> bool:
        """True 면 임계치 도달 → 쿨다운 진입(다음 pick 에서 전환)."""
        n = self._fails.get(name, 0) + 1
        self._fails[name] = n
        if n >= self._threshold:
            self._fails[name] = 0
            self.mark_down(name, self._cooldown)
            return True
        return False

    @property
    def current(self) -> str | None:
        return self._current
