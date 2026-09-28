"""노선 조회(계약 v4 §A · ADR-016): 캐시 확인 → 운영자 스위치 → 예산 → adsbdb(속도 상한) → Redis SET EX.

외부 호출 없음(respx 가 가짜 응답, 합성 자료). 실제 HttpClient·RateLimiter·Budget·ProviderStatus 를 거친다.
"""

from __future__ import annotations

import asyncio
import logging
import time
from datetime import UTC, datetime

import httpx
import orjson
import pytest
import respx
from adsbdb_synthetic import UNKNOWN, flightroute
from fakes import FakeRedis

from wakeline_collector.budget import Budget
from wakeline_collector.http import HttpClient
from wakeline_collector.jobs import route as rj
from wakeline_collector.jobs.route import RouteLookup
from wakeline_collector.providers.adsbdb import ADSBDB_HOST, AdsbdbProvider, RouteFetch
from wakeline_collector.ratelimit import PRIORITY_ROUTE, RateLimiter
from wakeline_collector.route import from_adsbdb
from wakeline_collector.status import ProviderStatus

URL = "https://api.adsbdb.com/v0/callsign/{}"
KEY = "wakeline:route:{}"
SYNTHETIC_WORDS = ("Synthetic", "Testland", "Alpha Town", "ZZAA", "ZZBB")


def _lookup(r: FakeRedis, *, limit: int = 2000, limiter: RateLimiter | None = None, provider=None, **kw):
    http = HttpClient(limiter or RateLimiter(100, 100, {ADSBDB_HOST: (100, 2)}))
    prov = provider or AdsbdbProvider(http)
    budget = Budget(r, {"adsbdb": limit})  # type: ignore[arg-type]
    rl = RouteLookup(r, prov, budget, ProviderStatus(r), **kw)  # type: ignore[arg-type]
    return rl, http, budget


async def _drain(rl: RouteLookup) -> None:
    for _ in range(200):
        tasks = list(rl._tasks.values())
        if not tasks:
            return
        await asyncio.gather(*tasks, return_exceptions=True)


def _cached(r: FakeRedis, cs: str) -> dict:
    return orjson.loads(r.kv[KEY.format(cs)])


def _ttl(r: FakeRedis, cs: str) -> float:
    return r.ttl[KEY.format(cs)] - time.time()


def _no_content_anywhere(r: FakeRedis, caplog: pytest.LogCaptureFixture) -> None:
    """노선 내용은 캐시 키에만 — 로그·공급자 상태·스트림에는 없다(약관)."""
    text = " ".join(rec.getMessage() for rec in caplog.records)
    hashes = orjson.dumps({k: v for k, v in r.kv.items() if not k.startswith("wakeline:route:")}).decode()
    for w in SYNTHETIC_WORDS:
        assert w not in text and w not in hashes
    assert r.streams == {}  # 스트림(→ api → DB)으로 흘리지 않는다


# ---- 결과별 캐시 -------------------------------------------------------------------------------------------------------
async def test_found_is_cached_1800s_and_only_callsign_and_status_are_logged(caplog):
    caplog.set_level(logging.INFO)
    r = FakeRedis()
    rl, http, budget = _lookup(r)
    with respx.mock:
        route = respx.get(URL.format("ZZX123")).mock(return_value=httpx.Response(200, json=flightroute("ZZX123", midpoint=True)))
        assert rl.request([" zzx123 "]) == 1
        await _drain(rl)
    assert route.call_count == 1
    v = _cached(r, "ZZX123")
    assert (
        v["status"] == "found" and v["callsign"] == "ZZX123" and v["origin"]["icao"] == "ZZAA" and v["midpoint"]["icao"] == "ZZCC"
    )
    assert 1790 < _ttl(r, "ZZX123") <= 1800
    assert await budget.usage("adsbdb") == (1, 2000)
    ps = r.kv["wakeline:provider:adsbdb"]
    assert (
        ps["last_records"] == "1"
        and ps["budget_used"] == "1"
        and ps["budget_limit"] == "2000"
        and ps["consecutive_failures"] == "0"
    )
    assert [rec.getMessage() for rec in caplog.records if rec.name == "job.route"] == ["route ZZX123: found"]
    _no_content_anywhere(r, caplog)
    assert rl.metrics() == {"route_lookups": "1", "route_errors": "0", "route_inflight": "0"}
    await http.aclose()


async def test_cached_callsign_is_not_looked_up_again():
    r = FakeRedis()
    await r.set(KEY.format("ZZX123"), '{"v":1}', ex=1800)
    rl, http, budget = _lookup(r)
    with respx.mock(assert_all_called=False) as m:
        route = m.get(url__regex=r".*").mock(return_value=httpx.Response(200, json=flightroute()))
        rl.request(["ZZX123"])
        await _drain(rl)
    assert route.call_count == 0 and (await budget.usage("adsbdb"))[0] == 0 and r.kv[KEY.format("ZZX123")] == '{"v":1}'
    await http.aclose()


