"""정리 태스크: 대기열의 원문을 파싱·검증해 ShipBook 에 반영하고 규칙별로 센다.

수신 태스크와 같은 이벤트 루프에서 돈다. 한 번에 최대 batch 건을 처리한 뒤 양보(sleep(0))해 수신·발행이 굶지 않게 한다.
공급자 오류 메시지({"error": ...})는 그 원문을 받은 구역(tag)과 함께 넘긴다 — 호출자가 비밀값을 가려 그 구역의 provider_error 로 남긴다.
지연 표본(처리 시각 - aisstream 수신 시각)도 구역별로 모은다(계약 v4 §D: 상태 해시 shards[].lag_p50_s).
"""

from __future__ import annotations

import asyncio
import logging
import statistics
import time
from collections import Counter, deque
from collections.abc import Callable

from wakeline_collector.ais.book import QUARANTINE_RULES, ShipBook
from wakeline_collector.ais.parse import parse_message
from wakeline_collector.ais.queue import Raw, RawQueue

log = logging.getLogger("ais.worker")

INVALID_REASONS = frozenset({"json", "shape", "type", "invalid_flag", "mmsi", "time", "position_range", "part"})
LAG_SAMPLES = 2048  # 구역마다


class Worker:
    def __init__(
        self,
        queue: RawQueue,
        book: ShipBook,
        *,
        wall: Callable[[], float] = time.time,
        on_provider_error: Callable[[int, str], None] | None = None,
        batch: int = 512,
    ) -> None:
        self.queue = queue
        self.book = book
        self._wall = wall
        self._on_provider_error = on_provider_error  # (구역 번호, 오류 문구)
        self.batch = batch
        self.counts: Counter[str] = Counter()  # 결과·거부 사유별 누적
        self.processed = 0
        self.quarantined_total = 0
        self.invalid_total = 0
        self._lag: dict[int, deque[float]] = {}  # 구역별로 받아들인 위치의 (처리 시각 - 수신 시각) 표본

    def handle(self, raw: Raw, tag: int = 0) -> None:
        self.processed += 1
        p = parse_message(raw)
        now = self._wall()
        if p.reject is not None:
            self.counts[p.reject] += 1
            if p.reject in INVALID_REASONS:
                self.invalid_total += 1
            elif p.reject == "provider_error" and self._on_provider_error is not None:
                self._on_provider_error(tag, p.error_text or "")
        if p.static is not None:
            r = self.book.apply_static(p.static, now)
            self.counts[f"static_{r}"] += 1
        if p.position is not None:
            r = self.book.apply_position(p.position, now)
            self.counts[r] += 1
            if r in QUARANTINE_RULES:
                self.quarantined_total += 1
            elif r == "accepted":
                lag = self._lag.get(tag)
                if lag is None:
                    lag = self._lag[tag] = deque(maxlen=LAG_SAMPLES)
                lag.append(now - p.position.t)

    def drain_nowait(self, limit: int) -> int:
        n = 0
        while n < limit:
            try:
                tag, raw = self.queue.get_tagged_nowait()
            except asyncio.QueueEmpty:
                break
            self.handle(raw, tag)
            n += 1
        return n

    def take_lag_p50(self) -> dict[int, float]:
        """직전 호출 이후 받아들인 위치의 지연(처리 시각 - aisstream 수신 시각) 중앙값(초), 구역별. 표본이 없는 구역은 빠진다."""
        out = {tag: statistics.median(samples) for tag, samples in self._lag.items() if samples}
        self._lag.clear()
        return out

    async def run(self) -> None:
        while True:
            tag, raw = await self.queue.get_tagged()
            try:
                self.handle(raw, tag)
                self.drain_nowait(self.batch - 1)
            except Exception:  # noqa: BLE001 — 메시지 하나의 예상 밖 오류가 정리 태스크를 죽이지 않게
                self.counts["worker_error"] += 1
                log.exception("ais worker: unexpected error while handling a message")
            await asyncio.sleep(0)
