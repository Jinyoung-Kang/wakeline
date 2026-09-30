"""격자 기하 채우기가 bbox 타일을 쓴다(ADR-023 2026-10-01 bbox 개정) — 작업 수준: 타일 먼저 · 한 번 = 예산 1(하루 · 해양수산부 시간 창) ·
찾은 칸은 한 칸 조회 대기열에서 빠짐 · 아는 칸 · 한 칸 조회 · 가장자리(받은 기하에서만)로 넣는 타일 · 잘렸을 수 있으면 나눔 · 재기동 뒤 다시 묻지 않음 ·
타일은 어느 번호도 '해양격자에 없음'으로 만들지 않음 · 한 번에 한 쓰기 · 요약 줄 · heartbeat. 외부 호출 · 실제 Redis/DB 없이(가짜 — 합성 서버
tests/wfs_tiles.FakeGrid 는 가정한 서버다)."""

from __future__ import annotations

import logging
from datetime import UTC, datetime, timedelta

import orjson
import pytest
from fakes import FakeRedis, make_ctx
from redis.exceptions import NoPermissionError
from test_traffic_grid_job import Clock, FakeKomsa, TGDb, komsa_body, snapshot
from wfs_tiles import FakeGrid, extent

from wakeline_collector import grid_tiles as gt
from wakeline_collector.budget import day_key
from wakeline_collector.grid_tiles import Tile, cell_xy, tile_at
from wakeline_collector.http import ProviderHttpError, SendCancelled
from wakeline_collector.jobs import traffic_grid as tg
from wakeline_collector.jobs.traffic_grid import NEGATIVE_KEY, TILES_KEY, TrafficGridJob
from wakeline_collector.marine_grid import WfsResult, WfsTooLarge, parse_wfs_tile
from wakeline_collector.providers.data_go_kr import WfsLookup, WfsTileLookup
from wakeline_collector.ratelimit import Throttled

HB = "wakeline:collector"
LOGGER = "job.traffic_grid"
MOF_HOUR = "budget:mof:h:2026092909"
SHARE = tg.MOF_HOURLY_CAP - tg.MOF_GRID4_HOURLY_HEADROOM
A = Tile(0, 28, 60)  # 인천 앞바다(확인한 칸 GR4_F2K41_C3 의 타일) — 896000,1920000,928000,1952000
E, W = Tile(0, 29, 60), Tile(0, 27, 60)
FAR = Tile(0, 30, 55)


class GridWfs:
    """가정한 서버 하나(FakeGrid)로 한 칸 조회와 bbox 를 모두 답한다. hidden = bbox 가 (조용히) 빼는 칸 · answers = 상자별 대신할 답."""

    name, cost, host = "mof_grid4", 1, "apis.data.go.kr"

    def __init__(self, grid: FakeGrid, *, hidden: set[str] | None = None, answers: dict | None = None) -> None:
        self.grid, self.configured = grid, True
        self.hidden = hidden or set()
        self.answers: dict = answers or {}
        self.asked: list[str] = []
        self.boxes: list[tuple[int, int, int, int]] = []

    async def lookup(self, grid_no, *, wait_s=5.0, before_send=None):
        if before_send is not None and not await before_send():
            raise SendCancelled("apis.data.go.kr")
        self.asked.append(grid_no)
        if grid_no in self.grid.where:
            return WfsLookup(WfsResult("found", cell=self.grid.cell(grid_no)), b"<xml/>", 30)
        return WfsLookup(WfsResult("not_found"), b"<xml/>", 30)

    async def bbox(self, box, *, wait_s=5.0, before_send=None):
        a = self.answers.get(box)
        if isinstance(a, Throttled):
            raise a
        if before_send is not None and not await before_send():
            raise SendCancelled("apis.data.go.kr")
        self.boxes.append(box)
        if isinstance(a, BaseException):
            raise a
        body = a if isinstance(a, bytes) else self.grid.body(box, omit=self.hidden)
        return WfsTileLookup(parse_wfs_tile(body), body, 40)


