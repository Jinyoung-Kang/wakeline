"""연안 교통량 격자 기하 채우기가 수렴하는가(ADR-023 2026-10-01 개정) — 스냅샷 줄의 수가 무엇을 세는지 · 한 칸을 한 번만 묻는지 · 결과가 DB ·
부정 캐시에 남아 재기동 뒤 다시 묻지 않는지 · 채우기 한 번(pass)마다 INFO 요약 한 줄 · DB 없이 heartbeat 로 진행이 보이는지.
운영 로그(2026-09-30): 스냅샷마다 'N new unknown ids'(340–450, 재기동 직후 1,372)가 이어져 채우기가 끝나지 않는 것처럼 보였다 — 그 수는
'이 프로세스가 처음 대기열에 넣은 칸'이다(대기열은 메모리라 재기동하면 다시 센다). 외부 호출 · 실제 Redis/DB 없이(가짜)."""

from __future__ import annotations

import logging
import random
import re
from datetime import UTC, datetime, timedelta

import orjson
import pytest
from fakes import FakeRedis, make_ctx
from test_traffic_grid_job import CELLS, T0, Clock, FakeKomsa, FakeWfs, TGDb, cell, komsa_body, setup, snapshot

from wakeline_collector import traffic_grid_plan as plan
from wakeline_collector.http import ProviderHttpError
from wakeline_collector.jobs import traffic_grid as tg
from wakeline_collector.jobs.traffic_grid import NEGATIVE_KEY, TrafficGridJob
from wakeline_collector.marine_grid import WfsResult
from wakeline_collector.traffic_grid import KST

HB = "wakeline:collector"
MOF_HOUR = "budget:mof:h:2026092909"
LOGGER = "job.traffic_grid"
PASS_RE = re.compile(
    r"geometry fill pass (\S+) → (\S+) — (\d+) lookups: (\d+) found, (\d+) not in the MOF grid, (\d+) off grid, "
    r"(\d+) errors \((\d+) set aside as failed\)"
)


def lines(caplog, needle: str) -> list[str]:
    return [r.getMessage() for r in caplog.records if r.name == LOGGER and needle in r.getMessage()]


def passes(caplog) -> list[tuple[str, ...]]:
    out = []
    for m in (PASS_RE.search(s) for s in lines(caplog, "geometry fill pass")):
        assert m is not None
        out.append(m.groups())
    return out


# ---- 스냅샷 줄: 무엇을 세는가 ------------------------------------------------------------------------------------------


async def test_the_snapshot_line_says_how_many_cells_have_geometry_and_what_the_queue_count_counts(caplog):
    """전에는 'regDt … — 3846 cells (0 rejected, 342 new unknown ids)' — 수가 이 프로세스가 처음 대기열에 넣은 칸이라는 것도, 스냅샷의 몇 칸이
    지도에 그려지는지도 말하지 않았다. 이제 기하가 있는 칸 · 없는 칸(까닭별) · 대기열 크기와 새로 넣은 수를 적는다."""
    caplog.set_level(logging.INFO, logger=LOGGER)
    later = komsa_body(
        "2026-09-29 18:10:05",
        [("GR4_F2K41_C3", 12, 34), ("GR4_F2K41_C4", 1, 0), ("GR4_F2K41_D3", 102, 100), ("GR4_F2K41_E3", 3, 5)],
    )
    job, _k, _w, _r, clock, _db = setup(komsa_body(), later)
    await job.run_once()
    clock.t = job.schedule.next_due
    await job.run_once()
    got = lines(caplog, "traffic grid: regDt")
    assert got == [
        "traffic grid: regDt 2026-09-29T09:05:05Z — 3 cells (0 rejected): 0 with geometry, 3 without "
        "(3 waiting for a lookup, 0 not in the MOF grid, 0 off grid, 0 lookup failed); lookup queue 3 "
        "(+3 newly queued — first snapshot since this process started: the queue is not kept across restarts, "
        "so ids queued before a restart are counted again)",
        "traffic grid: regDt 2026-09-29T09:10:05Z — 4 cells (0 rejected): 3 with geometry, 1 without "
        "(1 waiting for a lookup, 0 not in the MOF grid, 0 off grid, 0 lookup failed); lookup queue 1 (+1 newly queued)",
    ]
    assert not lines(caplog, "new unknown ids")


async def test_a_full_queue_is_not_silent(monkeypatch, caplog):
    """대기열 상한(MAX_TRACKED)을 넘은 칸은 넣지 않는다(다음에 보일 때 다시 넣는다) — 전에는 수만 세고 로그 · heartbeat 어디에도 없었다."""
    caplog.set_level(logging.INFO, logger=LOGGER)
    monkeypatch.setattr(tg, "MAX_TRACKED", 2)
    monkeypatch.setattr(tg, "WFS_PER_TICK", 0)  # 이 시험은 대기열만 본다
    job, _k, _w, r, _c, _db = setup()
    await job.run_once()
    (line,) = lines(caplog, "traffic grid: regDt")
    assert (
        "0 with geometry, 3 without (2 waiting for a lookup, 0 not in the MOF grid, 0 off grid, 0 lookup failed, "
        "1 not queued — queue full at 2); lookup queue 2 (+2 newly queued"
    ) in line
    assert r.kv[HB]["traffic_grid_not_queued"] == "1"


