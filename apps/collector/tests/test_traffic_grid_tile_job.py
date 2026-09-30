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
from wfs_tiles import FakeGrid, collection, extent, feature, ring

from wakeline_collector import grid_tiles as gt
from wakeline_collector.budget import day_key
from wakeline_collector.grid_tiles import Tile, cell_xy, tile_at
from wakeline_collector.http import ProviderHttpError, SendCancelled
from wakeline_collector.jobs import traffic_grid as tg
from wakeline_collector.jobs.traffic_grid import NEGATIVE_KEY, TILES_KEY, TrafficGridJob
from wakeline_collector.marine_grid import WfsError, WfsResult, WfsTooLarge, parse_wfs_tile
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
        return WfsTileLookup(parse_wfs_tile(body, box=box), body, 40)  # 공급자처럼 물은 상자를 넘긴다


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
    # WARN 은 채우기 한 번에 하나(검토 지적: 타일 147개가 incomplete 면 WARN 9,408줄이 /logs 상한 약 3,000을 넘쳤다) — 나머지는 INFO, 요약 줄이 센다
    warns = [x for x in caplog.records if x.name == LOGGER and x.levelno == logging.WARNING and "incomplete" in x.getMessage()]
    assert len(warns) == 1 and "further incomplete tiles in this fill pass" in warns[0].getMessage()
    assert len(lines(caplog, "marked incomplete")) == 4
    assert len([q for q in db.runs[-1][2]["quality"] if q[0] == "traffic_grid_tile_incomplete"]) == 4
    (summary,) = lines(caplog, "geometry fill pass")
    assert " 1 split and 4 left incomplete as possibly truncated, " in summary
    assert snapshot(r)["resolved"] == 2  # 받은 칸은 그대로 쓴다(지물마다 검사를 통과한 실제 기하)
    assert r.kv[HB]["traffic_grid_fill_pass_tile_incomplete"] == "4" and r.kv[HB]["traffic_grid_fill_pass_tile_splits"] == "1"


async def test_a_server_that_always_declares_one_more_costs_five_calls_per_tile_not_85(caplog):
    """검토 지적(2026-10-01): numberOfFeatures 의 뜻이 다르면(서버가 늘 하나 더 적는다) 32 km 타일 하나가 4 km 까지 1 + 4 + 16 + 64 = 85번을 쓰고
    incomplete WARN 64줄을 냈다. 자식의 답이 부모가 준 칸보다 적은 지물로도 여전히 어긋나면 상한 탓이 아니다 — 더 나누지 않는다: 5번 · WARN 한 줄."""
    caplog.set_level(logging.INFO, logger=LOGGER)
    grid = FakeGrid()

    class PlusOne(GridWfs):
        async def bbox(self, box, *, wait_s=5.0, before_send=None):
            self.answers[box] = self.grid.body(box, extra_declared=1)
            return await super().bbox(box, wait_s=wait_s, before_send=before_send)

    job, wfs, r, _c, _db = start(grid, [home(grid, A)[1]], known=[home(grid, A)[0]], wfs=PlusOne(grid))
    await job.run_once()
    assert wfs.boxes == [A.box, *[k.box for k in A.children()]] and wfs.asked == []
    states = {k: orjson.loads(v)["status"] for k, v in r.kv[TILES_KEY].items()}
    assert states == {"0/28/60": "split", **{k.key: "incomplete" for k in A.children()}}
    warns = [x.getMessage() for x in caplog.records if x.name == LOGGER and x.levelno == logging.WARNING]
    assert len(warns) == 1 and "a server cap cannot explain it" in warns[0]


async def test_a_server_ignoring_the_bbox_is_split_once_then_the_too_large_parts_are_errors():
    """검토 지적(2026-10-01): 상자를 무시하고 늘 큰 본문을 주는 서버에는 타일 하나가 16 km · 8 km 까지 21번을 쓰고서야 오류가 됐다. 칸이 0.025°
    정사각형이면 32 km 상자에는 약 200칸(≈ 130 KB)뿐이라 384 KiB 를 넘는 16 km 답은 나눠서 나아지지 않는다 — 크기 초과는 level 0 에서만 한 번
    나누고, 나눈 상자가 또 넘으면 오류(타일 물러나기)."""
    grid = FakeGrid()

    class Huge(GridWfs):
        async def bbox(self, box, *, wait_s=5.0, before_send=None):
            self.answers[box] = WfsTooLarge("response too large (459859 bytes > 393216)")
            return await super().bbox(box, wait_s=wait_s, before_send=before_send)

    job, wfs, r, _c, db = start(grid, [home(grid, A)[1]], known=[home(grid, A)[0]], wfs=Huge(grid))
    await job.run_once()
    assert wfs.boxes[0] == A.box and all(b in [k.box for k in A.children()] for b in wfs.boxes[1:])
    states = {k: orjson.loads(v)["status"] for k, v in r.kv[TILES_KEY].items()}
    assert states == {"0/28/60": "split"}
    assert all(q.failures >= 1 for t, q in job.tiles._queued.items() if t.box in wfs.boxes[1:])
    runs = [kw for j, _p, kw in db.runs if j == "traffic_grid_geom"]
    assert "still too large after a split" in runs[-1]["error_text"]


