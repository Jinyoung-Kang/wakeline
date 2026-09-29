"""연안 교통량 작업(ADR-023): 호출 일정(regDt · 물러나기 · 시간당 상한) · 예산 · 모르는 칸 채우기(순서 · 부정 캐시 · 격리 · 오류 물러나기 ·
차단기) · DB 캐시 · 운영자 스위치 · 발행 · heartbeat · 서비스 키 비노출. 외부 호출 · 실제 Redis/DB 없이(가짜)."""

from __future__ import annotations

import asyncio
import json
from datetime import UTC, datetime, timedelta
from typing import Any

import orjson
import pytest
from fakes import FakeRedis, RecordingDb, make_ctx

from wakeline_collector import masking
from wakeline_collector.budget import DEFAULT_STRICT
from wakeline_collector.http import FetchResponse, ProviderHttpError, SendCancelled
from wakeline_collector.jobs import traffic_grid as tg
from wakeline_collector.jobs.traffic_grid import NEGATIVE_KEY, SNAPSHOT_KEY, TrafficGridJob
from wakeline_collector.marine_grid import Cell, WfsError, WfsResult
from wakeline_collector.providers.data_go_kr import WfsLookup
from wakeline_collector.ratelimit import Throttled
from wakeline_collector.traffic_grid import KomsaApiError, parse_komsa

REG0 = "2026-09-29 18:05:05"  # KST → 09:05:05 UTC
T0 = datetime(2026, 9, 29, 9, 6, 15, tzinfo=UTC)  # regDt 뒤 70 s 에 처음 부른다
SECRET = "Te5tKey+not/real==0123456789abcdef"


class Clock:
    def __init__(self, t: datetime = T0) -> None:
        self.t = t

    def __call__(self) -> datetime:
        return self.t

    def advance(self, s: float) -> None:
        self.t += timedelta(seconds=s)


def komsa_body(reg: str = REG0, items: list[tuple[str, int, float]] | None = None, total: int | None = None) -> bytes:
    items = [("GR4_F2K41_C3", 12, 34), ("GR4_F2K41_C4", 1, 0), ("GR4_F2K41_D3", 102, 100)] if items is None else items
    body: dict[str, Any] = {"items": {"item": [{"grid_id": g, "vmtc": v, "dnsty": d} for g, v, d in items]}, "regDt": reg}
    if total is not None:
        body["totalCount"] = total
    return json.dumps({"response": {"header": {"resultCode": "200", "resultMsg": "ok"}, "body": body}}).encode()


class FakeKomsa:
    name, cost, host = "komsa_traffic", 1, "apis.data.go.kr"

    def __init__(self, clock: Clock, *answers: bytes | BaseException, configured: bool = True) -> None:
        self.clock, self.answers, self.configured = clock, list(answers), configured
        self.calls = 0

    async def fetch(self, *, before_send=None):
        if before_send is not None and not await before_send():
            raise SendCancelled("apis.data.go.kr")
        a = self.answers.pop(0) if len(self.answers) > 1 else self.answers[0]
        if isinstance(a, Throttled):
            raise a
        self.calls += 1
        if isinstance(a, BaseException):
            raise a
        return FetchResponse(a, 200, {}, self.clock(), 42), parse_komsa(a)


def cell(g: str, lat: float, lon: float) -> Cell:
    return Cell(g, lat, lon, round(lat + 0.025, 3), round(lon + 0.025, 3), 1)


CELLS = {
    "GR4_F2K41_C3": cell("GR4_F2K41_C3", 37.45, 126.6),
    "GR4_F2K41_C4": cell("GR4_F2K41_C4", 37.45, 126.625),
    "GR4_F2K41_D3": cell("GR4_F2K41_D3", 37.425, 126.6),
}


class FakeWfs:
    name, cost, host = "mof_grid4", 1, "apis.data.go.kr"

    def __init__(self, answers: dict[str, WfsResult | BaseException] | None = None, configured: bool = True) -> None:
        self.answers = answers if answers is not None else {g: WfsResult("found", cell=c) for g, c in CELLS.items()}
        self.configured = configured
        self.asked: list[str] = []

    async def lookup(self, grid_no, *, wait_s=5.0, before_send=None):
        if before_send is not None and not await before_send():
            raise SendCancelled("apis.data.go.kr")
        a = self.answers.get(grid_no, WfsResult("not_found"))
        if isinstance(a, Throttled):
            raise a
        self.asked.append(grid_no)
        if isinstance(a, BaseException):
            raise a
        return WfsLookup(a, b"<xml/>", 30)


