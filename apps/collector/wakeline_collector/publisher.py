"""Redis Streams 발행. payload 는 gzip+base64 JSON.

트리밍(R-14 · ADR-017 §4):
- 항공기(wakeline:aircraft)·선박(wakeline:ships)은 개수가 아니라 시간으로 자른다: XADD MINID ~ (now − STREAM_RETENTION_S = 2.5 h).
  api 가 2 h 멈췄다 돌아와도(재기동·밀린 것 따라잡기 30분 여유) 그 사이 발행분을 모두 읽을 수 있다. 전에는 MAXLEN ~200
  (항공기 약 35분 · 선박 약 33분)이라 그보다 오래 멈추면 항적·선박 위치가 읽히기 전에 지워졌다.
- 메모리 상한: 이 프로세스가 보존 창 안에 발행한 바이트(필드 길이 합)가 STREAM_BUDGET_BYTES 를 넘으면 그 XADD 는 예산 안에 드는
  최신 항목 수로 MAXLEN ~ 을 건다(budget_trims 로 센다). 그때만 창이 2.5 h 보다 짧아진다.
  fixture 로 잰 항목 크기(측정: 관심 지역 127대 9.3 KB · 전세계 6,604대(합성) 448 KB · 선박 1척 49 B)로 본 api 정지 중 항공기 2.5 h 분량
  (관심 지역 10 s · 전세계 120 s — 수요 임대는 api 가 쓰므로 정지 중에는 focus·hot 이 없다)은 약 42 MB(관심 지역 500대면 약 66 MB)라
  예산 80 MiB 안이다. 운영 설정 최단 주기(5 s · 60 s)에 관심 지역이 크면 예산이 창을 약 2 h 로 줄인다. 선박은 10 s 마다 약 13 KB
  (ADR-014 실측: 200항목 2.5 MiB) → 2.5 h 약 12 MB, 예산 16 MiB. 두 스트림 합계 상한 96 MiB(Redis maxmemory 256 MB).
  수집기가 재시작하면 재시작 전 항목은 이 계산에 들어가지 않으므로, 창이 꽉 찬 채 재시작한 경우 최대 2.5 h 동안 두 배까지 남을 수 있다.
- MINID 기준 시각은 이 프로세스의 벽시계다. 스트림 ID 는 Redis 서버 시계로 매겨지지만 같은 호스트라 차이는 무시할 수 있다.
- SIGMET(300 s)·레이더(60 s)는 MAXLEN ~200 으로 이미 2 h 를 넘게 담는다(개수 트리밍 유지).

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
from collections.abc import Callable
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
MAXLEN = 200  # 개수 트리밍(SIGMET·레이더)
STREAM_RETENTION_S = 2.5 * 3600  # 시간 트리밍 보존 창(항공기·선박) — api 정지 2 h + 재기동·따라잡기 여유
STREAM_BUDGET_BYTES = {STREAM_AIRCRAFT: 80 * 2**20, STREAM_SHIPS: 16 * 2**20}  # 보존 창 안 발행 바이트 상한(메모리 상한)
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


class StreamTrim:
    """한 스트림의 시간 트리밍(MINID ~ now − retention) + 바이트 예산(넘으면 MAXLEN ~ n). 이 프로세스가 유일한 발행자일 때 쓴다."""

    def __init__(self, retention_s: float, budget_bytes: int, clock: Callable[[], float] = time.time):
        self.retention_s, self.budget_bytes, self._clock = retention_s, budget_bytes, clock
        self._sent: deque[tuple[float, int]] = deque()  # (발행 시각, 바이트) — 보존 창 안의 것만
        self._bytes = 0
        self.budget_trims = 0

    def _expire(self, cutoff: float) -> None:
        while self._sent and self._sent[0][0] < cutoff:
            self._bytes -= self._sent.popleft()[1]

    def xadd_args(self, size: int) -> dict[str, Any]:
        """이번 XADD 의 트리밍 인자. 보낸 뒤 record() 로 기록한다(실패한 XADD 는 세지 않는다)."""
        now = self._clock()
        cutoff = now - self.retention_s
        self._expire(cutoff)
        if self._bytes + size <= self.budget_bytes:
            return {"minid": int(cutoff * 1000), "approximate": True}
        keep, total = 1, size  # 새 항목 + 예산 안에 드는 최신 항목들
        for _t, n in reversed(self._sent):
            if total + n > self.budget_bytes:
                break
            keep, total = keep + 1, total + n
        self.budget_trims += 1
        return {"maxlen": keep, "approximate": True}

    def record(self, size: int, args: dict[str, Any]) -> None:
        self._sent.append((self._clock(), size))
        self._bytes += size
        keep = args.get("maxlen")
        while keep is not None and len(self._sent) > keep:
            self._bytes -= self._sent.popleft()[1]


class Publisher:
    def __init__(self, redis: Redis, *, clock: Callable[[], float] = time.time):
        self._r = redis
        self._clock = clock
        self._trims = {s: StreamTrim(STREAM_RETENTION_S, b, clock=lambda: self._clock()) for s, b in STREAM_BUDGET_BYTES.items()}
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
        trim = self._trims.get(stream)
        size = _size(fields)
        args = trim.xadd_args(size) if trim is not None else {"maxlen": MAXLEN, "approximate": True}
        sid = await self._r.xadd(stream, fields, **args)  # type: ignore[arg-type]
        if trim is not None:
            trim.record(size, args)
        return sid if isinstance(sid, str) else sid.decode()

    @property
    def queued(self) -> int:
        return len(self._queue)

    @property
    def budget_trims(self) -> dict[str, int]:
        """스트림별로 바이트 예산 때문에 보존 창보다 일찍 자른 XADD 수(heartbeat stream_budget_trims)."""
        return {s: t.budget_trims for s, t in self._trims.items()}