async def test_not_queued_counts_distinct_cells_of_the_latest_snapshot_not_sightings(monkeypatch, caplog):
    """검토 지적: 예전 수(GridGeometry.dropped)는 넣지 못한 '칸'이라 적었지만 observe 를 부를 때마다(새 스냅샷 · 같은 regDt 의 unchanged 호출도)
    거절을 1씩 더했다 — 대기열이 차 있는 동안 (거절한 칸 × 호출 수)로 불어나 곧 있는 칸 수보다 커졌다. 이제 heartbeat · 요약 줄 · 스냅샷 줄 모두
    '마지막으로 읽은 스냅샷의 칸 가운데 대기열이 가득 차 넣지 못한 칸'(서로 다른 칸 수)이다."""
    caplog.set_level(logging.INFO, logger=LOGGER)
    monkeypatch.setattr(tg, "MAX_TRACKED", 3)
    items = [("GR4_Q1", 50, 1), ("GR4_Q2", 40, 1), ("GR4_Q3", 30, 1), ("GR4_Q4", 20, 1), ("GR4_Q5", 10, 1)]
    wfs = FakeWfs({g: WfsResult("found", cell=cell(g, 35.0, 129.0 + i * 0.025)) for i, (g, _v, _d) in enumerate(items)})
    same, later = komsa_body(items=items), komsa_body("2026-09-29 18:10:05", items)
    job, komsa, _w, r, clock, _db = setup(same, same, same, same, later, later, later, wfs=wfs)
    share = tg.MOF_HOURLY_CAP - tg.MOF_GRID4_HOURLY_HEADROOM
    r.kv[MOF_HOUR] = {"used": str(share - 1), "limit": str(tg.MOF_HOURLY_CAP)}  # 이 시에 남은 채우기 몫 1 — 그 뒤 정시까지 쉰다
    await job.run_once()
    assert wfs.asked == ["GR4_Q1"]
    (line,) = lines(caplog, "geometry fill pass")
    assert (
        "; 1 cells known, 2 ids waiting (0 after an error), 2 of the latest snapshot's cells not queued (queue limit 3); " in line
    )
    assert r.kv[HB]["traffic_grid_not_queued"] == "2"  # Q4 · Q5
    for _ in range(6):  # 같은 regDt(unchanged) 세 번 · 새 regDt 한 번 · 다시 unchanged — 채우기는 정시까지 쉰다
        clock.t = max(job.schedule.next_due or clock.t, clock.t + timedelta(seconds=30))
        await job.run_once()
    assert komsa.calls == 7 and wfs.asked == ["GR4_Q1"]
    # 칸 하나(Q1)를 찾아 빈 자리에 Q4 가 들어갔고 Q5 하나만 넣지 못했다 — 부른 횟수만큼 불어나지 않는다(예전 수: 2 + 6 = 8)
    assert job.geometry.pending == 3
    assert r.kv[HB]["traffic_grid_not_queued"] == "1"
    snap_lines = lines(caplog, "traffic grid: regDt")
    assert len(snap_lines) == 2 and ", 1 not queued — queue full at 3); lookup queue 3" in snap_lines[-1]


async def test_not_queued_is_unknown_before_any_snapshot(monkeypatch):
    job, _k, _w, r, _c, _db = setup(ProviderHttpError(502, "bad gateway"))
    await job.run_once()
    assert r.kv[HB]["traffic_grid_not_queued"] == ""  # 스냅샷을 읽은 적이 없다 — 0 으로 채우지 않는다


async def test_ids_queued_at_an_unchanged_poll_are_counted_on_the_next_snapshot_line(monkeypatch, caplog):
    """같은 regDt(unchanged) 호출도 스냅샷을 다시 읽어 대기열에 넣는다(부정 캐시 기한이 지난 칸 · 채우기가 비운 자리). 전에는 그 수가 어느 줄에도
    없어, 대기열이 찬 뒤 '+K newly queued' 가 실제로 넣은 수보다 적게 나왔다 — 이제 다음 스냅샷 줄의 K 는 앞 스냅샷 줄 뒤에 넣은 칸 모두다
    (줄마다 K 를 더하면 이 프로세스가 넣은 칸 수)."""
    caplog.set_level(logging.INFO, logger=LOGGER)
    monkeypatch.setattr(tg, "MAX_TRACKED", 3)
    items = [("GR4_Q1", 50, 1), ("GR4_Q2", 40, 1), ("GR4_Q3", 30, 1), ("GR4_Q4", 20, 1), ("GR4_Q5", 10, 1)]
    wfs = FakeWfs({g: WfsResult("found", cell=cell(g, 35.0, 129.0 + i * 0.025)) for i, (g, _v, _d) in enumerate(items)})
    same = komsa_body(items=items)
    job, _k, _w, r, clock, _db = setup(same, same, komsa_body("2026-09-29 18:10:05", items), wfs=wfs)
    r.kv[MOF_HOUR] = {"used": str(tg.MOF_HOURLY_CAP - tg.MOF_GRID4_HOURLY_HEADROOM - 1), "limit": str(tg.MOF_HOURLY_CAP)}
    await job.run_once()  # Q1 · Q2 · Q3 을 넣고(+3) Q1 을 찾는다 — 자리 하나가 빈다
    clock.t = job.schedule.next_due
    await job.run_once()  # 같은 regDt: Q4 가 빈 자리에 들어간다(줄 없음)
    assert job.geometry.pending == 3
    clock.t = job.schedule.next_due
    await job.run_once()  # 새 regDt: 더 넣을 자리가 없다
    got = lines(caplog, "traffic grid: regDt")
    assert [re.search(r"\(\+(\d+) newly queued", s).group(1) for s in got] == ["3", "1"]  # type: ignore[union-attr]


