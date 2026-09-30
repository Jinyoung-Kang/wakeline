"""시뮬레이션(잰 값이 아니다) — ADR-023 2026-10-01 bbox 개정의 예산 계산과 채우기 모형.

- 칸 분포는 tests/coast_sim.Coast(한반도 해안을 손으로 찍은 점 몇 개로 이은 꺾은선 · 40 km 띠 · 항로 넷 — 합성)이고, 격자 서버는
  tests/wfs_tiles.FakeGrid(칸이 빈틈없이 깔렸고 bbox 는 겹치는 칸을 모두 준다 — 확인한 두 호출 28 · 450칸을 재현하는 가정)다.
- 아래 수는 이 가정에서 나온다. 운영의 실제 타일 수는 배포 뒤 수집기 로그 'bbox tiles — N tiles queued from K known cells' 가 말한다.
"""

from __future__ import annotations

import logging
import random
from datetime import UTC, datetime, timedelta

import orjson
from coast_sim import Coast
from fakes import FakeRedis, make_ctx
from test_traffic_grid_job import Clock, FakeKomsa, komsa_body
from test_traffic_grid_tile_job import CallDb, GridWfs
from wfs_tiles import FakeGrid

from wakeline_collector.grid_tiles import tile_at
from wakeline_collector.jobs import traffic_grid as tg
from wakeline_collector.jobs.traffic_grid import SNAPSHOT_KEY, TrafficGridJob
from wakeline_collector.marine_grid import CELL_DEG, wgs84_to_tm5179
from wakeline_collector.traffic_grid import KST

SHARE = tg.MOF_HOURLY_CAP - tg.MOF_GRID4_HOURLY_HEADROOM  # 290
KNOWN_TODAY = 8_216  # 운영 2026-10-01 06:12 KST 'cells known'(오케스트레이터가 읽은 로그) — 모형의 아는 칸 수로만 쓴다


