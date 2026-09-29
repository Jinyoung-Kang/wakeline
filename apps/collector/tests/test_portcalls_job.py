"""한국 항만 입출항 조회(ADR-022): 수요 임대 → 캐시 확인 → 운영자 스위치 → 예산(요청마다) → PORT-MIS(속도 상한) → Redis SET EX.

외부 호출 없음(respx 가 가짜 응답 — 저장소 fixture 와 그것을 복제한 자료). 실제 HttpClient·RateLimiter·Budget·ProviderStatus 를 거친다.
"""

from __future__ import annotations

import asyncio
import logging
import time
from datetime import UTC, datetime
from urllib.parse import parse_qs, urlsplit

import httpx
import orjson
import pytest
import respx
from fakes import FakeRedis
from portmis_synthetic import empty_page, fixture_bytes, item, page

from wakeline_collector.budget import Budget
from wakeline_collector.http import HttpClient
from wakeline_collector.jobs import portcalls as pj
from wakeline_collector.jobs.portcalls import PortCallJob, PortCallLookup
from wakeline_collector.masking import register_secrets
from wakeline_collector.portcalls import DEMAND_KEY, PORT_AUTHORITIES
from wakeline_collector.providers.portmis import PORTMIS_HOST, PortMisProvider, service_key_forms
from wakeline_collector.ratelimit import PRIORITY_PORTCALL, PRIORITY_ROUTE, RateLimiter, default_limiter
from wakeline_collector.status import ProviderStatus

URL = "https://apis.data.go.kr/1192000/VsslEtrynd5/Info5"
KEY = "wakeline:portcalls:{}"
# 시험용 키(실제 키가 아니다) — 인코딩 키 모양(%2B · %3D). 로그·상태·캐시 어디에도 나오면 안 된다
SERVICE_KEY = "TESTONLYkey0123%2Babc%2Fdef%3D%3D"
DECODED = "TESTONLYkey0123+abc/def=="
NOW = datetime(2026, 9, 29, 3, 0, tzinfo=UTC)  # KST 12:00 → 조회 창 2026-08-30 ~ 2026-09-29


def _lookup(r: FakeRedis, *, limit: int = 3000, limiter: RateLimiter | None = None, key: str = SERVICE_KEY, **kw):
    http = HttpClient(limiter or RateLimiter(100, 100, {PORTMIS_HOST: (100, 2)}))
    prov = PortMisProvider(http, key)
    budget = Budget(r, {"portmis": limit})  # type: ignore[arg-type]
    lk = PortCallLookup(r, prov, budget, ProviderStatus(r), now=lambda: NOW, **kw)  # type: ignore[arg-type]
    return lk, http, budget


async def _drain(lk: PortCallLookup) -> None:
    for _ in range(200):
        tasks = list(lk._tasks.values())
        if not tasks:
            return
        await asyncio.gather(*tasks, return_exceptions=True)


def _cached(r: FakeRedis, cs: str) -> dict:
    return orjson.loads(r.kv[KEY.format(cs)])


def _ttl(r: FakeRedis, cs: str) -> float:
    return r.ttl[KEY.format(cs)] - time.time()


def _q(req: httpx.Request) -> dict[str, str]:
    return {k: v[0] for k, v in parse_qs(urlsplit(str(req.url)).query).items()}


def _responder(pages: dict[tuple[str, int], bytes], *, default: bytes | None = None, status: dict[str, int] | None = None):
    """(prtAgCd, pageNo) → 본문. 없으면 빈 쪽. status 에 있는 항만청은 그 HTTP 상태."""

    def respond(req: httpx.Request) -> httpx.Response:
        q = _q(req)
        code, no = q["prtAgCd"], int(q["pageNo"])
        if status and code in status:
            return httpx.Response(status[code], text="<html><title>err</title></html>")
        body = pages.get((code, no), default if default is not None else empty_page())
        return httpx.Response(200, content=body, headers={"content-type": "text/xml;charset=UTF-8"})

    return respond


@pytest.fixture(autouse=True)
def _httpx_quiet():
    """main 과 같이 httpx 의 INFO(전체 URL — 쿼리의 serviceKey 포함)를 끈다 — 운영에서는 MaskFilter 도 가린다(test_masking)."""
    lg = logging.getLogger("httpx")
    old = lg.level
    lg.setLevel(logging.WARNING)
    yield
    lg.setLevel(old)