def deep_in(grid: FakeGrid, t: Tile, margin: float = 1_800.0) -> list[str]:
    """칸 전체가 타일 t 의 자식 하나 안에 드는(가장자리에서 margin m 넘게) 칸 — 받은 기하(합성 서버의 꼭짓점)로만 고른다."""
    out = []
    for g in grid.cells_in(t.box):
        ex = extent(*grid.where[g])
        for k in t.children():
            x0, y0, x1, y1 = k.box
            if ex[0] > x0 + margin and ex[2] < x1 - margin and ex[1] > y0 + margin and ex[3] < y1 - margin:
                out.append(g)
    return out


async def test_known_cells_inside_the_box_missing_from_the_answer_do_not_let_the_tile_finish(caplog):
    """검토 지적(2026-10-01): 타일은 수(numberOfFeatures · maxFeatures)만 보고 끝났다 — 상자 안의 아는 칸이 답에 없어도(서버가 조용히 잘랐거나
    빠뜨렸다) done(기한 없음). 아는 칸(marine_grid4) 가운데 칸 전체가 상자 안인 칸이 답에 없으면 잘렸을 수 있다고 보고 나눈다 — 수로 잡지 못하는
    '조용한 상한'을 이미 가진 자료로 잡는다. 빠진 칸이 든 자식이 부모보다 적은 지물로도 여전히 빠뜨리면(상한으로 설명되지 않는다) incomplete."""
    caplog.set_level(logging.INFO, logger=LOGGER)
    grid = FakeGrid()
    deep = deep_in(grid, A)
    hidden = {deep[0], deep[-1]}
    wfs = GridWfs(grid, hidden=hidden)
    job, wfs, r, _c, db = start(grid, [home(grid, A)[1]], known=[*hidden, home(grid, A)[2]], wfs=wfs)
    await job.run_once()
    states = {k: orjson.loads(v)["status"] for k, v in r.kv[TILES_KEY].items()}
    assert states["0/28/60"] == "split" and wfs.boxes[:5] == [A.box, *[k.box for k in A.children()]]
    holding = {k.key for k in A.children() if any(tile_at(*cell_xy(grid.cell(g)), 1) == k for g in hidden)}
    assert {k: v for k, v in states.items() if k in holding} == dict.fromkeys(holding, "incomplete")
    assert all(v == "done" for k, v in states.items() if k not in holding and k != "0/28/60")
    q = [q for run in db.runs if run[0] == "traffic_grid_geom" for q in run[2].get("quality") or []]
    assert [x[2]["tile"] for x in q if x[0] == "traffic_grid_tile_missing_cell"][0] == "0/28/60"
    (split_line,) = lines(caplog, "0/28/60 possibly truncated")
    assert "known cells inside the box missing from the answer" in split_line


async def test_a_quiet_server_cap_is_caught_by_known_cells_and_split_until_complete():
    """확인하지 않은 경우(ADR-023): 서버가 maxFeatures 보다 적게 조용히 자르고 numberOfFeatures 도 같이 줄인다(합성 상한 60). 수로는 알 수 없지만 상자
    안의 아는 칸이 빠져 나눈다 — 나눈 상자는 상한 아래라 모두 온다: 한 칸 조회 없이 스냅샷의 칸이 풀리고 incomplete 는 없다."""
    grid = FakeGrid()

    class Capped(GridWfs):
        async def bbox(self, box, *, wait_s=5.0, before_send=None):
            self.answers[box] = self.grid.body(box, max_features=60)  # numberOfFeatures = 준 수(조용한 상한)
            return await super().bbox(box, wait_s=wait_s, before_send=before_send)

    order = grid.cells_in(A.box)
    beyond = [g for g in deep_in(grid, A) if order.index(g) >= 60]
    wfs = Capped(grid)
    job, wfs, r, _c, _db = start(grid, beyond[2:6], known=beyond[:2], wfs=wfs)
    await job.run_once()
    states = {k: orjson.loads(v)["status"] for k, v in r.kv[TILES_KEY].items()}
    assert states["0/28/60"] == "split" and "incomplete" not in states.values()
    assert wfs.asked == [] and snapshot(r)["resolved"] == 4


