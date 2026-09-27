"""공급자 상태를 Redis 해시(skywx:provider:{name})로 노출한다. api 의 /status · /ops/providers 가 읽는다."""

from __future__ import annotations

from datetime import UTC, datetime

from redis.asyncio import Redis

from skywx_collector.masking import mask


def _iso(dt: datetime | None) -> str:
    return dt.astimezone(UTC).isoformat().replace("+00:00", "Z") if dt else ""


class ProviderStatus:
    def __init__(self, redis: Redis):
        self._r = redis

    def key(self, name: str) -> str:
        return f"skywx:provider:{name}"

    async def success(
        self,
        name: str,
        *,
        at: datetime,
        latency_ms: int,
        records: int,
        used: int,
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
            "budget_used": str(used),
            "budget_limit": str(limit),
            "last_scope": scope,
        }
        if remaining is not None:
            fields["budget_remaining"] = str(remaining)
        await self._r.hset(self.key(name), mapping=fields)

    async def failure(self, name: str, *, at: datetime, error: str, http_status: int | None) -> int:
        k = self.key(name)
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

    async def set_active(self, job: str, name: str, *, reason: str) -> None:
        await self._r.hset("skywx:active", mapping={job: name, f"{job}_since": _iso(datetime.now(UTC)), f"{job}_reason": reason})

    async def switch_event(self, job: str, frm: str, to: str, reason: str) -> None:
        await self._r.xadd(
            "skywx:events",
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

    async def is_disabled(self, name: str) -> bool:
        v = await self._r.hget(self.key(name), "disabled")
        return v == "1"

    async def heartbeat(self, job: str, *, lag_s: float | None, fixture: bool) -> None:
        await self._r.hset(
            "skywx:collector",
            mapping={
                f"{job}_at": _iso(datetime.now(UTC)),
                f"{job}_lag_s": "" if lag_s is None else f"{lag_s:.1f}",
                "fixture": "1" if fixture else "0",
            },
        )