# ---- 채우기 한 번(pass)마다 INFO 요약 한 줄 ----------------------------------------------------------------------------


def five_ids_wfs() -> tuple[list[tuple[str, int, float]], FakeWfs]:
    items = [("GR4_A1", 50, 1), ("GR4_A2", 40, 1), ("GR4_A3", 30, 1), ("GR4_A4", 20, 1), ("GR4_A5", 10, 1)]
    wfs = FakeWfs(
        {
            "GR4_A1": WfsResult("found", cell=cell("GR4_A1", 35.0, 129.0)),
            "GR4_A2": WfsResult("off_grid", detail="corner off the lattice"),
            "GR4_A3": WfsResult("found", cell=cell("GR4_A3", 35.0, 129.025)),
            "GR4_A4": WfsResult("not_found"),
            "GR4_A5": WfsResult("found", cell=cell("GR4_A5", 35.0, 129.05)),
        }
    )
    return items, wfs


async def test_one_info_summary_per_fill_pass_with_outcomes_queue_budget_and_resume_time(caplog):
    """채우기 한 번 = 다시 시작한 때부터 멈춘 때(시간 창 · 하루 예산 · 차단기 · 대기열이 빔)까지. 멈출 때 한 줄: 조회 수와 결과(찾음 · 해양격자에
    없음 · 격자 밖 · 오류 · failed 로 뺀 수) · 아는 칸 · 기다리는 칸 · 오늘 쓴 호출 · 멈춘 까닭과 다시 시작하는 때(UTC — 로그는 발행한 그대로)."""
    caplog.set_level(logging.INFO, logger=LOGGER)
    items, wfs = five_ids_wfs()
    job, _k, _w, r, clock, db = setup(komsa_body(items=items), wfs=wfs)
    share = tg.MOF_HOURLY_CAP - tg.MOF_GRID4_HOURLY_HEADROOM
    r.kv[MOF_HOUR] = {"used": str(share - 2), "limit": str(tg.MOF_HOURLY_CAP)}  # 이 시에 남은 채우기 몫 2
    await job.run_once()
    assert wfs.asked == ["GR4_A1", "GR4_A2"]
    (first,) = lines(caplog, "geometry fill pass")
    assert first == (
        "traffic grid: geometry fill pass 2026-09-29T09:06:15Z → 2026-09-29T09:06:15Z — 2 lookups: 1 found, 0 not in the MOF grid, "
        "1 off grid, 0 errors (0 set aside as failed); 1 cells known, 3 ids waiting (0 after an error); "
        "mof_grid4 today 2 of 6000 (UTC day); stopped: MOF hourly window: grid share used "
        f"({share} of {tg.MOF_HOURLY_CAP} in UTC hour 2026092909, {tg.MOF_GRID4_HOURLY_HEADROOM} left for port calls) — "
        "geometry fill resumes at 2026-09-29T10:00:00Z"
    )
    assert len(lines(caplog, "geometry fill resumes at")) == 1  # 멈춘 까닭은 요약 한 줄에만(전에는 따로 한 줄)
    hb = r.kv[HB]
    assert (hb["traffic_grid_fill_state"], hb["traffic_grid_fill_resume_at"]) == ("hour_window", "2026-09-29T10:00:00Z")
    assert hb["traffic_grid_fill_pass_at"] == "2026-09-29T09:06:15Z"
    fields = ("lookups", "found", "not_found", "off_grid", "errors")
    assert [hb[f"traffic_grid_fill_pass_{k}"] for k in fields] == ["2", "1", "0", "1", "0"]
    assert (hb["traffic_grid_off_grid"], hb["traffic_grid_not_found"], hb["traffic_grid_pending"]) == ("1", "0", "3")
    for _ in range(3):  # 멈춘 동안은 줄을 쌓지 않는다
        clock.advance(60)
        await job.run_once()
    assert len(lines(caplog, "geometry fill pass")) == 1
    clock.t = datetime(2026, 9, 29, 10, 0, 1, tzinfo=UTC)
    await job.run_once()
    assert wfs.asked[2:] == ["GR4_A3", "GR4_A4", "GR4_A5"]
    second = lines(caplog, "geometry fill pass")[-1]
    assert second == (
        "traffic grid: geometry fill pass 2026-09-29T10:00:01Z → 2026-09-29T10:00:01Z — 3 lookups: 2 found, 1 not in the MOF grid, "
        "0 off grid, 0 errors (0 set aside as failed); 3 cells known, 0 ids waiting (0 after an error); "
        "mof_grid4 today 5 of 6000 (UTC day); queue empty — every queued id has geometry or a negative-cache entry"
    )
    hb = r.kv[HB]
    assert (hb["traffic_grid_fill_state"], hb["traffic_grid_fill_resume_at"]) == ("idle", "")
    assert (hb["traffic_grid_not_found"], hb["traffic_grid_cells_known"]) == ("1", "3")
    # 실행 기록(틱마다 한 줄 — 운영 RUNS)은 그대로다
    assert [kw["status"] for j, _p, kw in db.runs if j == "traffic_grid_geom"] == ["ok", "budget_exhausted", "ok"]