class TGDb(RecordingDb):
    def __init__(self, rows: list[tuple] | None = None) -> None:
        super().__init__()
        self.rows = rows
        self.runs: list[tuple[str, str, dict[str, Any]]] = []
        self.upserts: list[Cell] = []
        self.reads = 0

    async def read_marine_grid4(self):  # type: ignore[override]
        self.reads += 1
        return self.rows

    def record_run(self, job, provider, started_at, **kw):  # type: ignore[override]
        self.runs.append((job, provider, kw))

    def upsert_marine_grid4(self, cells, fetched_at):  # type: ignore[override]
        self.upserts.extend(cells)


def setup(
    *answers: bytes | BaseException,
    wfs: FakeWfs | None = None,
    rows: list[tuple] | None = None,
    limits=None,
    configured=True,
    fixture=False,
):
    r = FakeRedis()
    clock = Clock()
    ctx = make_ctx(r, limits=limits or {"komsa_traffic": 400, "mof_grid4": 6000}, fixture=fixture)
    ctx.db = TGDb([] if rows is None else rows)  # type: ignore[assignment]
    komsa = FakeKomsa(clock, *(answers or (komsa_body(),)), configured=configured)
    job = TrafficGridJob(komsa, wfs or FakeWfs(), ctx, now=clock)
    return job, komsa, job.wfs, r, clock, ctx.db


def snapshot(r: FakeRedis) -> dict[str, Any]:
    return orjson.loads(r.kv[SNAPSHOT_KEY])


def statuses(db: TGDb, job: str = "traffic_grid") -> list[str]:
    return [kw["status"] for j, _p, kw in db.runs if j == job]


# ---- 꺼짐 --------------------------------------------------------------------------------------------------------------


async def test_no_key_disables_without_calls_and_says_why():
    job, komsa, wfs, r, _c, _db = setup(configured=False)
    await job.run_once()
    await job.run_once()
    assert komsa.calls == 0 and wfs.asked == [] and SNAPSHOT_KEY not in r.kv
    assert r.kv["wakeline:collector"]["traffic_grid_state"] == "no_key"


async def test_fixture_mode_makes_no_external_calls():
    job, komsa, wfs, r, _c, _db = setup(fixture=True)
    await job.run_once()
    assert komsa.calls == 0 and wfs.asked == []
    assert r.kv["wakeline:collector"]["traffic_grid_state"] == "fixture"


def test_both_data_go_kr_budgets_fail_closed():
    assert {"komsa_traffic", "mof_grid4"} <= DEFAULT_STRICT


# ---- 한 틱 --------------------------------------------------------------------------------------------------------------


async def test_first_tick_fetches_fills_busiest_first_and_publishes():
    job, komsa, wfs, r, _c, db = setup()
    await job.run_once()
    assert komsa.calls == 1
    assert wfs.asked == ["GR4_F2K41_D3", "GR4_F2K41_C3", "GR4_F2K41_C4"]  # 척수 많은 칸 먼저
    assert sorted(c.grid_no for c in db.upserts) == sorted(CELLS)
    p = snapshot(r)
    assert (p["total"], p["resolved"], p["unresolved"], p["pending"]) == (3, 3, 0, 0)
    assert p["reg_dt_utc"] == "2026-09-29T09:05:05Z" and p["reg_dt_kst"] == "2026-09-29T18:05:05+09:00"
    assert ["GR4_F2K41_D3", 37.425, 126.6, 102, 100.0] in p["cells"]
    assert abs(r.ttl[SNAPSHOT_KEY] - (__import__("time").time() + tg.SNAPSHOT_TTL_S)) < 5
    hb = r.kv["wakeline:collector"]
    assert hb["traffic_grid_state"] == "active" and hb["traffic_grid_reg_dt"] == "2026-09-29T09:05:05Z"
    assert (hb["traffic_grid_resolved"], hb["traffic_grid_unresolved"], hb["traffic_grid_cells_known"]) == ("3", "0", "3")
    assert (hb["traffic_grid_calls_komsa"], hb["traffic_grid_calls_wfs"]) == ("1", "3")
    assert hb["traffic_grid_lag_s"] == "70.0" and hb["traffic_grid_last_ok"] == "2026-09-29T09:06:15Z"
    assert statuses(db) == ["ok"] and statuses(db, "traffic_grid_geom") == ["ok"]
    assert r.kv["wakeline:provider:komsa_traffic"]["last_records"] == "3"
    assert r.kv["wakeline:provider:mof_grid4"]["last_records"] == "3"


