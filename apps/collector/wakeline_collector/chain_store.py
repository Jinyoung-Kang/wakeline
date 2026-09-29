"""ProviderChain 의 429 이력(R-17)을 Redis 에 남긴다 — 수집기가 재시작해도(재배포) 쉼·미룸을 이어 간다.

이전에는 이력이 프로세스 메모리에만 있어 재시작마다 1순위(adsb.lol)를 바로 다시 불렀다(재시작 직후 로그가 늘 'backing off 60 s').

- 키: wakeline:provider:{공급자}:ratelimit:{작업} — 해시 하나(작업 × 공급자). 수집기 ACL 의 ~wakeline:provider:* 안에서 HSET · HGETALL ·
  HDEL 을 쓰고, EXPIRE 는 start.sh 의 셀렉터가 이 키 패턴(…:ratelimit:…)에만 준다. api 는 wakeline:provider:{name} 만 읽으므로
  (StatusService) 운영 공급자 표에 섞이지 않는다.
- 값: 벽시계 epoch 초(소수 3자리) — stage · last_429_at · backoff_until · hold_until(없으면 빈 값) · hold_s · quiet_from · expires_at ·
  saved_at, 형식 v=1. 체인은 단조 시계로 재므로 읽고 쓸 때 '지금'의 두 시계 차이로 바꾼다(단조 시계는 프로세스마다 기준이 다르다).
- TTL: expires_at(= quiet_from + 15분 — 그 뒤에는 이력이 초기화된 것과 같다)이 논리 만료이고, 쓸 때마다 같은 때로 Redis TTL 을 건다
  (HSET + EXPIRE 한 파이프라인) — 더 쓰지 않는 공급자·작업의 키도 남지 않는다. 읽을 때 지났거나 형식이 틀린 기록은 버리고 HDEL 로 지운다.
  EXPIRE 가 거부되면(규칙을 바꾸기 전에 뜬 redis) 기록은 그대로 두고 논리 만료로 계속한다 — 경고는 프로세스마다 한 번.
- Redis 오류는 선택을 막지 않는다: 호출마다 AUX_TIMEOUT_S 로 끊고, 실패하면 메모리 이력만 쓴다. 경고는 장애마다 한 번(되살아나면 INFO).
  읽기 실패는 None(모름)으로 돌려준다 — 체인은 읽힐 때까지 다시 읽고, 그동안 받은 429 는 저장하지 않는다(읽지 못한 기록을 덮지 않게).
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import Callable

from redis.asyncio import Redis

from wakeline_collector.status import AUX_TIMEOUT_S

log = logging.getLogger("chain_store")
KEY = "wakeline:provider:{name}:ratelimit:{job}"
FIELDS = ("v", "stage", "last_429_at", "backoff_until", "hold_until", "hold_s", "quiet_from", "expires_at", "saved_at")
VERSION = "1"


class ChainStateStore:
    def __init__(self, redis: Redis, *, wall: Callable[[], float] = time.time) -> None:
        self._r = redis
        self.wall = wall  # 벽시계(epoch 초) — 시험은 가짜 시계를 준다
        self._failing = False
        self._ttl_warned = False
        self.errors = 0

    @staticmethod
    def key(job: str, name: str) -> str:
        return KEY.format(name=name, job=job)

    def _fail(self, what: str, e: Exception) -> None:
        self.errors += 1
        if not self._failing:
            self._failing = True
            log.warning("429 history %s failed (%s) — using memory only until Redis answers", what, type(e).__name__)

    def _ok(self) -> None:
        if self._failing:
            self._failing = False
            log.info("429 history store recovered — persisting again")

    async def load(self, job: str, names: list[str]) -> dict[str, dict[str, str]] | None:
        """{공급자: 저장된 해시}(빈 해시는 빼고). Redis 오류면 None(모름 — '저장된 것 없음'과 다르다: 체인이 다음에 다시 읽는다)."""
        if not names:
            return {}
        try:
            async with asyncio.timeout(AUX_TIMEOUT_S):
                pipe = self._r.pipeline(transaction=False)  # MULTI·EXEC 는 수집기 ACL 에 없다
                for n in names:
                    pipe.hgetall(self.key(job, n))
                rows = await pipe.execute()
        except Exception as e:  # noqa: BLE001 — 부가 기능: 선택을 막지 않는다
            self._fail("read", e)
            return None
        self._ok()
        return {n: dict(row) for n, row in zip(names, rows, strict=True) if isinstance(row, dict) and row}

    async def save(self, job: str, name: str, fields: dict[str, str], *, ttl_s: int) -> bool:
        """기록을 쓰고 ttl_s 초 뒤 Redis 가 지우게 한다(논리 만료와 같은 때). True = 기록을 썼다(TTL 을 못 걸었어도)."""
        key = self.key(job, name)
        try:
            async with asyncio.timeout(AUX_TIMEOUT_S):
                pipe = self._r.pipeline(transaction=False)  # MULTI·EXEC 는 수집기 ACL 에 없다
                pipe.hset(key, mapping=fields)  # type: ignore[arg-type]
                pipe.expire(key, max(1, int(ttl_s)))
                written, expired = await pipe.execute(raise_on_error=False)
        except Exception as e:  # noqa: BLE001
            self._fail("write", e)
            return False
        if isinstance(written, Exception):
            self._fail("write", written)
            return False
        self._ok()
        if isinstance(expired, Exception) and not self._ttl_warned:
            self._ttl_warned = True
            log.warning(
                "429 history TTL not set (%s) — records still expire logically (expires_at); if redis was started before "
                "infra/redis/start.sh allowed EXPIRE on wakeline:provider:*:ratelimit:*, restart redis to load the rule",
                type(expired).__name__,
            )
        return True

    async def drop(self, job: str, name: str) -> None:
        """지난·망가진 기록을 지운다(필드를 모두 지우면 키도 없어진다)."""
        try:
            async with asyncio.timeout(AUX_TIMEOUT_S):
                await self._r.hdel(self.key(job, name), *FIELDS)
        except Exception as e:  # noqa: BLE001
            self._fail("delete", e)
