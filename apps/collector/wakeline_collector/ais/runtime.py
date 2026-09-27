"""런타임 구독 영역: Redis 해시 wakeline:settings 의 ais_bboxes(운영 API 가 씀, 이 프로세스는 읽기 전용)를 30 s 마다 읽는다.

값이 없거나 비면 환경변수 기본값(AIS_BBOXES). 형식이 틀리면 무시하고 현재 구독을 유지한다(분당 1회 경고).
Redis 오류도 현재 구독 유지. 바뀐 값은 BboxState 로 넘기고, 연결 세션이 5 s 속도 제한 안에서 구독을 다시 보낸다.
"""

from __future__ import annotations

import asyncio
import logging
import time

from redis.asyncio import Redis

from wakeline_collector.ais.bbox import BBox, BboxState, format_bboxes, parse_bboxes

log = logging.getLogger("ais.settings")

SETTINGS_KEY = "wakeline:settings"
FIELD = "ais_bboxes"
REFRESH_S = 30.0


class BboxWatcher:
    def __init__(self, redis: Redis, bboxes: BboxState, default: tuple[BBox, ...], *, interval_s: float = REFRESH_S) -> None:
        self._r = redis
        self.bboxes = bboxes
        self.default = default
        self.interval_s = interval_s
        self.invalid = 0
        self.errors = 0
        self._last_warn = 0.0

    def _warn(self, msg: str, *args: object) -> None:
        now = time.monotonic()
        if now - self._last_warn > 60:
            self._last_warn = now
            log.warning(msg, *args)

    async def refresh(self) -> str:
        """결과: changed · same · invalid · error."""
        try:
            raw = await self._r.hget(SETTINGS_KEY, FIELD)
        except Exception as e:  # noqa: BLE001 — Redis 장애 시 현재 구독 유지
            self.errors += 1
            self._warn("ais_bboxes refresh failed (%s) — keeping current subscription", type(e).__name__)
            return "error"
        text = raw.decode() if isinstance(raw, bytes) else raw
        if not text or not text.strip():
            target = self.default
        else:
            try:
                target = parse_bboxes(text)
            except ValueError as e:
                self.invalid += 1
                self._warn("ignoring invalid runtime ais_bboxes (%s) — keeping current subscription", str(e)[:120])
                return "invalid"
        if self.bboxes.set(target):
            log.info("ais bbox setting changed → %s", format_bboxes(target))
            return "changed"
        return "same"

    async def run(self, stop: asyncio.Event) -> None:
        while not stop.is_set():
            await self.refresh()
            try:
                await asyncio.wait_for(stop.wait(), timeout=self.interval_s)
            except TimeoutError:
                continue
