"""실 Redis 대조(선택 실행, WAKELINE_TEST_REDIS_URL 이 있을 때만): ais 프로세스를 infra/redis/start.sh 의 wakeline_ais ACL 규칙
그대로 만든 사용자로 돌려, 필요한 명령(XADD wakeline:ships · HSET/HGETALL wakeline:ais:status · HGET wakeline:settings)은 되고
그 밖(설정 쓰기 · 항공기 스트림 · 세션 · 소비자 그룹 · 키 열람)은 거부되는지 확인한다(최소 권한).
실행: docker run --rm -d -p 127.0.0.1:56379:6379 redis:8-alpine --requirepass pw
      WAKELINE_TEST_REDIS_URL=redis://:pw@127.0.0.1:56379/0 uv run pytest tests/test_ais_redis_integration.py
"""

from __future__ import annotations

import asyncio
import os
import uuid

import pytest
from acl_rules import service_acl_rules
from redis.asyncio import Redis
from redis.exceptions import NoPermissionError
from test_ais_helpers import ROOT, decode, validator

from wakeline_collector.ais import main as ais_main
from wakeline_collector.ais.config import AisSettings
from wakeline_collector.ais.sink import STATUS_KEY
from wakeline_collector.publisher import STREAM_SHIPS

URL = os.environ.get("WAKELINE_TEST_REDIS_URL", "")
pytestmark = pytest.mark.skipif(not URL, reason="WAKELINE_TEST_REDIS_URL not set (opt-in real Redis check)")


def ais_rules() -> list[str]:
    """infra/redis/start.sh 가 wakeline_ais 에게 주는 규칙 그대로(변수를 흉내 내지 않고 스크립트를 실행해 읽는다 — R-41)."""
    return service_acl_rules("wakeline_ais")


@pytest.fixture
async def admin():
    r = Redis.from_url(URL, decode_responses=True)
    await r.delete(STREAM_SHIPS, STATUS_KEY, "wakeline:settings")
    yield r
    await r.delete(STREAM_SHIPS, STATUS_KEY, "wakeline:settings")
    await r.aclose()


@pytest.fixture
async def ais_user(admin):
    user, pw = f"itest_ais_{uuid.uuid4().hex[:8]}", uuid.uuid4().hex
    await admin.execute_command("ACL", "SETUSER", user, "reset", "on", f">{pw}", *ais_rules())
    kw = admin.connection_pool.connection_kwargs
    yield {"host": kw["host"], "port": kw["port"], "user": user, "pw": pw}
    await admin.execute_command("ACL", "DELUSER", user)


def _redis(u) -> Redis:
    return Redis(host=u["host"], port=u["port"], username=u["user"], password=u["pw"], decode_responses=True)


async def test_ais_process_runs_under_least_privilege_acl(admin, ais_user):
    await admin.hset("wakeline:settings", "ais_bboxes", "18,105,46,150")
    r = _redis(ais_user)
    s = AisSettings(wakeline_fixture_mode=1, ais_flush_s=1.0, fixtures_dir=str(ROOT / "fixtures"))
    stop = asyncio.Event()
    task = asyncio.create_task(ais_main.main(stop=stop, redis=r, settings=s, replay_speed=40))
    await asyncio.sleep(2.6)
    stop.set()
    assert await asyncio.wait_for(task, 15) == 0
    entries = await admin.xrange(STREAM_SHIPS)
    assert entries, "no XADD reached Redis"
    v = validator("stream_envelope.v1.json", "/$defs/ships_payload")
    for _id, f in entries:
        if f["kind"] == "ships":
            assert not list(v.iter_errors(decode(f)))
    h = await admin.hgetall(STATUS_KEY)
    assert h["state"] == "stopped" and h["provider"] == "fixture" and int(h["msgs_total"]) > 100
    assert int(h["publish_errors"]) == 0


async def test_ais_user_is_denied_everything_else(admin, ais_user):
    r = _redis(ais_user)
    try:
        await admin.hset("wakeline:settings", "ais_bboxes", "1,1,2,2")
        assert await r.hget("wakeline:settings", "ais_bboxes") == "1,1,2,2"  # 설정 읽기는 된다
        denied = [
            r.hset("wakeline:settings", "ais_bboxes", "-90,-180,90,180"),  # 설정 쓰기
            r.xadd("wakeline:aircraft", {"x": "1"}),  # 항공기 스트림
            r.get("wakeline:session:abc"),  # 운영 세션
            r.hset("wakeline:collector", "x", "1"),
            r.set("budget:x", "1"),
            r.execute_command("SCAN", "0"),  # 키 이름 열람
            r.execute_command("XGROUP", "CREATE", STREAM_SHIPS, "evil", "$", "MKSTREAM"),  # 소비자 그룹 조작
            r.execute_command("KEYS", "*"),
        ]
        for coro in denied:
            with pytest.raises(NoPermissionError):
                await coro
    finally:
        await r.aclose()
