"""발행 태스크 — 이 프로세스에서 Redis 에 쓰는 유일한 곳(수신·정리 태스크는 Redis 를 기다리지 않는다).

- 10 s 마다 바뀐 선박만 `wakeline:ships` 로 XADD(kind "ships", scope "ships"). 한 엔트리에 선박·정적 정보를 각각 최대 CHUNK 건,
  넘으면 part/parts 로 나눈다.
- 닫힌 공백은 다음 틱(≤ 1 s)에 XADD(kind "ais_gap"). 구역 연결의 공백은 payload scope(그 구역의 정규화한 상자 문자열)를 싣는다(계약 v4 §D).
- 상태 해시 `wakeline:ais:status` 는 5 s 마다 + 상태가 바뀔 때. updated_at 은 프로세스가 살아 있다는 heartbeat(헬스체크가 본다).
  구역이 여럿이면 합계 필드 + shards(JSON 배열) — 합계의 의미는 shards.py 설명.

Redis 장애: 선박 변경분은 쌓지 않고 ShipBook 에 '바뀜' 표시를 되돌린다 — 복구 뒤 첫 발행이 그때의 최신값을 싣는다(메모리는 선박 수 상한 안).
공백 이벤트는 구역마다 순서대로 최대 1,000건 보관했다가 다시 보낸다(api 는 (source, scope, started_at) 로 중복을 막는다).
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections import deque
from collections.abc import Callable
from datetime import UTC, datetime
from typing import Any

import orjson
from redis.asyncio import Redis
from redis.exceptions import RedisError

from wakeline_collector.ais.book import ShipBook
from wakeline_collector.ais.parse import iso_ms
from wakeline_collector.ais.queue import RawQueue
from wakeline_collector.ais.shards import ShardSet
from wakeline_collector.ais.worker import Worker
from wakeline_collector.logsink import sink_metrics
from wakeline_collector.masking import mask
from wakeline_collector.publisher import STREAM_BUDGET_BYTES, STREAM_RETENTION_S, STREAM_SHIPS, Publisher, StreamTrim, _size

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
        shards: ShardSet,
        worker: Worker,
        queue: RawQueue,
        provider: str,
        raw_ref: str,
        flush_s: float = 10.0,
        redact: Callable[[str], str] | None = None,
        wall: Callable[[], float] = time.time,
        mono: Callable[[], float] = time.monotonic,
        log_metrics: Callable[[], dict[str, str]] | None = None,
    ) -> None:
        self._r = redis
        self.book, self.shards, self.worker, self.queue = book, shards, worker, queue
        self.provider, self.raw_ref, self.flush_s = provider, raw_ref, flush_s
        self._redact = redact or (lambda s: mask(s) or "")
        self._wall, self._mono = wall, mono
        self._log_metrics = log_metrics or (lambda: sink_metrics(None))  # 싱크가 없으면 빈 값(모름) — 지난 실행의 값도 덮는다
        self._env = Publisher(redis)  # envelope 형식(gzip+base64 JSON)만 빌려 쓴다 — 이 Publisher 의 로컬 큐는 쓰지 않는다
        # 선박 스트림은 시간으로 자른다(R-14: 2.5 h, 바이트 예산 — publisher.py 설명). 이 프로세스가 유일한 발행자다.
        self._trim = StreamTrim(STREAM_RETENTION_S, STREAM_BUDGET_BYTES[STREAM_SHIPS], clock=lambda: self._wall())
        self._last_warn = 0.0
        self._prev_flush = (mono(), 0, 0, 0, 0)  # 직전 창 끝: (mono, msgs, dropped, quarantined, invalid)
        self._last_status = float("-inf")
        self.published_entries = 0
        self.published_ships = 0
        self.publish_errors = 0
        self.status_errors = 0
        self.last_publish_at: float | None = None
        self._gap_lock = asyncio.Lock()  # 발행 루프와 final() 이 같은 공백을 동시에 보내지 않게

    def _warn(self, msg: str, *args: object) -> None:
        now = self._mono()
        if now - self._last_warn > 60:
            self._last_warn = now
            log.warning(msg, *args)

    # ── 선박 변경분 ──────────────────────────────────────────────

    def _window(self) -> dict[str, Any]:
        """직전 발행 틱 이후의 건수(이번 창). 구역마다 수신률·지연 중앙값도 이 창으로 갱신한다(상태 해시 shards)."""
        now = self._mono()
        cur = (now, self.shards.msgs_total, self.queue.dropped, self.worker.quarantined_total, self.worker.invalid_total)
        prev, self._prev_flush = self._prev_flush, cur
        span = max(1e-3, cur[0] - prev[0])
        msgs = cur[1] - prev[1]
        lags = self.worker.take_lag_p50()
        for s in self.shards.active:
            t0, m0 = s.window
            s.window = (now, s.feed.msgs_total)
            s.msgs_per_s = (s.feed.msgs_total - m0) / max(1e-3, now - t0)
            s.lag_p50_s = lags.get(s.id)
        return {
            "msgs": msgs,
            "msgs_per_s": round(msgs / span, 2),
            "dropped": cur[2] - prev[2],
            "quarantined": cur[3] - prev[3],
            "invalid": cur[4] - prev[4],
            "window_s": round(span, 1),
            "connected": self.shards.connected,
            "bbox": self.shards.bbox,
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
                await self._xadd(env)
            except (RedisError, OSError) as e:
                kept = self._keep_unsent(states, statics, i)
                self.publish_errors += 1
                self._warn("ships xadd failed (%s) — %d ships kept for the next flush", type(e).__name__, kept)
                break
            except asyncio.CancelledError:
                self._keep_unsent(states, statics, i)  # 종료 때 취소돼도 final() 의 flush 가 싣는다
                raise
            sent += 1
            self.published_entries += 1
            self.published_ships += len(ships)
            self.last_publish_at = now
        return sent

    async def _xadd(self, env: dict[str, str]) -> None:
        size = _size(env)
        args = self._trim.xadd_args(size)
        await self._r.xadd(STREAM_SHIPS, env, **args)  # type: ignore[arg-type]
        self._trim.record(size, args)

    def _keep_unsent(self, states: list[dict[str, Any]], statics: list[dict[str, Any]], part: int) -> int:
        """part 번째(0부터)부터 보내지 못한 선박을 다시 '바뀜' 으로 표시한다. 반환: 위치 건수."""
        rest_s = [s["mmsi"] for s in states[part * CHUNK :]]
        self.book.mark_dirty(rest_s, [s["mmsi"] for s in statics[part * CHUNK :]])
        return len(rest_s)

    # ── 공백 ─────────────────────────────────────────────────────

    async def publish_gaps(self) -> int:
        """보관한 닫힌 공백을 구역마다 순서대로 보낸다. 보낸 그 이벤트만 지운다 — 보내는 사이 보관 상한 때문에 밀려났으면 지우지 않는다.
        XADD 가 실패하면 그 틱은 멈춘다(다음 틱에 다시)."""
        async with self._gap_lock:
            n = 0
            for pending in self.shards.pending_queues():
                sent, ok = await self._publish_queue(pending)
                n += sent
                if not ok:
                    break
            return n

    async def _publish_queue(self, pending: deque[dict[str, str]]) -> tuple[int, bool]:
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
                await self._xadd(env)
            except (RedisError, OSError) as e:
                self.publish_errors += 1
                self._warn("ais_gap xadd failed (%s) — %d gap event(s) pending", type(e).__name__, self.shards.gaps_pending)
                return n, False
            if pending and pending[0] is ev:
                pending.popleft()
            n += 1
            where = f" scope={ev['scope'][:120]}" if ev.get("scope") else ""
            log.info("ais gap published: %s → %s (%s)%s", ev["started_at"], ev["ended_at"], ev["reason"], where)
        return n, True

    # ── 상태 해시 ────────────────────────────────────────────────

    def status_fields(self) -> dict[str, str]:
        """상태 해시. 구역이 여럿이면 합계(의미는 shards.py) + shards(JSON). 구역 하나면 v4 이전과 같은 값이다."""
        sh, w = self.shards, self.worker
        last = sh.last_gap() or {}
        opened = sh.gap_open()
        deflate, backoff, rate, lag = sh.deflate, sh.backoff_s, sh.msgs_per_s, sh.lag_p50_s
        return {
            "provider": self.provider,
            "fixture": "1" if self.provider == "fixture" else "0",
            "state": sh.state,
            "connected": "1" if sh.connected else "0",
            "connected_since": _iso(sh.connected_since),
            "last_msg_at": _iso(sh.last_msg_at),
            "msgs_per_s": "" if rate is None else f"{rate:.2f}",
            "msgs_total": str(sh.msgs_total),
            "dropped_total": str(self.queue.dropped),
            "quarantined_total": str(w.quarantined_total),
            "invalid_total": str(w.invalid_total),
            "gap_open_since": _iso(opened[0]) if opened else "",
            "gap_reason": opened[1] if opened else "",
            "last_gap_started_at": last.get("started_at", ""),
            "last_gap_ended_at": last.get("ended_at", ""),
            "last_gap_reason": last.get("reason", ""),
            "last_gap_scope": last.get("scope", ""),  # 계약 v4 G: 마지막 닫힌 공백의 구역("" = 구역 없음 — 모든 선박에 적용)
            "gaps_pending": str(sh.gaps_pending),
            "bbox": sh.bbox,
            "deflate": "" if deflate is None else ("1" if deflate else "0"),
            "sessions_ended": str(sh.sessions_ended),
            "subscribe_updates": str(sh.subscribe_updates),
            "backoff_s": "" if backoff is None else f"{backoff:.1f}",
            "last_error": self._redact(sh.last_error)[:ERROR_TEXT_MAX],
            "provider_error": self._redact(sh.provider_error)[:ERROR_TEXT_MAX],
            "queue_depth": str(self.queue.qsize()),
            "queue_max": str(self.queue.maxsize),
            "queue_bytes": str(self.queue.bytes),
            "ships_tracked": str(len(self.book)),
            "evicted_total": str(self.book.evicted),
            "lag_p50_s": "" if lag is None else f"{lag:.1f}",
            "shards": orjson.dumps(sh.shards_view()).decode(),
            "published_ships_total": str(self.published_ships),
            "last_publish_at": _iso(self.last_publish_at),
            "publish_errors": str(self.publish_errors),
            "stream_budget_trims": str(self._trim.budget_trims),  # R-14: 바이트 예산 때문에 보존 창(2.5 h)보다 일찍 자른 XADD 수
            **self._log_metrics(),  # 계약 v5 §C2: log_sent · log_dropped · log_suppressed(로그 싱크, 기동 뒤 누계)
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
                if now >= next_status or (self.shards.changed.is_set() and now - self._last_status >= STATUS_MIN_GAP_S):
                    self.shards.changed.clear()
                    await self.write_status()
                    next_status = self._mono() + STATUS_EVERY_S
            except Exception:  # noqa: BLE001 — 예상 밖 오류 하나로 발행 루프가 멈추지 않게(다음 틱에 다시)
                self.publish_errors += 1
                log.exception("ais sink tick failed")
                next_flush = max(next_flush, self._mono() + TICK_S)
                next_status = max(next_status, self._mono() + TICK_S)
            timeout = min(TICK_S, max(0.0, min(next_flush, next_status) - self._mono()))
            await _wait_any(stop, self.shards.changed, timeout)

    async def final(self) -> None:
        """종료 직전: 남은 변경분·공백을 보내고 마지막 상태(stopped, 공백 열림)를 쓴다. 발행이 예상 밖으로 실패해도 상태는 쓴다.
        호출자(main)는 발행 루프(run)를 먼저 멈춘 뒤 부른다."""
        try:
            await self.publish_gaps()
            await self.flush()
        except Exception:  # noqa: BLE001 — 마지막 상태 쓰기를 막지 않게
            self.publish_errors += 1
            log.exception("ais final publish failed")
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