async def test_geometry_fills_over_several_ticks_and_the_snapshot_says_how_far(monkeypatch):
    monkeypatch.setattr(tg, "WFS_PER_TICK", 1)
    job, _k, wfs, r, clock, _db = setup()
    await job.run_once()
    p = snapshot(r)
    assert (p["resolved"], p["unresolved"], p["pending"]) == (1, 2, 2)
    assert [c[0] for c in p["cells"]] == ["GR4_F2K41_D3"]
    clock.advance(tg.PUBLISH_MIN_INTERVAL_S)
    await job.run_once()
    assert snapshot(r)["resolved"] == 2
    clock.advance(tg.PUBLISH_MIN_INTERVAL_S)
    await job.run_once()
    assert snapshot(r)["resolved"] == 3 and wfs.asked == ["GR4_F2K41_D3", "GR4_F2K41_C3", "GR4_F2K41_C4"]


# ---- 교통 호출 일정 ---------------------------------------------------------------------------------------------------


async def test_waits_for_the_next_reg_dt_before_calling_again():
    later = komsa_body("2026-09-29 18:10:05")
    job, komsa, _w, _r, clock, _db = setup(komsa_body(), later)
    await job.run_once()
    reg = datetime(2026, 9, 29, 9, 5, 5, tzinfo=UTC)
    assert job.schedule.next_due == reg + timedelta(seconds=tg.PERIOD_S + tg.PUBLISH_DELAY_S)
    for _ in range(9):  # 다음 regDt 가 나올 때까지(4분 50초) 틱마다 부르지 않는다
        clock.advance(30)
        await job.run_once()
    assert komsa.calls == 1
    clock.t = job.schedule.next_due
    await job.run_once()
    assert komsa.calls == 2 and job.snapshot is not None and job.snapshot.reg_dt.minute == 10


async def test_unchanged_reg_dt_backs_off_and_republishes_the_identical_value():
    job, komsa, _w, r, clock, db = setup(komsa_body())
    await job.run_once()
    first = r.kv[SNAPSHOT_KEY]
    clock.t = job.schedule.next_due
    await job.run_once()
    assert komsa.calls == 2 and statuses(db) == ["ok", "unchanged"]
    assert r.kv[SNAPSHOT_KEY] == first  # 같은 값(ETag 가 바뀌지 않는다) — TTL 만 늘었다
    assert job.schedule.next_due == clock.t + timedelta(seconds=120)
    clock.t = job.schedule.next_due
    await job.run_once()
    assert job.schedule.next_due == clock.t + timedelta(seconds=240)


async def test_an_older_reg_dt_never_replaces_the_newer_snapshot():
    job, _k, _w, r, clock, db = setup(komsa_body("2026-09-29 18:10:05"), komsa_body("2026-09-29 18:05:05"))
    await job.run_once()
    first = r.kv[SNAPSHOT_KEY]
    clock.t = job.schedule.next_due
    await job.run_once()
    assert statuses(db) == ["ok", "unchanged"]
    assert snapshot(r)["reg_dt_kst"] == "2026-09-29T18:10:05+09:00" and r.kv[SNAPSHOT_KEY] == first