async def test_an_answer_about_another_place_does_not_finish_the_tile():
    """검토 지적(2026-10-01): 먼 타일의 칸만 담은 답도 A 를 끝냈다(그 칸들을 A 의 답으로 적었다). 이제 그런 답은 오류 — A 는 물러났다가 다시."""
    grid = FakeGrid()
    wfs = GridWfs(grid, answers={A.box: grid.body(FAR.box)})
    job, wfs, r, _c, _db = start(grid, [home(grid, A)[1]], known=[home(grid, A)[0]], wfs=wfs)
    await job.run_once()
    assert wfs.boxes[0] == A.box and "0/28/60" not in r.kv.get(TILES_KEY, {})
    assert not set(grid.cells_in(FAR.box)) & set(job.geometry.cells)
    assert A in job.tiles.queued_tiles() and job.tiles.retries()[0] == 1


async def test_an_oversized_tile_is_split_not_counted_as_an_error():
    grid = FakeGrid()
    wfs = GridWfs(grid, answers={A.box: WfsTooLarge("response too large (500000 bytes > 393216)")})
    job, wfs, r, _c, _db = start(grid, home(grid, A)[:2], known=[home(grid, A)[5]], wfs=wfs)
    await job.run_once()
    assert wfs.boxes == [A.box, *[k.box for k in A.children()]]
    assert r.kv[HB]["traffic_grid_fill_state"] == "idle" and snapshot(r)["resolved"] == 2


async def test_tile_errors_back_off_per_tile_and_trip_the_tile_breaker_while_lookups_go_on(caplog):
    caplog.set_level(logging.INFO, logger=LOGGER)
    grid = FakeGrid()
    boom = ProviderHttpError(502, "bad gateway")
    tiles = [A, FAR, Tile(0, 33, 52), Tile(0, 31, 58)]
    known = [home(grid, t)[0] for t in tiles]
    wfs = GridWfs(grid, answers={t.box: boom for t in tiles})
    job, wfs, r, clock, db = start(grid, [home(grid, A)[4]], known=known, wfs=wfs)
    await job.run_once()
    assert len(wfs.boxes) == tg.FILL_BREAKER_ERRORS and wfs.asked == [home(grid, A)[4]]
    assert job.tiles.retries()[0] == tg.FILL_BREAKER_ERRORS
    (warn,) = [x.getMessage() for x in caplog.records if x.name == LOGGER and x.levelno == logging.WARNING]
    assert warn.startswith(
        "traffic grid: 3 bbox tile errors in a row — tiles paused until 2026-09-29T09:11:15Z, one-id lookups go on"
    )
    # 물을 칸이 없고 타일만 쉰다 — 채우기 상태는 차단기, 다음은 타일이 다시 시작하는 때
    assert (r.kv[HB]["traffic_grid_fill_state"], r.kv[HB]["traffic_grid_fill_resume_at"]) == ("breaker", "2026-09-29T09:11:15Z")
    assert r.kv[HB]["traffic_grid_tiles_resume_at"] == "2026-09-29T09:11:15Z"
    (run,) = [kw for j, _p, kw in db.runs if j == "traffic_grid_geom"]
    assert (run["status"], run["http_status"]) == ("ok", 200)  # 한 칸 조회 하나가 성공했다 — 호출 넷 중 셋 실패
    assert run["error_text"].startswith("3 of 4 calls failed; last: ")


