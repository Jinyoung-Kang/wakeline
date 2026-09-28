"""수요 기반 정밀 추적 작업(focus 5 s · hot 30 s) — 계약 v2 §A2. 외부 호출 없음(가짜 공급자 · fixture)."""

from __future__ import annotations

import asyncio
import base64
import gzip
import time
from datetime import UTC, datetime

import httpx
import orjson
import pytest
from fakes import FakeRedis, make_ctx

from wakeline_collector.demand import FOCUS_KEY, HOT_KEY, HOT_META_KEY, STATUS_KEY, DemandPoller, DemandStatus
from wakeline_collector.http import ProviderHttpError
from wakeline_collector.jobs import demand as dj
from wakeline_collector.jobs.demand import DemandTracker, focus_payload, hot_payload, plan_hot
from wakeline_collector.jobs.route import RouteLookup
from wakeline_collector.models import ProviderResult
from wakeline_collector.providers.adsbdb import RouteFetch
from wakeline_collector.providers.fixture import FixtureAircraftProvider, FixtureDemandProvider
from wakeline_collector.publisher import STREAM_AIRCRAFT
from wakeline_collector.ratelimit import RateLimiter, Throttled
from wakeline_collector.route import not_found as route_not_found


def _ac(hex_: str, lat: float = 35.0, lon: float = 139.0, **kw) -> dict:
    return {"hex": hex_, "lat": lat, "lon": lon, "alt_baro": 30000, "gs": 450, "track": 90, "seen_pos": 1.0, **kw}


class FakeDemandProvider:
    name = "adsb_fi"
    cost = 1
    host = "opendata.adsb.fi"

    def __init__(self) -> None:
        self.calls: list[tuple] = []
        self.fail: Exception | None = None
        self.ac: list[dict] = []
        self.gate: asyncio.Event | None = None

    def _res(self, ac: list[dict]) -> ProviderResult:
        data = {"ac": ac}
        return ProviderResult(self.name, orjson.dumps(data), datetime.now(UTC), 200, 40, data=data)

    async def fetch_icao(self, hexes, *, wait_s):
        self.calls.append(("icao", list(hexes), wait_s))
        if self.gate is not None:
            await self.gate.wait()
        if self.fail:
            raise self.fail
        return self._res(self.ac)

    async def fetch_point(self, lat, lon, radius_nm, *, wait_s):
        self.calls.append(("point", (lat, lon, radius_nm), wait_s))
        if self.fail:
            raise self.fail
        return self._res(self.ac)


def _now_ms() -> float:
    return time.time() * 1000


def _decode(fields):
    return orjson.loads(gzip.decompress(base64.b64decode(fields["payload"])))


def _status(r: FakeRedis) -> dict[str, dict]:
    return {k: orjson.loads(v) for k, v in r.kv.get(STATUS_KEY, {}).items()}


def _tracker(r: FakeRedis, prov, *, limits=None, limiter=None, clock=None):
    ctx = make_ctx(r, limits=limits or {"adsb_fi": 0})
    clk = clock or [0.0]
    t = DemandTracker(
        ctx,
        DemandPoller(r),  # type: ignore[arg-type]
        DemandStatus(r),  # type: ignore[arg-type]
        prov,
        limiter=limiter,
        clock=lambda: clk[0],
    )
    return t, ctx, clk


async def _drain(t: DemandTracker) -> None:
    tasks = [x for x in [t._focus_task, *(c.task for c in t._cells.values())] if x is not None]
    await asyncio.gather(*tasks)


# ---- 계획 ------------------------------------------------------------------------------------------------------------
def test_plan_hot_backs_off_then_skips():
    assert plan_hot(6, 0.64, 0.3) == (30, 6)  # 정상: 0.1 region + 0.2 focus, 6셀 × 1/30 = 0.2
    assert plan_hot(6, 0.64, 0.5) == (60, 6)  # 0.14 남음 → 30 s 는 부족, 60 s 는 충분
    assert plan_hot(6, 0.64, 0.6) == (120, 4)  # 120 s 로도 부족 → 앞 순위 4셀만
    assert plan_hot(3, 0.64, 1.0) == (120, 0)
    assert plan_hot(0, 0.64, 0.0) == (30, 0)


