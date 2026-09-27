"""재연결 지수 백오프(계약 v2 §B1)와 구독 갱신 속도 제한.

- Backoff: 1 → 2 → 4 … 60 s, 각 값에 ±20 % 지터(여러 인스턴스·재시작이 같은 순간에 몰리지 않게).
  시도 횟수는 '60 s 넘게 정상(메시지를 받는) 연결' 이 끝났을 때만 초기화한다 — 붙자마자 끊기는 상태(잘못된 키·연결 수 초과)가
  1 s 간격 재접속으로 공급자를 두드리지 않게 한다.
- SubscribeLimiter: 같은 연결에서 구독 갱신은 5 s 에 한 번까지(aisstream 한도는 연결당 초당 1회 — 넘으면 연결을 끊는다).
"""

from __future__ import annotations

import random
import time
from collections.abc import Callable


class Backoff:
    def __init__(
        self,
        base_s: float = 1.0,
        cap_s: float = 60.0,
        jitter: float = 0.2,
        healthy_reset_s: float = 60.0,
        rng: random.Random | None = None,
    ) -> None:
        if not (0 < base_s <= cap_s) or not (0 <= jitter < 1):
            raise ValueError("invalid backoff parameters")
        self.base_s, self.cap_s, self.jitter, self.healthy_reset_s = base_s, cap_s, jitter, healthy_reset_s
        self._rng = rng or random.Random()  # noqa: S311 — 지터용(보안 용도 아님)
        self.attempt = 0

    def nominal(self) -> float:
        return min(self.cap_s, self.base_s * (2 ** min(self.attempt, 30)))

    def next_delay(self) -> float:
        d = self.nominal() * self._rng.uniform(1 - self.jitter, 1 + self.jitter)
        self.attempt += 1
        return d

    def session_ended(self, healthy_for_s: float | None) -> bool:
        """연결이 끝났다. healthy_for_s = 첫 메시지부터 끊길 때까지(초, 메시지가 없었으면 None). 초기화했으면 True."""
        if healthy_for_s is not None and healthy_for_s >= self.healthy_reset_s:
            self.attempt = 0
            return True
        return False


class SubscribeLimiter:
    def __init__(self, min_interval_s: float = 5.0, mono: Callable[[], float] = time.monotonic) -> None:
        self.min_interval_s = min_interval_s
        self._mono = mono
        self._last: float | None = None

    def wait_s(self) -> float:
        if self._last is None:
            return 0.0
        return max(0.0, self._last + self.min_interval_s - self._mono())

    def mark(self) -> None:
        self._last = self._mono()
