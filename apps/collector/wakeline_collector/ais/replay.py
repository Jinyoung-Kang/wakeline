"""fixture 재생(계약 v2 §B1): fixtures/ais_east_asia_90s.jsonl(실수신 484건, 줄마다 `_recv_offset_s`)을 받은 간격 그대로 되풀이한다.

외부 호출 없음. 각 메시지의 MetaData.time_utc 를 '지금' 으로 바꿔 실시간 경로(대기열 → 정리 → 발행)를 그대로 태운다.
공급자 표시는 "fixture". 한 바퀴(≈ 90 s)가 끝나면 처음 위치로 돌아간다(선박이 조금 뒤로 이동해 보인다 — 재생 자료의 한계).
재생은 구역 하나다(계약 v4 §D) — 구독 영역이 없으므로 공백에 scope 를 붙이지 않는다.
"""

from __future__ import annotations

import asyncio
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any

import orjson

from wakeline_collector.ais.feed import FeedState
from wakeline_collector.ais.parse import go_time
from wakeline_collector.ais.queue import RawQueue

FIXTURE_NAME = "ais_east_asia_90s.jsonl"
MAX_FILE_BYTES = 8 * 1024 * 1024
MAX_LINES = 50_000


def load_fixture(path: Path) -> list[tuple[float, dict[str, Any]]]:
    """(offset_s, 메시지) 목록(오프셋 순). 크기·줄 수 상한, 잘못된 줄은 건너뛴다."""
    if path.stat().st_size > MAX_FILE_BYTES:
        raise ValueError(f"fixture larger than {MAX_FILE_BYTES} bytes: {path.name}")
    out: list[tuple[float, dict[str, Any]]] = []
    with path.open("rb") as f:
        for i, line in enumerate(f):
            if i >= MAX_LINES:
                break
            try:
                doc = orjson.loads(line)
            except orjson.JSONDecodeError:
                continue
            if not isinstance(doc, dict) or not isinstance(doc.get("MetaData"), dict):
                continue
            off = doc.pop("_recv_offset_s", 0.0)
            out.append((float(off) if isinstance(off, int | float) and off >= 0 else 0.0, doc))
    out.sort(key=lambda x: x[0])
    return out


class FixtureReplayer:
    def __init__(
        self,
        path: Path,
        queue: RawQueue,
        feed: FeedState,
        *,
        speed: float = 1.0,
        loop: bool = True,
        wall: Callable[[], float] = time.time,
        mono: Callable[[], float] = time.monotonic,
        tag: int = 0,
    ) -> None:
        if speed <= 0:
            raise ValueError("speed must be > 0")
        self.path, self.queue, self.feed = path, queue, feed
        self.speed, self.loop = speed, loop
        self._wall, self._mono = wall, mono
        self.tag = tag  # 대기열에 넣는 원문의 구역 번호
        self.rounds = 0

    async def run(self, stop: asyncio.Event) -> None:
        items = load_fixture(self.path)
        self.feed.on_subscribed(f"fixture:{self.path.name}", deflate=None, state="replaying")
        while not stop.is_set() and items:
            t0 = self._mono()
            for off, doc in items:
                delay = t0 + off / self.speed - self._mono()
                if delay > 0 and await _stopped_within(stop, delay):
                    return
                now = self._wall()
                out = {**doc, "MetaData": {**doc["MetaData"], "time_utc": go_time(now)}}
                self.queue.put(orjson.dumps(out), self.tag)
                self.feed.on_message(now)
            self.rounds += 1
            if not self.loop or await _stopped_within(stop, 1.0 / self.speed):
                return


async def _stopped_within(stop: asyncio.Event, delay: float) -> bool:
    try:
        await asyncio.wait_for(stop.wait(), timeout=delay)
        return True
    except TimeoutError:
        return False