def test_payload_helpers():
    from wakeline_collector.demand import HotCell

    assert focus_payload(["abcdef"], [], ["abcdef"]) == {
        "region": None,
        "requested": ["abcdef"],
        "missing": ["abcdef"],
        "states": [],
    }
    cell = HotCell("35.5:139.5:150", 35.5, 139.5, 150, 0.0)
    assert hot_payload(cell, []) == {
        "region": {"lat": 35.5, "lon": 139.5, "radius_nm": 150},
        "cell": "35.5:139.5:150",
        "states": [],
    }


# ---- focus ------------------------------------------------------------------------------------------------------------
async def test_focus_publishes_requested_missing_and_status():
    r = FakeRedis()
    await r.zadd(FOCUS_KEY, {"abcdef": _now_ms() + 60_000, "71c0a1": _now_ms() + 60_000, "a1b2c3": _now_ms() + 60_000})
    prov = FakeDemandProvider()
    prov.ac = [
        _ac("abcdef"),
        _ac("71c0a1", seen_pos=None),  # 위치 시각 없음 → 격리(DH-13)
        _ac("ffffff"),  # 요청하지 않은 항공기 → 싣지 않는다
    ]
    t, ctx, _clk = _tracker(r, prov)
    await t.tick()
    await _drain(t)
    assert prov.calls == [("icao", ["71c0a1", "a1b2c3", "abcdef"], dj.FOCUS_WAIT_S)]  # 한 요청에 묶음
    ((sid, fields),) = r.streams[STREAM_AIRCRAFT]
    assert (
        fields["scope"] == "focus" and fields["kind"] == "aircraft" and fields["provider"] == "adsb_fi" and fields["count"] == "1"
    )
    p = _decode(fields)
    assert p["region"] is None and p["requested"] == ["71c0a1", "a1b2c3", "abcdef"] and p["missing"] == ["71c0a1", "a1b2c3"]
    assert [s["hex"] for s in p["states"]] == ["abcdef"]
    st = _status(r)
    assert (
        st["focus:abcdef"]["state"] == "active"
        and st["focus:abcdef"]["interval_s"] == 5
        and st["focus:abcdef"]["last_success_at"]
    )
    assert st["focus:71c0a1"] == {
        "state": "not_found",
        "interval_s": 5,
        "last_success_at": None,
        "last_error": "no usable position (no_position_time)",
        "provider": "adsb_fi",
    }
    assert st["focus:a1b2c3"]["last_error"] == "not in provider response"
    assert ctx.db.names == ["ingest_run(focus)"]  # type: ignore[attr-defined]
    assert (await r.hgetall("wakeline:collector"))["focus_at"]
    assert (await ctx.budget.usage("adsb_fi"))[0] == 1


async def test_focus_cadence_is_5s_and_new_hex_is_fetched_early():
    r = FakeRedis()
    await r.zadd(FOCUS_KEY, {"abcdef": _now_ms() + 60_000})
    prov = FakeDemandProvider()
    t, _ctx, clk = _tracker(r, prov)
    await t.tick()
    await _drain(t)
    clk[0] = 1.0
    assert await t.tick() == pytest.approx(1.0)
    clk[0] = 1.5
    await r.zadd(FOCUS_KEY, {"71c0a1": _now_ms() + 60_000})  # 새 선택 → 최소 간격 2 s 전이라 아직
    await t.tick()
    assert len(prov.calls) == 1
    clk[0] = 2.0
    await t.tick()  # 새 hex + 2 s 경과 → 바로
    await _drain(t)
    assert len(prov.calls) == 2 and prov.calls[1][1] == ["71c0a1", "abcdef"]
    clk[0] = 5.0
    await t.tick()
    assert len(prov.calls) == 2  # 다음 차례는 2.0 + 5 = 7.0
    clk[0] = 7.0
    await t.tick()
    await _drain(t)
    assert len(prov.calls) == 3


