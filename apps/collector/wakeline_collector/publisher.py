"""Redis Streams 발행. payload 는 gzip+base64 JSON.

트리밍(R-14 · ADR-017 §4):
- 항공기(wakeline:aircraft)·선박(wakeline:ships)은 개수가 아니라 시간으로 자른다: XADD MINID ~ (now − STREAM_RETENTION_S = 2.5 h).
  api 가 2 h 멈췄다 돌아와도(재기동·밀린 것 따라잡기 30분 여유) 그 사이 발행분을 모두 읽을 수 있다. 전에는 MAXLEN ~200
  (항공기 약 35분 · 선박 약 33분)이라 그보다 오래 멈추면 항적·선박 위치가 읽히기 전에 지워졌다.
- 메모리 상한: 이 프로세스가 보존 창 안에 발행한 바이트(필드 길이 합)가 STREAM_BUDGET_BYTES 를 넘으면 그 XADD 는 예산 안에 드는
  최신 항목 수로 MAXLEN ~ 을 건다(budget_trims 로 센다). 그때만 창이 2.5 h 보다 짧아진다.
  fixture 로 잰 항목 크기(측정: 관심 지역 127대 9.3 KB · 전세계 6,604대(합성) 448 KB · 선박 1척 49 B)로 본 api 정지 중 항공기 2.5 h 분량
  (관심 지역 10 s · 전세계 120 s — 수요 임대는 api 가 쓰므로 정지 중에는 focus·hot 이 없다)은 약 42 MB(관심 지역 500대면 약 66 MB)라
  예산 80 MiB 안이다(2026-09-29 운영 실측: 890항목 37.8 MB 로 2.5 h 전체). 운영 설정 최단 주기(5 s · 60 s)에 관심 지역이 크면 예산이
  창을 약 2 h 로 줄인다. 선박은 ADR-014 때 10 s 마다 약 13 KB(200항목 2.5 MiB)였으나 2026-09-29 운영 실측은 약 28.2 KB
  (597항목 · MEMORY USAGE 16,825,126 B)라 2.5 h(900항목)에 약 25.4 MB 가 든다 — 그때의 예산 16 MiB 는 창을 약 1.66 h 로 줄였다
  (ais stream_budget_trims 233). 그래서 선박 예산을 32 MiB 로 골랐다(선택값: 필요량이 예산의 약 76 %, MEMORY USAGE 기준이라
  필드 길이 합으로는 조금 더 남는다). 두 스트림 예산 합계 112 MiB(Redis maxmemory 256 MiB — 여유 계산은 ADR-011).
- 재시작: 이 Publisher 는 스트림에 처음 보내기 전 한 번 보존 창 안의 기존 항목을 최신부터 되읽어(XREVRANGE, 예산 + 한 항목까지)
  예산 계산에 넣는다(existing_entries · StreamTrim.seed). 전에는 재시작 전 항목이 계산에서 빠져, 예산이 창을 줄일 만큼 발행량이
  클 때 재시작하면 최대 2.5 h 동안 예산의 두 배까지 남았다(ADR-011: 두 스트림이 겹치면 maxmemory 를 넘는 최악). 선박 스트림의
  발행자(ais sink)는 읽기 권한이 없어(ACL: +xadd 뿐) 되읽지 않는다 — 선박은 여전히 재시작 뒤 최대 두 배(ADR-011 여유 계산에 넣었다).
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
from redis.exceptions import RedisError, ResponseError

from wakeline_collector.gz import gunzip_bounded

log = logging.getLogger("publisher")

STREAM_AIRCRAFT = "wakeline:aircraft"
STREAM_SIGMET = "wakeline:sigmet"
STREAM_RADAR = "wakeline:radar"
STREAM_SHIPS = "wakeline:ships"
MAXLEN = 200  # 개수 트리밍(SIGMET·레이더)
STREAM_RETENTION_S = 2.5 * 3600  # 시간 트리밍 보존 창(항공기·선박) — api 정지 2 h + 재기동·따라잡기 여유
# 보존 창 안 발행 바이트 상한(메모리 상한, 선택값). 선박 32 MiB: 실측 약 25.4 MB/2.5 h 위 여유(위 설명 · ADR-011)
STREAM_BUDGET_BYTES = {STREAM_AIRCRAFT: 80 * 2**20, STREAM_SHIPS: 32 * 2**20}
SEED_PAGE = 16  # 재시작 뒤 되읽기 한 번에 읽는 항목 수(항공기 전세계 항목 약 448 KB — 한 번에 약 7 MB 이하)
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
    """한 스트림의 시간 트리밍(MINID ~ now − retention) + 바이트 예산(넘으면 MAXLEN ~ n). 이 프로세스가 유일한 발행자일 때 쓴다.
    seeded: 재시작 전 항목을 계산에 넣었는지(seed) — 넣기 전에는 이 프로세스가 보낸 것만 센다."""

    def __init__(self, retention_s: float, budget_bytes: int, clock: Callable[[], float] = time.time):
        self.retention_s, self.budget_bytes, self._clock = retention_s, budget_bytes, clock
        self._sent: deque[tuple[float, int]] = deque()  # (발행 시각, 바이트) — 보존 창 안의 것만
        self._bytes = 0
        self.budget_trims = 0
        self.seeded = False

    def cutoff_ms(self) -> int:
        """지금 MINID 기준(보존 창 시작, 밀리초) — 되읽기도 이 경계 안의 항목만 센다."""
        return int((self._clock() - self.retention_s) * 1000)

    def seed(self, entries: list[tuple[float, int]]) -> None:
        """스트림에 이미 있던 항목(스트림 ID 시각 초, 바이트 — 오래된 것부터)을 계산 앞에 넣는다. 한 번만 부른다."""
        self.seeded = True
        self._sent.extendleft(reversed(entries))
        self._bytes += sum(n for _t, n in entries)

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


async def existing_entries(redis: Redis, stream: str, *, since_ms: int, budget_bytes: int) -> list[tuple[float, int]]:
    """재시작 직후 되읽기: 스트림의 최신 항목부터 거꾸로(XREVRANGE, SEED_PAGE 씩) 보존 창 시작(since_ms)까지, 또는 바이트 합이 예산을
    넘는 첫 항목까지(그 항목 포함 — 다음 XADD 가 예산으로 자르게, 그보다 오래된 것은 MAXLEN 이 함께 지운다) 읽어
    (스트림 ID 시각 초, 필드 길이 합)을 오래된 것부터 돌려준다. 읽는 양은 예산 + 한 항목 이하다."""
    out: list[tuple[float, int]] = []  # 최신 → 오래된
    total = 0
    hi = "+"
    while True:
        rows = await redis.xrevrange(stream, max=hi, min=str(since_ms), count=SEED_PAGE) or []
        for sid, fields in rows:
            sid_s = sid.decode() if isinstance(sid, bytes) else str(sid)
            n = sum(len(k) + len(v) for k, v in (fields or {}).items())  # _size 와 같다(bytes 응답이면 바이트 수)
            out.append((int(sid_s.split("-")[0]) / 1000, n))
            total += n
            if total > budget_bytes:
                return out[::-1]
        if len(rows) < SEED_PAGE:
            return out[::-1]
        last = rows[-1][0]
        hi = "(" + (last.decode() if isinstance(last, bytes) else str(last))  # 배타 경계(Redis 6.2+)


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

    async def _seed(self, stream: str, trim: StreamTrim) -> None:
        """이 스트림에 처음 보내기 전 한 번: 재시작 전 항목을 바이트 예산 계산에 넣는다(ADR-011 Redis 여유 — 재시작해도 예산의 두 배가
        남지 않게). Redis 연결 오류는 올린다(발행이 로컬 큐로 가고 다음 발행에서 다시 되읽는다). 명령 거부(NOPERM 등 ResponseError)는
        경고 한 번 뒤 되읽지 않고 예전처럼 이 프로세스가 보낸 것만 센다 — 발행은 막지 않는다."""
        try:
            got = await existing_entries(self._r, stream, since_ms=trim.cutoff_ms(), budget_bytes=trim.budget_bytes)
        except ResponseError as e:
            trim.seed([])
            log.warning(
                "%s: entries from before this start not counted toward the byte budget (%s) — up to 2x the budget may stay"
                " for one retention window",
                stream,
                type(e).__name__,
            )
            return
        trim.seed(got)
        if got:
            log.info(
                "%s: counted %d entries (%d B) already in the stream toward the byte budget (%d B)",
                stream,
                len(got),
                sum(n for _t, n in got),
                trim.budget_bytes,
            )

    async def _xadd(self, stream: str, fields: dict[str, str]) -> str:
        trim = self._trims.get(stream)
        if trim is not None and not trim.seeded:
            await self._seed(stream, trim)
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

    def stream_limits(self, stream: str) -> tuple[float, int] | None:
        """(보존 창 목표 초, 바이트 예산) — 이 Publisher 가 그 스트림에 실제로 거는 설정. 개수 트리밍 스트림이면 None.
        heartbeat stream_retention_s · stream_budget_bytes 의 원천(설정값 — 잰 값이 아니다)."""
        t = self._trims.get(stream)
        return None if t is None else (t.retention_s, t.budget_bytes)


def limit_fields(limits: tuple[float, int] | None) -> dict[str, str]:
    """상태 해시 필드 계약: stream_retention_s(시간 트림 목표, 정수 초) · stream_budget_bytes(바이트 예산) — 정수 문자열.
    시간 트림 스트림이 아니면(None) 빈 값 = 모름(0 으로 채우지 않는다)."""
    if limits is None:
        return {"stream_retention_s": "", "stream_budget_bytes": ""}
    retention_s, budget_bytes = limits
    return {"stream_retention_s": f"{retention_s:.0f}", "stream_budget_bytes": str(int(budget_bytes))}