async def test_404_unknown_callsign_is_not_found_for_1800s():
    r = FakeRedis()
    rl, http, budget = _lookup(r)
    with respx.mock:
        respx.get(URL.format("ZZX404")).mock(return_value=httpx.Response(404, json=UNKNOWN))
        rl.request(["ZZX404"])
        await _drain(rl)
    v = _cached(r, "ZZX404")
    assert v["status"] == "not_found" and v["origin"] is None and v["destination"] is None and 1790 < _ttl(r, "ZZX404") <= 1800
    assert (await budget.usage("adsbdb"))[0] == 1  # 보낸 호출
    ps = r.kv["wakeline:provider:adsbdb"]
    assert ps["last_records"] == "0" and ps["consecutive_failures"] == "0"  # 모르는 콜사인은 공급자 실패가 아니다
    await http.aclose()


async def test_found_without_valid_airports_is_not_found():
    r = FakeRedis()
    rl, http, _budget = _lookup(r)
    with respx.mock:
        respx.get(URL.format("ZZX124")).mock(
            return_value=httpx.Response(200, json=flightroute("ZZX124", origin={"icao_code": "X"}, destination=None))
        )
        rl.request(["ZZX124"])
        await _drain(rl)
    assert _cached(r, "ZZX124")["status"] == "not_found"
    await http.aclose()


@pytest.mark.parametrize(
    ("resp", "why", "http_status", "budget_used"),
    [
        (httpx.Response(500, text="Synthetic Field Alpha exploded"), "HTTP 500", "500", 1),
        (httpx.Response(404, text="Synthetic Field Alpha gone"), "HTTP 404", "404", 1),  # 모르는 콜사인 응답이 아닌 404
        (httpx.Response(200, text="<html>Synthetic Field Alpha</html>"), "RouteParseError", "", 1),
        (httpx.ConnectError("Synthetic Field Alpha"), "ConnectError", "", 0),  # 보내지 못했다 → 예산 되돌림
        (httpx.ConnectTimeout("Synthetic Field Alpha"), "ConnectTimeout", "", 0),
        (httpx.ReadTimeout("Synthetic Field Alpha"), "ReadTimeout", "", 1),  # 보냈다 → 예산은 쓴 것으로
    ],
)
async def test_provider_failures_are_cached_as_error_for_120s(caplog, resp, why, http_status, budget_used):
    caplog.set_level(logging.INFO)
    r = FakeRedis()
    rl, http, budget = _lookup(r)
    with respx.mock:
        m = respx.get(URL.format("ZZX500"))
        if isinstance(resp, Exception):
            m.mock(side_effect=resp)
        else:
            m.mock(return_value=resp)
        rl.request(["ZZX500"])
        await _drain(rl)
    v = _cached(r, "ZZX500")
    assert v["status"] == "error" and v["origin"] is None and v["airline"] is None and 110 < _ttl(r, "ZZX500") <= 120
    assert (await budget.usage("adsbdb"))[0] == budget_used
    ps = r.kv["wakeline:provider:adsbdb"]
    assert ps["last_error"] == why and ps["last_http_status"] == http_status and ps["consecutive_failures"] == "1"
    assert [rec.getMessage() for rec in caplog.records if rec.name == "job.route"] == [f"route ZZX500: error ({why})"]
    _no_content_anywhere(r, caplog)
    assert rl.metrics()["route_errors"] == "1"
    assert rl.metrics()["route_lookups"] == str(budget_used)  # 실제로 보낸 호출만 센다
    await http.aclose()


async def test_429_penalizes_the_host_for_every_caller_and_writes_error():
    r = FakeRedis()
    limiter = RateLimiter(100, 100, {ADSBDB_HOST: (100, 2)})
    rl, http, budget = _lookup(r, limiter=limiter)
    with respx.mock:
        route = respx.get(url__regex=r"https://api\.adsbdb\.com/v0/callsign/.*").mock(
            return_value=httpx.Response(429, headers={"Retry-After": "90"}, text="slow down")
        )
        rl.request(["ZZX429"])
        await _drain(rl)
        assert _cached(r, "ZZX429")["status"] == "error" and limiter.cooldown_remaining(ADSBDB_HOST) > 80
        rl.request(["ZZX430"])  # 벌점 중: 보내지 않고 error(대기 상한 10 s < 남은 쿨다운)
        await _drain(rl)
    assert route.call_count == 1
    assert _cached(r, "ZZX430")["status"] == "error" and 110 < _ttl(r, "ZZX430") <= 120
    assert (await budget.usage("adsbdb"))[0] == 1  # 보내지 않은 두 번째 호출은 예산을 되돌렸다
    assert r.kv["wakeline:provider:adsbdb"]["last_http_status"] == "429"
    await http.aclose()