async def test_focus_does_not_overlap_a_slow_request():
    r = FakeRedis()
    await r.zadd(FOCUS_KEY, {"abcdef": _now_ms() + 60_000})
    prov = FakeDemandProvider()
    prov.gate = asyncio.Event()
    t, _ctx, clk = _tracker(r, prov)
    await t.tick()
    await asyncio.sleep(0)
    clk[0] = 10.0
    await t.tick()
    assert len(prov.calls) == 1  # 앞 조회가 끝나지 않았으면 겹쳐 보내지 않는다
    prov.gate.set()
    await _drain(t)


async def test_focus_batches_over_limit(monkeypatch):
    monkeypatch.setattr(dj, "FOCUS_BATCH", 2)
    r = FakeRedis()
    await r.zadd(FOCUS_KEY, {h: _now_ms() + 60_000 for h in ("a00001", "a00002", "a00003", "a00004", "a00005")})
    prov = FakeDemandProvider()
    t, _ctx, _clk = _tracker(r, prov)
    await t.tick()
    await _drain(t)
    assert [c[1] for c in prov.calls] == [["a00001", "a00002"], ["a00003", "a00004"], ["a00005"]]
    assert len(r.streams[STREAM_AIRCRAFT]) == 3


async def test_focus_budget_share_exhausted_is_throttled_not_called(monkeypatch):
    monkeypatch.setattr(dj.settings, "demand_budget_reserve_region", 9)
    r = FakeRedis()
    await r.zadd(FOCUS_KEY, {"abcdef": _now_ms() + 60_000})
    prov = FakeDemandProvider()
    prov.ac = [_ac("abcdef")]
    t, ctx, clk = _tracker(r, prov, limits={"adsb_fi": 10})
    await t.tick()
    await _drain(t)
    clk[0] = 5.0
    await t.tick()
    await _drain(t)
    assert len(prov.calls) == 1  # 두 번째는 예산 여유분(관심 지역 몫 9) 때문에 호출하지 않는다
    st = _status(r)["focus:abcdef"]
    assert st["state"] == "throttled" and "daily budget share exhausted" in st["last_error"]
    assert st["last_success_at"]  # 직전 성공 시각은 그대로 보인다
    assert ctx.db.names[-1] == "ingest_run(focus)"  # type: ignore[attr-defined]
    ok, _ = await ctx.budget.reserve("adsb_fi")  # 관심 지역 폴백은 여전히 예약할 수 있다
    assert ok


@pytest.mark.parametrize(
    ("exc", "state", "released"),
    [
        (Throttled("opendata.adsb.fi", "no slot within 4.0 s"), "throttled", True),
        (ProviderHttpError(429, "slow down"), "throttled", False),
        (ProviderHttpError(500, "boom"), "error", False),
        (httpx.ConnectError("refused"), "error", True),
        (ValueError("unexpected readsb response shape"), "error", False),
    ],
)
async def test_focus_failures_are_reported_honestly(exc, state, released):
    r = FakeRedis()
    await r.zadd(FOCUS_KEY, {"abcdef": _now_ms() + 60_000})
    prov = FakeDemandProvider()
    prov.fail = exc
    t, ctx, _clk = _tracker(r, prov)
    await t.tick()
    await _drain(t)
    st = _status(r)["focus:abcdef"]
    assert st["state"] == state and st["last_success_at"] is None and st["last_error"]
    assert STREAM_AIRCRAFT not in r.streams
    assert (await ctx.budget.usage("adsb_fi"))[0] == (0 if released else 1)  # 보내지 않은 호출은 예산을 되돌린다


# ---- hot ---------------------------------------------------------------------------------------------------------------
async def _hot_leases(r: FakeRedis, n: int) -> list[str]:
    keys = [f"{10 + i}.0:120.0:100" for i in range(n)]
    await r.zadd(HOT_KEY, {k: _now_ms() + 60_000 for k in keys})
    await r.hset(HOT_META_KEY, mapping={k: orjson.dumps({"sessions": n - i}).decode() for i, k in enumerate(keys)})
    return keys


