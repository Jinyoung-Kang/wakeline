"""구역마다 aisstream 연결 하나(계약 v4 §D, ADR-014 부록 B).

실측: 같은 범위를 한 연결로 받으면 공급자 쪽 지연이 쌓여 끊기고(6시간 51회), 두 연결로 나누면 p50 약 2 s · 끊김 0.
- 구역 i = AisStreamClient 하나(각자 Backoff · FeedState · idle 기한 · 재구독 제한). 대기열·정리·ShipBook·발행은 함께 쓴다.
- 설정(ShardsState)이 바뀌면 맞춘다: 같은 순번 구역의 상자만 바뀌면 **그 연결에서** 재구독(5 s 제한), 구역이 늘면 새 연결,
  줄면 뒤쪽 구역의 연결을 닫는다(닫는 동안 기다리지 않는다 — 종료 요청이 오면 모두 함께 닫는다).
  닫는 중인 연결도 키당 연결 수(3)에 세므로, 줄인 직후 다시 늘리면 새 연결은 닫기가 끝난 뒤에 연다.
- 연결 태스크가 예상 밖으로 끝나면(예외) 이 태스크도 끝난다 — 진입점이 나머지를 정리하고 1 로 끝낸다(compose 가 다시 띄운다).
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Callable
from typing import Any

from wakeline_collector.ais.backoff import Backoff
from wakeline_collector.ais.bbox import MAX_SHARDS, BBox, BboxState, Shards, ShardsState, format_bboxes
from wakeline_collector.ais.client import AIS_URL, AisStreamClient, check_url
from wakeline_collector.ais.queue import RawQueue
from wakeline_collector.ais.shards import Shard, ShardSet

log = logging.getLogger("ais.pool")


class AisStreamPool:
    def __init__(
        self,
        *,
        api_key: str,
        queue: RawQueue,
        shards: ShardSet,
        desired: ShardsState,
        backoff_factory: Callable[[], Backoff] = Backoff,
        **client_kw: Any,
    ) -> None:
        check_url(client_kw.get("url", AIS_URL))  # 연결 태스크를 띄우기 전에 설정 오류를 드러낸다
        if not api_key:
            raise ValueError("API key is required")
        self._key = api_key
        self.queue, self.shards, self.desired = queue, shards, desired
        self._backoff_factory = backoff_factory
        self._client_kw = client_kw

    def _start(self, boxes: tuple[BBox, ...], *, restore: bool) -> Shard:
        shard = self.shards.add(format_bboxes(boxes), restore=restore)
        shard.bboxes = BboxState(boxes)
        client = AisStreamClient(
            api_key=self._key,
            queue=self.queue,
            feed=shard.feed,
            bboxes=shard.bboxes,
            backoff=self._backoff_factory(),
            tag=shard.id,
            label=shard.label,
            **self._client_kw,
        )
        shard.task = asyncio.create_task(client.run(shard.stop), name=f"ais-{shard.label.replace(' ', '-')}")
        return shard

    def _reconcile(self, target: Shards) -> None:
        """설정에 맞춘다. 새 연결은 닫는 중인 연결까지 세어 키당 3개 안에서만 연다 — 나머지는 닫기가 끝난 뒤(run 이 다시 부른다)."""
        current = list(self.shards.active)
        for shard, boxes in zip(current, target, strict=False):
            if shard.bboxes is not None and shard.bboxes.set(boxes):
                log.info("ais %s boxes changed → resubscribing on the same connection", shard.label)
        room = max(0, MAX_SHARDS - len(current) - len(self.shards.closing))
        for boxes in target[len(current) :][:room]:
            s = self._start(boxes, restore=False)
            log.info("ais %s added: bbox=%s", s.label, format_bboxes(boxes))
        for shard in current[len(target) :]:
            shard.stop.set()
            self.shards.begin_closing(shard)
            log.info("ais %s removed — closing its connection", shard.label)

    def _reap(self) -> None:
        for shard in list(self.shards.closing):
            if shard.task is None or shard.task.done():
                if shard.task is not None and not shard.task.cancelled() and shard.task.exception() is not None:
                    log.warning("ais %s ended with %r while closing", shard.label, shard.task.exception())
                self.shards.retire(shard)
        for shard in self.shards.active:
            if shard.task is not None and shard.task.done():
                exc = None if shard.task.cancelled() else shard.task.exception()
                raise RuntimeError(f"ais {shard.label} connection task ended unexpectedly") from exc

    async def _close_all(self) -> None:
        shards = [*self.shards.active, *self.shards.closing]
        for s in shards:
            s.stop.set()
        await asyncio.gather(*(s.task for s in shards if s.task is not None), return_exceptions=True)
        for s in list(self.shards.closing):
            self.shards.retire(s)

    async def run(self, stop: asyncio.Event) -> None:
        target, version = self.desired.snapshot()
        for boxes in target:
            self._start(boxes, restore=True)  # 기동 때 만든 구역만 이전 실행의 공백을 잇는다
        try:
            while not stop.is_set():
                change = asyncio.ensure_future(self.desired.wait_change(version))
                stopper = asyncio.ensure_future(stop.wait())
                tasks = [s.task for s in (*self.shards.active, *self.shards.closing) if s.task is not None]
                try:
                    await asyncio.wait([change, stopper, *tasks], return_when=asyncio.FIRST_COMPLETED)
                finally:
                    change.cancel()
                    stopper.cancel()
                if stop.is_set():
                    break
                self._reap()
                target, new_version = self.desired.snapshot()
                if new_version != version or len(self.shards.active) != len(target):  # 미룬 새 연결도 여기서
                    version = new_version
                    self._reconcile(target)
        finally:
            await self._close_all()
