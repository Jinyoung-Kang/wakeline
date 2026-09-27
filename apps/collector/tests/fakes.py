"""테스트용 가짜 Redis·작업 컨텍스트(외부 서비스 없이 작업 흐름을 검증한다)."""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

from redis.exceptions import ConnectionError as RedisConnectionError

from skywx_collector.budget import Budget
from skywx_collector.db import Db
from skywx_collector.jobs.context import JobContext
from skywx_collector.publisher import Publisher
from skywx_collector.status import ProviderStatus


class FakeRedis:
    """이 프로젝트가 쓰는 명령만 흉내 낸다. down=True 면 모든 명령이 ConnectionError."""

    def __init__(self) -> None:
        self.kv: dict[str, Any] = {}
        self.ttl: dict[str, float] = {}
        self.streams: dict[str, list[tuple[str, dict[str, str]]]] = {}
        self.down = False
        self._seq = 0

    def _check(self) -> None:
        if self.down:
            raise RedisConnectionError("fake redis down")

    def _expired(self, key: str) -> bool:
        exp = self.ttl.get(key)
        if exp is not None and exp <= time.time():
            self.kv.pop(key, None)
            self.ttl.pop(key, None)
            return True
        return False

    def expire_now(self, key: str) -> None:
        self.kv.pop(key, None)
        self.ttl.pop(key, None)

    # strings
    async def get(self, key: str) -> str | None:
        self._check()
        self._expired(key)
        v = self.kv.get(key)
        return v if isinstance(v, str) else None

    async def set(self, key: str, value: str, ex: int | None = None) -> bool:
        self._check()
        self.kv[key] = value
        if ex:
            self.ttl[key] = time.time() + ex
        else:
            self.ttl.pop(key, None)
        return True

    async def delete(self, *keys: str) -> int:
        self._check()
        n = 0
        for k in keys:
            n += int(self.kv.pop(k, None) is not None)
            self.ttl.pop(k, None)
        return n

    async def exists(self, *keys: str) -> int:
        self._check()
        return sum(1 for k in keys if not self._expired(k) and k in self.kv)

    # hashes
    async def hset(self, key: str, field: str | None = None, value: str | None = None, mapping: dict | None = None) -> int:
        self._check()
        h = self.kv.setdefault(key, {})
        if field is not None:
            h[field] = str(value)
        for k, v in (mapping or {}).items():
            h[k] = str(v)
        return 1

    async def hget(self, key: str, field: str) -> str | None:
        self._check()
        return self.kv.get(key, {}).get(field)

    async def hgetall(self, key: str) -> dict[str, str]:
        self._check()
        return dict(self.kv.get(key, {}))

    async def hincrby(self, key: str, field: str, n: int) -> int:
        self._check()
        h = self.kv.setdefault(key, {})
        h[field] = str(int(h.get(field, 0)) + n)
        return int(h[field])

    # streams
    async def xadd(self, stream: str, fields: dict[str, str], maxlen: int | None = None, approximate: bool = True) -> str:
        self._check()
        self._seq += 1
        sid = f"{self._seq}-0"
        self.streams.setdefault(stream, []).append((sid, dict(fields)))
        return sid

    async def xrevrange(self, stream: str, count: int | None = None):
        self._check()
        items = list(reversed(self.streams.get(stream, [])))
        return items[:count] if count else items

    # scripting (budget.RESERVE_LUA 와 같은 의미)
    async def script_load(self, script: str) -> str:
        self._check()
        return "sha"

    async def evalsha(self, sha: str, numkeys: int, key: str, cost: int, limit: int, ttl: int):
        self._check()
        h = self.kv.setdefault(key, {})
        used = int(h.get("used", 0))
        if limit > 0 and used + cost > limit:
            return [0, used]
        used += cost
        h["used"], h["limit"] = str(used), str(limit)
        return [1, used]

    def pipeline(self, transaction: bool = False) -> FakePipeline:
        return FakePipeline(self)


class FakePipeline:
    def __init__(self, r: FakeRedis) -> None:
        self._r = r
        self._ops: list[tuple[str, tuple]] = []

    def exists(self, *keys: str) -> FakePipeline:
        self._ops.append(("exists", keys))
        return self

    async def execute(self) -> list:
        return [await getattr(self._r, name)(*args) for name, args in self._ops]


class FakeRaw:
    def save(self, provider: str, body: bytes, at: datetime | None = None) -> str:
        return f"raw/{provider}"

    def purge(self, retention_h: int | None = None) -> int:
        return 0


@dataclass
class FakeRt:
    provider_order: list[str] = field(default_factory=lambda: ["adsb_lol", "adsb_fi", "opensky"])
    region: tuple[float, float, int] = (36.5, 127.8, 250)
    global_enabled: bool = True


class RecordingDb(Db):
    """writer 를 돌리지 않고 제출된 작업 이름만 기록한다(작업 흐름 검증용)."""

    def __init__(self) -> None:
        super().__init__(pool_factory=None)
        self.names: list[str] = []

    def _submit(self, name, fn) -> None:  # type: ignore[override]
        self.names.append(name)
        super()._submit(name, fn)


def make_ctx(redis: FakeRedis | None = None, *, limits: dict[str, int] | None = None, fixture: bool = False) -> JobContext:
    r = redis or FakeRedis()
    return JobContext(
        budget=Budget(r, limits or {"adsb_lol": 0, "adsb_fi": 0, "opensky": 2880, "awc": 0, "kma_radar": 1000}),  # type: ignore[arg-type]
        db=RecordingDb(),
        publisher=Publisher(r),  # type: ignore[arg-type]
        raw=FakeRaw(),  # type: ignore[arg-type]
        status=ProviderStatus(r),  # type: ignore[arg-type]
        rt=FakeRt(),  # type: ignore[arg-type]
        fixture=fixture,
    )
