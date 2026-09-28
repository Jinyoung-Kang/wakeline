"""수신 → 정리 사이의 제한된 원문 대기열(계약 v2 §B1: 20,000건 + 바이트 상한).

수신 태스크는 파싱하지 않고 put 만 한다 — 절대 기다리지 않는다(aisstream 은 "계속 읽어라" 이며 재전송이 없다).
가득 차면(건수 또는 바이트) 가장 오래된 원문을 버리고 센다: 위치 보고는 곧 새 값으로 대체되므로 신선한 쪽을 남긴다.
바이트 상한은 비정상적으로 큰 메시지(프레임 상한 1 MiB)가 몰려도 메모리가 건수 × 1 MiB 로 커지지 않게 한다.
대기열은 모든 구역(연결)이 함께 쓴다. 원문마다 구역 번호(tag)를 붙여 정리 태스크가 지연·공급자 오류를 구역별로 가른다(계약 v4 §D).
"""

from __future__ import annotations

import asyncio

Raw = bytes | str
Tagged = tuple[int, Raw]  # (구역 번호, 원문)

DEFAULT_MAX_BYTES = 32 * 1024 * 1024  # 실측 메시지 ≈ 0.7 KiB × 20,000 ≈ 14 MiB 의 두 배 남짓


class RawQueue:
    def __init__(self, maxsize: int = 20_000, max_bytes: int = DEFAULT_MAX_BYTES) -> None:
        if maxsize < 1 or max_bytes < 1:
            raise ValueError("maxsize and max_bytes must be >= 1")
        self.maxsize = maxsize
        self.max_bytes = max_bytes
        self._q: asyncio.Queue[Tagged] = asyncio.Queue(maxsize)
        self.bytes = 0
        self.dropped = 0  # 누적(프로세스 시작 이후)

    def _drop_oldest(self) -> bool:
        try:
            _tag, old = self._q.get_nowait()
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
        self._q.put_nowait((tag, item))
        self.bytes += size
        return clean

    async def get_tagged(self) -> Tagged:
        tag, item = await self._q.get()
        self.bytes -= len(item)
        return tag, item

    def get_tagged_nowait(self) -> Tagged:
        tag, item = self._q.get_nowait()
        self.bytes -= len(item)
        return tag, item

    async def get(self) -> Raw:
        return (await self.get_tagged())[1]

    def get_nowait(self) -> Raw:
        return self.get_tagged_nowait()[1]

    def qsize(self) -> int:
        return self._q.qsize()