async def test_a_pass_spread_over_several_ticks_is_one_line(monkeypatch, caplog):
    caplog.set_level(logging.INFO, logger=LOGGER)
    monkeypatch.setattr(tg, "WFS_PER_TICK", 2)
    items, wfs = five_ids_wfs()
    job, _k, _w, _r, clock, _db = setup(komsa_body(items=items), wfs=wfs)
    for _ in range(3):
        await job.run_once()
        clock.advance(30)
    assert len(wfs.asked) == 5
    assert passes(caplog) == [("2026-09-29T09:06:15Z", "2026-09-29T09:07:15Z", "5", "3", "1", "1", "0", "0")]


async def test_the_breaker_ends_a_pass_and_says_when_the_fill_resumes(caplog):
    caplog.set_level(logging.INFO, logger=LOGGER)
    boom = ProviderHttpError(502, "bad gateway")
    job, _k, wfs, r, _c, _db = setup(wfs=FakeWfs({g: boom for g in CELLS}))
    await job.run_once()
    (line,) = lines(caplog, "geometry fill pass")
    assert (
        "— 3 lookups: 0 found, 0 not in the MOF grid, 0 off grid, 3 errors (0 set aside as failed); 0 cells known, 3 ids waiting (3 after an error)"
        in line
    )
    assert line.endswith("paused: 3 WFS errors in a row — geometry fill resumes at 2026-09-29T09:11:15Z")
    assert (r.kv[HB]["traffic_grid_fill_state"], r.kv[HB]["traffic_grid_fill_resume_at"]) == ("breaker", "2026-09-29T09:11:15Z")


async def test_a_pass_that_leaves_only_retries_says_when_the_next_one_is_due(caplog):
    caplog.set_level(logging.INFO, logger=LOGGER)
    wfs = FakeWfs({**{g: WfsResult("found", cell=c) for g, c in CELLS.items()}, "GR4_F2K41_C4": ProviderHttpError(503, "busy")})
    job, _k, _w, r, clock, _db = setup(wfs=wfs)
    await job.run_once()
    (line,) = lines(caplog, "geometry fill pass")
    assert (
        "3 lookups: 2 found, 0 not in the MOF grid, 0 off grid, 1 errors (0 set aside as failed); 2 cells known, 1 ids waiting (1 after an error)"
        in line
    )
    assert line.endswith("nothing due — 1 waiting for a retry after an error (next at 2026-09-29T09:11:15Z)")
    assert r.kv[HB]["traffic_grid_fill_state"] == "retry_wait"
    clock.advance(60)
    await job.run_once()
    assert len(lines(caplog, "geometry fill pass")) == 1


async def test_a_restart_in_a_full_hour_says_so_once_as_a_pass_without_lookups(caplog):
    """시간 창이 이미 찬 시에 다시 시작하면(운영 2026-09-30 17:18:11Z) 부르지 않고 멈춘 까닭과 다시 시작할 때를 한 줄로."""
    caplog.set_level(logging.INFO, logger=LOGGER)
    job, _k, wfs, r, clock, _db = setup()
    r.kv[MOF_HOUR] = {"used": "304", "limit": str(tg.MOF_HOURLY_CAP)}
    await job.run_once()
    clock.advance(30)
    await job.run_once()
    assert wfs.asked == []
    (line,) = lines(caplog, "geometry fill pass")
    assert "— 0 lookups: 0 found" in line and "3 ids waiting" in line
    assert line.endswith(
        "(304 of 390 in UTC hour 2026092909, 100 left for port calls) — geometry fill resumes at 2026-09-29T10:00:00Z"
    )


async def test_the_daily_budget_stop_ends_a_pass_and_the_heartbeat_says_daily_budget_until_the_next_utc_day(caplog):
    """/ops 가 '하루 예산을 다 씀'으로 그리는 상태(traffic_grid_fill_state=daily_budget)와 다음 UTC 날 — 검토 지적: 이 값이 시험에 묶이지 않아
    'hour_window' 로 바꿔도 시험이 모두 통과했다."""
    caplog.set_level(logging.INFO, logger=LOGGER)
    job, _k, wfs, r, clock, _db = setup(limits={"komsa_traffic": 400, "mof_grid4": 2})
    await job.run_once()
    assert len(wfs.asked) == 2
    (line,) = lines(caplog, "geometry fill pass")
    assert (
        "— 2 lookups: 2 found, 0 not in the MOF grid, 0 off grid, 0 errors (0 set aside as failed); 2 cells known, 1 ids waiting"
        in line
    )
    assert line.endswith(
        "mof_grid4 today 2 of 2 (UTC day); stopped: daily budget exhausted (used=2) — geometry fill resumes at 2026-09-30T00:00:00Z"
    )
    hb = r.kv[HB]
    assert (hb["traffic_grid_fill_state"], hb["traffic_grid_fill_resume_at"]) == ("daily_budget", "2026-09-30T00:00:00Z")
    clock.advance(3600)  # 다음 UTC 시가 와도 하루 예산은 다음 UTC 날까지다(시간 창과 다르다)
    await job.run_once()
    assert len(wfs.asked) == 2 and r.kv[HB]["traffic_grid_fill_state"] == "daily_budget"


