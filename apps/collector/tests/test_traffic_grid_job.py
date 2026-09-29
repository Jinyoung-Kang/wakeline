"""연안 교통량 작업(ADR-023): 호출 일정(regDt · 물러나기 · 시간당 상한) · 예산 · 모르는 칸 채우기(순서 · 부정 캐시 · 격리 · 오류 물러나기 ·
차단기) · DB 캐시 · 운영자 스위치 · 발행 · heartbeat · 서비스 키 비노출. 외부 호출 · 실제 Redis/DB 없이(가짜)."""

from __future__ import annotations

import asyncio
import json
import random
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
    steps = []
    for _ in range(len(tg.UNCHANGED_BACKOFF_S) + 1):
        clock.t = job.schedule.next_due
        await job.run_once()
        steps.append(round((job.schedule.next_due - clock.t).total_seconds()))
    assert statuses(db)[:2] == ["ok", "unchanged"]
    assert r.kv[SNAPSHOT_KEY] == first  # 같은 값(ETag 가 바뀌지 않는다) — TTL 만 늘었다
    # 한 주기 안에서는 짧게(발행이 늦은 것 — 늦은 만큼을 좁게 잰다), 그 뒤로는 공급자가 멈춘 것으로 보고 길게
    assert steps == [*tg.UNCHANGED_BACKOFF_S, tg.UNCHANGED_BACKOFF_S[-1]]
    assert steps[:3] == [60, 60, 60] and steps[-1] == 900


async def test_an_older_reg_dt_never_replaces_the_newer_snapshot():
    job, _k, _w, r, clock, db = setup(komsa_body("2026-09-29 18:10:05"), komsa_body("2026-09-29 18:05:05"))
    clock.advance(tg.PERIOD_S)  # 18:10:05 KST 자료가 나온 뒤
    await job.run_once()
    first = r.kv[SNAPSHOT_KEY]
    clock.t = job.schedule.next_due
    await job.run_once()
    assert statuses(db) == ["ok", "unchanged"]
    assert snapshot(r)["reg_dt_kst"] == "2026-09-29T18:10:05+09:00" and r.kv[SNAPSHOT_KEY] == first


def simulate_provider(
    lag_s: float,
    *,
    tick_s: float,
    hours: float = 24,
    jitter_s: float = 0,
    seed: int = 1,
    lag_after: tuple[float, float] | None = None,
    schedule: tg.KomsaSchedule | None = None,
) -> tuple[list[float], list[tuple[float, float]], tg.KomsaSchedule]:
    """공급자 모형(잰 값이 아니다 — 모르는 발행 지연을 넓게 훑는다): regDt 가 300 s 마다(+0–2 s) 찍히고, 그 regDt 는 lag_s(± jitter_s) 뒤에야
    응답에 나온다. 틱마다 실제 KomsaSchedule 로 부를지 정한다. lag_after = (이 초부터, 새 지연) — 공급자가 도중에 빨라지거나 느려진다.
    (호출 시각 목록, (시각, 그때 싣고 있는 regDt 의 나이) 목록, 일정)."""
    rnd = random.Random(seed)
    t0 = datetime(2026, 9, 29, tzinfo=UTC)
    regs: list[tuple[float, float]] = []
    for k in range(-2, int(hours * 3600 / tg.PERIOD_S) + 4):
        r = k * tg.PERIOD_S + 5 + rnd.uniform(0, 2)
        lag = lag_s if lag_after is None or r < lag_after[0] else lag_after[1]
        regs.append((r, r + max(0.0, lag + rnd.uniform(-jitter_s, jitter_s))))
    s = schedule or tg.KomsaSchedule()
    last: datetime | None = None
    stamps: list[float] = []
    ages: list[tuple[float, float]] = []
    t = 0.0
    while t < hours * 3600:
        now = t0 + timedelta(seconds=t)
        if s.due(now):
            reg = t0 + timedelta(seconds=max(r for r, a in regs if a <= t))
            s.called(now)
            stamps.append(t)
            if last is not None and reg <= last:
                s.on_unchanged(now)
            else:
                last = reg
                s.on_new(reg, now)
        if last is not None:
            ages.append((t, (now - last).total_seconds()))
        t += tick_s
    return stamps, ages, s


