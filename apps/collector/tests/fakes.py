"""테스트용 가짜 Redis·작업 컨텍스트(외부 서비스 없이 작업 흐름을 검증한다)."""

from __future__ import annotations

import hashlib
import time
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

from redis.exceptions import ConnectionError as RedisConnectionError

from wakeline_collector.budget import RELEASE_LUA, Budget
from wakeline_collector.db import Db
from wakeline_collector.jobs.context import JobContext
from wakeline_collector.publisher import Publisher
from wakeline_collector.status import ProviderStatus


class FakeRedis:
    """이 프로젝트가 쓰는 명령만 흉내 낸다. down=True 면 모든 명령이 ConnectionError."""

    def __init__(self, clock=None) -> None:
        self.kv: dict[str, Any] = {}
        self.ttl: dict[str, float] = {}
        self.streams: dict[str, list[tuple[str, dict[str, str]]]] = {}
        self.down = False
        self._scripts: dict[str, str] = {}  # sha → 스크립트(SCRIPT LOAD)
        self._seq = 0
        self.clock = clock  # 있으면 스트림 ID 를 Redis 처럼 '<ms>-<seq>' 로 만든다(MINID 트리밍 시험용)

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

    async def expire(self, key: str, seconds: int) -> bool:
        self._check()
        if self._expired(key) or key not in self.kv:
            return False
        self.ttl[key] = time.time() + seconds
        return True

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

    async def hmget(self, key: str, fields, *args) -> list[str | None]:
        self._check()
        names = [fields] if isinstance(fields, str) else list(fields)
        h = self.kv.get(key, {})
        return [h.get(f) for f in [*names, *args]]

    async def hkeys(self, key: str) -> list[str]:
        self._check()
        return list(self.kv.get(key, {}))

    async def hdel(self, key: str, *fields: str) -> int:
        self._check()
        h = self.kv.get(key, {})
        return sum(1 for f in fields if h.pop(f, None) is not None)

    # sorted sets (수요 임대)
    async def zadd(self, key: str, mapping: dict[str, float]) -> int:
        self._check()
        z = self.kv.setdefault(key, {})
        z.update({m: float(sc) for m, sc in mapping.items()})
        return len(mapping)

    async def zrangebyscore(self, key: str, min, max, start=None, num=None, withscores: bool = False):
        self._check()
        lo = float("-inf") if min == "-inf" else float(min)
        hi = float("inf") if max == "+inf" else float(max)
        items = sorted(((sc, m) for m, sc in self.kv.get(key, {}).items() if lo <= sc <= hi))
        rows = [(m, sc) for sc, m in items]
        if start is not None and num is not None:
            rows = rows[start : start + num]
        return rows if withscores else [m for m, _ in rows]

    # streams
    async def xadd(
        self,
        stream: str,
        fields: dict[str, str],
        maxlen: int | None = None,
        approximate: bool = True,
        minid: int | str | None = None,
    ) -> str:
        """MAXLEN·MINID 트리밍을 정확히(~ 없이) 흉내 낸다 — 실제 Redis 는 ~ 이면 조금 더 남긴다."""
        self._check()
        if maxlen is not None and minid is not None:
            raise ValueError("Only one of maxlen or minid may be specified")  # redis-py 와 같은 제약
        self._seq += 1
        sid = f"{int(self.clock() * 1000)}-{self._seq}" if self.clock else f"{self._seq}-0"
        entries = self.streams.setdefault(stream, [])
        entries.append((sid, dict(fields)))
        if maxlen is not None and len(entries) > maxlen:
            del entries[: len(entries) - maxlen]
        if minid is not None and self.clock:  # 시계가 없으면 ID 가 순번이라 MINID 를 비교할 수 없다(트리밍하지 않음)
            floor = int(str(minid).split("-")[0])
            entries[:] = [e for e in entries if int(e[0].split("-")[0]) >= floor]
        return sid

    async def xrevrange(self, stream: str, max: str = "+", min: str = "-", count: int | None = None):
        """XREVRANGE max min [COUNT] — '(' 는 배타 경계(Redis 6.2+), 순번 없는 ID 는 끝이면 그 밀리초의 마지막·시작이면 처음."""
        self._check()

        def key(sid: str) -> tuple[int, int]:
            ms, _, seq = sid.partition("-")
            return int(ms), int(seq or 0)

        def within(sid: str, bound: str, upper: bool) -> bool:
            if bound in ("+", "-"):
                return True
            excl = bound.startswith("(")
            ms, _, seq = bound.lstrip("(").partition("-")
            b = (int(ms), int(seq) if seq else (2**63 if upper else 0))
            k = key(sid)
            if upper:
                return k < b if excl else k <= b
            return k > b if excl else k >= b

        items = [e for e in reversed(self.streams.get(stream, [])) if within(e[0], max, True) and within(e[0], min, False)]
        return items[:count] if count else items

    # scripting (budget.RESERVE_LUA · RELEASE_LUA 와 같은 의미)
    async def script_load(self, script: str) -> str:
        self._check()
        sha = hashlib.sha1(script.encode()).hexdigest()  # noqa: S324 — Redis 의 스크립트 이름(보안 용도 아님)
        self._scripts[sha] = script
        return sha

    async def evalsha(self, sha: str, numkeys: int, key: str, *args: int):
        self._check()
        if self._scripts.get(sha) == RELEASE_LUA:
            (cost,) = args
            h = self.kv.get(key)
            if not isinstance(h, dict) or "used" not in h or int(h["used"]) < cost:
                return 0  # 키를 만들지 않고 음수로 내리지 않는다
            h["used"] = str(int(h["used"]) - cost)
            return 1
        cost, limit, _ttl, *rest = args
        headroom = rest[0] if rest else 0
        h = self.kv.setdefault(key, {})
        used = int(h.get("used", 0))
        if limit > 0 and used + cost > limit - headroom:
            return [0, used]
        used += cost
        h["used"], h["limit"] = str(used), str(limit)
        return [1, used]

    def pipeline(self, transaction: bool = False) -> FakePipeline:
        return FakePipeline(self)


class FakePipeline:
    """명령을 모았다가 execute 에서 순서대로 실행한다(redis-py 파이프라인과 같은 모양)."""

    def __init__(self, r: FakeRedis) -> None:
        self._r = r
        self._ops: list[tuple[str, tuple, dict]] = []

    def __getattr__(self, name: str):
        if name.startswith("_"):
            raise AttributeError(name)

        def queue(*args, **kwargs) -> FakePipeline:
            self._ops.append((name, args, kwargs))
            return self

        return queue

    async def execute(self, raise_on_error: bool = True) -> list:
        """raise_on_error=False 면 redis-py 처럼 명령마다의 오류를 결과 자리에 예외 객체로 돌려준다(나머지 명령은 실행된다)."""
        self._r._check()
        ops, self._ops = self._ops, []
        out: list = []
        for name, args, kwargs in ops:
            try:
                out.append(await getattr(self._r, name)(*args, **kwargs))
            except Exception as e:  # noqa: BLE001
                if raise_on_error:
                    raise
                out.append(e)
        return out


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
    region_poll_s: int = 10
    sigmet_poll_s: int = 300  # 기상 작업 주기 — config 기본값과 같다(다시 부르기 여유 계산이 읽는다)
    radar_poll_s: int = 60
    metar_poll_s: int = 600


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


async def _aclose(self) -> None:  # redis.asyncio.Redis.aclose 와 같은 이름
    return None


FakeRedis.aclose = _aclose  # type: ignore[attr-defined]
