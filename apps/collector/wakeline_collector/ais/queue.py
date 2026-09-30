"""수신 → 정리 사이의 제한된 원문 대기열(계약 v2 §B1: 20,000건 + 바이트 상한).

수신 태스크는 파싱하지 않고 put 만 한다 — 절대 기다리지 않는다(aisstream 은 "계속 읽어라" 이며 재전송이 없다).
가득 차면(건수 또는 바이트) 가장 오래된 원문을 버리고 센다: 위치 보고는 곧 새 값으로 대체되므로 신선한 쪽을 남긴다.
바이트 상한은 비정상적으로 큰 메시지(프레임 상한 1 MiB)가 몰려도 메모리가 건수 × 1 MiB 로 커지지 않게 한다.
대기열은 모든 구역(연결)이 함께 쓴다. 원문마다 구역 번호(tag)를 붙여 정리 태스크가 지연·공급자 오류를 구역별로 가른다(계약 v4 §D).
진단(diag.py): 원문마다 넣은 시각(단조)을 함께 두고, 꺼낼 때 머문 시간 · 넣을 때 깊이의 최근 최댓값을 잰다(상태 해시 queue_wait_max_s ·
queue_depth_max) — 정리 태스크가 밀리는지(소비자 적체) 보인다. 머문 시간에는 지금 맨 앞(가장 오래 기다리는) 원문의 머문 시간도 넣는다 — 정리 태스크가
완전히 멈춰 아무것도 꺼내지 않을 때(적체가 가장 클 때) 모름이 되지 않게. 넘쳐 버린 원문은 소비되지 않았으므로 꺼낸 머문 시간에 넣지 않는다.
"""

from __future__ import annotations

import asyncio
import time
from collections.abc import Callable
from typing import Any

from wakeline_collector.ais.diag import WindowMax

Raw = bytes | str
Tagged = tuple[int, Raw]  # (구역 번호, 원문)
_Item = tuple[int, Raw, float]  # (구역 번호, 원문, 넣은 단조 시각)

DEFAULT_MAX_BYTES = 32 * 1024 * 1024  # 실측 메시지 ≈ 0.7 KiB × 20,000 ≈ 14 MiB 의 두 배 남짓


class _Fifo(asyncio.Queue[Any]):
    """맨 앞(가장 오래된) 항목을 볼 수 있는 asyncio.Queue. 저장소는 asyncio.Queue._init 이 만드는 deque(_queue) 다 — 표준 라이브러리가 하위 클래스용으로
    둔 자리(LifoQueue · PriorityQueue 도 _init · _put · _get 로 만든다). 고정한 판에서 맞는지는 test_ais_diag 가 지킨다."""

    def oldest(self) -> _Item | None:
        q = self._queue  # type: ignore[attr-defined]
        return q[0] if q else None  # type: ignore[no-any-return]


class RawQueue:
    def __init__(
        self, maxsize: int = 20_000, max_bytes: int = DEFAULT_MAX_BYTES, *, mono: Callable[[], float] = time.monotonic
    ) -> None:
        if maxsize < 1 or max_bytes < 1:
            raise ValueError("maxsize and max_bytes must be >= 1")
        self.maxsize = maxsize
        self.max_bytes = max_bytes
        self._q = _Fifo(maxsize)
        self.bytes = 0
        self.dropped = 0  # 누적(프로세스 시작 이후)
        self._mono = mono
        self._wait = WindowMax(mono=mono)  # 꺼낸 원문이 머문 시간(초)
        self._depth = WindowMax(mono=mono)  # 넣은 직후 깊이

    def wait_max_s(self) -> float | None:
        """최근 창(diag.DIAG_WINDOW_S)에 꺼낸 원문이 머문 시간과 지금 맨 앞 원문(가장 오래 기다리는 것)이 머문 시간 중 최댓값(초).
        정리 태스크가 멈춰 아무것도 꺼내지 않아도 커진다. 꺼낸 것도 기다리는 것도 없으면 None(모름)."""
        taken = self._wait.value()
        head = self._q.oldest()
        waiting = None if head is None else max(0.0, self._mono() - head[2])
        if taken is None or waiting is None:
            return waiting if taken is None else taken
        return max(taken, waiting)

    def depth_max(self) -> int | None:
        """최근 창에 넣은 직후 깊이의 최댓값. 넣은 것이 없으면 None."""
        v = self._depth.value()
        return None if v is None else int(v)

    def _drop_oldest(self) -> bool:
        try:
            _tag, old, _t = self._q.get_nowait()
        except asyncio.QueueEmpty:
            return False
        self.bytes -= len(old)
        self.dropped += 1
        return True

    def put(self, item: Raw, tag: int = 0) -> bool:
        """넣는다(기다리지 않음). 자리를 만들려고 오래된 것을 버렸으면 False."""
        size = len(item)
        if size > self.max_bytes:  # 상한보다 큰 원문 하나는 넣지 않는다(연결 상한 1 MiB 라 실제로는 오지 않음)
            self.dropped += 1
            return False
        clean = True
        while self._q.full() or (self.bytes + size > self.max_bytes and self._q.qsize() > 0):
            if not self._drop_oldest():  # pragma: no cover — 비어 있지 않은 큐에서는 일어나지 않는다
                break
            clean = False
        self._q.put_nowait((tag, item, self._mono()))
        self.bytes += size
        self._depth.add(self._q.qsize())
        return clean

    def _took(self, entry: _Item) -> Tagged:
        tag, item, t = entry
        self.bytes -= len(item)
        self._wait.add(self._mono() - t)
        return tag, item

    async def get_tagged(self) -> Tagged:
        return self._took(await self._q.get())

    def get_tagged_nowait(self) -> Tagged:
        return self._took(self._q.get_nowait())

    async def get(self) -> Raw:
        return (await self.get_tagged())[1]

    def get_nowait(self) -> Raw:
        return self.get_tagged_nowait()[1]

    def qsize(self) -> int:
        return self._q.qsize()