async def test_a_broken_bbox_does_not_starve_working_one_id_lookups():
    """검토 지적(2026-10-01, high): 타일은 늘 먼저이고 차단기를 한 칸 조회와 함께 썼다 — bbox 만 고장 나면(OGC 예외 · HTML · 시간 초과) 새 타일이
    차단기 주기마다 호출 셋을 먼저 써 한 칸 조회는 약 10일 동안 0번이었다(합성 재현: 타일 20개 · 24시간 동안 조회 0). 타일에는 따로 차단기를 두고,
    타일이 쉬는 동안 한 칸 조회가 시간 몫을 쓴다."""
    grid = FakeGrid()

    class BrokenBbox(GridWfs):
        async def bbox(self, box, *, wait_s=5.0, before_send=None):
            self.answers[box] = WfsError("ServiceExceptionReport — InvalidParameterValue: bbox")
            return await super().bbox(box, wait_s=wait_s, before_send=before_send)

    known_tiles = [Tile(0, 28 + dx, 58 + dy) for dx in range(5) for dy in range(4)]
    known = [home(grid, t)[0] for t in known_tiles]
    pending = [home(grid, Tile(0, 40 + k, 50))[0] for k in range(20)]
    job, wfs, r, clock, _db = start(grid, pending, known=known, wfs=BrokenBbox(grid))
    for _ in range(4):
        await job.run_once()
        clock.advance(30)
    assert sorted(wfs.asked) == sorted(pending) and snapshot(r)["resolved"] == 20
    assert len(wfs.boxes) == tg.FILL_BREAKER_ERRORS  # 타일은 쉬는 중 — 쉬는 동안 다시 묻지 않는다
    # 한 시간: 타일은 차단기 주기마다 셋(5 · 10 · 30분 쉼), 한 칸 조회는 막히지 않았다 — 어느 UTC 시에도 몫 안
    for _ in range(116):
        await job.run_once()
        clock.advance(30)
    assert 3 < len(wfs.boxes) <= 4 * tg.FILL_BREAKER_ERRORS and int(r.kv[MOF_HOUR]["used"]) <= SHARE


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
        "traffic grid: bbox tiles — 1 tile states loaded (1 done, 0 split, 0 incomplete, 0 failed still valid); "
        "0 children of split tiles queued again"
    )


async def test_split_children_are_queued_again_after_a_restart(caplog):
    """검토 지적(2026-10-01): split 은 Redis 에 기한 없이 남지만 일을 넘겨받은 자식은 메모리 대기열에만 있었다 — 나눈 뒤 자식을 묻기 전에 재기동하면
    (시간 창 · 하루 예산이 나눈 직후 채우기를 멈추면 흔하다) 아는 칸이 없는 자식은 다시 묻지 않았다. 기동 때 읽은 split 타일의 자식 가운데 결과가
    없는 것을 다시 넣는다."""
    caplog.set_level(logging.INFO, logger=LOGGER)
    grid = FakeGrid()
    r, clock = FakeRedis(), Clock()
    known = [home(grid, A)[0]]
    big = GridWfs(grid, answers={A.box: WfsTooLarge("response too large (500000 bytes > 393216)")})
    first, wfs1, _r, _c, _db = start(grid, [home(grid, A)[0]], known=known, r=r, clock=clock, wfs=big)
    r.kv[MOF_HOUR] = {"used": str(SHARE - 1), "limit": str(tg.MOF_HOURLY_CAP)}
    await first.run_once()
    assert wfs1.boxes == [A.box]
    assert {k: orjson.loads(v)["status"] for k, v in r.kv[TILES_KEY].items()} == {"0/28/60": "split"}
    clock.advance(3600)
    second, wfs2, _r, _c, _db = start(grid, [home(grid, A)[0]], known=known, r=r, clock=clock)
    await second.run_once()
    assert sorted(wfs2.boxes) == sorted(k.box for k in A.children())
    assert lines(caplog, "tile states loaded")[-1].endswith("; 4 children of split tiles queued again")


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

    real_hset = r.hset

    async def hset(key, *a, **kw):
        if key == TILES_KEY:
            raise NoPermissionError("NOPERM this user has no permissions to access one of the keys used as arguments")
        return await real_hset(key, *a, **kw)

    r.hgetall = hgetall  # type: ignore[method-assign]
    r.hset = hset  # type: ignore[method-assign]
    for _ in range(5):
        await job.run_once()
        clock.advance(30)
    assert wfs.boxes == [] and wfs.asked == [] and r.kv[HB]["traffic_grid_fill_state"] == "waiting_tiles"
    clock.advance(tg.DB_WAIT_S)
    for _ in range(3):
        await job.run_once()
        clock.advance(30)
    assert wfs.boxes == [A.box]
    warns = [x.getMessage() for x in caplog.records if x.name == LOGGER and x.levelno == logging.WARNING]
    assert len(warns) == 1 and "NoPermissionError" in warns[0] and "restart" in warns[0]
    # 틱마다 같은 실패를 쌓지 않는다 — 읽기 · 쓰기 실패는 까닭(예외 이름)이 바뀔 때만 INFO 한 줄
    assert len(lines(caplog, "tile states not readable")) == 1 and len(lines(caplog, "tile state write failed")) == 1


