"""발행 태스크 — 이 프로세스에서 Redis 에 쓰는 유일한 곳(수신·정리 태스크는 Redis 를 기다리지 않는다).

- 10 s 마다 바뀐 선박만 `wakeline:ships` 로 XADD(kind "ships", scope "ships"). 한 엔트리에 선박·정적 정보를 각각 최대 CHUNK 건,
  넘으면 part/parts 로 나눈다.
- 닫힌 공백은 다음 틱(≤ 1 s)에 XADD(kind "ais_gap").
- 상태 해시 `wakeline:ais:status` 는 5 s 마다 + 상태가 바뀔 때. updated_at 은 프로세스가 살아 있다는 heartbeat(헬스체크가 본다).

Redis 장애: 선박 변경분은 쌓지 않고 ShipBook 에 '바뀜' 표시를 되돌린다 — 복구 뒤 첫 발행이 그때의 최신값을 싣는다(메모리는 선박 수 상한 안).
공백 이벤트는 순서대로 최대 1,000건 보관했다가 다시 보낸다(api 는 (source, started_at) 유일키로 중복을 막는다).
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import Callable
from datetime import UTC, datetime
from typing import Any

from redis.asyncio import Redis
from redis.exceptions import RedisError

from wakeline_collector.ais.book import ShipBook
from wakeline_collector.ais.feed import FeedState
from wakeline_collector.ais.parse import iso_ms
from wakeline_collector.ais.queue import RawQueue
from wakeline_collector.ais.worker import Worker
from wakeline_collector.masking import mask
from wakeline_collector.publisher import MAXLEN, STREAM_SHIPS, Publisher

log = logging.getLogger("ais.sink")

STATUS_KEY = "wakeline:ais:status"
CHUNK = 5000
STATUS_EVERY_S = 5.0
STATUS_MIN_GAP_S = 0.5
TICK_S = 1.0
ERROR_TEXT_MAX = 300


def _iso(epoch: float | None) -> str:
    return iso_ms(epoch) if epoch is not None else ""


class AisSink:
    def __init__(
        self,
        redis: Redis,
        *,
        book: ShipBook,
        feed: FeedState,
        worker: Worker,
        queue: RawQueue,
        provider: str,
        raw_ref: str,
        flush_s: float = 10.0,
        redact: Callable[[str], str] | None = None,
        wall: Callable[[], float] = time.time,
        mono: Callable[[], float] = time.monotonic,
    ) -> None:
        self._r = redis
        self.book, self.feed, self.worker, self.queue = book, feed, worker, queue
        self.provider, self.raw_ref, self.flush_s = provider, raw_ref, flush_s
        self._redact = redact or (lambda s: mask(s) or "")
        self._wall, self._mono = wall, mono
        self._env = Publisher(redis)  # envelope 형식(gzip+base64 JSON)만 빌려 쓴다 — 이 Publisher 의 로컬 큐는 쓰지 않는다
        self._last_warn = 0.0
        self._prev_flush = (mono(), 0, 0, 0, 0)  # 직전 창 끝: (mono, msgs, dropped, quarantined, invalid)
        self._last_status = float("-inf")
        self.msgs_per_s: float | None = None
        self.lag_p50_s: float | None = None
        self.published_entries = 0
        self.published_ships = 0
        self.publish_errors = 0
        self.status_errors = 0
        self.last_publish_at: float | None = None

    def _warn(self, msg: str, *args: object) -> None:
        now = self._mono()
        if now - self._last_warn > 60:
            self._last_warn = now
            log.warning(msg, *args)

    # ── 선박 변경분 ──────────────────────────────────────────────

    def _window(self) -> dict[str, Any]:
        """직전 발행 틱 이후의 건수(이번 창)."""
        now = self._mono()
        cur = (now, self.feed.msgs_total, self.queue.dropped, self.worker.quarantined_total, self.worker.invalid_total)
        prev, self._prev_flush = self._prev_flush, cur
        span = max(1e-3, cur[0] - prev[0])
        msgs = cur[1] - prev[1]
        self.msgs_per_s = msgs / span
        self.lag_p50_s = self.worker.take_lag_p50()
        return {
            "msgs": msgs,
            "msgs_per_s": round(self.msgs_per_s, 2),
            "dropped": cur[2] - prev[2],
            "quarantined": cur[3] - prev[3],
            "invalid": cur[4] - prev[4],
            "window_s": round(span, 1),
            "connected": self.feed.connected,
            "bbox": self.feed.bbox,
            "ships_tracked": len(self.book),
            "queue_depth": self.queue.qsize(),
        }

    async def flush(self) -> int:
        """바뀐 선박을 발행한다. 반환: 보낸 XADD 수."""
        stats = self._window()
        self.book.evict()
        states, statics = self.book.drain()
        if not states and not statics:
            return 0
        parts = max(1, -(-len(states) // CHUNK), -(-len(statics) // CHUNK))
        now = self._wall()
        fetched = datetime.fromtimestamp(now, UTC)
        sent = 0
        for i in range(parts):
            ships, static = states[i * CHUNK : (i + 1) * CHUNK], statics[i * CHUNK : (i + 1) * CHUNK]
            payload = {"ships": ships, "static": static, "stats": stats, "part": i + 1, "parts": parts}
            env = self._env.envelope(
                kind="ships",
                scope="ships",
                provider=self.provider,
                fetched_at=fetched,
                raw_ref=self.raw_ref,
                count=len(ships),
                payload=payload,
            )
            try:
                await self._r.xadd(STREAM_SHIPS, env, maxlen=MAXLEN, approximate=True)  # type: ignore[arg-type]
            except (RedisError, OSError) as e:
                rest_s = [s["mmsi"] for s in states[i * CHUNK :]]
                rest_t = [s["mmsi"] for s in statics[i * CHUNK :]]
                self.book.mark_dirty(rest_s, rest_t)
                self.publish_errors += 1
                self._warn("ships xadd failed (%s) — %d ships kept for the next flush", type(e).__name__, len(rest_s))
                break
            sent += 1
            self.published_entries += 1
            self.published_ships += len(ships)
            self.last_publish_at = now
        return sent

    # ── 공백 ─────────────────────────────────────────────────────

    async def publish_gaps(self) -> int:
        pending = self.feed.gaps.pending
        n = 0
        while pending:
            ev = pending[0]
            env = self._env.envelope(
                kind="ais_gap",
                scope="ships",
                provider=self.provider,
                fetched_at=datetime.fromtimestamp(self._wall(), UTC),
                raw_ref=self.raw_ref,
                count=1,
                payload=ev,
            )
            try:
                await self._r.xadd(STREAM_SHIPS, env, maxlen=MAXLEN, approximate=True)  # type: ignore[arg-type]
            except (RedisError, OSError) as e:
                self.publish_errors += 1
                self._warn("ais_gap xadd failed (%s) — %d gap event(s) pending", type(e).__name__, len(pending))
                break
            pending.popleft()
            n += 1
            log.info("ais gap published: %s → %s (%s)", ev["started_at"], ev["ended_at"], ev["reason"])
        return n

    # ── 상태 해시 ────────────────────────────────────────────────

    def status_fields(self) -> dict[str, str]:
        f, g, w = self.feed, self.feed.gaps, self.worker
        last = g.last or {}
        return {
            "provider": self.provider,
            "fixture": "1" if self.provider == "fixture" else "0",
            "state": f.state,
            "connected": "1" if f.connected else "0",
            "connected_since": _iso(f.connected_since),
            "last_msg_at": _iso(f.last_msg_at),
            "msgs_per_s": "" if self.msgs_per_s is None else f"{self.msgs_per_s:.2f}",
            "msgs_total": str(f.msgs_total),
            "dropped_total": str(self.queue.dropped),
            "quarantined_total": str(w.quarantined_total),
            "invalid_total": str(w.invalid_total),
            "gap_open_since": _iso(g.open_since),
            "gap_reason": g.reason if g.open_since is not None else "",
            "last_gap_started_at": last.get("started_at", ""),
            "last_gap_ended_at": last.get("ended_at", ""),
            "last_gap_reason": last.get("reason", ""),
            "gaps_pending": str(len(g.pending)),
            "bbox": f.bbox,
            "deflate": "" if f.deflate is None else ("1" if f.deflate else "0"),
            "sessions_ended": str(f.sessions_ended),
            "subscribe_updates": str(f.subscribe_updates),
            "backoff_s": "" if f.backoff_s is None else f"{f.backoff_s:.1f}",
            "last_error": self._redact(f.last_error)[:ERROR_TEXT_MAX],
            "provider_error": self._redact(f.provider_error)[:ERROR_TEXT_MAX],
            "queue_depth": str(self.queue.qsize()),
            "queue_max": str(self.queue.maxsize),
            "queue_bytes": str(self.queue.bytes),
            "ships_tracked": str(len(self.book)),
            "evicted_total": str(self.book.evicted),
            "lag_p50_s": "" if self.lag_p50_s is None else f"{self.lag_p50_s:.1f}",
            "published_ships_total": str(self.published_ships),
            "last_publish_at": _iso(self.last_publish_at),
            "publish_errors": str(self.publish_errors),
            "updated_at": iso_ms(self._wall()),
        }

    async def write_status(self) -> bool:
        self._last_status = self._mono()
        try:
            await self._r.hset(STATUS_KEY, mapping=self.status_fields())  # type: ignore[arg-type]
            return True
        except (RedisError, OSError) as e:
            self.status_errors += 1
            self._warn("ais status write failed (%s)", type(e).__name__)
            return False

    async def read_previous_status(self) -> dict[str, str]:
        """기동 때 한 번: 이전 실행이 남긴 상태(공백 이어받기용). Redis 오류면 빈 dict."""
        try:
            h = await self._r.hgetall(STATUS_KEY)
        except (RedisError, OSError) as e:
            log.warning("previous ais status unavailable (%s) — no gap carried over", type(e).__name__)
            return {}
        # decode_responses=True 라 str 이지만, bytes 가 와도 안전하게 문자열로 맞춘다
        return {
            (k.decode() if isinstance(k, bytes) else k): (v.decode() if isinstance(v, bytes) else v) for k, v in (h or {}).items()
        }

    # ── 루프 ─────────────────────────────────────────────────────

    async def run(self, stop: asyncio.Event) -> None:
        next_flush = self._mono() + self.flush_s
        next_status = self._mono()
        while not stop.is_set():
            try:
                await self.publish_gaps()
                now = self._mono()
                if now >= next_flush:
                    await self.flush()
                    next_flush += self.flush_s
                    if next_flush <= self._mono():  # 밀린 틱은 건너뛴다(한꺼번에 몰아 보내지 않음)
                        next_flush = self._mono() + self.flush_s
                if now >= next_status or (self.feed.changed.is_set() and now - self._last_status >= STATUS_MIN_GAP_S):
                    self.feed.changed.clear()
                    await self.write_status()
                    next_status = self._mono() + STATUS_EVERY_S
            except Exception:  # noqa: BLE001 — 예상 밖 오류 하나로 발행 루프가 멈추지 않게(다음 틱에 다시)
                self.publish_errors += 1
                log.exception("ais sink tick failed")
                next_flush = max(next_flush, self._mono() + TICK_S)
                next_status = max(next_status, self._mono() + TICK_S)
            timeout = min(TICK_S, max(0.0, min(next_flush, next_status) - self._mono()))
            await _wait_any(stop, self.feed.changed, timeout)

    async def final(self) -> None:
        """종료 직전: 남은 변경분·공백을 보내고 마지막 상태(stopped, 공백 열림)를 쓴다."""
        await self.publish_gaps()
        await self.flush()
        await self.write_status()


async def _wait_any(stop: asyncio.Event, changed: asyncio.Event, wait_s: float) -> None:
    if stop.is_set():
        return
    if changed.is_set():
        # 상태가 바뀌었지만 최소 간격 때문에 아직 못 썼다 — 잠깐 쉰다(바쁜 루프 방지)
        await asyncio.sleep(min(wait_s, STATUS_MIN_GAP_S))
        return
    waiters = [asyncio.ensure_future(stop.wait()), asyncio.ensure_future(changed.wait())]
    try:
        await asyncio.wait(waiters, timeout=wait_s, return_when=asyncio.FIRST_COMPLETED)
    finally:
        for w in waiters:
            w.cancel()