def _tiles_holding(cells, size_m: int) -> int:
    out = set()
    for i, j in cells:
        x, y = wgs84_to_tm5179((i + 0.5) * CELL_DEG, (j + 0.5) * CELL_DEG)
        out.add((int(x // size_m), int(y // size_m)))
    return len(out)


def test_budget_to_cover_the_known_cells_simulation():
    """시뮬레이션: 합성 분포에서 무게 비례로 뽑은 아는 칸 8,216개(운영의 오늘 수)가 든 타일 수 — 한 번씩 물으면 그 넓이를 덮는다.
    32 km 147타일 → 시간 몫 290 으로 약 0.5시간, UTC 날 예산 6,000 의 2.5%(25 km 225 · 40 km 104). 가장자리로 넓히는 이웃은 많아야 둘레 한 겹(111).
    분포와 상관없는 위 끝: 32–39 N × 124–132 E 상자 전체(육지 포함) 609타일 = 약 2.1시간 · 하루 예산의 10%."""
    coast = Coast()
    known = coast.sample(KNOWN_TODAY)
    assert len(coast.cells) == 17_494
    got = {size: _tiles_holding(known, size) for size in (25_000, 32_000, 40_000)}
    assert got == {25_000: 225, 32_000: 147, 40_000: 104}
    assert round(got[32_000] / SHARE, 2) == 0.51 and got[32_000] / 6000 < 0.03
    box = set()
    for a in range(0, 141):
        for b in range(0, 161):
            box.add(tile_at(*wgs84_to_tm5179(32.0 + a * 0.05, 124.0 + b * 0.05)))
    assert len(box) == 609 and 2.0 < len(box) / SHARE < 2.2


class CoastKomsa(FakeKomsa):
    """합성 점유: 칸마다 스냅샷에 있을 확률 p = min(0.9, 무게 × 1.2)(가정), 켜진 칸은 다음 스냅샷에 0.8 로 남고 꺼진 칸은 정상 상태가 p 가 되게
    켜진다. 5분마다 새 regDt(발행 60 s 뒤)."""

    def __init__(self, clock: Clock, coast: Coast, grid: FakeGrid, seed: int = 5) -> None:
        super().__init__(clock, b"")
        self.rng = random.Random(seed)
        self.cells = list(coast.cells)
        self.p = [min(0.9, coast.cells[c] * 1.2) for c in self.cells]
        self.ids = [grid.cell_id(i, j) for i, j in self.cells]
        self.on = [self.rng.random() < p for p in self.p]
        self.frames: dict[str, list[str]] = {}

    def frame(self, kst: str) -> list[str]:
        if kst not in self.frames:
            for k, p in enumerate(self.p):
                enter = p * 0.2 / (1 - p) if p < 1 else 1.0
                self.on[k] = self.rng.random() < (0.8 if self.on[k] else enter)
            self.frames[kst] = [self.ids[k] for k, on in enumerate(self.on) if on]
        return self.frames[kst]

    async def fetch(self, *, before_send=None):
        base = self.clock() - timedelta(seconds=60)
        reg = base.replace(minute=base.minute - base.minute % 5, second=5, microsecond=0)
        if reg > base:
            reg -= timedelta(minutes=5)
        kst = reg.astimezone(KST).strftime("%Y-%m-%d %H:%M:%S")
        self.answers = [komsa_body(kst, [(g, 3, 1.0) for g in self.frame(kst)])]
        return await super().fetch(before_send=before_send)


async def _run(tiles: bool, minutes: int) -> tuple[dict[int, float], dict[str, int], int]:
    coast, grid = Coast(), FakeGrid(seed=11)
    known = coast.sample(KNOWN_TODAY)
    r, clock = FakeRedis(), Clock(datetime(2026, 9, 29, 9, 0, 30, tzinfo=UTC))
    ctx = make_ctx(r, limits={"komsa_traffic": 400, "mof_grid4": 6000})
    ctx.db = CallDb(
        None,
        [
            (c.grid_no, c.lat_min, c.lon_min, c.lat_max, c.lon_max, c.gid)
            for c in (grid.cell(grid.cell_id(i, j)) for i, j in known)
        ],
    )  # type: ignore[assignment]
    wfs = GridWfs(grid)
    job = TrafficGridJob(CoastKomsa(clock, coast, grid), wfs, ctx, tiles=wfs if tiles else None, now=clock)
    share: dict[int, float] = {}
    per_hour: dict[str, int] = {}
    end = clock() + timedelta(minutes=minutes)
    while clock() < end:
        n = len(wfs.asked) + len(wfs.boxes)
        await job.run_once()
        h = clock().strftime("%Y%m%d%H")
        per_hour[h] = per_hour.get(h, 0) + len(wfs.asked) + len(wfs.boxes) - n
        minute = round((clock() - datetime(2026, 9, 29, 9, 0, 30, tzinfo=UTC)).total_seconds() / 60)
        if minute % 30 == 0 and SNAPSHOT_KEY in r.kv:
            p = orjson.loads(r.kv[SNAPSHOT_KEY])
            share[minute] = p["unresolved"] / p["total"]
        clock.advance(30)
    return share, per_hour, len(job.geometry.cells)


async def test_fill_simulation_tiles_resolve_the_unknown_cells_far_faster_than_one_id_lookups(caplog):
    """시뮬레이션 90분(첫 스냅샷 약 4,000칸): 같은 합성 연안 · 같은 아는 칸(8,216) · 같은 예산 규칙(시간 몫 290). 스냅샷의 '위치 모르는 칸' 몫 —
    한 칸 조회만: 0분 17.7% → 30분 16.3% → 90분 15.6%(시간 몫 290 을 다 쓰고도 새로 나타나는 칸을 거의 따라잡지 못한다 — 아는 칸 8,796),
    타일 먼저: 30분부터 0%(첫 시에 151호출 — 아는 칸의 타일 147개 + 가장자리 · 한 칸 조회, 둘째 시 2호출), 아는 칸 25,299(타일은 상자 안의 칸을
    모두 준다 — 모형에서는 육지 칸도). 둘 다 어느 UTC 시에도 290 을 넘지 않는다."""
    caplog.set_level(logging.WARNING)
    one_id, per_hour_1, known_1 = await _run(False, 90)
    tiled, per_hour_t, known_t = await _run(True, 90)
    assert per_hour_1 == {"2026092909": SHARE, "2026092910": SHARE}
    assert per_hour_t == {"2026092909": 151, "2026092910": 2}
    assert [round(one_id[m], 3) for m in (0, 30, 90)] == [0.177, 0.163, 0.156]
    assert [tiled[m] for m in (30, 60, 90)] == [0.0, 0.0, 0.0]
    assert (known_1, known_t) == (8_796, 25_299)
