"""공급자 상태를 Redis 해시(wakeline:provider:{name})로 노출한다. api 의 /status · /ops/providers 가 읽는다.

상태 기록은 부가 기능이다 — Redis 오류가 수집·발행 경로를 멈추지 않도록 모든 메서드가 예외를 삼키고(경고 로그는 분당 1회),
is_disabled 는 마지막으로 읽은 값을 쓴다.
"""

from __future__ import annotations

import logging
import time
from collections.abc import Callable
from datetime import UTC, datetime

from redis.asyncio import Redis

from wakeline_collector.masking import mask

log = logging.getLogger("status")
KEY_COLLECTOR = "wakeline:collector"


def _iso(dt: datetime | None) -> str:
    return dt.astimezone(UTC).isoformat().replace("+00:00", "Z") if dt else ""


class ProviderStatus:
    def __init__(self, redis: Redis, metrics: Callable[[], dict[str, str]] | None = None):
        self._r = redis
        self._metrics = metrics
        self._disabled: dict[str, bool] = {}
        self._last_log = 0.0
        self.errors = 0  # 상태 기록 실패 누적

    @property
    def redis(self) -> Redis:
        return self._r

    def _warn(self, what: str, e: Exception) -> None:
        self.errors += 1
        now = time.monotonic()
        if now - self._last_log > 60:
            self._last_log = now
            log.warning("status %s failed (%s) — continuing without it", what, type(e).__name__)

    async def hset_meta(self, key: str, fields: dict[str, str]) -> None:
        try:
            await self._r.hset(key, mapping=fields)
        except Exception as e:  # noqa: BLE001
            self._warn("hset", e)

    def key(self, name: str) -> str:
        return f"wakeline:provider:{name}"

    async def success(
        self,
        name: str,
        *,
        at: datetime,
        latency_ms: int,
        records: int,
        used: int | None,
        limit: int,
        remaining: int | None = None,
        scope: str = "-",
    ) -> None:
        fields = {
            "name": name,
            "last_success_at": _iso(at),
            "last_latency_ms": str(latency_ms),
            "last_records": str(records),
            "consecutive_failures": "0",
            "budget_limit": str(limit),
            "last_scope": scope,
        }
        if used is not None:
            fields["budget_used"] = str(used)
        if remaining is not None:
            fields["budget_remaining"] = str(remaining)
        await self.hset_meta(self.key(name), fields)

    async def failure(self, name: str, *, at: datetime, error: str, http_status: int | None) -> int:
        k = self.key(name)
        try:
            n = await self._r.hincrby(k, "consecutive_failures", 1)
            await self._r.hset(
                k,
                mapping={
                    "name": name,
                    "last_error_at": _iso(at),
                    "last_error": (mask(error) or "")[:500],
                    "last_http_status": str(http_status or ""),
                },
            )
            return int(n)
        except Exception as e:  # noqa: BLE001
            self._warn("failure", e)
            return 0

    async def set_active(self, job: str, name: str, *, reason: str) -> None:
        await self.hset_meta("wakeline:active", {job: name, f"{job}_since": _iso(datetime.now(UTC)), f"{job}_reason": reason})

    async def switch_event(self, job: str, frm: str, to: str, reason: str) -> None:
        try:
            await self._r.xadd(
                "wakeline:events",
                {
                    "type": "provider_switch",
                    "job": job,
                    "from": frm,
                    "to": to,
                    "reason": mask(reason) or "",
                    "at": _iso(datetime.now(UTC)),
                },
                maxlen=500,
                approximate=True,
            )
        except Exception as e:  # noqa: BLE001
            self._warn("switch_event", e)

    async def is_disabled(self, name: str) -> bool:
        """운영자가 끈 공급자인가. Redis 오류면 마지막으로 읽은 값(없으면 False)."""
        try:
            v = await self._r.hget(self.key(name), "disabled")
        except Exception as e:  # noqa: BLE001
            self._warn("is_disabled", e)
            return self._disabled.get(name, False)
        self._disabled[name] = v == "1"
        return self._disabled[name]

    async def heartbeat(self, job: str, *, lag_s: float | None, fixture: bool) -> None:
        fields = {
            f"{job}_at": _iso(datetime.now(UTC)),
            f"{job}_lag_s": "" if lag_s is None else f"{lag_s:.1f}",
            "fixture": "1" if fixture else "0",
        }
        if self._metrics is not None:
            try:
                fields.update(self._metrics())
            except Exception as e:  # noqa: BLE001
                self._warn("metrics", e)
        await self.hset_meta(KEY_COLLECTOR, fields)