class CallDb(TGDb):
    """upsert 를 부를 때마다 칸 수를 적는다(한 타일 = 한 쓰기) · 저장소를 흉내 낸다(다음 프로세스가 읽는다)."""

    def __init__(self, store: dict | None = None, rows: list[tuple] | None = None) -> None:
        super().__init__(rows if rows is not None else [])
        self.store = store
        self.calls: list[int] = []

    async def read_marine_grid4(self):  # type: ignore[override]
        self.reads += 1
        if self.store is None:
            return self.rows
        return [(c.grid_no, c.lat_min, c.lon_min, c.lat_max, c.lon_max, c.gid) for c in self.store.values()]

    def upsert_marine_grid4(self, cells, fetched_at):  # type: ignore[override]
        super().upsert_marine_grid4(cells, fetched_at)
        self.calls.append(len(cells))
        if self.store is not None:
            for c in cells:
                self.store[c.grid_no] = c


def row(c) -> tuple:
    return (c.grid_no, c.lat_min, c.lon_min, c.lat_max, c.lon_max, c.gid)


def home(grid: FakeGrid, t: Tile) -> list[str]:
    """중심이 타일 t 안인 칸(가장자리에 걸치지 않는 칸만 — 3 km 안쪽)."""
    x0, y0, x1, y1 = t.box
    out = []
    for g in grid.cells_in(t.box):
        ex = extent(*grid.where[g])
        if (
            tile_at(*cell_xy(grid.cell(g))) == t
            and ex[0] > x0 + 3000
            and ex[2] < x1 - 3000
            and ex[1] > y0 + 3000
            and ex[3] < y1 - 3000
        ):
            out.append(g)
    return out


def straddling(grid: FakeGrid, t: Tile, side: str) -> list[str]:
    """t 의 한 가장자리(east · west)에 걸친 칸 — 모서리에서 3 km 넘게 떨어져 이웃은 그쪽 타일 하나. 받은 기하(합성 서버의 꼭짓점)로만 고른다."""
    x0, y0, x1, y1 = t.box
    edge = x1 if side == "east" else x0
    return [
        g
        for g in grid.cells_in(t.box)
        if (ex := extent(*grid.where[g]))[0] < edge < ex[2] and ex[1] > y0 + 3000 and ex[3] < y1 - 3000
    ]


def start(
    grid: FakeGrid,
    items: list[str],
    *,
    known: list[str] = (),  # type: ignore[assignment]
    r: FakeRedis | None = None,
    clock: Clock | None = None,
    store: dict | None = None,
    wfs: GridWfs | None = None,
    limits: dict | None = None,
    bodies: list[bytes] | None = None,
):
    r = r or FakeRedis()
    clock = clock or Clock()
    ctx = make_ctx(r, limits=limits or {"komsa_traffic": 400, "mof_grid4": 6000})
    ctx.db = CallDb(store, [row(grid.cell(g)) for g in known])  # type: ignore[assignment]
    wfs = wfs or GridWfs(grid)
    body = komsa_body(items=[(g, 50 - i % 40, 1.0) for i, g in enumerate(items)])
    job = TrafficGridJob(FakeKomsa(clock, *(bodies or [body])), wfs, ctx, tiles=wfs, now=clock)
    return job, wfs, r, clock, ctx.db


def lines(caplog, needle: str) -> list[str]:
    return [x.getMessage() for x in caplog.records if x.name == LOGGER and needle in x.getMessage()]


# ---- 타일 먼저 · 예산 ---------------------------------------------------------------------------------------------------------


async def test_known_cells_seed_tiles_and_tiles_go_before_lookups():
    grid = FakeGrid()
    in_a = home(grid, A)
    in_far = home(grid, FAR)
    elsewhere = home(grid, Tile(0, 33, 52))[0]  # 아는 칸이 없는 타일의 칸 — 한 칸 조회로만 찾는다
    known = [in_a[0], in_a[1], in_far[0]]
    items = [*in_a[2:7], elsewhere, *known]
    job, wfs, r, _c, db = start(grid, items, known=known)
    await job.run_once()
    # 아는 칸 둘인 A 먼저, 하나인 FAR 다음 — 그다음 한 칸 조회는 타일이 풀지 못한 칸 하나뿐이고, 그 칸이 든 타일이 곧바로 뒤따른다
    assert wfs.boxes == [A.box, FAR.box, Tile(0, 33, 52).box]
    assert wfs.asked == [elsewhere]
    p = snapshot(r)
    assert (p["total"], p["resolved"], p["pending"]) == (len(items), len(items), 0)
    # 한 번 = 예산 1 — 하루 예산과 해양수산부 시간 창 모두(한 칸 조회와 같다)
    assert r.kv[day_key("mof_grid4")]["used"] == "4" and r.kv[MOF_HOUR]["used"] == "4"
    # 한 타일 = 한 쓰기(새 칸 · 바뀐 칸만 — 이미 같은 기하로 아는 칸은 다시 쓰지 않는다) · 한 칸 조회는 틱 끝에 한 번
    assert len(db.calls) == 4 and db.calls[0] == len(grid.cells_in(A.box)) - 2
    assert set(known).isdisjoint({c.grid_no for c in db.upserts[: db.calls[0]]})
    hb = r.kv[HB]
    assert (hb["traffic_grid_tiles_done"], hb["traffic_grid_tiles_queued"]) == ("3", "0")