def _no_secret_anywhere(r: FakeRedis, caplog: pytest.LogCaptureFixture) -> None:
    text = caplog.text + " ".join(rec.getMessage() for rec in caplog.records)
    stored = orjson.dumps({k: v for k, v in r.kv.items()}, default=str).decode()
    for form in service_key_forms(SERVICE_KEY):
        assert form not in text and form not in stored


# ---- 정상 경로 -------------------------------------------------------------------------------------------------------
async def test_ok_queries_all_ten_port_authorities_and_caches_6h(caplog):
    caplog.set_level(logging.INFO)
    r = FakeRedis()
    lk, _http, _budget = _lookup(r)
    with respx.mock:
        route = respx.get(URL).mock(side_effect=_responder({("020", 1): fixture_bytes()}))
        assert lk.request([" 230025 "]) == 1
        await _drain(lk)
    assert route.call_count == 10
    qs = [_q(c.request) for c in route.calls]
    assert [q["prtAgCd"] for q in qs] == [c for c, _ in PORT_AUTHORITIES]
    for q in qs:
        assert q["sde"] == "20260830" and q["ede"] == "20260929" and q["deGb"] == "I" and q["clsgn"] == "230025"
        assert q["numOfRows"] == "50" and q["pageNo"] == "1"
        assert q["serviceKey"] == DECODED  # 인코딩 키를 한 번 풀어 httpx 가 한 번만 인코딩했다
    assert "%252B" not in str(route.calls[0].request.url) and "serviceKey=TESTONLYkey0123%2Babc%2Fdef%3D%3D" in str(
        route.calls[0].request.url
    )
    v = _cached(r, "230025")
    assert v["status"] == "ok" and len(v["items"]) == 1 and v["items"][0]["reported_name"] == "부광9호"
    assert v["window"] == {"from": "2026-08-30", "to": "2026-09-29", "days": 30}
    assert 6 * 3600 - 5 < _ttl(r, "230025") <= 6 * 3600
    assert r.kv["budget:portmis:" + datetime.now(UTC).strftime("%Y%m%d")]["used"] == "10"
    st = r.kv["wakeline:provider:portmis"]
    assert st["last_records"] == "1" and st["budget_limit"] == "3000" and st["budget_used"] == "10"
    assert lk.metrics()["portcall_requests"] == "10" and lk.metrics()["portcall_lookups"] == "1"
    assert [rec.getMessage() for rec in caplog.records if rec.name == "job.portcalls"] == ["portcalls 230025: ok, 1 item(s)"]
    _no_secret_anywhere(r, caplog)


async def test_no_records_anywhere_is_none_for_6h():
    r = FakeRedis()
    lk, _, _ = _lookup(r)
    with respx.mock:
        respx.get(URL).mock(side_effect=_responder({}))
        lk.request(["D7AB2"])
        await _drain(lk)
    v = _cached(r, "D7AB2")
    assert v["status"] == "none" and v["items"] == [] and _ttl(r, "D7AB2") > 6 * 3600 - 5


async def test_follows_total_count_pages_and_merges():
    r = FakeRedis()
    lk, _, _ = _lookup(r)
    p1 = page([item(at=f"2026-09-{d:02d}T00:00:00+09:00") for d in range(1, 21)] + [item(clsgn="OTHER1")], 45)
    p2 = page([item(code="020", at="2026-09-29T12:00:00+09:00")] * 3, 45)
    with respx.mock:
        route = respx.get(URL).mock(side_effect=_responder({("020", 1): p1, ("020", 2): p2}, default=page([], 45)))
        lk.request(["230025"])
        await _drain(lk)
    # 020: totalCount 45 → 1쪽(50)으로 끝나야 하지만 우리는 쪽 수를 totalCount 로만 정한다: 45 ≤ 50 → 1쪽. 다른 항만청도 45 → 1쪽
    assert route.call_count == 10
    r2 = FakeRedis()
    lk2, _, _ = _lookup(r2)
    with respx.mock:
        route = respx.get(URL).mock(side_effect=_responder({("020", 1): page([item()] * 50, 60), ("020", 2): p2}))
        lk2.request(["230025"])
        await _drain(lk2)
    assert route.call_count == 11
    assert [(_q(c.request)["prtAgCd"], _q(c.request)["pageNo"]) for c in route.calls][:2] == [("020", "1"), ("020", "2")]
    v = _cached(r2, "230025")
    assert v["status"] == "ok" and v["truncated"] is True and v["incomplete"] is False
    assert v["items"][0]["entry_at"] == "2026-09-29T03:00:00Z"  # 2쪽의 가장 최근 입항이 맨 앞
    assert lk.counts["mismatched"] == 1  # 다른 호출부호의 기록은 버렸다