async def test_hot_cell_published_with_cell_and_region():
    r = FakeRedis()
    (key,) = await _hot_leases(r, 1)
    prov = FakeDemandProvider()
    prov.ac = [_ac("abcdef", 10.2, 120.1), _ac("bbbbbb", 10.3, 120.2, alt_baro="ground")]
    t, ctx, _clk = _tracker(r, prov)
    await t.tick()
    await _drain(t)
    assert prov.calls == [("point", (10.0, 120.0, 100), 15.0)]
    ((_sid, fields),) = r.streams[STREAM_AIRCRAFT]
    p = _decode(fields)
    assert fields["scope"] == "hot" and p["cell"] == key and p["region"] == {"lat": 10.0, "lon": 120.0, "radius_nm": 100}
    assert {s["hex"]: s["alt_ft"] for s in p["states"]} == {"abcdef": 30000, "bbbbbb": None}  # 지상 고도 0 을 만들지 않는다
    st = _status(r)[f"hot:{key}"]
    assert st["state"] == "active" and st["interval_s"] == 30
    assert ctx.db.names == ["ingest_run(hot)"]  # type: ignore[attr-defined]


async def test_hot_capacity_plan_skips_low_ranked_cells():
    r = FakeRedis()
    keys = await _hot_leases(r, 6)
    await r.zadd(FOCUS_KEY, {f"a0000{i}": _now_ms() + 60_000 for i in range(1)})
    prov = FakeDemandProvider()
    lim = RateLimiter(2.0, 2, {"opendata.adsb.fi": (0.2, 1)})  # 계획 용량 0.16 req/s − region 0.1 − focus 0.2 → 0
    t, _ctx, _clk = _tracker(r, prov, limiter=lim)
    await t.tick()
    await _drain(t)
    assert [c[0] for c in prov.calls] == ["icao"]  # hot 은 한 셀도 못 돈다(focus 우선)
    st = _status(r)
    assert all(st[f"hot:{k}"]["state"] == "throttled" for k in keys)
    assert st[f"hot:{keys[0]}"]["last_error"] == "capacity: 0 of 6 cells served at 120 s"
    before = dict(r.kv[STATUS_KEY])
    delay = await t.tick()  # 같은 상태는 다시 쓰지 않는다
    assert r.kv[STATUS_KEY] == before
    assert delay >= 0.5  # 용량 밖 셀 때문에 틱이 바빠지지 않는다(수요 임대 읽기는 초당 1회 수준)


async def test_hot_throttled_cell_backs_off_30_60_120_and_recovers():
    r = FakeRedis()
    (key,) = await _hot_leases(r, 1)
    prov = FakeDemandProvider()
    prov.fail = Throttled("opendata.adsb.fi", "no slot within 15.0 s")
    t, _ctx, clk = _tracker(r, prov)
    await t.tick()
    await _drain(t)
    cell = t._cells[key]
    assert cell.level == 1 and cell.interval_s == 60 and cell.next_due == 60
    assert _status(r)[f"hot:{key}"]["state"] == "throttled" and _status(r)[f"hot:{key}"]["interval_s"] == 60
    clk[0] = 60
    await t.tick()
    await _drain(t)
    assert cell.level == 2 and cell.interval_s == 120 and cell.next_due == 180 and prov.calls[-1][2] == 15.0
    prov.fail = None
    clk[0] = 180
    await t.tick()
    await _drain(t)
    assert cell.level == 1 and cell.interval_s == 60 and cell.next_due == 240  # 성공 → 한 단계 돌아온다
    assert _status(r)[f"hot:{key}"] | {"last_success_at": None} == {
        "state": "active",
        "interval_s": 60,
        "last_success_at": None,
        "last_error": None,
        "provider": "adsb_fi",
    }
    clk[0] = 240
    await t.tick()
    await _drain(t)
    assert cell.level == 0 and cell.interval_s == 30 and cell.next_due == 270