async def test_tiles_share_the_mof_hour_window_and_stop_there_like_lookups():
    grid = FakeGrid()
    known = [home(grid, A)[0], home(grid, FAR)[0], home(grid, Tile(0, 33, 52))[0]]
    job, wfs, r, clock, db = start(grid, [home(grid, A)[5]], known=known)
    r.kv[MOF_HOUR] = {"used": str(SHARE - 2), "limit": str(tg.MOF_HOURLY_CAP)}
    await job.run_once()
    assert len(wfs.boxes) == 2 and wfs.asked == [] and r.kv[MOF_HOUR]["used"] == str(SHARE)
    assert (r.kv[HB]["traffic_grid_fill_state"], r.kv[HB]["traffic_grid_fill_resume_at"]) == (
        "hour_window",
        "2026-09-29T10:00:00Z",
    )
    assert [kw["status"] for j, _p, kw in db.runs if j == "traffic_grid_geom"] == ["ok", "budget_exhausted"]
    clock.t = datetime(2026, 9, 29, 10, 0, 1, tzinfo=UTC)
    await job.run_once()
    assert len(wfs.boxes) == 3 and r.kv["budget:mof:h:2026092910"]["used"] == "1"


async def test_a_throttled_tile_gives_both_reservations_back():
    grid = FakeGrid()
    wfs = GridWfs(grid, answers={A.box: Throttled("apis.data.go.kr", "no slot")})
    job, wfs, r, _c, _db = start(grid, [home(grid, A)[3]], known=[home(grid, A)[0]], wfs=wfs)
    await job.run_once()
    assert wfs.boxes == [] and r.kv[day_key("mof_grid4")]["used"] == "0" and r.kv[MOF_HOUR]["used"] == "0"


# ---- 어디를 묻는가 ------------------------------------------------------------------------------------------------------------


async def test_a_cell_found_by_one_lookup_puts_its_tile_next_and_the_tile_resolves_the_rest():
    grid = FakeGrid()
    ids = home(grid, A)[:6]
    job, wfs, r, _c, _db = start(grid, ids)  # 아는 칸 없음 — 첫 칸은 한 칸 조회로
    await job.run_once()
    assert len(wfs.asked) == 1 and wfs.boxes == [A.box]  # 두 번째 호출은 그 칸의 타일 — 남은 다섯 칸은 묻지 않는다
    assert snapshot(r)["resolved"] == 6 and job.geometry.pending == 0


async def test_edge_cells_unknown_in_the_snapshot_queue_the_neighbour_tile_from_their_geometry():
    """이웃 타일은 받은 기하에서만: A 에서 받은 칸이 A 의 서쪽 가장자리에 걸치고 지금 스냅샷에서 위치를 모르던 칸이면 서쪽 타일 W 를 넣는다.
    동쪽 가장자리의 칸은 스냅샷에 없어 동쪽 타일 E 는 넣지 않는다(배가 없는 곳으로 넓혀 가지 않는다)."""
    grid = FakeGrid()
    west = straddling(grid, A, "west")
    assert len(west) >= 2 and straddling(grid, A, "east")
    assert all(tile_at(*cell_xy(grid.cell(g))) == A for g in west[:2])  # 중심은 A — 아는 칸이었다면 A 만 넣었을 칸
    job, wfs, r, _c, _db = start(grid, [*west[:2], home(grid, A)[1]], known=[home(grid, A)[0]])
    await job.run_once()
    assert wfs.boxes == [A.box, W.box] and E.box not in wfs.boxes and wfs.asked == []


async def test_edge_cells_already_known_do_not_widen_the_search():
    grid = FakeGrid()
    west = straddling(grid, A, "west")
    job, wfs, _r, _c, _db = start(grid, west[:2], known=[home(grid, A)[0], *west[:2]])
    await job.run_once()
    assert wfs.boxes == [A.box]