async def test_a_saturated_fill_reaches_the_daily_budget_minutes_after_20z_because_each_hour_goes_out_in_one_burst(caplog):
    """ADR-023 2026-10-01 개정의 계산을 실제 작업으로: 한 시의 몫(290)은 정시에 한꺼번에 나간다(틱마다 WFS_PER_TICK, 30 s). UTC 날 내내 물을 칸이
    있고 앞 20시간이 모두 290 을 채우면(5,800) 남은 200 은 20:00Z 부터 틱 14번에 나가 20:06:30Z 에 하루 예산(6,000)에서 멈춘다 — 이것이 가장 이른
    때다(실제 호출은 호스트 버킷 1 req/s · 입출항 호출 때문에 더 느리다). 검토 지적: 처음 적은 '빠르면 05:41 KST'(20:41Z)는 조회가 시간 안에 고르게
    나간다고 본 틀린 계산이었다."""
    caplog.set_level(logging.INFO, logger=LOGGER)
    items = [(f"GR4_D{i:05d}", 1, 1.0) for i in range(6_100)]  # 하루 몫보다 많이 — 모두 해양격자에 없음(가짜 WFS 의 기본 답)
    job, _k, wfs, r, clock, _db = setup(komsa_body(items=items))
    clock.t = datetime(2026, 9, 30, 0, 0, 0, tzinfo=UTC)
    per_hour: dict[int, int] = {}
    while clock() < datetime(2026, 9, 30, 21, 0, tzinfo=UTC):
        n = len(wfs.asked)
        await job.run_once()
        per_hour[clock().hour] = per_hour.get(clock().hour, 0) + len(wfs.asked) - n
        hold = job._fill_hold_until
        clock.t = hold if hold is not None and hold > clock() else clock.t + timedelta(seconds=30)  # 쉬는 동안은 건너뛴다
    assert per_hour == {**dict.fromkeys(range(20), 290), 20: 200}
    last = lines(caplog, "geometry fill pass")[-1]
    assert last.startswith("traffic grid: geometry fill pass 2026-09-30T20:00:00Z → 2026-09-30T20:06:30Z — 200 lookups:")
    assert last.endswith(
        "mof_grid4 today 6000 of 6000 (UTC day); stopped: daily budget exhausted (used=6000) — "
        "geometry fill resumes at 2026-10-01T00:00:00Z"
    )


async def test_the_heartbeat_says_waiting_db_until_the_marine_grid4_cache_is_read_or_the_wait_ends():
    job, _k, wfs, r, clock, db = setup()
    db.rows = None  # DB 에 닿지 못한다
    await job.run_once()
    assert wfs.asked == []
    assert (r.kv[HB]["traffic_grid_fill_state"], r.kv[HB]["traffic_grid_fill_resume_at"]) == ("waiting_db", "")
    clock.advance(tg.DB_WAIT_S)
    await job.run_once()  # 기다림이 끝났다 — DB 없이 묻는다
    assert len(wfs.asked) == 3 and r.kv[HB]["traffic_grid_fill_state"] == "idle"


async def test_a_pass_line_counts_an_id_set_aside_after_repeated_failures(caplog):
    """ID_MAX_FAILURES 번 연달아 실패한 칸은 failed 로 뺀다 — 그 채우기의 요약 줄이 '(1 set aside as failed)' 라고 적는다(검토 지적: 0 만 시험했다)."""
    caplog.set_level(logging.INFO, logger=LOGGER)
    wfs = FakeWfs(
        {
            "GR4_F2K41_D3": ProviderHttpError(502, "bad gateway"),
            "GR4_F2K41_C3": WfsResult("found", cell=CELLS["GR4_F2K41_C3"]),
            "GR4_F2K41_C4": WfsResult("found", cell=CELLS["GR4_F2K41_C4"]),
        }
    )
    job, _k, _w, r, clock, _db = setup(wfs=wfs)
    await job.run_once()
    for step in plan.ID_RETRY_S[: tg.ID_MAX_FAILURES - 1]:
        clock.advance(step)
        await job.run_once()
    assert wfs.asked.count("GR4_F2K41_D3") == tg.ID_MAX_FAILURES
    got = passes(caplog)
    assert [p[7] for p in got] == ["0"] * (tg.ID_MAX_FAILURES - 1) + ["1"]  # 다섯 번째 실패의 채우기에서 뺐다
    assert got[-1][2:7] == ("1", "0", "0", "0", "1")
    assert lines(caplog, "geometry fill pass")[-1].endswith(
        "queue empty — every queued id has geometry or a negative-cache entry"
    )
    assert r.kv[HB]["traffic_grid_failed"] == "1"