async def test_lease_gone_prunes_status_and_stops_calls():
    r = FakeRedis()
    (key,) = await _hot_leases(r, 1)
    await r.zadd(FOCUS_KEY, {"abcdef": _now_ms() + 60_000})
    prov = FakeDemandProvider()
    t, _ctx, clk = _tracker(r, prov)
    await t.tick()
    await _drain(t)
    assert set(_status(r)) == {"focus:abcdef", f"hot:{key}"}
    r.kv[FOCUS_KEY].clear()
    r.kv[HOT_KEY].clear()  # 창을 닫음 → api 가 임대를 지움(또는 만료)
    clk[0] = 100
    n = len(prov.calls)
    await t.tick()
    await _drain(t)
    assert _status(r) == {} and len(prov.calls) == n and t._cells == {}


async def test_result_for_a_lease_that_vanished_mid_flight_is_not_written():
    r = FakeRedis()
    await r.zadd(FOCUS_KEY, {"abcdef": _now_ms() + 60_000})
    prov = FakeDemandProvider()
    prov.gate = asyncio.Event()
    t, _ctx, _clk = _tracker(r, prov)
    await t.tick()
    r.kv[FOCUS_KEY].clear()
    await t.poller.poll()
    prov.gate.set()
    await _drain(t)
    assert "focus:abcdef" not in _status(r)


# ---- 남용 방지(계약 v3 §C) ---------------------------------------------------------------------------------------------
async def test_focus_fast_path_is_at_most_once_per_5s():
    r = FakeRedis()
    await r.zadd(FOCUS_KEY, {"abcdef": _now_ms() + 60_000})
    prov = FakeDemandProvider()
    t, _ctx, clk = _tracker(r, prov)

    async def at(sec: float, new_hex: str | None = None) -> int:
        clk[0] = sec
        if new_hex:
            await r.zadd(FOCUS_KEY, {new_hex: _now_ms() + 60_000})
        await t.tick()
        await _drain(t)
        return len(prov.calls)

    assert await at(0.0) == 1  # 정규(첫 조회), 다음 차례 5.0
    assert await at(2.0, "71c0a1") == 2  # 새 hex → fast path, 다음 차례 7.0
    assert await at(4.5, "a1b2c3") == 2  # 새 hex 지만 fast path 는 5 s 에 1회(전: 2 s 간격이면 바로)
    assert await at(6.9) == 2
    assert await at(7.0) == 3 and prov.calls[-1][1] == ["71c0a1", "a1b2c3", "abcdef"]  # 정규 차례에 함께
    assert await at(9.0, "b00001") == 4  # 앞 fast path(2.0)로부터 5 s 가 지났다


async def test_new_hot_cells_immediate_fetch_is_at_most_2_per_30s():
    r = FakeRedis()
    keys = await _hot_leases(r, 4)
    prov = FakeDemandProvider()
    t, _ctx, clk = _tracker(r, prov)
    await t.tick()
    await _drain(t)
    assert [c[1] for c in prov.calls] == [(10.0, 120.0, 100), (11.0, 120.0, 100)]  # 순위 앞 2개만 즉시
    st = _status(r)
    assert {k for k in keys if f"hot:{k}" in st} == set(keys[:2])  # 나머지는 상태를 쓰지 않는다(대기)
    assert t._cells[keys[2]].next_due == 30 and t._cells[keys[3]].next_due == 30  # 정규 일정: 한 주기 뒤 첫 조회
    late = "20.0:120.0:100"
    await r.zadd(HOT_KEY, {late: _now_ms() + 60_000})
    clk[0] = 10.0
    await t.tick()
    await _drain(t)
    assert len(prov.calls) == 2 and t._cells[late].next_due == 40  # 30 s 창에 즉시 조회 2개를 이미 썼다
    clk[0] = 30.0
    await t.tick()
    await _drain(t)
    assert sorted(c[1][0] for c in prov.calls[2:]) == [10.0, 11.0, 12.0, 13.0]
    clk[0] = 40.0
    await t.tick()
    await _drain(t)
    assert prov.calls[-1][1] == (20.0, 120.0, 100) and len(prov.calls) == 7