async def test_no_more_than_the_hourly_cap_in_any_hour(monkeypatch):
    monkeypatch.setattr(tg, "UNCHANGED_BACKOFF_S", (0,))
    job, komsa, _w, _r, clock, _db = setup(komsa_body())
    stamps: list[datetime] = []
    for _ in range(240):  # 30 s 틱 · 2시간
        before = komsa.calls
        await job.run_once()
        if komsa.calls > before:
            stamps.append(clock.t)
        clock.advance(30)
    assert len(stamps) == 2 * tg.HOURLY_CAP
    for i, t in enumerate(stamps):
        assert sum(1 for u in stamps[i:] if (u - t).total_seconds() < 3600) <= tg.HOURLY_CAP
    assert tg.HOURLY_CAP * 24 < 500  # 포털 하루 한도 — 어느 날 경계로 세어도


async def test_failures_back_off_and_are_recorded_without_the_key():
    err = ProviderHttpError(500, f"gateway error for serviceKey={SECRET}&pageNo=1 ({SECRET})")  # 요청 URL · 키를 되돌려 주는 본문
    job, komsa, _w, r, clock, db = setup(err)
    masking.register_secrets(SECRET)
    try:
        await job.run_once()
        assert job.schedule.next_due == clock.t + timedelta(seconds=60)
        clock.t = job.schedule.next_due
        await job.run_once()
        assert job.schedule.next_due == clock.t + timedelta(seconds=120)
    finally:
        masking._SECRETS.clear()
    assert komsa.calls == 2 and statuses(db) == ["error", "error"]
    st = r.kv["wakeline:provider:komsa_traffic"]
    assert st["consecutive_failures"] == "2" and st["last_http_status"] == "500"
    blob = json.dumps({k: v for k, v in r.kv.items()}, default=str) + json.dumps(db.runs, default=str)
    assert SECRET not in blob and "serviceKey=***" in st["last_error"]
    assert SNAPSHOT_KEY not in r.kv


async def test_provider_result_code_error_is_a_failure():
    job, _k, _w, r, _c, db = setup(KomsaApiError("22", "LIMITED_NUMBER_OF_SERVICE_REQUESTS_EXCEEDS_ERROR"))
    await job.run_once()
    assert statuses(db) == ["error"] and "resultCode 22" in r.kv["wakeline:provider:komsa_traffic"]["last_error"]


async def test_daily_budget_exhausted_is_recorded_and_not_called():
    job, komsa, _w, _r, clock, db = setup(
        komsa_body(), komsa_body("2026-09-29 18:10:05"), limits={"komsa_traffic": 1, "mof_grid4": 6000}
    )
    await job.run_once()
    clock.t = job.schedule.next_due
    await job.run_once()
    assert komsa.calls == 1 and statuses(db) == ["ok", "budget_exhausted"]
    assert job.schedule.next_due == clock.t + timedelta(seconds=tg.SKIP_RETRY_S)


async def test_budget_store_down_fails_closed():
    job, komsa, wfs, r, _c, db = setup()
    r.down = True
    await job.run_once()
    assert komsa.calls == 0 and wfs.asked == [] and statuses(db) == ["budget_unavailable"]


async def test_throttled_or_switched_off_call_gives_the_budget_back():
    job, komsa, _w, r, _c, _db = setup(Throttled("apis.data.go.kr", "no slot"))
    await job.run_once()
    assert komsa.calls == 0 and r.kv.get("budget:komsa_traffic:20260929", {}).get("used") == "0"


async def test_operator_switches_stop_each_part():
    job, komsa, wfs, r, _c, _db = setup()
    r.kv["wakeline:provider:komsa_traffic"] = {"disabled": "1"}
    await job.run_once()
    assert komsa.calls == 0 and r.kv["wakeline:collector"]["traffic_grid_state"] == "operator_off"
    r.kv["wakeline:provider:komsa_traffic"] = {"disabled": "0"}
    r.kv["wakeline:provider:mof_grid4"] = {"disabled": "1"}
    await job.run_once()
    assert komsa.calls == 1 and wfs.asked == [] and snapshot(r)["pending"] == 3


async def test_partial_page_is_flagged():
    job, _k, _w, r, _c, _db = setup(komsa_body(total=6200))
    await job.run_once()
    assert snapshot(r)["partial"] is True


# ---- 격자 기하 --------------------------------------------------------------------------------------------------------