def max_in_any_hour(stamps: list[float]) -> int:
    best = j = 0
    for i, t in enumerate(stamps):
        while t - stamps[j] >= 3600:
            j += 1
        best = max(best, i - j + 1)
    return best


@pytest.mark.parametrize("tick_s", [30, 45])  # 45 s = 틱마다 채우기가 15 s 걸릴 때(run_periodic 은 끝난 뒤 30 s 쉰다)
@pytest.mark.parametrize("lag_s", [0, 30, 60, 90, 120, 150, 185, 240, 300])
@pytest.mark.parametrize("jitter_s", [0, 20])
def test_schedule_learns_how_late_the_provider_publishes_and_stays_fresh_within_the_budget(tick_s, lag_s, jitter_s):
    """검토 지적: 발행이 regDt 뒤 65 s 넘게 늦으면 주기마다 두 번 불러 시간당 상한에 막히고 하루 몇 시간씩 '멈춤'이 됐다(regDt 기준 고정 60 s).
    이제 늦은 만큼을 관측으로 배운다 — 하루 평균 시간당 13회 이하, 어느 한 시간이든 상한 이하, 첫 한 시간 뒤로는 regDt 나이가 늘 900 s 미만."""
    stamps, ages, s = simulate_provider(lag_s, tick_s=tick_s, jitter_s=jitter_s)
    assert len(stamps) <= 13 * 24, f"{len(stamps)} calls/day"
    assert max_in_any_hour(stamps) <= tg.HOURLY_CAP
    worst = max(a for t, a in ages if t >= 3600)
    assert worst < 900, f"regDt age reached {worst:.0f} s"
    assert tg.DELAY_MIN_S <= s.delay_s <= tg.DELAY_MAX_S


def test_the_learned_delay_comes_back_down_when_the_provider_speeds_up():
    """느린 발행(300 s)을 배운 뒤 공급자가 빨라지면(30 s) 추정이 주기마다 조금씩 내려와 자료가 다시 빨리 보인다."""
    stamps, ages, s = simulate_provider(300, tick_s=30, lag_after=(3 * 3600, 30))
    assert s.delay_s <= tg.DELAY_MIN_S + tg.DELAY_DECAY_S
    assert max(a for t, a in ages if t >= 20 * 3600) < 400
    assert len(stamps) <= 13 * 24


def test_zero_lag_keeps_one_call_per_period():
    stamps, _ages, s = simulate_provider(0, tick_s=30)
    assert len(stamps) <= 12 * 24 + 1 and s.delay_s == tg.DELAY_MIN_S


def test_a_slow_first_answer_is_not_learned_as_the_delay():
    """재기동 뒤 첫 호출 · 실패 뒤 받은 regDt 의 나이는 발행 지연이 아니다(그 regDt 가 언제 나왔는지 모른다) — 배우지 않는다."""
    s = tg.KomsaSchedule()
    reg = datetime(2026, 9, 29, 9, 5, 5, tzinfo=UTC)
    s.on_new(reg, reg + timedelta(seconds=280))
    assert s.delay_s == tg.PUBLISH_DELAY_S
    s.on_failure(reg + timedelta(seconds=400))
    s.on_new(reg + timedelta(seconds=300), reg + timedelta(seconds=700))
    assert s.delay_s == tg.PUBLISH_DELAY_S - tg.DELAY_DECAY_S  # 한 번에 받은 주기와 같게(줄여 볼 뿐 늘리지 않는다)