# ---- 잘렸을 수 있음 · 오류 ------------------------------------------------------------------------------------------------------


async def test_a_possibly_truncated_tile_is_split_and_its_four_parts_fetched(caplog):
    caplog.set_level(logging.INFO, logger=LOGGER)
    grid = FakeGrid()
    ids = home(grid, A)
    wfs = GridWfs(grid, answers={A.box: grid.body(A.box, extra_declared=5)})  # numberOfFeatures 가 지물보다 많다
    job, wfs, r, _c, db = start(grid, ids[:3], known=[ids[5]], wfs=wfs)
    await job.run_once()
    kids = [k.box for k in A.children()]
    assert wfs.boxes == [A.box, *kids]
    states = {k: orjson.loads(v)["status"] for k, v in r.kv[TILES_KEY].items()}
    assert states == {"0/28/60": "split", **{k.key: "done" for k in A.children()}}
    assert snapshot(r)["resolved"] == 3
    (line,) = lines(caplog, "split into 4")
    assert line.startswith("traffic grid: tile 0/28/60 possibly truncated (numberOfFeatures ") and line.endswith(
        " — split into 4"
    )


async def test_the_smallest_tile_still_truncated_is_incomplete_and_said_loudly(monkeypatch, caplog):
    caplog.set_level(logging.INFO, logger=LOGGER)
    monkeypatch.setattr(gt, "MAX_LEVEL", 1)
    grid = FakeGrid()
    ids = home(grid, A)
    answers = {t.box: grid.body(t.box, extra_declared=1) for t in (A, *A.children())}
    job, wfs, r, _c, db = start(grid, ids[:2], known=[ids[5]], wfs=GridWfs(grid, answers=answers))
    await job.run_once()
    states = {k: orjson.loads(v)["status"] for k, v in r.kv[TILES_KEY].items()}
    assert states == {"0/28/60": "split", **{k.key: "incomplete" for k in A.children()}}
    warns = [x for x in caplog.records if x.name == LOGGER and x.levelno == logging.WARNING and "incomplete" in x.getMessage()]
    assert len(warns) == 4
    assert [q for q in db.runs[-1][2]["quality"] if q[0] == "traffic_grid_tile_incomplete"]
    assert snapshot(r)["resolved"] == 2  # 받은 칸은 그대로 쓴다(지물마다 검사를 통과한 실제 기하)


async def test_an_oversized_tile_is_split_not_counted_as_an_error():
    grid = FakeGrid()
    wfs = GridWfs(grid, answers={A.box: WfsTooLarge("response too large (500000 bytes > 393216)")})
    job, wfs, r, _c, _db = start(grid, home(grid, A)[:2], known=[home(grid, A)[5]], wfs=wfs)
    await job.run_once()
    assert wfs.boxes == [A.box, *[k.box for k in A.children()]]
    assert r.kv[HB]["traffic_grid_fill_state"] == "idle" and snapshot(r)["resolved"] == 2


async def test_tile_errors_back_off_per_tile_and_trip_the_breaker():
    grid = FakeGrid()
    boom = ProviderHttpError(502, "bad gateway")
    tiles = [A, FAR, Tile(0, 33, 52), Tile(0, 31, 58)]
    known = [home(grid, t)[0] for t in tiles]
    wfs = GridWfs(grid, answers={t.box: boom for t in tiles})
    job, wfs, r, clock, _db = start(grid, [home(grid, A)[4]], known=known, wfs=wfs)
    await job.run_once()
    assert len(wfs.boxes) == tg.FILL_BREAKER_ERRORS and wfs.asked == []
    assert r.kv[HB]["traffic_grid_fill_state"] == "breaker"
    assert job.tiles.retries()[0] == tg.FILL_BREAKER_ERRORS


# ---- 한 번만 · 재기동 --------------------------------------------------------------------------------------------------------------