async def test_operator_disabled_provider_gets_no_demand_calls():
    """리뷰 2026-09-28b #2: 운영자가 adsb_fi 를 끄면(wakeline:provider:adsb_fi disabled=1) focus·hot 도 부르지 않는다."""
    r = FakeRedis()
    (key,) = await _hot_leases(r, 1)
    await r.zadd(FOCUS_KEY, {"abcdef": _now_ms() + 60_000})
    prov = FakeDemandProvider()
    prov.ac = [_ac("abcdef")]
    t, _ctx, clk = _tracker(r, prov)
    await t.tick()
    await _drain(t)
    assert len(prov.calls) == 2 and _status(r)["focus:abcdef"]["state"] == "active"
    await r.hset("wakeline:provider:adsb_fi", "disabled", "1")
    for sec in (5.0, 30.0, 60.0):  # focus·hot 차례가 와도 부르지 않는다
        clk[0] = sec
        assert await t.tick() == dj.TICK_S
        await _drain(t)
    assert len(prov.calls) == 2
    st = _status(r)
    for f in ("focus:abcdef", f"hot:{key}"):
        assert st[f]["state"] == "disabled" and st[f]["last_error"] == "provider disabled by operator"
        assert st[f]["interval_s"] is None and st[f]["last_success_at"]  # 주기는 없고, 직전 성공 시각은 그대로
    await r.hset("wakeline:provider:adsb_fi", "disabled", "0")
    clk[0] = 61.0
    await t.tick()
    await _drain(t)
    assert [c[0] for c in prov.calls[2:]] == ["icao", "point"]  # 다시 켜면 곧바로 돈다
    st = _status(r)
    assert st["focus:abcdef"]["state"] == "active" and st[f"hot:{key}"]["state"] == "active"


class QueuedDemandProvider(FakeDemandProvider):
    """속도 상한 대기열에서 기다리는 조회를 흉내 낸다: gate 가 열려야 '전송'(calls 기록)한다."""

    async def fetch_icao(self, hexes, *, wait_s):
        assert self.gate is not None
        await self.gate.wait()
        self.calls.append(("icao", list(hexes), wait_s))
        return self._res(self.ac)


async def test_operator_disable_cancels_calls_already_waiting_to_be_sent():
    """리뷰 2026-09-28b #2 후속: 끄기 전에 대기열에 들어간 조회도 끈 뒤에는 보내지 않는다."""
    r = FakeRedis()
    await r.zadd(FOCUS_KEY, {"abcdef": _now_ms() + 60_000})
    prov = QueuedDemandProvider()
    prov.ac = [_ac("abcdef")]
    prov.gate = asyncio.Event()
    t, _ctx, clk = _tracker(r, prov)
    await t.tick()
    assert t._focus_task is not None and not t._focus_task.done()  # 대기 중
    await r.hset("wakeline:provider:adsb_fi", "disabled", "1")
    clk[0] = 1.0
    await t.tick()
    prov.gate.set()
    await asyncio.sleep(0)
    assert t._focus_task.done() and prov.calls == []
    assert _status(r)["focus:abcdef"]["last_error"] == "provider disabled by operator"


async def test_disabled_status_is_cleared_when_re_enabled_before_next_turn():
    r = FakeRedis()
    (key,) = await _hot_leases(r, 1)
    prov = FakeDemandProvider()
    t, _ctx, clk = _tracker(r, prov)
    await t.tick()
    await _drain(t)
    await r.hset("wakeline:provider:adsb_fi", "disabled", "1")
    clk[0] = 5.0
    await t.tick()
    assert _status(r)[f"hot:{key}"]["last_error"] == "provider disabled by operator"
    await r.hset("wakeline:provider:adsb_fi", "disabled", "0")
    clk[0] = 10.0
    await t.tick()  # 셀 차례(30 s)는 아직 → 호출 없음. 지난 '꺼짐' 사유는 남기지 않는다(다음 결과까지 대기)
    assert len(prov.calls) == 1 and f"hot:{key}" not in _status(r)