async def test_switching_the_wfs_off_ends_an_open_pass(monkeypatch, caplog):
    caplog.set_level(logging.INFO, logger=LOGGER)
    monkeypatch.setattr(tg, "WFS_PER_TICK", 1)
    job, _k, _w, r, clock, _db = setup()
    await job.run_once()
    assert not lines(caplog, "geometry fill pass")  # 아직 기다리는 칸이 있다 — 채우기는 이어진다
    r.kv.setdefault("wakeline:provider:mof_grid4", {})["disabled"] = "1"
    clock.advance(30)
    await job.run_once()
    (line,) = lines(caplog, "geometry fill pass")
    assert "— 1 lookups: 1 found" in line and line.endswith("stopped: mof_grid4 switched off by the operator")
    assert r.kv[HB]["traffic_grid_fill_state"] == "operator_off"


# ---- 부정 캐시 -------------------------------------------------------------------------------------------------------


def test_a_full_negative_cache_forgets_only_expired_entries(monkeypatch):
    """전에는 부정 캐시(메모리)가 MAX_TRACKED 에 닿으면 새 not_found 를 적지 않고 대기열에서만 뺐다 — 다음 스냅샷에서 다시 넣어 볼 때마다 다시
    물었다. 첫 고침은 기한이 지난 항목이 없으면 가장 먼저 끝나는 유효한 항목을 비웠다(검토 지적: 그 칸은 다음에 보일 때 다시 묻는다 — '잊지
    않는다'가 아니었다). 이제 기한이 지난 항목만 모두 비우고, 유효한 항목은 상한을 넘어도 남긴다 — 크기는 Redis 해시만큼이다(기동 때도 상한
    없이 읽는다). 운영에서는 닿지 않는 경로다(2026-09-30 기동 때 502항목 — 상한 20,000)."""
    monkeypatch.setattr(tg, "MAX_TRACKED", 2)
    g = tg.GridGeometry()
    g.observe([("GR4_A", 1), ("GR4_B", 1)], T0)
    g.mark_negative("GR4_A", "not_found", T0)
    g.mark_negative("GR4_B", "failed", T0)  # 1일 — 먼저 끝나지만 아직 유효하다
    g.observe([("GR4_C", 1)], T0)
    g.mark_negative("GR4_C", "not_found", T0)
    assert set(g.negative) == {"GR4_A", "GR4_B", "GR4_C"}  # 유효한 결과는 하나도 잊지 않는다
    assert g.observe([("GR4_A", 1), ("GR4_B", 1), ("GR4_C", 1)], T0 + timedelta(hours=1)) == 0  # 다시 묻지 않는다
    old = T0 - timedelta(seconds=plan.NEGATIVE_TTL_S + 1)
    g.negative["GR4_A"] = plan.Negative("not_found", old)  # 기한이 지났다
    g.negative["GR4_C"] = plan.Negative("off_grid", old)  # 기한이 지났다
    g.observe([("GR4_D", 1)], T0)
    g.mark_negative("GR4_D", "off_grid", T0)
    assert set(g.negative) == {"GR4_B", "GR4_D"}  # 기한이 지난 항목은 한 번에 모두 비운다


async def test_the_negative_cache_load_line_tells_valid_entries_from_expired_ones(caplog):
    """'502 negative-cached grid ids loaded' 는 기한이 지난 항목(보이면 다시 묻는다)도 셌다. Redis 해시는 줄지 않는다(수집기 ACL 에 HDEL 이 없다 —
    다시 물으면 같은 칸을 덮어쓴다) — 그래서 까닭별로 아직 유효한 수와 기한이 지난 수를 나눠 적는다."""
    caplog.set_level(logging.INFO, logger=LOGGER)
    job, _k, _w, r, _c, _db = setup()
    fresh = "2026-09-29T08:00:00Z"
    stale = "2026-09-20T08:00:00Z"
    r.kv[NEGATIVE_KEY] = {
        "GR4_N1": orjson.dumps({"reason": "not_found", "at": fresh}).decode(),
        "GR4_N2": orjson.dumps({"reason": "not_found", "at": stale}).decode(),
        "GR4_O1": orjson.dumps({"reason": "off_grid", "at": fresh}).decode(),
        "GR4_F1": orjson.dumps({"reason": "failed", "at": "2026-09-27T08:00:00Z"}).decode(),
    }
    await job.run_once()
    (line,) = lines(caplog, "negative cache")
    assert line == (
        "traffic grid: negative cache — 4 entries loaded: 1 not in the MOF grid, 1 off grid, 0 failed still valid; "
        "2 expired (asked again when seen)"
    )


# ---- 재기동: 무엇이 남고 무엇을 다시 세는가 ------------------------------------------------------------------------------


class StoreDb(TGDb):
    """marine_grid4 를 흉내 낸다 — upsert 한 칸을 다음 프로세스가 읽는다."""

    def __init__(self, store: dict) -> None:
        super().__init__([])
        self.store = store

    async def read_marine_grid4(self):  # type: ignore[override]
        self.reads += 1
        return [(c.grid_no, c.lat_min, c.lon_min, c.lat_max, c.lon_max, c.gid) for c in self.store.values()]

    def upsert_marine_grid4(self, cells, fetched_at):  # type: ignore[override]
        super().upsert_marine_grid4(cells, fetched_at)
        for c in cells:
            self.store[c.grid_no] = c


def process(r: FakeRedis, store: dict, clock: Clock, wfs: FakeWfs, *bodies: bytes) -> TrafficGridJob:
    ctx = make_ctx(r, limits={"komsa_traffic": 400, "mof_grid4": 6000})
    ctx.db = StoreDb(store)  # type: ignore[assignment]
    return TrafficGridJob(FakeKomsa(clock, *bodies), wfs, ctx, now=clock)


