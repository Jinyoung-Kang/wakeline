"""QA-1220(AWS 출시 QA · 수집기 · 예산): 시간 창 돌려주기(Budget.release_key)가 키가 없을 때 TTL 없는 음수 키를 만든다.

하루 예산의 돌려주기는 F3 에서 고쳤다 — RELEASE_LUA 는 "키를 만들지 않고(TTL 없는 키가 noeviction 에 남지 않게) 음수로 내리지 않는다"(budget.py:45-54).
그런데 시간 창(budget:{창}:h:{yyyymmddHH} — 해양수산부 창 budget:mof:h:* · 교통 폴링 budget:komsa_traffic:h:*)의 돌려주기는 그 규칙을 거치지 않고
`HINCRBY key used -cost` 한 줄이다(budget.py:149-154). 예약(reserve_hour — TTL 2 h)과 돌려주기 사이에 키가 사라지면(Redis 가 죽어 AOF everysec 의 마지막 1 s 를
잃음 · 운영자가 키를 지움) 돌려주기가 used=-1 · **TTL 없는** 키를 새로 만든다. 그 시의 다음 예약이 없으면(시 끝 무렵의 돌려주기 — 다음 예약은 다음 시 키)
그 키는 noeviction Redis 에 영영 남고, 같은 시에 다음 예약이 있으면 그 창은 한도보다 1 더 받는다.
돌려주기가 불리는 곳: traffic_grid.py:472 · 494 · 816 · 833, portcalls_index.py:620 · 634(보내지 않은 호출 · 하루 예산 거절).

기대: 하루 예산의 돌려주기와 같다 — 키가 없거나 사용량이 cost 보다 적으면 아무것도 하지 않는다.
실행: cd apps/collector && uv run --offline pytest tests/qa/test_qa_1220_release_key_creates_ttl_less_key.py -q
      실제 Redis 대조(선택): docker run --rm -d -p 127.0.0.1:56391:6379 redis:8-alpine 뒤 WAKELINE_TEST_REDIS_URL=redis://127.0.0.1:56391/0 를 붙여 실행.
"""

from __future__ import annotations

import os
from datetime import UTC, datetime

import pytest
from fakes import FakeRedis
from redis.asyncio import Redis

from wakeline_collector.budget import HOUR_TTL_S, Budget, hour_key

AT = datetime(2026, 10, 16, 8, 59, 58, tzinfo=UTC)  # 금요일 17:59:58 KST — 그 시의 마지막 예약
URL = os.environ.get("WAKELINE_TEST_REDIS_URL", "")


async def test_qa_1220_giving_back_to_a_vanished_hour_window_creates_no_key():
    r = FakeRedis()
    b = Budget(r, {"mof_grid4": 10_000})  # type: ignore[arg-type]
    ok, used, key = await b.reserve_hour("mof_grid4", 390, now=AT, window="mof")
    assert (ok, used) == (True, 1)
    r.expire_now(key)  # 예약 뒤 키가 사라졌다(Redis 재시작으로 마지막 1 s 를 잃음 등)
    await b.release_key(key)  # 보내지 않은 호출 — 돌려준다
    assert key not in r.kv, f"release_key created {key} = {r.kv.get(key)} (ttl {r.ttl.get(key, 'none')})"


@pytest.mark.skipif(not URL, reason="WAKELINE_TEST_REDIS_URL not set (opt-in real Redis check)")
async def test_qa_1220_on_real_redis_the_created_key_has_no_ttl_and_a_negative_count():
    r = Redis.from_url(URL, decode_responses=True)
    key = hour_key("qa1220", AT)
    await r.delete(key)
    try:
        b = Budget(r, {})
        ok, used, k = await b.reserve_hour("qa1220", 390, now=AT)
        assert (ok, used, k) == (True, 1, key) and 0 < await r.ttl(key) <= HOUR_TTL_S
        await r.delete(key)  # 키가 사라졌다
        await b.release_key(key)
        state = (await r.hgetall(key), await r.ttl(key))
        assert state == ({}, -2), f"release_key left {key}: fields={state[0]} ttl={state[1]} (-1 = no expiry)"
    finally:
        await r.delete(key)
        await r.aclose()
