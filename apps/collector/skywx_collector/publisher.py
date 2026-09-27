"""Redis Streams 발행. payload 는 gzip+base64 JSON. MAXLEN ~ 200. XADD 실패 시 로컬 큐(최대 1,000)에 보관 후 재전송."""

from __future__ import annotations

import base64
import gzip
import logging
from collections import deque
from datetime import UTC, datetime
from typing import Any

import orjson
from redis.asyncio import Redis
from redis.exceptions import RedisError

log = logging.getLogger("publisher")

STREAM_AIRCRAFT = "skywx:aircraft"
STREAM_SIGMET = "skywx:sigmet"
STREAM_RADAR = "skywx:radar"
MAXLEN = 200


def encode_payload(obj: Any) -> str:
    raw = orjson.dumps(obj, option=orjson.OPT_UTC_Z)
    return base64.b64encode(gzip.compress(raw, compresslevel=5)).decode("ascii")


class Publisher:
    def __init__(self, redis: Redis):
        self._r = redis
        self._queue: deque[tuple[str, dict[str, str]]] = deque(maxlen=1000)

    def envelope(
        self, *, kind: str, scope: str, provider: str, fetched_at: datetime, raw_ref: str, count: int, run_id: str, payload: Any
    ) -> dict[str, str]:
        return {
            "schema_version": "1",
            "kind": kind,
            "scope": scope,
            "provider": provider,
            "fetched_at": fetched_at.astimezone(UTC).isoformat().replace("+00:00", "Z"),
            "raw_ref": raw_ref,
            "encoding": "gzip+base64",
            "count": str(count),
            "run_id": run_id,
            "payload": encode_payload(payload),
        }

    async def publish(self, stream: str, fields: dict[str, str]) -> str | None:
        # 먼저 밀린 큐를 비운다(순서 보존)
        while self._queue:
            s, f = self._queue[0]
            try:
                await self._r.xadd(s, f, maxlen=MAXLEN, approximate=True)
                self._queue.popleft()
            except RedisError:
                break
        try:
            return await self._r.xadd(stream, fields, maxlen=MAXLEN, approximate=True)
        except RedisError as e:
            self._queue.append((stream, fields))
            log.warning("xadd failed (%s); queued %d", type(e).__name__, len(self._queue))
            return None

    @property
    def queued(self) -> int:
        return len(self._queue)