async def test_finished_tiles_survive_a_restart_and_are_not_fetched_again(caplog):
    caplog.set_level(logging.INFO, logger=LOGGER)
    grid = FakeGrid()
    r, clock = FakeRedis(), Clock()
    ids = home(grid, A)
    store = {ids[10]: grid.cell(ids[10])}  # marine_grid4 — 앞 프로세스가 한 칸 조회로 찾은 칸 하나
    first, wfs1, _r, _c, _db = start(grid, ids[:4], r=r, clock=clock, store=store)
    await first.run_once()
    assert wfs1.boxes == [A.box] and len(store) == len(grid.cells_in(A.box))
    assert orjson.loads(r.kv[TILES_KEY]["0/28/60"]) == {"status": "done", "at": "2026-09-29T09:06:15Z", "cells": len(store)}
    clock.advance(600)
    second, wfs2, _r, _c, _db = start(grid, [*ids[:4], ids[20]], r=r, clock=clock, store=store)
    await second.run_once()
    assert wfs2.boxes == [] and wfs2.asked == []  # 끝난 타일도, 그 타일이 준 칸도 다시 묻지 않는다
    assert lines(caplog, "tile states loaded")[-1] == (
        "traffic grid: bbox tiles — 1 tile states loaded (1 done, 0 split, 0 incomplete, 0 failed still valid)"
    )


async def test_the_tile_map_is_awaited_then_the_fill_goes_on_without_it_and_says_why(caplog):
    """타일 상태 해시를 읽지 못하면(예: Redis ACL 을 새 셀렉터로 다시 띄우지 않았다 — NOPERM) DB 캐시처럼 기동 뒤 DB_WAIT_S 까지 기다린다(끝난 타일을
    다시 묻지 않게). 그 뒤에는 메모리로만 채우고 WARN 한 줄로 까닭을 적는다 — 조용히 멈추지 않는다."""
    caplog.set_level(logging.INFO, logger=LOGGER)
    grid = FakeGrid()
    job, wfs, r, clock, _db = start(grid, home(grid, A)[:2], known=[home(grid, A)[5]])
    real = r.hgetall

    async def hgetall(key):
        if key == TILES_KEY:
            raise NoPermissionError("NOPERM this user has no permissions to access one of the keys used as arguments")
        return await real(key)

    r.hgetall = hgetall  # type: ignore[method-assign]
    await job.run_once()
    assert wfs.boxes == [] and wfs.asked == [] and r.kv[HB]["traffic_grid_fill_state"] == "waiting_tiles"
    clock.advance(tg.DB_WAIT_S)
    await job.run_once()
    assert wfs.boxes == [A.box]
    warns = [x.getMessage() for x in caplog.records if x.name == LOGGER and x.levelno == logging.WARNING]
    assert len(warns) == 1 and "NoPermissionError" in warns[0] and "restart" in warns[0]


async def test_a_tile_never_marks_an_id_not_found_only_a_lookup_does():
    """상자에 없는 번호는 묻지 않은 것이다 — 타일이 끝나도 그 번호는 기다리고, 한 칸 조회가 0건으로 답해야 '해양격자에 없음'이다."""
    grid = FakeGrid()
    ghost = "GR4_NOT_IN_GRID"
    job, wfs, r, _c, _db = start(grid, [home(grid, A)[2], ghost], known=[home(grid, A)[0]])
    await job.run_once()
    assert wfs.boxes == [A.box] and wfs.asked == [ghost]
    assert orjson.loads(r.kv[NEGATIVE_KEY][ghost])["reason"] == "not_found"


async def test_a_lookup_that_finds_a_cell_a_done_tile_did_not_list_rechecks_that_tile_once(caplog):
    """done 타일 안에서 한 칸 조회가 칸을 찾으면(타일 응답에 없던 칸 — 서버가 조용히 뺐거나 DB 쓰기를 잃었다) 그 타일을 한 번 다시 묻는다. 다시 받아도
    없으면 WARN 한 줄(bbox 응답이 칸을 빠뜨릴 수 있다는 증거) — 되풀이하지 않는다."""
    caplog.set_level(logging.INFO, logger=LOGGER)
    grid = FakeGrid()
    ids = home(grid, A)
    hidden = ids[7]
    wfs = GridWfs(grid, hidden={hidden})
    job, wfs, r, _c, _db = start(grid, [ids[1], hidden], known=[ids[0]], wfs=wfs)
    await job.run_once()
    assert wfs.boxes == [A.box, A.box] and wfs.asked == [hidden]
    (warn,) = [x.getMessage() for x in caplog.records if x.name == LOGGER and x.levelno == logging.WARNING]
    assert "0/28/60" in warn and hidden in warn and "still not listed" in warn
    assert snapshot(r)["resolved"] == 2


# ---- 기록 · 관측 ---------------------------------------------------------------------------------------------------------------