# ---- 부르지 않는 경우 ---------------------------------------------------------------------------------------------------
async def test_operator_kill_switch_prevents_the_call(caplog):
    caplog.set_level(logging.INFO)
    r = FakeRedis()
    await r.hset("wakeline:provider:adsbdb", "disabled", "1")
    rl, http, budget = _lookup(r)
    with respx.mock(assert_all_called=False) as m:
        route = m.get(url__regex=r".*").mock(return_value=httpx.Response(200, json=flightroute()))
        rl.request(["ZZX123"])
        await _drain(rl)
        assert route.call_count == 0 and (await budget.usage("adsbdb"))[0] == 0
        assert _cached(r, "ZZX123")["status"] == "error" and _ttl(r, "ZZX123") <= 120  # "조회 중" 으로 남지 않게
        assert "provider disabled by operator" in caplog.text
        await r.hset("wakeline:provider:adsbdb", "disabled", "0")
        r.expire_now(KEY.format("ZZX123"))  # 2분 뒤(TTL) 다시 켜져 있으면 조회한다
        rl.request(["ZZX123"])
        await _drain(rl)
        assert route.call_count == 1 and _cached(r, "ZZX123")["status"] == "found"
    await http.aclose()


async def test_daily_budget_exhausted_prevents_the_call():
    r = FakeRedis()
    rl, http, budget = _lookup(r, limit=1)
    assert (await budget.reserve("adsbdb"))[0]  # 오늘 몫을 다 씀
    with respx.mock(assert_all_called=False) as m:
        route = m.get(url__regex=r".*").mock(return_value=httpx.Response(200, json=flightroute()))
        rl.request(["ZZX123"])
        await _drain(rl)
    assert route.call_count == 0 and (await budget.usage("adsbdb"))[0] == 1
    assert _cached(r, "ZZX123")["status"] == "error"
    await http.aclose()


async def test_rate_limit_wait_exceeded_is_error_and_budget_released():
    r = FakeRedis()
    limiter = RateLimiter(100, 100, {ADSBDB_HOST: (0.01, 1)})  # 100 s 에 1회
    rl, http, budget = _lookup(r, limiter=limiter, wait_s=0.05)
    with respx.mock:
        route = respx.get(url__regex=r".*").mock(return_value=httpx.Response(200, json=flightroute()))
        rl.request(["ZZX001", "ZZX002"])
        await _drain(rl)
    assert route.call_count == 1
    statuses = sorted(_cached(r, cs)["status"] for cs in ("ZZX001", "ZZX002"))
    assert statuses == ["error", "found"] and (await budget.usage("adsbdb"))[0] == 1
    await http.aclose()


async def test_redis_unavailable_means_no_lookup_and_no_crash():
    r = FakeRedis()
    rl, http, _budget = _lookup(r)
    r.down = True
    with respx.mock(assert_all_called=False) as m:
        route = m.get(url__regex=r".*").mock(return_value=httpx.Response(200, json=flightroute()))
        rl.request(["ZZX123"])
        await _drain(rl)
    assert route.call_count == 0 and rl.inflight == 0
    await http.aclose()


async def test_cache_write_failure_holds_the_callsign_for_its_ttl():
    """Redis noeviction 메모리 초과: EXISTS 는 되는데 SET 이 실패한다 — focus 5 s 마다 공급자를 다시 부르지 않는다."""

    class SetFails(FakeRedis):
        fail = True

        async def set(self, key, value, ex=None):
            if self.fail:
                raise ConnectionError("OOM command not allowed")
            return await super().set(key, value, ex=ex)

    r = SetFails()
    clk = [100.0]
    rl, http, _budget = _lookup(r, clock=lambda: clk[0])
    with respx.mock:
        route = respx.get(URL.format("ZZX123")).mock(return_value=httpx.Response(200, json=flightroute()))
        rl.request(["ZZX123"])
        await _drain(rl)
        assert rl.counts["found"] == 1 and "wakeline:route:ZZX123" not in r.kv and route.call_count == 1
        clk[0] += 5  # 다음 focus 결과
        assert rl.request(["ZZX123"]) == 0
        clk[0] += 1800  # found 의 TTL 이 지나면 다시 묻는다
        r.fail = False
        assert rl.request(["ZZX123"]) == 1
        await _drain(rl)
    assert route.call_count == 2 and _cached(r, "ZZX123")["status"] == "found" and rl._hold == {}
    await http.aclose()