async def test_page_cap_marks_incomplete():
    r = FakeRedis()
    lk, _, _ = _lookup(r)
    with respx.mock:
        route = respx.get(URL).mock(side_effect=_responder({}, default=page([item()], 10_000)))
        lk.request(["230025"])
        await _drain(lk)
    assert route.call_count == 10 * pj.MAX_PAGES
    v = _cached(r, "230025")
    assert v["incomplete"] is True and v["status"] == "ok"


async def test_cached_call_sign_is_not_looked_up_again():
    r = FakeRedis()
    await r.set(KEY.format("230025"), '{"v":1}', ex=100)
    lk, _, _ = _lookup(r)
    with respx.mock(assert_all_called=False) as m:
        route = m.get(URL).mock(side_effect=_responder({}))
        lk.request(["230025"])
        await _drain(lk)
    assert route.call_count == 0


# ---- 꺼짐 ------------------------------------------------------------------------------------------------------------
@pytest.mark.parametrize(
    ("reason", "msg"), [("no_key", "DATA_GO_KR_SERVICE_KEY not set"), ("fixture", "fixture mode — no external calls")]
)
async def test_no_provider_writes_disabled_with_reason_for_2min(caplog, reason, msg):
    caplog.set_level(logging.INFO)
    r = FakeRedis()
    lk = PortCallLookup(r, None, Budget(r, {"portmis": 3000}), ProviderStatus(r), off_reason=reason)  # type: ignore[arg-type]
    with respx.mock(assert_all_called=False) as m:
        route = m.get(url__regex=r".*").mock(return_value=httpx.Response(200))
        lk.request(["230025"])
        await _drain(lk)
    assert route.call_count == 0
    v = _cached(r, "230025")
    assert v["status"] == "disabled" and v["reason"] == reason and 110 < _ttl(r, "230025") <= 120
    assert f"portcalls 230025: disabled ({msg})" in caplog.text


async def test_operator_switch_prevents_every_call():
    r = FakeRedis()
    await r.hset("wakeline:provider:portmis", "disabled", "1")
    lk, _, budget = _lookup(r)
    with respx.mock(assert_all_called=False) as m:
        route = m.get(URL).mock(side_effect=_responder({}))
        lk.request(["230025"])
        await _drain(lk)
    assert route.call_count == 0 and _cached(r, "230025")["reason"] == "operator"
    assert (await budget.usage("portmis"))[0] == 0


