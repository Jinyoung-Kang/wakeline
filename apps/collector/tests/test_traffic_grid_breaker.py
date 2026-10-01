"""격자 기하 채우기의 차단기 사다리 — 지금 동작을 고정하는 시험(PLAN Phase 0 · collector-review §2.4: 3B-6 의 Breaker 로 옮기기 전).

종류마다 따로 센다: 한 칸 조회(_fill_pause_until · _fill_pauses) · bbox 타일(_tile_pause_until · _tile_pauses).
- 한 틱 안에서 연달아 FILL_BREAKER_ERRORS(3)번 실패하면 그 종류가 쉰다: 5분 → 10분 → 30분 → 1시간, 그 뒤로 1시간 그대로.
- 연달은 오류 수는 틱마다 새로 센다 · 그 종류의 성공 한 번이 0 으로 돌린다.
- 한 칸 조회 차단기는 그 틱을 멈춘다(False), 타일 차단기는 틱을 잇는다(True — 남은 호출은 한 칸 조회가 쓴다) · 쉬는 동안 다시 걸리지 않는다.
- 사다리는 틱을 넘어 오른다. 그 종류가 답을 받은 틱이 있으면 처음 단계로 돌아간다(jobs/traffic_grid.py _fill).
"""

from __future__ import annotations

from datetime import timedelta

import pytest
from test_traffic_grid_job import CELLS, FakeWfs, setup
from test_traffic_grid_tile_job import FAR, GridWfs, home, start
from wfs_tiles import FakeGrid

from wakeline_collector.grid_tiles import Tile
from wakeline_collector.http import ProviderHttpError
from wakeline_collector.jobs import traffic_grid as tg
from wakeline_collector.jobs.traffic_grid import _Tick
from wakeline_collector.marine_grid import WfsResult

BOOM = ProviderHttpError(502, "bad gateway")
LADDER_S = [300, 600, 1800, 3600, 3600, 3600]  # 쉼마다(처음부터) — 1시간에서 멈춘다


def test_the_ladder_settings():
    assert tg.FILL_BREAKER_ERRORS == 3 and tg.FILL_PAUSE_S == (300, 600, 1800, 3600)


def test_one_id_lookup_breaker_climbs_5_10_30_60_min_and_stops_the_tick():
    job, _k, _w, _r, clock, _db = setup()
    for step in LADDER_S:
        now = clock()
        tk = _Tick()
        assert [job._call_failed(BOOM, tk, now) for _ in range(3)] == [True, True, False]
        assert (tk.paused, tk.tile_paused, tk.calls, tk.http_status) == (True, False, 3, 502)
        assert job._fill_pause_until == now + timedelta(seconds=step)
        assert job._lookups_paused(now) and not job._lookups_paused(job._fill_pause_until)
        assert (job._tile_pause_until, job._tile_pauses) == (None, 0)  # 다른 종류는 그대로
        clock.t = job._fill_pause_until
    assert job._fill_pauses == len(LADDER_S)


def test_tile_breaker_climbs_the_same_ladder_keeps_the_tick_and_does_not_climb_while_paused():
    job, _k, _w, _r, clock, _db = setup()
    for step in LADDER_S:
        now = clock()
        tk = _Tick()
        # 셋째에서 걸리고, 쉬는 동안의 넷째 · 다섯째는 사다리를 오르지 않는다
        assert [job._call_failed(BOOM, tk, now, tile=True) for _ in range(5)] == [True] * 5
        assert (tk.tile_paused, tk.paused, tk.tile_errors_in_row) == (True, False, 5)
        assert job._tile_pause_until == now + timedelta(seconds=step)
        assert job._tiles_paused(now) and not job._tiles_paused(job._tile_pause_until)
        assert (job._fill_pause_until, job._fill_pauses) == (None, 0)
        clock.t = job._tile_pause_until
    assert job._tile_pauses == len(LADDER_S)


@pytest.mark.parametrize("tile", [False, True])
def test_errors_in_a_row_are_counted_per_tick(tile):
    job, _k, _w, _r, clock, _db = setup()
    first, second = _Tick(), _Tick()
    assert [job._call_failed(BOOM, first, clock(), tile=tile) for _ in range(2)] == [True, True]
    assert job._call_failed(BOOM, second, clock(), tile=tile) is True  # 다음 틱의 첫 오류 — 연달아 셋이 아니다
    assert (job._fill_pause_until, job._tile_pause_until, job._fill_pauses, job._tile_pauses) == (None, None, 0, 0)


# ---- 작업을 거쳐: 틱 끝의 되돌림(_fill) ---------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    "answer",
    [
        WfsResult("found", cell=CELLS["GR4_F2K41_D3"]),
        WfsResult("not_found"),
        WfsResult("off_grid", detail="corner off the lattice"),
    ],
    ids=lambda a: a.kind,
)
async def test_a_tick_where_a_lookup_got_an_answer_restarts_the_lookup_ladder(answer):
    wfs = FakeWfs({"GR4_F2K41_D3": BOOM, "GR4_F2K41_C3": BOOM, "GR4_F2K41_C4": answer})
    job, _k, _w, _r, _clock, _db = setup(wfs=wfs)
    job._fill_pauses = 3  # 앞서 세 번 걸렸다
    await job.run_once()
    assert wfs.asked == ["GR4_F2K41_D3", "GR4_F2K41_C3", "GR4_F2K41_C4"]  # 오류 · 오류 · 답 — 연달아 둘뿐이라 걸리지 않는다
    assert (job._fill_pauses, job._fill_pause_until) == (0, None)


async def test_a_tick_of_lookup_errors_only_climbs_from_where_the_ladder_was():
    wfs = FakeWfs({g: BOOM for g in CELLS})
    job, _k, _w, _r, clock, _db = setup(wfs=wfs)
    job._fill_pauses = 2
    await job.run_once()
    assert job._fill_pauses == 3 and job._fill_pause_until == clock() + timedelta(seconds=1800)


async def test_tile_errors_climb_the_tile_ladder_while_an_answered_lookup_restarts_the_lookup_ladder():
    grid = FakeGrid()
    tiles = [Tile(0, 28, 60), FAR, Tile(0, 33, 52), Tile(0, 31, 58)]
    wfs = GridWfs(grid, answers={t.box: BOOM for t in tiles})
    job, wfs, _r, clock, _db = start(grid, [home(grid, tiles[0])[4]], known=[home(grid, t)[0] for t in tiles], wfs=wfs)
    job._tile_pauses = job._fill_pauses = 1
    await job.run_once()
    assert len(wfs.boxes) == 3 and wfs.asked == [home(grid, tiles[0])[4]]
    assert job._tile_pauses == 2 and job._tile_pause_until == clock() + timedelta(seconds=600)
    assert (job._fill_pauses, job._fill_pause_until) == (0, None)


async def test_a_tick_where_a_tile_answered_restarts_the_tile_ladder():
    grid = FakeGrid()
    a = Tile(0, 28, 60)
    job, wfs, _r, _clock, _db = start(grid, [home(grid, a)[3]], known=[home(grid, a)[0]])
    job._tile_pauses = 3
    await job.run_once()
    assert wfs.boxes == [a.box]
    assert (job._tile_pauses, job._tile_pause_until) == (0, None)