async def test_a_tile_never_marks_an_id_not_found_only_a_lookup_does():
    """상자에 없는 번호는 묻지 않은 것이다 — 타일이 끝나도 그 번호는 기다리고, 한 칸 조회가 0건으로 답해야 '해양격자에 없음'이다."""
    grid = FakeGrid()
    ghost = "GR4_NOT_IN_GRID"
    job, wfs, r, _c, _db = start(grid, [home(grid, A)[2], ghost], known=[home(grid, A)[0]])
    await job.run_once()
    assert wfs.boxes == [A.box] and wfs.asked == [ghost]
    assert orjson.loads(r.kv[NEGATIVE_KEY][ghost])["reason"] == "not_found"


def tile_body(
    grid: FakeGrid, box, *, shifted: set[str] = frozenset(), moved: dict | None = None, declared_extra: int = 0
) -> bytes:
    """상자 안의 칸 모두(합성 서버) — shifted = 꼭짓점을 동쪽으로 50 m 민 칸(격자 밖), moved = 번호 → (위도, 경도, gid) 다른 기하로 주는 칸."""
    feats = []
    for g in grid.cells_in(box):
        la, lo = grid.where[g]
        gid = grid.gids[g]
        if moved and g in moved:
            la, lo, gid = moved[g]
        pts = [(x + 50.0, y) for x, y in ring(la, lo)] if g in shifted else None
        feats.append(feature(g, la, lo, gid, pts=pts))
    return collection(feats, len(feats) + declared_extra)


async def test_a_tile_off_grid_feature_writes_no_negative_and_the_one_id_lookup_gives_the_verdict():
    """검토 지적(2026-10-01): 타일의 격자 밖 지물이 그 번호를 7일 부정 캐시에 넣어 한 칸 조회(확인한 길)에서 뺐다 — 한 번의 이상한 답(밀린 좌표 ·
    가장자리를 잘라 준 기하)이 번호 수백 개를 일주일 뺀다. 타일의 격자 밖 판정은 품질 사례 · 원본 보관만 하고 번호는 기다리게 둔다(한 칸 조회가
    판정한다). 아는 칸이 격자 밖으로 오면 아는 기하를 그대로 둔다."""
    grid = FakeGrid()
    ids = home(grid, A)
    pending_id, known_id = ids[3], ids[4]
    body = tile_body(grid, A.box, shifted={pending_id, known_id})
    wfs = GridWfs(grid, answers={A.box: body})
    job, wfs, r, _c, db = start(grid, [ids[1], pending_id, known_id], known=[ids[0], known_id], wfs=wfs)
    await job.run_once()
    assert NEGATIVE_KEY not in r.kv or not ({pending_id, known_id} & set(r.kv[NEGATIVE_KEY]))
    assert wfs.boxes == [A.box] and wfs.asked == [pending_id]  # 한 칸 조회가 판정한다(합성 서버는 그 칸을 준다)
    assert job.geometry.cells[known_id] == grid.cell(known_id)  # marine_grid4 의 기하 그대로
    assert snapshot(r)["resolved"] == 3
    q = [
        q
        for run in db.runs
        if run[0] == "traffic_grid_geom"
        for q in run[2].get("quality") or []
        if q[0] == "traffic_grid_off_grid"
    ]
    assert sorted(x[2]["grid_no"] for x in q) == sorted([pending_id, known_id])
    assert all(x[2]["tile"] == "0/28/60" and x[2]["raw_ref"] for x in q)