def test_early_call_bounds_the_delay_tightly():
    """이른 호출(unchanged) 뒤 새 regDt 를 받으면 발행 지연은 (마지막 이른 호출, 받은 때] 안이다 — 위쪽 끝을 쓰되 그 폭이 넓으면(긴 물러나기 ·
    실패 사이) 아래 끝 + LEARN_SLACK_S 로 좁힌다(틀리면 다음 주기에 다시 짧게 잰다)."""
    s = tg.KomsaSchedule()
    reg = datetime(2026, 9, 29, 9, 5, 5, tzinfo=UTC)
    s.on_new(reg, reg + timedelta(seconds=70))
    nxt = reg + timedelta(seconds=tg.PERIOD_S)
    s.on_unchanged(nxt + timedelta(seconds=60))
    s.on_new(nxt, nxt + timedelta(seconds=125))
    assert s.delay_s == 125
    assert s.next_due == nxt + timedelta(seconds=tg.PERIOD_S + 125)
    s.on_unchanged(s.next_due)  # 이번에는 더 늦다: 이른 호출 뒤 한참(실패 · 긴 물러나기) 뒤에야 받았다
    third = nxt + timedelta(seconds=tg.PERIOD_S)
    s.on_new(third, third + timedelta(seconds=500))
    assert s.delay_s == 125 + tg.LEARN_SLACK_S
    s.on_unchanged(third + timedelta(seconds=tg.PERIOD_S + 900))
    s.on_new(third + timedelta(seconds=tg.PERIOD_S), third + timedelta(seconds=tg.PERIOD_S + 2000))
    assert s.delay_s == tg.DELAY_MAX_S  # 위 끝: regDt + 5분 + 이 값 + 틱이 오래됨(900 s) 안에


async def test_the_learned_delay_survives_a_restart_via_the_heartbeat():
    job, _k, _w, r, clock, _db = setup(komsa_body())
    await job.run_once()
    # 아직 배우지 않았다 — 처음 추정(선택값)을 싣지 않는다
    assert r.kv["wakeline:collector"]["traffic_grid_publish_delay_s"] == ""
    reg = datetime(2026, 9, 29, 9, 5, 5, tzinfo=UTC)
    job.schedule.on_unchanged(reg + timedelta(seconds=tg.PERIOD_S + 120))  # 이른 호출 → 새 regDt 를 185 s 에 받음
    job.schedule.on_new(reg + timedelta(seconds=tg.PERIOD_S), reg + timedelta(seconds=tg.PERIOD_S + 185))
    clock.advance(30)
    await job.run_once()
    assert r.kv["wakeline:collector"]["traffic_grid_publish_delay_s"] == "185"
    again = TrafficGridJob(FakeKomsa(clock, komsa_body()), FakeWfs(), job.ctx, now=clock)
    await again.run_once()
    assert again.schedule.delay_s == 185.0
    r.kv["wakeline:collector"]["traffic_grid_publish_delay_s"] = "99999"  # 범위 밖(손댄 값) — 쓰지 않는다
    third = TrafficGridJob(FakeKomsa(clock, komsa_body()), FakeWfs(), job.ctx, now=clock)
    await third.run_once()
    assert third.schedule.delay_s == tg.PUBLISH_DELAY_S


async def test_restarts_cannot_exceed_the_hourly_cap_because_it_is_counted_in_redis():
    """재기동(또는 두 번째 수집기)마다 곧바로 부르더라도 Redis 시간 창(UTC 시 — KST 와 경계가 같다)이 막는다 → 어느 날 경계로 세어도 하루 360회 이하."""
    r = FakeRedis()
    clock = Clock()
    ctx = make_ctx(r, limits={"komsa_traffic": 400, "mof_grid4": 6000})
    ctx.db = TGDb([])  # type: ignore[assignment]
    calls = 0
    for _ in range(tg.HOURLY_CAP + 3):  # 30 s 마다 죽고 다시 뜨는 수집기
        k = FakeKomsa(clock, komsa_body())
        job = TrafficGridJob(k, FakeWfs(), ctx, now=clock)
        await job.run_once()
        calls += k.calls
        clock.advance(30)
    assert calls == tg.HOURLY_CAP
    assert r.kv["budget:komsa_traffic:h:2026092909"]["used"] == str(tg.HOURLY_CAP)
    assert r.kv["budget:komsa_traffic:20260929"]["used"] == str(tg.HOURLY_CAP)  # 거절된 호출은 하루 예산을 쓰지 않는다
    refused = [kw for _j, _p, kw in ctx.db.runs if kw["status"] == "budget_exhausted"]  # type: ignore[attr-defined]
    assert len(refused) == 3 and "hourly cap" in refused[0]["error_text"]
    assert job.schedule.next_due == datetime(2026, 9, 29, 10, 0, tzinfo=UTC)  # 다음 시가 시작할 때 다시 본다


