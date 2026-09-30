"""공급자 상태를 Redis 해시(wakeline:provider:{name})로 노출한다. api 의 /status · /ops/providers 가 읽는다.

상태 기록은 부가 기능이다 — Redis 오류가 수집·발행 경로를 멈추지 않도록 모든 메서드가 예외를 삼키고(경고 로그는 분당 1회),
is_disabled 는 마지막으로 읽은 값을 쓴다. Redis 가 응답하지 않을 때 호출 하나가 socket_timeout × 재시도만큼 붙잡지 않도록
각 호출을 AUX_TIMEOUT_S 로 끊는다(R-43 — 수요 상태 쓰기도 같은 상한).
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import Callable, Iterable
from datetime import UTC, datetime

from redis.asyncio import Redis

from wakeline_collector.masking import mask

log = logging.getLogger("status")
KEY_COLLECTOR = "wakeline:collector"
AUX_TIMEOUT_S = 1.5  # 부가 경로(상태·heartbeat·전환 이벤트·수요 상태) Redis 호출 하나의 상한
# wakeline:active 의 공급자 없음 필드({job}_none_since · {job}_none_reason · {job}_none_next — 계약 v5 §G24)
NONE_FIELDS = ("none_since", "none_reason", "none_next")


def _iso(dt: datetime | None) -> str:
    return dt.astimezone(UTC).isoformat().replace("+00:00", "Z") if dt else ""


def newest_age_s(seen: Iterable[datetime], now: datetime | None = None) -> float | None:
    """heartbeat {job}_lag_s: 발행한 관측 중 가장 새 것(seen_at 최댓값)의 나이(초). 발행한 관측이 없으면 None(모름, R-20)."""
    newest = max(seen, default=None)
    if newest is None:
        return None
    return max(0.0, ((now or datetime.now(UTC)) - newest).total_seconds())


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
            async with asyncio.timeout(AUX_TIMEOUT_S):
                await self._r.hset(key, mapping=fields)  # type: ignore[arg-type]
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
            async with asyncio.timeout(AUX_TIMEOUT_S):
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
        """작업이 쓰는 공급자 · 그때 · 까닭. 공급자 없음 필드({job}_none_*)를 비운다(fallback.py — 공급자 없음이 끝났다)."""
        await self.hset_meta(
            "wakeline:active",
            {job: name, f"{job}_since": _iso(datetime.now(UTC)), f"{job}_reason": reason}
            | {f"{job}_{k}": "" for k in NONE_FIELDS},
        )

    async def set_none(self, job: str, *, since: datetime, reason: str, next_at: datetime | None) -> None:
        """작업에 쓸 공급자가 하나도 없다(fallback.py): {job}_none_since(UTC ISO) · {job}_none_reason(건너뛴 공급자와 까닭) · {job}_none_next
        (가장 먼저 풀리는 때 — 체인 상태로 정해진 값, 모르면 빈 값). {job}(마지막으로 쓴 공급자)은 그대로 둔다."""
        await self.hset_meta(
            "wakeline:active",
            {
                f"{job}_none_since": _iso(since),
                f"{job}_none_reason": (mask(reason) or "")[:200],
                f"{job}_none_next": _iso(next_at),
            },
        )

    async def switch_event(self, job: str, frm: str, to: str, reason: str) -> None:
        try:
            async with asyncio.timeout(AUX_TIMEOUT_S):
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
            async with asyncio.timeout(AUX_TIMEOUT_S):
                v = await self._r.hget(self.key(name), "disabled")
        except Exception as e:  # noqa: BLE001
            self._warn("is_disabled", e)
            return self._disabled.get(name, False)
        self._disabled[name] = v == "1"
        return self._disabled[name]

    async def heartbeat(self, job: str, *, lag_s: float | None, fixture: bool, extra: dict[str, str] | None = None) -> None:
        """{job}_at 과 {job}_lag_s(자료 나이 — 잴 수 없으면 None → 빈 값, 0 으로 채우지 않는다)."""
        fields = {
            f"{job}_at": _iso(datetime.now(UTC)),
            f"{job}_lag_s": "" if lag_s is None else f"{lag_s:.1f}",
            "fixture": "1" if fixture else "0",
            **(extra or {}),
        }
        if self._metrics is not None:
            try:
                fields.update(self._metrics())
            except Exception as e:  # noqa: BLE001
                self._warn("metrics", e)
        await self.hset_meta(KEY_COLLECTOR, fields)