async def test_not_found_and_off_grid_are_negative_cached_and_quarantined():
    wfs = FakeWfs(
        {
            "GR4_F2K41_C3": WfsResult("found", cell=CELLS["GR4_F2K41_C3"]),
            "GR4_F2K41_C4": WfsResult("not_found"),
            "GR4_F2K41_D3": WfsResult("off_grid", detail="corner 37.4 off the 0.025° lattice"),
        }
    )
    job, _k, _w, r, clock, db = setup(komsa_body(), komsa_body("2026-09-29 18:10:05"), wfs=wfs)
    await job.run_once()
    p = snapshot(r)
    assert (p["resolved"], p["not_found"], p["off_grid"], p["pending"]) == (1, 1, 1, 0)
    neg = r.kv[NEGATIVE_KEY]
    assert (
        orjson.loads(neg["GR4_F2K41_C4"])["reason"] == "not_found" and orjson.loads(neg["GR4_F2K41_D3"])["reason"] == "off_grid"
    )
    geom = [kw for j, _p, kw in db.runs if j == "traffic_grid_geom"][0]
    assert geom["records_quarantined"] == 1 and geom["quality"][0][0] == "traffic_grid_off_grid"
    assert geom["quality"][0][2]["grid_no"] == "GR4_F2K41_D3"
    clock.t = job.schedule.next_due
    await job.run_once()
    assert wfs.asked == ["GR4_F2K41_D3", "GR4_F2K41_C3", "GR4_F2K41_C4"]  # 다음 스냅샷에서 다시 묻지 않는다
    clock.advance(tg.NEGATIVE_TTL_S)
    job.schedule.next_due = None
    await job.run_once()
    assert sorted(wfs.asked[3:]) == ["GR4_F2K41_C4", "GR4_F2K41_D3"]  # 7일 뒤 다시 묻는다


async def test_negative_cache_survives_restart_via_redis():
    job, _k, wfs, r, _c, _db = setup()
    r.kv[NEGATIVE_KEY] = {
        "GR4_F2K41_C4": orjson.dumps({"reason": "not_found", "at": "2026-09-29T08:00:00Z"}).decode(),
        "bad id!": orjson.dumps({"reason": "not_found", "at": "2026-09-29T08:00:00Z"}).decode(),
        "GR4_X": "not json",
    }
    await job.run_once()
    assert "GR4_F2K41_C4" not in wfs.asked and snapshot(r)["not_found"] == 1


async def test_wfs_errors_back_off_per_id_and_trip_the_breaker():
    boom = ProviderHttpError(502, "bad gateway")
    wfs = FakeWfs({g: boom for g in CELLS})
    job, _k, _w, r, clock, db = setup(wfs=wfs)
    await job.run_once()
    assert len(wfs.asked) == tg.FILL_BREAKER_ERRORS
    assert statuses(db, "traffic_grid_geom") == ["error"]
    assert r.kv["wakeline:provider:mof_grid4"]["last_http_status"] == "502"
    clock.advance(60)
    await job.run_once()
    assert len(wfs.asked) == 3  # 차단기(5분) · 칸별 물러나기(5분)
    clock.advance(tg.FILL_PAUSE_S[0])
    wfs.answers = {g: WfsResult("found", cell=c) for g, c in CELLS.items()}
    await job.run_once()
    assert snapshot(r)["resolved"] == 3


async def test_wfs_error_bodies_are_retried_later_not_negative_cached():
    wfs = FakeWfs(
        {
            "GR4_F2K41_D3": WfsError("unexpected srsName"),
            "GR4_F2K41_C3": WfsResult("found", cell=CELLS["GR4_F2K41_C3"]),
            "GR4_F2K41_C4": WfsResult("found", cell=CELLS["GR4_F2K41_C4"]),
        }
    )
    job, _k, _w, r, clock, _db = setup(wfs=wfs)
    await job.run_once()
    assert NEGATIVE_KEY not in r.kv and snapshot(r)["pending"] == 1
    clock.advance(60)
    await job.run_once()
    assert wfs.asked.count("GR4_F2K41_D3") == 1  # 5분 전에는 다시 묻지 않는다
    clock.advance(tg.ID_RETRY_S[0])
    await job.run_once()
    assert wfs.asked.count("GR4_F2K41_D3") == 2