async def test_a_restart_asks_only_ids_without_a_stored_result_and_recounts_the_queue(caplog):
    """찾은 칸은 marine_grid4 에, 해양격자에 없는 칸은 부정 캐시에 남아 다음 프로세스가 다시 묻지 않는다. 대기열(메모리)은 남지 않으므로 다음
    프로세스의 첫 스냅샷은 아직 결과가 없는 칸을 모두 '새로 넣은' 수로 센다 — 운영의 '재기동 직후 1,372'가 이것이다(같은 칸을 다시 묻는 것이 아니다).
    오류가 났던 칸의 실패 횟수도 메모리라 새 프로세스는 처음부터 다시 센다(ADR-023 개정 — 알려진 대가)."""
    caplog.set_level(logging.INFO, logger=LOGGER)
    r, store, clock = FakeRedis(), {}, Clock()
    items = [("GR4_B1", 9, 1), ("GR4_B2", 8, 1), ("GR4_B3", 7, 1), ("GR4_B4", 6, 1)]
    answers = {
        "GR4_B1": WfsResult("found", cell=cell("GR4_B1", 35.0, 129.0)),
        "GR4_B2": WfsResult("found", cell=cell("GR4_B2", 35.0, 129.025)),
        "GR4_B3": WfsResult("not_found"),
        "GR4_B4": ProviderHttpError(502, "bad gateway"),
        "GR4_B5": WfsResult("found", cell=cell("GR4_B5", 35.0, 129.05)),
    }
    wfs1 = FakeWfs(dict(answers))
    first = process(r, store, clock, wfs1, komsa_body(items=items))
    await first.run_once()
    assert wfs1.asked == ["GR4_B1", "GR4_B2", "GR4_B3", "GR4_B4"] and sorted(store) == ["GR4_B1", "GR4_B2"]
    clock.advance(600)  # 다시 시작(대기열 · 실패 횟수는 사라진다)
    wfs2 = FakeWfs(dict(answers))
    second = process(r, store, clock, wfs2, komsa_body("2026-09-29 18:15:05", [*items, ("GR4_B5", 5, 1)]))
    await second.run_once()
    assert wfs2.asked == ["GR4_B4", "GR4_B5"]  # 찾은 칸 · 해양격자에 없는 칸은 다시 묻지 않는다
    snap_lines = lines(caplog, "traffic grid: regDt")
    assert "5 cells (0 rejected): 2 with geometry, 3 without (2 waiting for a lookup, 1 not in the MOF grid" in snap_lines[-1]
    assert "lookup queue 2 (+2 newly queued — first snapshot since this process started" in snap_lines[-1]
    assert lines(caplog, "grid cells loaded from marine_grid4")[-1] == "traffic grid: 2 grid cells loaded from marine_grid4"
    assert sorted(store) == ["GR4_B1", "GR4_B2", "GR4_B5"]


# ---- 모형: 칸이 한정되면 채우기가 끝나고, 끝났다고 말한다 ------------------------------------------------------------------


