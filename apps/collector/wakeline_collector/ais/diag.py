"""수신 진단 — keepalive 1011(ping 시간 초과) 끊김의 원인을 다음번에 가릴 수 있게 재는 값(ADR-014 부록 C).

1011 을 내는 기제는 셋이다(tests/test_ais_keepalive.py 로 재현):
  1. 이벤트 루프 멈춤(루프 위 CPU 작업 · 프로세스가 멈춤) — ping 이 나가 있는 동안 시간 초과보다 길면 1011 이 날 수 있다(버퍼 크기와 상관없다).
     늘 나지는 않는다: 멈춤이 끝난 뒤 pong 을 읽는 콜백과 시간 초과 콜백의 순서에 달린다(연결마다 다를 수 있다). → LoopLag(loop_lag_max_s · loop_stalls_total)
  2. 소켓을 읽는 코드가 멈춤 — websockets 수신 버퍼가 max_queue 를 넘으면 읽기를 멈춰 pong 도 못 읽는다. 우리 수신 태스크는 기다리지 않으므로
     곧 비운다. 버퍼가 상한을 넘는 것 자체는 결함이 아니다 — 한 번 읽기에 프레임이 많이 든 묶음(공급자 적체 해소 · 망이 잠깐 끊겼다 이어짐)이나 루프
     멈춤 뒤에 잠깐 넘는다(test_ais_diag). → 구역별 ws 수신 버퍼 깊이(ws_queue_max, client._read) · 원문 대기열 머문 시간(queue_wait_max_s, RawQueue)
  3. 서버·망이 pong 을 늦게 보냄(공급자 쪽 연결별 적체 — VERIFICATION #17) → 구역별 keepalive 왕복(ping_rtt_max_s) · 공급자 지연(lag_p50_s)

모두 '최근 창의 최댓값' 이다. 표본이 없으면 None(상태 해시 "" — 모름, 0 으로 채우지 않는다).

고른 값(잰 값이 아니다):
- DIAG_WINDOW_S 60 s: 최근 최댓값의 창. keepalive 한 번(ping 20 s 간격 + 시간 초과 20 s = 40 s)을 덮고, 상태 해시 쓰기(5 s)를 몇 번 놓쳐도 남는다.
- BUCKET_S 5 s: 창을 12칸으로 나눈다 — 값마다 칸 13개(시작 시각·최댓값)만 들고 있다(메모리 상한). 창 경계는 칸 단위라 최대 65 s 까지 본다.
- LOOP_TICK_S 0.5 s: 루프 지연 표본 간격(sleep 이 늦게 깬 만큼이 지연). 1 s 멈춤을 놓치지 않고, 깨우는 비용은 초당 2번.
- LOOP_STALL_S 1.0 s: loop_stalls_total 로 세는 지연. 우리 코드의 루프 위 작업은 잰 최악이 약 0.1 s(M1, 선박 2만 척을 한 번에 발행하는
  꺼내기 56 ms + 인코딩 56 ms · 정리 512건 묶음 20 ms — 2026-09-30 측정) — 그 10배.
- LOOP_WARN_S 5.0 s: WARN 으로 알리는 지연 — keepalive 시간 초과 20 s 의 1/4. 분당 1번까지(수는 모두 센다).
"""

from __future__ import annotations

import asyncio
import logging
import math
import time
from collections import deque
from collections.abc import Callable

log = logging.getLogger("ais.diag")

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
    """이벤트 루프 지연: tick_s 마다 잠들고, 늦게 깬 만큼(실제 경과 − tick_s)을 표본으로 둔다. 프로세스에 하나(구역이 모두 같은 루프)."""

    def __init__(
        self,
        *,
        tick_s: float = LOOP_TICK_S,
        stall_s: float = LOOP_STALL_S,
        warn_s: float = LOOP_WARN_S,
        mono: Callable[[], float] = time.monotonic,
    ) -> None:
        self.tick_s, self.stall_s, self.warn_s = tick_s, stall_s, warn_s
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
            if now - self._last_warn >= WARN_EVERY_S:
                self._last_warn = now
                log.warning(
                    "ais event loop was blocked for %.1f s — nothing was read meanwhile; a keepalive ping outstanding across a stall "
                    "longer than its timeout can end in 1011 (%d stall(s) >= %g s since start)",
                    lag_s,
                    self.stalls,
                    self.stall_s,
                )

    def max_s(self) -> float | None:
        return self.window.value()

    async def run(self) -> None:
        """취소될 때까지. 한 표본의 예상 밖 오류는 남기고 계속 잰다(진단이 수신을 멈추지 않게 — main 은 이 태스크의 죽음을 기다리지 않는다)."""
        loop = asyncio.get_running_loop()
        while True:
            t0 = loop.time()
            await asyncio.sleep(self.tick_s)
            try:
                self.observe(max(0.0, loop.time() - t0 - self.tick_s))
            except Exception:  # noqa: BLE001 — 진단 오류로 태스크가 조용히 멈추지 않게(ERROR 로 남기고 계속)
                log.exception("ais loop lag sample failed")
