"""이벤트 루프 진단 — 최근 창의 최댓값(WindowMax)과 루프 지연(LoopLag). ais(ADR-014 부록 C — 1011 끊김의 원인 가리기)와 수집기(collector-review §4 —
루프를 막는 작업을 운영에서 잰다)가 함께 쓴다. ais.diag 가 같은 이름으로 다시 내보낸다(ais 의 WARN 글 · 로거는 그대로).

모두 '최근 창의 최댓값' 이다. 표본이 없으면 None(상태 해시 "" — 모름, 0 으로 채우지 않는다).

고른 값(잰 값이 아니다 — 까닭은 ais/diag.py 설명):
- DIAG_WINDOW_S 60 s: 최근 최댓값의 창. BUCKET_S 5 s: 창을 12칸으로 나눈다(값마다 칸 13개 — 메모리 상한, 창 경계는 칸 단위라 최대 65 s 까지 본다).
- LOOP_TICK_S 0.5 s: 루프 지연 표본 간격(sleep 이 늦게 깬 만큼이 지연 — 프로세스가 tick_s 를 골라 넘길 수 있다).
- LOOP_STALL_S 1.0 s: loop_stalls_total 로 세는 지연. LOOP_WARN_S 5.0 s: WARN 으로 알리는 지연 — WARN_EVERY_S 60 s 에 1번까지(수는 모두 센다).
"""

from __future__ import annotations

import asyncio
import logging
import math
import time
from collections import deque
from collections.abc import Callable

DIAG_WINDOW_S = 60.0
BUCKET_S = 5.0
LOOP_TICK_S = 0.5
LOOP_STALL_S = 1.0
LOOP_WARN_S = 5.0
WARN_EVERY_S = 60.0


class WindowMax:
    """최근 window_s 초의 최댓값. bucket_s 칸마다 최댓값 하나만 둔다(칸 수로 메모리 고정). 표본이 없으면 None(모름)."""

    __slots__ = ("window_s", "bucket_s", "_mono", "_buckets")

    def __init__(
        self, window_s: float = DIAG_WINDOW_S, bucket_s: float = BUCKET_S, *, mono: Callable[[], float] = time.monotonic
    ) -> None:
        if not (0 < bucket_s <= window_s):
            raise ValueError("need 0 < bucket_s <= window_s")
        self.window_s, self.bucket_s, self._mono = window_s, bucket_s, mono
        self._buckets: deque[list[float]] = deque(maxlen=math.ceil(window_s / bucket_s) + 1)  # [칸 시작, 최댓값]

    def add(self, value: float) -> None:
        now = self._mono()
        start = now - now % self.bucket_s
        b = self._buckets
        if b and b[-1][0] == start:
            if value > b[-1][1]:
                b[-1][1] = value
        else:
            b.append([start, value])

    def value(self) -> float | None:
        cutoff = self._mono() - self.window_s - self.bucket_s  # 칸 시작 기준 — 창 안에 조금이라도 걸친 칸까지
        best: float | None = None
        for start, m in self._buckets:
            if start > cutoff and (best is None or m > best):
                best = m
        return best


class LoopLag:
    """이벤트 루프 지연: tick_s 마다 잠들고, 늦게 깬 만큼(실제 경과 − tick_s)을 표본으로 둔다. 프로세스에 하나(작업 · 구역이 모두 같은 루프).
    label · context · logger 는 WARN 한 줄의 앞머리 · 그동안 무엇이 멈췄는지 · 로거(로그 지문이 프로세스마다 따로 묶인다)."""

    def __init__(
        self,
        *,
        label: str,
        context: str,
        logger: logging.Logger,
        tick_s: float = LOOP_TICK_S,
        stall_s: float = LOOP_STALL_S,
        warn_s: float = LOOP_WARN_S,
        warn_every_s: float = WARN_EVERY_S,
        mono: Callable[[], float] = time.monotonic,
    ) -> None:
        self.tick_s, self.stall_s, self.warn_s, self.warn_every_s = tick_s, stall_s, warn_s, warn_every_s
        self.label, self.context, self._log = label, context, logger
        self._mono = mono
        self.window = WindowMax(mono=mono)
        self.stalls = 0  # 누적(프로세스 시작 이후): 지연 ≥ stall_s 인 표본 수
        self._last_warn = float("-inf")

    def observe(self, lag_s: float) -> None:
        self.window.add(lag_s)
        if lag_s >= self.stall_s:
            self.stalls += 1
        if lag_s >= self.warn_s:
            now = self._mono()
            if now - self._last_warn >= self.warn_every_s:
                self._last_warn = now
                self._log.warning(
                    "%s event loop was blocked for %.1f s — %s (%d stall(s) >= %g s since start)",
                    self.label,
                    lag_s,
                    self.context,
                    self.stalls,
                    self.stall_s,
                )

    def max_s(self) -> float | None:
        return self.window.value()

    async def run(self) -> None:
        """취소될 때까지. 한 표본의 예상 밖 오류는 남기고 계속 잰다(진단이 일을 멈추지 않게 — main 은 이 태스크의 죽음을 기다리지 않는다)."""
        loop = asyncio.get_running_loop()
        while True:
            t0 = loop.time()
            await asyncio.sleep(self.tick_s)
            try:
                self.observe(max(0.0, loop.time() - t0 - self.tick_s))
            except Exception:  # noqa: BLE001 — 진단 오류로 태스크가 조용히 멈추지 않게(ERROR 로 남기고 계속)
                self._log.exception("%s loop lag sample failed", self.label)