async def test_hold_list_is_pruned():
    r = FakeRedis()
    clk = [0.0]
    rl, http, _budget = _lookup(r, provider=GatedProvider(), clock=lambda: clk[0])
    rl._hold = {f"ZZX{i:04d}": 10.0 for i in range(rj.HOLD_PRUNE_AT)} | {"ZZY0001": 99.0}
    clk[0] = 50.0
    rl.request([])
    assert rl._hold == {"ZZY0001": 99.0}
    await http.aclose()


# ---- 동시성 -----------------------------------------------------------------------------------------------------------
class GatedProvider:
    name, cost, host = "adsbdb", 1, ADSBDB_HOST

    def __init__(self) -> None:
        self.gate = asyncio.Event()
        self.calls: list[str] = []
        self.active = 0
        self.max_active = 0

    async def lookup(self, callsign: str, *, wait_s: float) -> RouteFetch:
        self.calls.append(callsign)
        self.active += 1
        self.max_active = max(self.max_active, self.active)
        try:
            await self.gate.wait()
        finally:
            self.active -= 1
        v = from_adsbdb(200, orjson.dumps(flightroute(callsign)), callsign, datetime.now(UTC))
        return RouteFetch(v, 200, 30)


async def test_request_does_not_wait_and_one_lookup_per_callsign():
    r = FakeRedis()
    prov = GatedProvider()
    rl, http, _budget = _lookup(r, provider=prov)
    assert rl.request(["ZZX123", "zzx123", "ZZX124"]) == 2  # 같은 콜사인은 한 번
    for _ in range(5):
        await asyncio.sleep(0)
    assert rl.request(["ZZX123"]) == 0 and rl.inflight == 2  # 진행 중이면 새로 시작하지 않는다
    assert sorted(prov.calls) == ["ZZX123", "ZZX124"]
    prov.gate.set()
    await _drain(rl)
    assert rl.inflight == 0 and _cached(r, "ZZX123")["status"] == "found"
    rl.request(["ZZX123"])  # 캐시에 있으면 다시 묻지 않는다
    await _drain(rl)
    assert sorted(prov.calls) == ["ZZX123", "ZZX124"]
    await http.aclose()


async def test_at_most_two_lookups_wait_on_the_rate_limiter_at_once():
    r = FakeRedis()
    prov = GatedProvider()
    rl, http, _budget = _lookup(r, provider=prov)
    rl.request([f"ZZX{i:03d}" for i in range(6)])
    for _ in range(10):
        await asyncio.sleep(0)
    assert len(prov.calls) == 2 and rl.inflight == 6
    prov.gate.set()
    await _drain(rl)
    assert len(prov.calls) == 6 and prov.max_active == 2
    await http.aclose()


async def test_pending_cap_and_invalid_callsigns():
    r = FakeRedis()
    prov = GatedProvider()
    rl, http, _budget = _lookup(r, provider=prov, max_pending=2)
    assert rl.request([None, "", "AB", "ZZX-1", 42, "ZZX001", "ZZX002", "ZZX003"]) == 2
    assert rl.counts["dropped"] == 1
    await rl.aclose()  # 종료: 진행 중 조회 취소
    assert rl.inflight == 0 and not any(k.startswith("wakeline:route:") for k in r.kv)
    await http.aclose()


async def test_unexpected_bug_is_logged_by_type_only(caplog, monkeypatch):
    r = FakeRedis()
    rl, http, _budget = _lookup(r)

    async def boom(cs):
        raise RuntimeError("Synthetic Field Alpha")

    monkeypatch.setattr(rl, "_resolve", boom)
    rl.request(["ZZX123"])
    await _drain(rl)
    assert "RuntimeError" in caplog.text and "Synthetic" not in caplog.text and rl.counts["errors"] == 1
    await http.aclose()


# ---- 공급자 ----------------------------------------------------------------------------------------------------------
async def test_provider_url_revalidates_callsign_and_uses_route_priority(monkeypatch):
    http = HttpClient(RateLimiter(100, 100))
    p = AdsbdbProvider(http, base_url="https://api.adsbdb.com/")
    assert p.url("ZZX123") == "https://api.adsbdb.com/v0/callsign/ZZX123"
    for bad in ("zzx123", "ZZX/../x", "ZZ", "ZZX123?x=1"):
        with pytest.raises(ValueError):
            p.url(bad)
    seen: dict = {}

    async def fake_get(url, *, priority, wait_s):
        seen.update(url=url, priority=priority, wait_s=wait_s)
        raise httpx.ConnectError("x")

    monkeypatch.setattr(http, "get", fake_get)
    with pytest.raises(httpx.ConnectError):
        await p.lookup("ZZX123")
    assert seen == {"url": "https://api.adsbdb.com/v0/callsign/ZZX123", "priority": PRIORITY_ROUTE, "wait_s": 10.0}
    assert rj.CONCURRENCY == 2 and p.name == "adsbdb" and p.cost == 1
    await http.aclose()