async def test_a_lookup_that_finds_a_cell_a_done_tile_did_not_list_rechecks_that_tile_once(caplog):
    """done 타일 안에서 한 칸 조회가 칸을 찾으면(타일 응답에 없던 칸 — 서버가 조용히 뺐거나 DB 쓰기를 잃었다) 그 타일을 한 번 다시 묻는다. 다시
    받아도 없으면 그 답은 잘렸을 수 있다(빠진 아는 칸 — 품질 사례 traffic_grid_tile_missing_cell): 넷으로 나누고, 그 칸이 든 자식이 부모보다 적은
    지물로도 여전히 빠뜨리면 incomplete · WARN 한 줄(bbox 응답이 칸을 빠뜨릴 수 있다는 증거 — 그 칸은 한 칸 조회가 맡는다). 되풀이하지 않는다."""
    caplog.set_level(logging.INFO, logger=LOGGER)
    grid = FakeGrid()
    ids = home(grid, A)
    hidden = ids[7]
    wfs = GridWfs(grid, hidden={hidden})
    job, wfs, r, _c, db = start(grid, [ids[1], hidden], known=[ids[0]], wfs=wfs)
    await job.run_once()
    assert wfs.boxes[:2] == [A.box, A.box] and wfs.asked == [hidden]
    assert wfs.boxes[2:] == [k.box for k in A.children()]
    states = {k: orjson.loads(v)["status"] for k, v in r.kv[TILES_KEY].items()}
    holder = tile_at(*cell_xy(grid.cell(hidden)), 1)
    assert states == {"0/28/60": "split", **{k.key: "incomplete" if k == holder else "done" for k in A.children()}}
    (warn,) = [x.getMessage() for x in caplog.records if x.name == LOGGER and x.levelno == logging.WARNING]
    assert holder.key in warn and hidden in warn and "incomplete" in warn
    q = [q for run in db.runs if run[0] == "traffic_grid_geom" for q in run[2].get("quality") or []]
    assert [x[2]["tile"] for x in q if x[0] == "traffic_grid_tile_missing_cell"] == ["0/28/60", holder.key]
    assert snapshot(r)["resolved"] == 2


# ---- 기록 · 관측 ---------------------------------------------------------------------------------------------------------------


async def test_the_pass_summary_and_the_heartbeat_count_tiles(caplog):
    caplog.set_level(logging.INFO, logger=LOGGER)
    grid = FakeGrid()
    wfs = GridWfs(grid, answers={A.box: grid.body(A.box, extra_declared=3)})
    known = [home(grid, A)[0], home(grid, FAR)[0]]
    job, wfs, r, _c, db = start(grid, [home(grid, A)[3], home(grid, FAR)[4]], known=known, wfs=wfs)
    await job.run_once()
    (line,) = lines(caplog, "geometry fill pass")
    n_cells = len(grid.cells_in(A.box)) + sum(len(grid.cells_in(k.box)) for k in A.children()) + len(grid.cells_in(FAR.box))
    assert "— 0 lookups: 0 found, 0 not in the MOF grid, 0 off grid, 0 errors (0 set aside as failed); 6 tiles: " in line
    new = int(r.kv[HB]["traffic_grid_cells_known"]) - 2
    # 새 칸만 DB 에 보낸다(이미 같은 기하로 아는 칸 · 겹치는 타일이 다시 준 칸은 보내지 않는다) — 'queued' 는 쓰기 큐에 넣었다는 뜻(쓰기는 비동기)
    assert (
        f"6 tiles: {n_cells} cells listed ({new} new, {sum(db.calls)} queued for marine_grid4), 1 split and 0 left incomplete as possibly truncated, 0 errors; "
        in line
    )
    assert "; tiles queued 0, done 5; " in line and sum(db.calls) == new
    assert line.endswith("queue empty — every queued id has geometry or a negative-cache entry; no tile queued (5 done)")
    hb = r.kv[HB]
    assert (
        hb["traffic_grid_fill_pass_tiles"],
        hb["traffic_grid_fill_pass_tile_splits"],
        hb["traffic_grid_fill_pass_tile_errors"],
    ) == ("6", "1", "0")
    assert hb["traffic_grid_fill_pass_tile_cells"] == str(n_cells)
    assert int(hb["traffic_grid_fill_pass_tile_new"]) == int(hb["traffic_grid_cells_known"]) - 2
    assert hb["traffic_grid_fill_pass_tile_stored"] == str(sum(db.calls))
    assert (hb["traffic_grid_tiles_done"], hb["traffic_grid_tiles_queued"]) == ("5", "0")
    assert r.kv["wakeline:provider:mof_grid4"]["last_records"] == str(n_cells)


async def test_without_a_tile_source_the_heartbeat_tile_fields_are_empty():
    from test_traffic_grid_job import setup

    job, _k, _w, r, _c, _db = setup()
    await job.run_once()
    for f in (
        "tiles_done",
        "tiles_queued",
        "fill_pass_tiles",
        "fill_pass_tile_cells",
        "fill_pass_tile_stored",
        "fill_pass_tile_incomplete",
    ):
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