async def test_switch_off_while_waiting_sends_nothing_more_and_releases_the_budget():
    r = FakeRedis()
    lk, _, budget = _lookup(r)
    calls = 0

    def respond(req: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        if calls == 2:  # 두 번째 요청이 끝나면 운영자가 끈다 — 세 번째는 보내기 직전 확인에서 멈춘다
            r.kv.setdefault("wakeline:provider:portmis", {})["disabled"] = "1"
        return httpx.Response(200, content=empty_page())

    with respx.mock:
        respx.get(URL).mock(side_effect=respond)
        lk.request(["230025"])
        await _drain(lk)
    assert calls == 2
    assert _cached(r, "230025")["status"] == "disabled" and _cached(r, "230025")["reason"] == "operator"
    assert (await budget.usage("portmis"))[0] == 2  # 세 번째 예약은 되돌렸다


# ---- 실패 ------------------------------------------------------------------------------------------------------------
async def test_http_error_stops_the_lookup_and_is_error_for_5min(caplog):
    caplog.set_level(logging.INFO)
    r = FakeRedis()
    lk, _, budget = _lookup(r)
    with respx.mock:
        route = respx.get(URL).mock(side_effect=_responder({}, status={"200": 500}))
        lk.request(["230025"])
        await _drain(lk)
    assert [_q(c.request)["prtAgCd"] for c in route.calls] == ["020", "030", "200"]  # 실패 뒤 나머지 항만청은 묻지 않는다
    v = _cached(r, "230025")
    assert v["status"] == "error" and v["items"] == [] and v["error"] == "prtAgCd 200: HTTP 500 err"  # 상태 코드 + HTML 제목
    assert v["error_kind"] == "http" and v["error_code"] == "500"
    assert 290 < _ttl(r, "230025") <= 300
    assert (await budget.usage("portmis"))[0] == 3
    st = r.kv["wakeline:provider:portmis"]
    assert st["last_http_status"] == "500" and st["consecutive_failures"] == "1"
    _no_secret_anywhere(r, caplog)


async def test_result_code_error_is_error_with_provider_code(caplog):
    caplog.set_level(logging.INFO)
    r = FakeRedis()
    lk, _, _ = _lookup(r)
    body = page([], None, code="30", msg=f"SERVICE KEY IS NOT REGISTERED ERROR serviceKey={DECODED}")
    with respx.mock:
        respx.get(URL).mock(return_value=httpx.Response(200, content=body))
        lk.request(["230025"])
        await _drain(lk)
    v = _cached(r, "230025")
    assert (
        v["status"] == "error" and v["error"] == "prtAgCd 020: resultCode 30 · SERVICE KEY IS NOT REGISTERED ERROR serviceKey=***"
    )
    assert v["error_kind"] == "provider" and v["error_code"] == "30"
    _no_secret_anywhere(r, caplog)


async def test_key_echoed_in_an_error_body_is_masked_by_value(caplog):
    """공급자가 키를 본문에 되돌려 줘도(모양 규칙이 못 잡는 곳) 기동 때 올린 키 값으로 가린다."""
    caplog.set_level(logging.INFO)
    register_secrets(*service_key_forms(SERVICE_KEY))
    r = FakeRedis()
    lk, _, _ = _lookup(r)
    with respx.mock:
        respx.get(URL).mock(return_value=httpx.Response(502, text=f"bad gateway for key {DECODED} / {SERVICE_KEY}"))
        lk.request(["230025"])
        await _drain(lk)
    assert _cached(r, "230025")["status"] == "error"
    _no_secret_anywhere(r, caplog)


async def test_daily_budget_exhausted_mid_lookup_is_error():
    r = FakeRedis()
    lk, _, _ = _lookup(r, limit=4)
    with respx.mock:
        route = respx.get(URL).mock(side_effect=_responder({}))
        lk.request(["230025"])
        await _drain(lk)
    assert route.call_count == 4
    assert _cached(r, "230025")["error"] == "daily budget exhausted (used=4)"
    assert _cached(r, "230025")["error_kind"] == "budget" and _cached(r, "230025")["error_code"] is None


async def test_rate_limit_wait_exceeded_is_error_and_budget_released():
    r = FakeRedis()
    limiter = RateLimiter(100, 100, {PORTMIS_HOST: (0.01, 1)})
    lk, _, budget = _lookup(r, limiter=limiter, wait_s=0.05)
    with respx.mock:
        route = respx.get(URL).mock(side_effect=_responder({}))
        lk.request(["230025"])
        await _drain(lk)
    assert route.call_count == 1  # 두 번째 요청은 토큰을 기다리다 포기
    assert _cached(r, "230025")["status"] == "error" and (await budget.usage("portmis"))[0] == 1
    assert _cached(r, "230025")["error_kind"] == "rate_limited"


async def test_unexpected_body_is_a_response_error():
    r = FakeRedis()
    lk, _, _ = _lookup(r)
    body = b"<OpenAPI_ServiceResponse><cmmMsgHeader><errMsg>SERVICE ERROR</errMsg></cmmMsgHeader></OpenAPI_ServiceResponse>"
    with respx.mock:
        respx.get(URL).mock(return_value=httpx.Response(200, content=body))
        lk.request(["230025"])
        await _drain(lk)
    v = _cached(r, "230025")
    assert v["error_kind"] == "response" and v["error_code"] is None and "OpenAPI_ServiceResponse" in v["error"]


async def test_connection_failure_is_a_network_error_and_releases_the_budget():
    r = FakeRedis()
    lk, _, budget = _lookup(r)
    with respx.mock:
        respx.get(URL).mock(side_effect=httpx.ConnectError("refused"))
        lk.request(["230025"])
        await _drain(lk)
    assert _cached(r, "230025")["error_kind"] == "network" and (await budget.usage("portmis"))[0] == 0


async def test_redis_unavailable_means_no_lookup():
    r = FakeRedis()
    r.down = True
    lk, _, _ = _lookup(r)
    with respx.mock(assert_all_called=False) as m:
        route = m.get(URL).mock(side_effect=_responder({}))
        lk.request(["230025"])
        await _drain(lk)
    assert route.call_count == 0


async def test_cache_write_failure_holds_the_call_sign_for_its_ttl():
    r = FakeRedis()
    lk, _, _ = _lookup(r)

    async def boom(*a, **k):
        raise ConnectionError("oom")

    r.set = boom  # type: ignore[method-assign]
    with respx.mock:
        route = respx.get(URL).mock(side_effect=_responder({}))
        lk.request(["230025"])
        await _drain(lk)
        assert lk.request(["230025"]) == 0  # 같은 TTL 동안 다시 묻지 않는다(공급자 보호)
    assert route.call_count == 10 and "230025" in lk._hold


async def test_request_validates_dedupes_and_caps_pending():
    r = FakeRedis()
    lk, _, _ = _lookup(r, max_pending=2)
    with respx.mock(assert_all_called=False) as m:
        m.get(URL).mock(side_effect=_responder({}))
        assert lk.request(["230025", "230025", "ab", None, "AB 12", "D7AB2", "D7AB3"]) == 2
        assert lk.counts["dropped"] == 1
        await _drain(lk)


async def test_shutdown_releases_the_budget_of_the_request_not_sent():
    r = FakeRedis()
    limiter = RateLimiter(100, 100, {PORTMIS_HOST: (0.001, 1)})
    lk, _, budget = _lookup(r, limiter=limiter, wait_s=30)
    with respx.mock:
        respx.get(URL).mock(side_effect=_responder({}))
        lk.request(["230025"])
        for _ in range(50):
            await asyncio.sleep(0.01)
            if limiter.waiting:
                break
        await lk.aclose()
    assert (await budget.usage("portmis"))[0] == 1  # 첫 요청은 보냈고, 기다리던 두 번째는 되돌렸다
    assert KEY.format("230025") not in r.kv


# ---- 속도 상한 · 우선순위 ----------------------------------------------------------------------------------------------
def test_default_limiter_has_a_portmis_host_bucket_and_lowest_priority():
    lim = default_limiter(2.0, 0.8, 0.5)
    assert lim.host_rps(PORTMIS_HOST) == 1.0 and lim._hosts[PORTMIS_HOST].burst == 2
    assert default_limiter(2.0, 0.8, 0.5, 0.5).host_rps(PORTMIS_HOST) == 0.5
    assert PRIORITY_PORTCALL > PRIORITY_ROUTE


# ---- 수요 임대 읽기 ----------------------------------------------------------------------------------------------------
class _Rec:
    def __init__(self) -> None:
        self.asked: list[list[str]] = []
        self.provider = None

    def request(self, cs):
        self.asked.append(list(cs))
        return len(cs)

    async def aclose(self) -> None:
        pass


async def test_job_reads_live_leases_and_reasks_only_every_30s():
    r = FakeRedis()
    now_ms = [1_000_000.0]
    clock = [100.0]
    await r.zadd(DEMAND_KEY, {"230025": 2_000_000, "d7ab2": 2_000_000, "OLD1": 999_000, "bad key": 2_000_000})
    rec = _Rec()
    job = PortCallJob(r, rec, now_ms=lambda: now_ms[0], clock=lambda: clock[0])  # type: ignore[arg-type]
    assert await job.tick() == 2
    assert rec.asked == [["230025", "D7AB2"]]  # 만료된 임대·형식이 틀린 값은 넘기지 않는다
    clock[0] += 10
    assert await job.tick() == 0
    clock[0] += 25
    assert await job.tick() == 2


async def test_job_survives_redis_errors():
    r = FakeRedis()
    r.down = True
    rec = _Rec()
    job = PortCallJob(r, rec)  # type: ignore[arg-type]
    assert await job.tick() == 0 and job.errors == 1


async def test_job_caps_leases():
    r = FakeRedis()
    await r.zadd(DEMAND_KEY, {f"ZZ{i:04d}": 9e15 for i in range(40)})
    rec = _Rec()
    job = PortCallJob(r, rec)  # type: ignore[arg-type]
    await job.tick()
    assert len(rec.asked[0]) == pj.MAX_LEASES


async def test_job_run_stops_and_closes():
    r = FakeRedis()
    rec = _Rec()
    job = PortCallJob(r, rec, poll_s=0.01)  # type: ignore[arg-type]
    stop = asyncio.Event()
    t = asyncio.create_task(job.run(stop))
    await asyncio.sleep(0.05)
    stop.set()
    await asyncio.wait_for(t, 2)
