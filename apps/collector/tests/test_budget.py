"""하루 예산: 여유분(headroom)으로 우선순위를 지킨다 — 저장되는 한도는 그대로."""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime

from fakes import FakeRedis
from redis.exceptions import NoScriptError
from redis.exceptions import TimeoutError as RedisTimeoutError

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


class _Scripts(FakeRedis):
    """SCRIPT LOAD 마다 새 sha · forget() 뒤에는 그 sha 를 모른다(NoScriptError — 재시작 · SCRIPT FLUSH 와 같은 모양) · lose 번 응답을 잃는다(스크립트는
    돌았는데 응답을 받기 전에 시간 초과)."""

    def __init__(self) -> None:
        super().__init__()
        self.known: set[str] = set()
        self.loads = 0
        self.lose = 0

    async def script_load(self, script: str) -> str:
        self.loads += 1
        sha = f"sha{self.loads}"
        self.known.add(sha)
        return sha

    def forget(self) -> None:
        self.known.clear()

    async def evalsha(self, sha, *args, **kwargs):
        if sha not in self.known:
            raise NoScriptError("No matching script. Please use EVAL.")
        out = await super().evalsha(sha, *args, **kwargs)
        if self.lose:
            self.lose -= 1
            raise RedisTimeoutError("Timeout reading from socket")
        return out


async def test_a_reply_lost_after_the_script_ran_does_not_reserve_twice():
    """F4(collector-review · PLAN D4): _eval 은 EVALSHA 가 어떤 예외로 실패해도 스크립트를 다시 올리고 한 번 더 실행했다 — 스크립트는 돌았고 응답만
    잃은 시간 초과면 두 번 예약했다(OpenSky 는 그때마다 4크레딧). 다시 실행하는 것은 서버가 스크립트를 모를 때(NoScriptError)뿐이다."""
    r = _Scripts()
    r.lose = 1
    b = Budget(r, {"opensky": 4000})  # type: ignore[arg-type]
    assert await b.reserve("opensky", 4) == (False, UNKNOWN)  # 결과를 모른다 — 엄격한 공급자는 부르지 않는다
    assert r.kv[day_key("opensky")]["used"] == "4"  # 한 번만 예약됐다(전에는 8)


async def test_a_forgotten_script_is_loaded_again_once():
    r = _Scripts()
    b = Budget(r, {"adsb_fi": 10})  # type: ignore[arg-type]
    assert await b.reserve("adsb_fi") == (True, 1)
    r.forget()  # Redis 재시작 · SCRIPT FLUSH
    assert await b.reserve("adsb_fi") == (True, 2)
    assert r.loads == 2


def _clock(monkeypatch, start: datetime) -> list[datetime]:
    """budget.day_key 의 '지금'을 바꿀 수 있게 — 하루 키를 고르는 시각만 움직인다."""
    from wakeline_collector import budget as budget_mod

    clock = [start]
    real = budget_mod.day_key
    monkeypatch.setattr(budget_mod, "day_key", lambda p, now=None: real(p, now or clock[0]))
    return clock


DAY1_END = datetime(2026, 10, 1, 23, 59, 59, 900000, tzinfo=UTC)
DAY2 = datetime(2026, 10, 2, 0, 0, 4, tzinfo=UTC)


async def test_a_give_back_after_utc_midnight_goes_to_the_day_it_was_reserved_on(monkeypatch):
    """F3(collector-review 부록 B 실험 3 · PLAN D4): release 가 돌려줄 때의 날 키를 다시 셌다 — 00:00Z 를 넘긴 돌려주기(속도 상한 대기 · 연결 실패 ·
    다시 부르기 5 s)는 새 날 키에서 뺐다: 앞 날은 1 그대로, 새 날 used=-1 · TTL 없는 키(noeviction 에서 남는다) · 유지보수가 -1 을 적는다."""
    clock = _clock(monkeypatch, DAY1_END)
    r = FakeRedis()
    b = Budget(r, {"adsbdb": 2000})  # type: ignore[arg-type]
    assert await b.reserve("adsbdb") == (True, 1)
    clock[0] = DAY2
    await b.release("adsbdb")
    assert r.kv["budget:adsbdb:20261001"]["used"] == "0"
    assert "budget:adsbdb:20261002" not in r.kv
    assert await b.usage("adsbdb") == (0, 2000)


async def test_each_task_gives_back_to_its_own_reservation(monkeypatch):
    """예약과 돌려주기는 같은 태스크(작업)에서 짝을 이룬다 — 자정을 사이에 두고 두 작업이 같은 공급자를 예약해도 저마다 제 날에 돌려준다."""
    clock = _clock(monkeypatch, DAY1_END)
    r = FakeRedis()
    b = Budget(r, {"adsb_fi": 100})  # type: ignore[arg-type]
    reserved, go = asyncio.Event(), asyncio.Event()

    async def before_midnight() -> None:
        assert await b.reserve("adsb_fi") == (True, 1)
        reserved.set()
        await go.wait()
        await b.release("adsb_fi")  # 자정 뒤에 돌려준다

    task = asyncio.create_task(before_midnight())
    await reserved.wait()
    clock[0] = DAY2
    assert await b.reserve("adsb_fi") == (True, 1)  # 이 태스크는 새 날에 예약했다
    go.set()
    await task
    assert (r.kv["budget:adsb_fi:20261001"]["used"], r.kv["budget:adsb_fi:20261002"]["used"]) == ("0", "1")
    await b.release("adsb_fi")
    assert r.kv["budget:adsb_fi:20261002"]["used"] == "0"


async def test_a_give_back_never_creates_a_key_or_goes_below_zero():
    r = FakeRedis()
    b = Budget(r, {"adsbdb": 10})  # type: ignore[arg-type]
    await b.release("adsbdb")  # 이 태스크는 예약한 적이 없다 · 오늘 키도 없다
    assert day_key("adsbdb") not in r.kv
    assert await b.reserve("adsbdb") == (True, 1)
    await b.release("adsbdb", 2)  # 예약한 것보다 많이 — 돌려주지 않는다
    assert r.kv[day_key("adsbdb")]["used"] == "1"
    await b.release("adsbdb")
    await b.release("adsbdb")
    assert r.kv[day_key("adsbdb")]["used"] == "0"
