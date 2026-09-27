"""하루 예산: 여유분(headroom)으로 우선순위를 지킨다 — 저장되는 한도는 그대로."""

from __future__ import annotations

from fakes import FakeRedis

from wakeline_collector.budget import UNKNOWN, Budget, day_key


async def test_headroom_keeps_share_for_higher_priority():
    r = FakeRedis()
    b = Budget(r, {"adsb_fi": 10})  # type: ignore[arg-type]
    assert await b.reserve("adsb_fi", headroom=8) == (True, 1)
    assert await b.reserve("adsb_fi", headroom=8) == (True, 2)
    assert await b.reserve("adsb_fi", headroom=8) == (False, 2)  # 낮은 우선순위는 여기서 멈춤
    assert await b.reserve("adsb_fi") == (True, 3)  # 관심 지역(여유분 없음)은 계속
    assert (await r.hgetall(day_key("adsb_fi")))["limit"] == "10"
    assert await b.usage("adsb_fi") == (3, 10)


async def test_unlimited_provider_ignores_headroom_and_redis_failure_policy():
    r = FakeRedis()
    b = Budget(r, {"adsb_lol": 0, "opensky": 100})  # type: ignore[arg-type]
    assert (await b.reserve("adsb_lol", headroom=1000))[0] is True
    r.down = True
    assert await b.reserve("adsb_fi") == (True, UNKNOWN)  # 느슨한 공급자는 계속(속도 상한은 여전히 적용)
    assert await b.reserve("opensky") == (False, UNKNOWN)  # 엄격한 공급자는 호출하지 않는다
    assert await b.usage("adsb_fi") == (None, 0)
    await b.release("adsb_fi")  # 예외 없음