# ---- fixture 모드 · 루프 ------------------------------------------------------------------------------------------------
async def test_fixture_mode_focus_and_hot_without_external_calls(fixtures_dir):
    base = FixtureAircraftProvider()
    region = (36.5, 127.8, 250)
    fx = FixtureDemandProvider(base, lambda: region)
    first = next(a for a in base._base["ac"] if a.get("alt_baro") != "ground")
    hex_ = first["hex"]
    res = await fx.fetch_icao([hex_, "000000"])
    assert (
        [a["hex"] for a in res.data["ac"]] == [hex_] and res.provider == "fixture" and res.extra["raw_ref"].startswith("fixture:")
    )
    near = await fx.fetch_point(36.5, 127.8, 250)
    far = await fx.fetch_point(35.5, 139.5, 150)  # 재생 자료는 한반도 주변뿐 → 비어 있다(사실대로)
    assert len(near.data["ac"]) > 50 and far.data["ac"] == []
    # 같은 hex 는 region 재생과 같은 위치(같은 기준으로 움직임)
    reg = await base.fetch_region(*region)
    pos_region = next((a["lat"], a["lon"]) for a in reg.data["ac"] if a["hex"] == hex_)
    pos_focus = (res.data["ac"][0]["lat"], res.data["ac"][0]["lon"])
    assert pos_region == pytest.approx(pos_focus, abs=1e-3)

    r = FakeRedis()
    await r.zadd(FOCUS_KEY, {hex_: _now_ms() + 60_000})
    ctx = make_ctx(r, fixture=True)
    t = DemandTracker(ctx, DemandPoller(r), DemandStatus(r), fx)  # type: ignore[arg-type]
    await t.tick()
    await _drain(t)
    p = _decode(r.streams[STREAM_AIRCRAFT][0][1])
    assert p["states"][0]["provider"] == "fixture" and p["missing"] == []
    assert _status(r)[f"focus:{hex_}"]["provider"] == "fixture"
    assert (await ctx.budget.usage("fixture"))[0] == 0  # 예산을 쓰지 않는다


async def test_run_loop_and_shutdown():
    r = FakeRedis()
    await r.zadd(FOCUS_KEY, {"abcdef": _now_ms() + 60_000})
    prov = FakeDemandProvider()
    prov.ac = [_ac("abcdef")]
    ctx = make_ctx(r)
    t = DemandTracker(ctx, DemandPoller(r), DemandStatus(r), prov)  # type: ignore[arg-type]
    stop = asyncio.Event()
    task = asyncio.create_task(t.run(stop))
    for _ in range(100):
        if r.streams.get(STREAM_AIRCRAFT):
            break
        await asyncio.sleep(0.01)
    assert r.streams[STREAM_AIRCRAFT]
    prov.gate = asyncio.Event()  # 다음 조회는 끝나지 않는다 → 종료 시 취소
    stop.set()
    await asyncio.wait_for(task, 2)
    m = t.metrics()
    assert m["demand_focus"] == "1" and m["demand_hot"] == "0" and m["demand_errors"] == "0"


async def test_aclose_cancels_stuck_fetch():
    r = FakeRedis()
    await r.zadd(FOCUS_KEY, {"abcdef": _now_ms() + 60_000})
    prov = FakeDemandProvider()
    prov.gate = asyncio.Event()
    t, _ctx, _clk = _tracker(r, prov)
    await t.tick()
    await asyncio.sleep(0)
    await t.aclose(wait_s=0.05)
    assert t._focus_task is not None and t._focus_task.cancelled()


async def test_tick_error_does_not_kill_loop(monkeypatch):
    r = FakeRedis()
    t, _ctx, _clk = _tracker(r, FakeDemandProvider())
    calls = 0

    async def boom():
        nonlocal calls
        calls += 1
        raise RuntimeError("bug")

    monkeypatch.setattr(t, "tick", boom)
    monkeypatch.setattr(dj, "TICK_S", 0.01)
    stop = asyncio.Event()
    task = asyncio.create_task(t.run(stop))
    await asyncio.sleep(0.05)
    stop.set()
    await asyncio.wait_for(task, 1)
    assert calls >= 2


# ---- 노선 조회(계약 v4 §A) -------------------------------------------------------------------------------------------
class GatedRouteProvider:
    """adsbdb 대역 — gate 가 열릴 때까지 응답하지 않는다(느린 공급자)."""

    name, cost, host = "adsbdb", 1, "api.adsbdb.com"

    def __init__(self) -> None:
        self.gate = asyncio.Event()
        self.calls: list[str] = []

    async def lookup(self, callsign, *, wait_s):
        self.calls.append(callsign)
        await self.gate.wait()
        return RouteFetch(route_not_found(callsign, datetime.now(UTC)), 404, 20)