async def test_a_call_not_sent_gives_back_both_the_day_and_the_hour():
    job, komsa, _w, r, _c, _db = setup(Throttled("apis.data.go.kr", "no slot"))
    await job.run_once()
    assert komsa.calls == 0
    assert r.kv["budget:komsa_traffic:20260929"]["used"] == "0" and r.kv["budget:komsa_traffic:h:2026092909"]["used"] == "0"


async def test_day_budget_refusal_gives_the_hour_back():
    job, komsa, _w, r, _c, db = setup(komsa_body(), limits={"komsa_traffic": 1, "mof_grid4": 6000})
    r.kv["budget:komsa_traffic:20260929"] = {"used": "1", "limit": "1"}
    await job.run_once()
    assert komsa.calls == 0 and statuses(db) == ["budget_exhausted"]
    assert r.kv["budget:komsa_traffic:h:2026092909"]["used"] == "0"


async def test_a_future_reg_dt_is_rejected_so_it_cannot_freeze_the_layer():
    """검토 지적: 미래 regDt 하나를 받으면 뒤의 옳은 자료가 모두 '더 이른 것'(unchanged)이 되어 층이 얼고 api 는 ok 로 보였다.
    수집기 시계보다 PUBLISH_FUTURE_SKEW_S 넘게 앞선 regDt 는 실패로 — 싣지 않고, 원본 · 품질 사례를 남긴다."""
    future = komsa_body("2026-09-30 18:05:05")  # 하루 앞
    job, _k, _w, r, clock, db = setup(komsa_body(), future, komsa_body("2026-09-29 18:10:05"))
    await job.run_once()
    clock.t = job.schedule.next_due
    await job.run_once()
    assert statuses(db) == ["ok", "error"]
    assert snapshot(r)["reg_dt_kst"] == "2026-09-29T18:05:05+09:00"
    run = db.runs[-1][2]
    assert "ahead of the collector clock" in run["error_text"] and run["raw_ref"]
    assert run["quality"][0][0] == "traffic_grid_reg_dt_future" and run["quality"][0][2]["reg_dt"] == "2026-09-30T09:05:05Z"
    assert "ahead of the collector clock" in r.kv["wakeline:provider:komsa_traffic"]["last_error"]
    assert job.schedule.next_due == clock.t + timedelta(seconds=tg.FAIL_BACKOFF_S[0])
    clock.t = job.schedule.next_due
    await job.run_once()
    assert snapshot(r)["reg_dt_kst"] == "2026-09-29T18:10:05+09:00"  # 옳은 다음 자료는 그대로 받는다


async def test_a_first_answer_from_the_future_is_rejected_but_small_clock_skew_is_accepted():
    job, _k, _w, r, _c, db = setup(komsa_body("2026-09-29 18:30:00"))  # 앞선 자료 없이 23분 앞
    await job.run_once()
    assert statuses(db) == ["error"] and SNAPSHOT_KEY not in r.kv
    job2, _k2, _w2, r2, _c2, db2 = setup(komsa_body("2026-09-29 18:07:05"))  # 50 s 앞 — 시계 차이 안
    await job2.run_once()
    assert statuses(db2) == ["ok"] and snapshot(r2)["reg_dt_utc"] == "2026-09-29T09:07:05Z"


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