async def test_wfs_daily_budget_is_respected():
    job, _k, wfs, _r, clock, db = setup(limits={"komsa_traffic": 400, "mof_grid4": 2})
    await job.run_once()
    assert len(wfs.asked) == 2
    clock.advance(30)
    await job.run_once()
    assert len(wfs.asked) == 2 and statuses(db, "traffic_grid_geom") == ["ok", "budget_exhausted"]


async def test_throttled_lookup_gives_the_budget_back_and_stops_the_tick():
    wfs = FakeWfs({g: Throttled("apis.data.go.kr", "no slot") for g in CELLS})
    job, _k, _w, r, _c, db = setup(wfs=wfs)
    await job.run_once()
    assert wfs.asked == [] and r.kv["budget:mof_grid4:20260929"]["used"] == "0"
    assert statuses(db, "traffic_grid_geom") == []


async def test_db_cache_skips_known_ids_and_ignores_invalid_rows():
    rows = [
        ("GR4_F2K41_C3", 37.45, 126.6, 37.475, 126.625, 5),
        ("GR4_F2K41_C4", 37.4512, 126.625, 37.4762, 126.65, None),  # 격자에 맞지 않음 — 쓰지 않는다
        ("bad id", 37.45, 126.6, 37.475, 126.625, None),
        ("GR4_F2K41_D3", 37.425, 126.6, 37.5, 126.625, None),  # 한 칸이 아니다
    ]
    job, _k, wfs, r, _c, _db = setup(rows=rows)
    await job.run_once()
    assert "GR4_F2K41_C3" not in wfs.asked and sorted(wfs.asked) == ["GR4_F2K41_C4", "GR4_F2K41_D3"]
    assert snapshot(r)["resolved"] == 3


async def test_fill_waits_for_the_db_cache_then_proceeds_without_it():
    job, _k, wfs, r, clock, db = setup()
    db.rows = None  # DB 에 닿지 못한다
    await job.run_once()
    assert wfs.asked == [] and snapshot(r)["pending"] == 3  # 교통 자료는 바로 싣는다(DB 에 의존하지 않는다)
    clock.advance(tg.DB_WAIT_S - 30)
    await job.run_once()
    assert wfs.asked == []
    clock.advance(30)
    await job.run_once()
    assert len(wfs.asked) == 3
    db.rows = [("GR4_F2K41_C3", 37.45, 126.6, 37.475, 126.625, 5)]
    clock.advance(tg.DB_RETRY_S)
    await job.run_once()
    assert job._db_loaded and db.reads >= 3


async def test_publish_failure_keeps_the_value_pending(monkeypatch):
    job, _k, _w, r, clock, _db = setup()
    orig = r.set

    async def broken(*a, **kw):
        raise ConnectionError("down")

    r.set = broken  # type: ignore[method-assign]
    await job.run_once()
    assert SNAPSHOT_KEY not in r.kv
    r.set = orig  # type: ignore[method-assign]
    clock.advance(30)
    await job.run_once()
    assert snapshot(r)["resolved"] == 3


async def test_cancelled_lookup_before_sending_gives_the_budget_back():
    started = asyncio.Event()

    class SlowWfs(FakeWfs):
        async def lookup(self, grid_no, *, wait_s=5.0, before_send=None):
            started.set()
            await asyncio.sleep(10)  # 속도 상한 대기 중(아직 보내지 않았다)
            raise AssertionError("not reached")

    job, _k, _w, r, _c, _db = setup(wfs=SlowWfs())
    t = asyncio.create_task(job.run_once())
    await asyncio.wait_for(started.wait(), 2)
    t.cancel()
    with pytest.raises(asyncio.CancelledError):
        await t
    assert r.kv["budget:mof_grid4:20260929"]["used"] == "0"


def test_geometry_queue_is_bounded(monkeypatch):
    monkeypatch.setattr(tg, "MAX_TRACKED", 2)
    g = tg.GridGeometry()
    assert g.observe([("A", 1), ("B", 2), ("C", 3)], T0) == 2
    assert g.dropped == 1 and g.due(T0, 10) == ["C", "B"]