def _routed_tracker(r: FakeRedis, prov, clk=None):
    ctx = make_ctx(r, limits={"adsb_fi": 0, "adsbdb": 2000})
    rprov = GatedRouteProvider()
    routes = RouteLookup(r, rprov, ctx.budget, ctx.status)  # type: ignore[arg-type]
    clk = clk or [0.0]
    t = DemandTracker(ctx, DemandPoller(r), DemandStatus(r), prov, routes=routes, clock=lambda: clk[0])  # type: ignore[arg-type]
    return t, routes, rprov, clk


async def _settle(routes: RouteLookup) -> None:
    for _ in range(50):
        if not routes.inflight:
            return
        await asyncio.sleep(0)


async def test_focus_results_request_route_lookups_without_delaying_publish():
    r = FakeRedis()
    await r.zadd(FOCUS_KEY, {"abcdef": _now_ms() + 60_000, "71c0a1": _now_ms() + 60_000, "a1b2c3": _now_ms() + 60_000})
    prov = FakeDemandProvider()
    prov.ac = [
        _ac("abcdef", flight="ZZX123  "),
        _ac("71c0a1", flight="ZZX777", seen_pos=None),  # 격리된 항공기의 콜사인은 묻지 않는다
        _ac("a1b2c3"),  # 콜사인 없음
    ]
    t, routes, rprov, _clk = _routed_tracker(r, prov)
    await t.tick()
    await _drain(t)  # focus 조회·발행은 노선 조회(아직 응답 없음)를 기다리지 않고 끝난다
    assert len(r.streams[STREAM_AIRCRAFT]) == 1 and _status(r)["focus:abcdef"]["state"] == "active"
    for _ in range(5):
        await asyncio.sleep(0)
    assert rprov.calls == ["ZZX123"] and routes.inflight == 1 and t.metrics()["route_inflight"] == "1"
    rprov.gate.set()
    await _settle(routes)
    assert orjson.loads(r.kv["wakeline:route:ZZX123"])["status"] == "not_found"
    routes.request(["ZZX123"])  # 다음 focus 결과에 같은 콜사인 — 캐시에 있으므로 다시 묻지 않는다
    await _settle(routes)
    assert rprov.calls == ["ZZX123"]


async def test_shutdown_cancels_pending_route_lookups():
    r = FakeRedis()
    await r.zadd(FOCUS_KEY, {"abcdef": _now_ms() + 60_000})
    prov = FakeDemandProvider()
    prov.ac = [_ac("abcdef", flight="ZZX123")]
    t, routes, rprov, _clk = _routed_tracker(r, prov)
    stop = asyncio.Event()
    task = asyncio.create_task(t.run(stop))
    for _ in range(100):
        if rprov.calls:
            break
        await asyncio.sleep(0.01)
    assert rprov.calls == ["ZZX123"] and routes.inflight == 1
    stop.set()
    await asyncio.wait_for(task, 2)
    assert routes.inflight == 0 and "wakeline:route:ZZX123" not in r.kv


async def test_adsb_fi_kill_switch_does_not_cancel_route_lookups():
    """adsb_fi 를 끄면 focus 는 멈추지만, 이미 시작한 노선 조회(다른 공급자)는 취소하지 않는다."""
    r = FakeRedis()
    await r.zadd(FOCUS_KEY, {"abcdef": _now_ms() + 60_000})
    prov = FakeDemandProvider()
    prov.ac = [_ac("abcdef", flight="ZZX123")]
    t, routes, rprov, clk = _routed_tracker(r, prov)
    await t.tick()
    await _drain(t)
    await asyncio.sleep(0)
    await r.hset("wakeline:provider:adsb_fi", "disabled", "1")
    clk[0] = 5.0
    await t.tick()
    assert routes.inflight == 1
    rprov.gate.set()
    await _settle(routes)
    assert "wakeline:route:ZZX123" in r.kv
