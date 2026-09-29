"""하루 예산: 여유분(headroom)으로 우선순위를 지킨다 — 저장되는 한도는 그대로."""

from __future__ import annotations

from datetime import UTC, datetime

from fakes import FakeRedis

from wakeline_collector.budget import UNKNOWN, Budget, day_key, hour_key


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


async def test_hour_window_is_shared_by_every_process_and_counts_per_utc_hour():
    """시간 창(ADR-023): 키는 UTC 시(KST 와 시 경계가 같다) — 재기동 · 두 번째 수집기도 같은 키를 센다. 되돌리기는 예약한 키에."""
    r = FakeRedis()
    a, b = Budget(r, {}), Budget(r, {})  # type: ignore[arg-type]
    t = datetime(2026, 9, 29, 9, 59, 59, tzinfo=UTC)
    assert hour_key("komsa_traffic", t) == "budget:komsa_traffic:h:2026092909"
    assert await a.reserve_hour("komsa_traffic", 2, now=t) == (True, 1, "budget:komsa_traffic:h:2026092909")
    assert (await b.reserve_hour("komsa_traffic", 2, now=t))[:2] == (True, 2)
    assert (await a.reserve_hour("komsa_traffic", 2, now=t))[:2] == (False, 2)  # 다른 프로세스가 쓴 몫까지 센다
    later = datetime(2026, 9, 29, 10, 0, 0, tzinfo=UTC)
    ok, used, key = await a.reserve_hour("komsa_traffic", 2, now=later)
    assert (ok, used) == (True, 1)
    await a.release_key(key)
    assert (await r.hgetall("budget:komsa_traffic:h:2026092910"))["used"] == "0"
    assert (await r.hgetall("budget:komsa_traffic:h:2026092909"))["used"] == "2"  # 앞 시의 몫은 그대로
    assert (await r.hgetall("budget:komsa_traffic:h:2026092909"))["limit"] == "2"


async def test_hour_window_follows_the_strict_policy_when_redis_is_down():
    r = FakeRedis()
    b = Budget(r, {})  # type: ignore[arg-type]
    r.down = True
    t = datetime(2026, 9, 29, 9, 0, 0, tzinfo=UTC)
    assert (await b.reserve_hour("komsa_traffic", 15, now=t))[:2] == (False, UNKNOWN)  # 엄격: 부르지 않는다
    assert (await b.reserve_hour("adsb_fi", 15, now=t))[:2] == (True, UNKNOWN)
    await b.release_key("budget:komsa_traffic:h:2026092909")  # 예외 없음


async def test_a_shared_hour_window_counts_several_providers_and_lets_the_lower_priority_one_leave_room():
    """해양수산부 두 서비스(ADR-022 · ADR-023)는 한 시간 창(budget:mof:h:{UTC 시})을 나눠 센다. 격자 채우기는 headroom 만큼 남기고 멈추고,
    입출항 색인은 창 끝까지 쓴다. 엄격함은 창이 아니라 부른 공급자로 정한다(둘 다 엄격 — portmis 는 ADR-022 개정부터)."""
    r = FakeRedis()
    b = Budget(r, {})  # type: ignore[arg-type]
    t = datetime(2026, 9, 29, 3, 30, tzinfo=UTC)
    assert await b.reserve_hour("mof_grid4", 4, now=t, window="mof", headroom=1) == (True, 1, "budget:mof:h:2026092903")
    assert (await b.reserve_hour("mof_grid4", 4, now=t, window="mof", headroom=1))[:2] == (True, 2)
    assert (await b.reserve_hour("portmis", 4, now=t, window="mof"))[:2] == (True, 3)  # 두 공급자가 같은 창을 센다
    assert (await b.reserve_hour("mof_grid4", 4, now=t, window="mof", headroom=1))[:2] == (False, 3)  # 1 을 남기고 멈춘다
    assert (await b.reserve_hour("portmis", 4, now=t, window="mof"))[:2] == (True, 4)  # 남긴 몫은 입출항 색인이 쓴다
    assert (await b.reserve_hour("portmis", 4, now=t, window="mof"))[:2] == (False, 4)
    assert "budget:portmis:h:2026092903" not in r.kv and "budget:mof_grid4:h:2026092903" not in r.kv
    r.down = True
    assert (await b.reserve_hour("mof_grid4", 4, now=t, window="mof"))[:2] == (False, UNKNOWN)
    # 입출항 색인(ADR-022 개정)은 기다리는 사람이 없는 배경 작업이다 — 셀 수 없으면 부르지 않는다(엄격)
    assert (await b.reserve_hour("portmis", 4, now=t, window="mof"))[:2] == (False, UNKNOWN)
    assert await b.reserve("portmis") == (False, UNKNOWN)