async def test_the_pass_summary_and_the_heartbeat_count_tiles(caplog):
    caplog.set_level(logging.INFO, logger=LOGGER)
    grid = FakeGrid()
    wfs = GridWfs(grid, answers={A.box: grid.body(A.box, extra_declared=3)})
    known = [home(grid, A)[0], home(grid, FAR)[0]]
    job, wfs, r, _c, _db = start(grid, [home(grid, A)[3], home(grid, FAR)[4]], known=known, wfs=wfs)
    await job.run_once()
    (line,) = lines(caplog, "geometry fill pass")
    n_cells = len(grid.cells_in(A.box)) + sum(len(grid.cells_in(k.box)) for k in A.children()) + len(grid.cells_in(FAR.box))
    assert "— 0 lookups: 0 found, 0 not in the MOF grid, 0 off grid, 0 errors (0 set aside as failed); 6 tiles: " in line
    assert (
        f"6 tiles: {n_cells} cells listed (" in line
        and "1 split as possibly truncated, 0 errors; tiles queued 0, done 5; " in line
    )
    assert line.endswith("queue empty — every queued id has geometry or a negative-cache entry; no tile queued (5 done)")
    hb = r.kv[HB]
    assert (
        hb["traffic_grid_fill_pass_tiles"],
        hb["traffic_grid_fill_pass_tile_splits"],
        hb["traffic_grid_fill_pass_tile_errors"],
    ) == ("6", "1", "0")
    assert hb["traffic_grid_fill_pass_tile_cells"] == str(n_cells)
    assert int(hb["traffic_grid_fill_pass_tile_new"]) == int(hb["traffic_grid_cells_known"]) - 2
    assert (hb["traffic_grid_tiles_done"], hb["traffic_grid_tiles_queued"]) == ("5", "0")
    assert r.kv["wakeline:provider:mof_grid4"]["last_records"] == str(n_cells)


async def test_without_a_tile_source_the_heartbeat_tile_fields_are_empty():
    from test_traffic_grid_job import setup

    job, _k, _w, r, _c, _db = setup()
    await job.run_once()
    for f in ("tiles_done", "tiles_queued", "fill_pass_tiles", "fill_pass_tile_cells"):
        assert r.kv[HB][f"traffic_grid_{f}"] == ""


async def test_large_loads_run_off_the_event_loop(monkeypatch):
    """아는 칸 읽기(10만 칸 약 0.3 s — 잰 값)와 아는 칸의 타일 셈(칸마다 투영 약 3 µs)은 이벤트 루프 밖 스레드에서."""
    names: list[str] = []
    real = tg.asyncio.to_thread

    async def spy(fn, /, *a, **kw):
        names.append(getattr(fn, "__name__", "?"))
        return await real(fn, *a, **kw)

    monkeypatch.setattr(tg.asyncio, "to_thread", spy)
    grid = FakeGrid()
    job, _w, _r, _c, _db = start(grid, home(grid, A)[:1], known=[home(grid, A)[3]])
    await job.run_once()
    assert names[:2] == ["load_cells", "known_tiles"]


@pytest.fixture(autouse=True)
def _utc_day_is_fixed(monkeypatch):
    from wakeline_collector import budget

    day = datetime.now(UTC)
    monkeypatch.setattr(budget, "day_key", lambda provider, now=None: f"budget:{provider}:{(now or day).strftime('%Y%m%d')}")


def test_constants_are_the_adr_values():
    assert (gt.TILE_M, gt.MAX_LEVEL, gt.TILE_MAX_FAILURES, gt.TILE_FAILED_TTL_S) == (32_000, 3, 5, 86400)
    assert TILES_KEY == "wakeline:traffic_grid:tiles"
    assert timedelta(seconds=gt.TILE_RETRY_S[0]) == timedelta(minutes=5)


def test_the_collector_wires_bbox_tiles_to_the_same_provider_and_budget():
    from wakeline_collector import main as col_main
    from wakeline_collector.http import HttpClient

    job = col_main.traffic_grid_job(HttpClient(), "k", make_ctx())
    assert job.tile_src is job.wfs and job.wfs.name == "mof_grid4"
    other = GridWfs(FakeGrid())
    other.name = "portmis"  # type: ignore[misc]
    with pytest.raises(ValueError, match="same provider"):
        TrafficGridJob(job.komsa, job.wfs, make_ctx(), tiles=other)