class Occupancy:
    """배가 있는 칸의 모형(가정 — 수렴 · 셈의 규칙을 보려는 것이지 운영 수치를 흉내 내려는 것이 아니다): 칸마다 5분 스냅샷에 있을 확률이 다르고
    (늘 차는 칸 · 가끔 차는 칸), 한 번 찬 칸은 다음 스냅샷에도 있을 확률이 높다. 칸 20개 중 1개는 해양격자에 없다(not_found)."""

    def __init__(self, seed: int = 11) -> None:
        self.rng = random.Random(seed)
        self.pi = [0.9] * 60 + [0.1] * 1140
        self.ids = [f"GR4_Z{i:04d}" for i in range(len(self.pi))]
        self.on = [self.rng.random() < p for p in self.pi]
        self.frames: dict[str, list[tuple[str, int, float]]] = {}

    def frame(self, reg_kst: str) -> list[tuple[str, int, float]]:
        if reg_kst not in self.frames:
            for i, p in enumerate(self.pi):
                enter = p * 0.3 / (1 - p)
                self.on[i] = self.rng.random() < (0.7 if self.on[i] else enter)
            self.frames[reg_kst] = [(self.ids[i], 1 + i % 9, 5.0) for i, on in enumerate(self.on) if on]
        return self.frames[reg_kst]

    def wfs(self) -> FakeWfs:
        ans: dict = {}
        for i, g in enumerate(self.ids):
            ans[g] = (
                WfsResult("not_found")
                if i % 20 == 7
                else WfsResult("found", cell=cell(g, 34.0 + (i // 40) * 0.025, 125.0 + (i % 40) * 0.025))
            )
        return FakeWfs(ans)


class ModelKomsa(FakeKomsa):
    """시계로 regDt 를 정한다(regDt + 60 s 뒤 발행) — 모형의 그 regDt 스냅샷."""

    def __init__(self, clock: Clock, model: Occupancy) -> None:
        super().__init__(clock, b"")
        self.model = model

    async def fetch(self, *, before_send=None):
        base = self.clock() - timedelta(seconds=60)
        reg = base.replace(minute=base.minute - base.minute % 5, second=5, microsecond=0)
        if reg > base:
            reg -= timedelta(minutes=5)
        kst = reg.astimezone(KST).strftime("%Y-%m-%d %H:%M:%S")
        self.answers = [komsa_body(kst, self.model.frame(kst))]
        return await super().fetch(before_send=before_send)


async def test_on_a_bounded_set_of_ids_the_fill_converges_asks_each_id_once_and_says_so(caplog):
    """모형 6시간(1시간째 재기동): 모든 WFS 호출이 채우기 요약 줄의 합과 같고, 찾은 수 = marine_grid4 행 수, 한 프로세스 안에서 같은 칸을 두 번
    묻지 않고 재기동 뒤에도 결과가 남은 칸은 다시 묻지 않으며, 시간당 호출은 채우기 몫(290) 안이다. 칸이 한정되면 대기열이 비고 — 마지막 요약이
    '대기열이 빔'이라 말하고 heartbeat 는 idle — 그 뒤 스냅샷의 기하 없는 칸은 모두 '해양격자에 없음'이다(끝까지 풀 수 없는 칸을 참되게 센다)."""
    caplog.set_level(logging.INFO, logger=LOGGER)
    model, r, store, clock = Occupancy(), FakeRedis(), {}, Clock()
    wfs = model.wfs()

    def start() -> TrafficGridJob:
        ctx = make_ctx(r, limits={"komsa_traffic": 400, "mof_grid4": 6000})
        ctx.db = StoreDb(store)  # type: ignore[assignment]
        return TrafficGridJob(ModelKomsa(clock, model), wfs, ctx, now=clock)

    job, asked_before = start(), 0
    per_process: list[list[str]] = []
    per_hour: dict[str, int] = {}
    end = T0 + timedelta(hours=6)
    restarted = False
    while clock() < end:
        if not restarted and clock() >= T0 + timedelta(hours=1):
            restarted = True
            per_process.append(wfs.asked[asked_before:])
            asked_before = len(wfs.asked)
            pending_at_restart = job.geometry.pending
            caplog.clear()  # 새 프로세스의 줄만(첫 스냅샷 줄을 아래에서 본다)
            known_before = set(store)
            neg_before = {k for k, v in r.kv.get(NEGATIVE_KEY, {}).items() if orjson.loads(v)["reason"] == "not_found"}
            job = start()
            first_line_checked = False
        n = len(wfs.asked)
        await job.run_once()
        hour = clock().strftime("%Y%m%d%H")
        per_hour[hour] = per_hour.get(hour, 0) + len(wfs.asked) - n
        if restarted and not first_line_checked and lines(caplog, "traffic grid: regDt"):
            first_line_checked = True
            first = lines(caplog, "traffic grid: regDt")[0]
            first_reg = max(model.frames)
            frame = model.frames[first_reg]
            expect = sum(1 for g, _v, _d in frame if g not in known_before and g not in neg_before)
            assert f"(+{expect} newly queued — first snapshot since this process started" in first
        clock.advance(30)
    per_process.append(wfs.asked[asked_before:])

    assert pending_at_restart > 0 and known_before and neg_before and per_process[1]  # 채우기 도중에 다시 시작했다
    for asked in per_process:
        assert len(asked) == len(set(asked))  # 한 프로세스 안에서 같은 칸을 두 번 묻지 않는다
    second_ids = set(per_process[1])
    assert not (second_ids & known_before) and not (second_ids & neg_before)  # 남은 결과는 다시 묻지 않는다
    assert max(per_hour.values()) <= tg.MOF_HOURLY_CAP - tg.MOF_GRID4_HOURLY_HEADROOM
    summary = [tuple(int(x) for x in g[2:]) for g in passes(caplog)]
    # 첫 프로세스의 줄은 caplog.clear() 로 지웠다 — 두 번째 프로세스의 호출만 맞춘다
    assert sum(s[0] for s in summary) == len(per_process[1])
    assert len(store) == sum(s[1] for s in summary) + len(known_before)  # 찾은 칸은 모두 marine_grid4 에 남는다
    assert job.geometry.pending == 0 and r.kv[HB]["traffic_grid_fill_state"] == "idle"
    assert lines(caplog, "geometry fill pass")[-1].endswith(
        "queue empty — every queued id has geometry or a negative-cache entry"
    )
    p = snapshot(r)
    assert p["pending"] == 0 and p["unresolved"] == p["not_found"] and p["resolved"] > 0
    # 두 번째 프로세스가 본 칸은 모두 결과가 있다. 재기동 전에 대기열에만 있다가 다시 보이지 않은 칸은 묻지 않는다(대기열은 남지 않는다 —
    # 배가 다시 들어서면 그때 넣는다)
    seen_after = {g for k, fr in model.frames.items() if k >= first_reg for g, _v, _d in fr}
    assert set(store) | set(r.kv[NEGATIVE_KEY]) >= seen_after


@pytest.fixture(autouse=True)
def _utc_day_is_fixed(monkeypatch):
    """하루 예산 키는 벽시계 날짜로 센다(budget.day_key) — 시험 중 자정을 넘겨도 같은 키를 쓰게."""
    from wakeline_collector import budget

    day = datetime.now(UTC)
    monkeypatch.setattr(budget, "day_key", lambda provider, now=None: f"budget:{provider}:{(now or day).strftime('%Y%m%d')}")
