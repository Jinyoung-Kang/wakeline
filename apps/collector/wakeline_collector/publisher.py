"""Redis Streams 발행. payload 는 gzip+base64 JSON. MAXLEN ~ 200.

XADD 실패 시 로컬 큐(최대 1,000건 · 64 MB)에 보관하고 다음 발행 때 순서대로 재전송한다. 상한을 넘으면 가장 오래된 것부터 버린다(건수 집계).
모든 작업(region·global·focus·hot·sigmet·radar)이 한 Publisher 를 같은 이벤트 루프에서 공유하므로, 큐 비우기와 전송은
asyncio.Lock 으로 직렬화한다(COL-1: 동시 호출이 같은 항목을 두 번 보내거나 남의 항목을 꺼내던 경쟁). 순서 보장도 이 락에 기댄다.
"""

from __future__ import annotations

import asyncio
import base64
import gzip
import logging
import time
from collections import deque
from datetime import UTC, datetime
from typing import Any

import orjson
from redis.asyncio import Redis
from redis.exceptions import RedisError

from wakeline_collector.gz import gunzip_bounded

log = logging.getLogger("publisher")

STREAM_AIRCRAFT = "wakeline:aircraft"
STREAM_SIGMET = "wakeline:sigmet"
STREAM_RADAR = "wakeline:radar"
STREAM_SHIPS = "wakeline:ships"
MAXLEN = 200
QUEUE_MAX = 1000
QUEUE_MAX_BYTES = 64 * 1024 * 1024
PAYLOAD_MAX_BYTES = 64 * 1024 * 1024  # decode_payload 해제 상한


def encode_payload(obj: Any) -> str:
    raw = orjson.dumps(obj, option=orjson.OPT_UTC_Z)
    return base64.b64encode(gzip.compress(raw, compresslevel=5)).decode("ascii")


def decode_payload(s: str) -> Any:
    """encode_payload 의 역. 스트림에서 되읽을 때(마지막 발행분 복원) 쓴다."""
    return orjson.loads(gunzip_bounded(base64.b64decode(s, validate=True), PAYLOAD_MAX_BYTES))


def _size(fields: dict[str, str]) -> int:
    return sum(len(k) + len(v) for k, v in fields.items())


class Publisher:
    def __init__(self, redis: Redis):
        self._r = redis
        self._queue: deque[tuple[str, dict[str, str], int]] = deque()
        self._queued_bytes = 0
        self._lock = asyncio.Lock()  # 큐 비우기 + 전송 직렬화(COL-1)
        self._last_log = 0.0
        self.dropped = 0  # 로컬 큐 상한으로 버린 건수

    def _warn(self, msg: str, *args: object) -> None:
        now = time.monotonic()
        if now - self._last_log > 60:
            self._last_log = now
            log.warning(msg, *args)

    def envelope(
        self,
        *,
        kind: str,
        scope: str,
        provider: str,
        fetched_at: datetime,
        raw_ref: str,
        count: int,
        payload: Any,
        run_id: str | None = None,
    ) -> dict[str, str]:
        env = {
            "schema_version": "1",
            "kind": kind,
            "scope": scope,
            "provider": provider,
            "fetched_at": fetched_at.astimezone(UTC).isoformat().replace("+00:00", "Z"),
            "raw_ref": raw_ref,
            "encoding": "gzip+base64",
            "count": str(count),
            "payload": encode_payload(payload),
        }
        if run_id is not None:
            env["run_id"] = run_id
        return env

    def _enqueue(self, stream: str, fields: dict[str, str]) -> None:
        size = _size(fields)
        while self._queue and (len(self._queue) >= QUEUE_MAX or self._queued_bytes + size > QUEUE_MAX_BYTES):
            _s, _f, n = self._queue.popleft()
            self._queued_bytes -= n
            self.dropped += 1
        if size > QUEUE_MAX_BYTES:
            self.dropped += 1
            return
        self._queue.append((stream, fields, size))
        self._queued_bytes += size

    async def publish(self, stream: str, fields: dict[str, str]) -> str | None:
        """발행. 반환값은 스트림 ID(바로 보냈을 때) 또는 None(로컬 큐에 보관)."""
        async with self._lock:
            # 먼저 밀린 큐를 비운다(순서 보존). 락 안이라 머리 항목을 읽은 코루틴만 그것을 꺼낸다.
            while self._queue:
                s, f, n = self._queue[0]
                try:
                    await self._xadd(s, f)
                except (RedisError, OSError):
                    break
                self._queue.popleft()
                self._queued_bytes -= n
            if self._queue:
                # Redis 가 아직 안 되면 새 항목은 바로 큐 뒤로(순서 보존)
                self._enqueue(stream, fields)
                self._warn("xadd pending; queued %d (%d B, dropped %d)", len(self._queue), self._queued_bytes, self.dropped)
                return None
            try:
                return await self._xadd(stream, fields)
            except (RedisError, OSError) as e:
                self._enqueue(stream, fields)
                self._warn("xadd failed (%s); queued %d", type(e).__name__, len(self._queue))
                return None

    async def _xadd(self, stream: str, fields: dict[str, str]) -> str:
        sid = await self._r.xadd(stream, fields, maxlen=MAXLEN, approximate=True)  # type: ignore[arg-type]
        return sid if isinstance(sid, str) else sid.decode()

    @property
    def queued(self) -> int:
        return len(self._queue)