async def test_a_lookup_that_keeps_failing_is_set_aside_for_a_day_and_counted_as_failed():
    """검토 지적: 계속 실패하는 칸(포털 게이트웨이 문서 · grid_no 불일치 등)을 6시간마다 영원히 다시 묻고 '위치 확인 중'으로 셌다.
    ID_MAX_FAILURES 번 연달아 실패하면 failed(부정 캐시, FAILED_TTL_S 뒤 다시) — 스냅샷에 pending 이 아니라 failed 로 센다."""
    wfs = FakeWfs(
        {
            "GR4_F2K41_D3": WfsError("portal gateway document instead of GML"),
            "GR4_F2K41_C3": WfsResult("found", cell=CELLS["GR4_F2K41_C3"]),
            "GR4_F2K41_C4": WfsResult("found", cell=CELLS["GR4_F2K41_C4"]),
        }
    )
    job, _k, _w, r, clock, db = setup(wfs=wfs)
    await job.run_once()
    for step in tg.ID_RETRY_S[: tg.ID_MAX_FAILURES - 1]:
        clock.advance(step)
        await job.run_once()
    assert tg.ID_MAX_FAILURES == 5 and wfs.asked.count("GR4_F2K41_D3") == tg.ID_MAX_FAILURES
    p = snapshot(r)
    assert (p["resolved"], p["pending"], p["failed"], p["unresolved"]) == (2, 0, 1, 1)
    neg = orjson.loads(r.kv[NEGATIVE_KEY]["GR4_F2K41_D3"])
    assert neg["reason"] == "failed"
    geom = [kw for j, _p, kw in db.runs if j == "traffic_grid_geom"][-1]
    assert geom["quality"][0][0] == "traffic_grid_lookup_failed" and geom["quality"][0][2]["grid_no"] == "GR4_F2K41_D3"
    assert r.kv["wakeline:collector"]["traffic_grid_failed"] == "1" and r.kv["wakeline:collector"]["traffic_grid_pending"] == "0"
    clock.advance(tg.ID_RETRY_S[-1] * 3)
    await job.run_once()
    assert wfs.asked.count("GR4_F2K41_D3") == tg.ID_MAX_FAILURES  # 하루 동안은 묻지 않는다
    clock.advance(tg.FAILED_TTL_S)
    await job.run_once()
    assert wfs.asked.count("GR4_F2K41_D3") == tg.ID_MAX_FAILURES + 1  # 하루 뒤 처음부터 다시


def test_retries_wait_behind_first_time_lookups():
    """오래 실패한 칸이 새 칸보다 먼저 나와 차단기(연달아 3번)를 걸고 채우기 전체를 멈추지 않게 — 실패 횟수가 적은 칸부터, 같으면 처음 본 순서."""
    g = tg.GridGeometry()
    g.observe([("A", 5), ("B", 4)], T0)
    g.failed("A", T0)
    g.observe([("C", 1)], T0)
    later = T0 + timedelta(seconds=tg.ID_RETRY_S[0])
    assert g.due(later, 10) == ["B", "C", "A"]


def test_failed_ids_survive_a_restart_with_their_own_shorter_ttl():
    g = tg.GridGeometry()
    at = orjson.dumps({"reason": "failed", "at": "2026-09-29T09:00:00Z"}).decode()
    nf = orjson.dumps({"reason": "not_found", "at": "2026-09-29T09:00:00Z"}).decode()
    bad = orjson.dumps({"reason": "made_up", "at": "2026-09-29T09:00:00Z"}).decode()
    assert g.load_negative({"GR4_A": at, "GR4_B": nf, "GR4_C": bad}) == 2
    t = datetime(2026, 9, 29, 9, 0, tzinfo=UTC)
    assert g.reasons(t + timedelta(hours=23)) == {"GR4_A": "failed", "GR4_B": "not_found"}
    assert g.reasons(t + timedelta(hours=25)) == {"GR4_B": "not_found"}
    assert g.observe([("GR4_A", 1), ("GR4_B", 1)], t + timedelta(hours=25)) == 1  # 기한이 지난 failed 만 다시 기다림에


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
