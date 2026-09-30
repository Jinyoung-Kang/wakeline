"""격자 기하 채우기의 bbox 타일 계획(ADR-023 2026-10-01 bbox 개정) — EPSG:5179 에 고정한 타일 · 나누기 · 순서 · 상태와 재기동 · 한 번만 묻기.
타일은 칸의 WFS 기하(꼭짓점)로만 정한다 — 칸 번호의 글자에서 위치를 읽지 않는다."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import orjson
import pytest

from wakeline_collector import grid_tiles as gt
from wakeline_collector.grid_tiles import MAX_LEVEL, TILE_M, Tile, TilePlan, cell_xy, parse_key, tile_at
from wakeline_collector.marine_grid import Cell, wgs84_to_tm5179

T0 = datetime(2026, 10, 1, 6, 0, tzinfo=UTC)
VERIFIED = Cell("GR4_F2K41_C3", 37.45, 126.6, 37.475, 126.625, 167305)  # 2026-09-29 실제 응답의 칸


# ---- 타일 -----------------------------------------------------------------------------------------------------------------


def test_tiles_are_fixed_32km_squares_in_epsg5179_and_split_into_four():
    assert TILE_M == 32_000 and MAX_LEVEL == 3  # 32 → 16 → 8 → 4 km
    t = tile_at(921_514.0, 1_940_736.0)
    assert t == Tile(0, 28, 60) and t.box == (896_000, 1_920_000, 928_000, 1_952_000) and t.key == "0/28/60"
    kids = t.children()
    assert [k.box for k in kids] == [
        (896_000, 1_920_000, 912_000, 1_936_000),
        (912_000, 1_920_000, 928_000, 1_936_000),
        (896_000, 1_936_000, 912_000, 1_952_000),
        (912_000, 1_936_000, 928_000, 1_952_000),
    ]
    assert all(k.parent() == t for k in kids) and t.parent() is None
    assert tile_at(-1.0, -1.0) == Tile(0, -1, -1)  # 내림(음수도)
    assert Tile(3, 229, 481).size == 4_000 and tile_at(917_000.0, 1_925_000.0, 3) == Tile(3, 229, 481)


def test_tile_keys_round_trip_and_bad_keys_are_ignored():
    for t in (Tile(0, 28, 60), Tile(3, -5, 12345), Tile(2, 0, 0)):
        assert parse_key(t.key) == t
    for bad in ("", "0/1", "4/1/2", "0/a/1", "0/1/2/3", " 0/1/2", "0/1/2 ", "-1/0/0", "0/1234567/0"):
        assert parse_key(bad) is None


def test_a_cells_tile_comes_from_its_geometry_not_its_number():
    """칸의 위치(타일)는 WFS 가 준 기하의 중심에서만 — 번호가 달라도 기하가 같으면 같은 타일, 번호가 같아도 기하가 다르면 다른 타일."""
    x, y = cell_xy(VERIFIED)
    ex, ey = wgs84_to_tm5179(37.4625, 126.6125)
    assert (x, y) == pytest.approx((ex, ey), abs=1e-6)
    assert tile_at(*cell_xy(VERIFIED)) == Tile(0, 28, 60)
    other_name = Cell("GR4_ZZZZZ_Z9", 37.45, 126.6, 37.475, 126.625, None)
    moved = Cell("GR4_F2K41_C3", 35.0, 129.0, 35.025, 129.025, None)
    assert tile_at(*cell_xy(other_name)) == tile_at(*cell_xy(VERIFIED)) != tile_at(*cell_xy(moved))


# ---- 대기열: 순서 · 한 번만 -----------------------------------------------------------------------------------------------------


def test_order_is_split_then_current_traffic_then_known_cells_by_weight():
    p = TilePlan()
    assert p.add(Tile(0, 1, 1), "known", T0, weight=5)
    assert p.add(Tile(0, 2, 2), "known", T0, weight=50)
    assert p.add(Tile(0, 3, 3), "edge", T0)
    assert p.add(Tile(0, 4, 4), "lookup", T0)
    order = []
    while (t := p.next_due(T0)) is not None:
        order.append(t)
        p.finish(t, "split" if t == Tile(0, 3, 3) else "done", 10, T0)
    kids = list(Tile(0, 3, 3).children())
    # 가장자리(먼저 넣음) → 나눈 자식 넷(시작한 타일을 먼저 끝낸다) → 한 칸 조회 → 아는 칸(칸 많은 타일 먼저)
    assert order == [Tile(0, 3, 3), *kids, Tile(0, 4, 4), Tile(0, 2, 2), Tile(0, 1, 1)]


def test_a_known_tile_is_promoted_when_current_traffic_points_at_it():
    p = TilePlan()
    p.add(Tile(0, 1, 1), "known", T0, weight=500)
    p.add(Tile(0, 2, 2), "known", T0, weight=1)
    assert not p.add(Tile(0, 2, 2), "edge", T0)  # 이미 대기 중 — 새로 넣지 않고 순위만 올린다
    assert p.next_due(T0) == Tile(0, 2, 2)


def test_a_finished_tile_is_never_fetched_twice():
    p = TilePlan()
    t = Tile(0, 5, 5)
    p.add(t, "known", T0)
    assert p.next_due(T0) == t
    p.finish(t, "done", 200, T0)
    assert p.next_due(T0) is None and p.queued == 0
    for source in ("known", "lookup", "edge"):
        assert not p.add(
            t, source, T0 + timedelta(days=365)
        )  # done 은 기한이 없다(칸 기하는 바뀌지 않는다고 본다 — 한 칸 조회도 다시 묻지 않는다)
    assert p.covered(t, T0) and p.done_count() == 1


def test_leaf_follows_splits_down_to_the_smallest_tile():
    p = TilePlan()
    x, y = 917_000.0, 1_925_000.0
    assert p.leaf(x, y) == Tile(0, 28, 60)
    p.finish(Tile(0, 28, 60), "split", 0, T0)
    assert p.leaf(x, y) == Tile(1, 57, 120) and p.covered(Tile(1, 57, 120), T0)  # 자식은 대기 중
    p.finish(Tile(1, 57, 120), "split", 0, T0)
    p.finish(Tile(2, 114, 240), "split", 0, T0)
    assert p.leaf(x, y) == Tile(3, 229, 481)
    p.finish(Tile(3, 229, 481), "split", 0, T0)  # 가장 작은 타일은 더 나누지 않는다(작업이 incomplete 로 적는다)
    assert p.leaf(x, y) == Tile(3, 229, 481)
    assert all(t.level <= MAX_LEVEL for t in p.queued_tiles())


def test_seed_at_a_point_adds_the_leaf_only_when_nothing_covers_it():
    p = TilePlan()
    x, y = cell_xy(VERIFIED)
    assert p.seed_at(x, y, "lookup", T0) == Tile(0, 28, 60)
    assert p.seed_at(x, y, "lookup", T0) is None  # 대기 중
    p.finish(Tile(0, 28, 60), "done", 201, T0)
    assert p.seed_at(x, y, "edge", T0) is None  # 끝남


# ---- 실패 · 다시 묻기 ----------------------------------------------------------------------------------------------------------


def test_failures_back_off_then_set_the_tile_aside_for_a_day():
    p = TilePlan()
    t = Tile(0, 7, 7)
    p.add(t, "known", T0)
    now = T0
    for i, step in enumerate(gt.TILE_RETRY_S):
        assert not p.failed(t, now)
        assert p.next_due(now) is None and p.retries() == (1, now + timedelta(seconds=step))
        now += timedelta(seconds=step)
        assert p.next_due(now) == t, i
    assert p.failed(t, now)  # 다섯 번째
    assert p.queued == 0 and p.states[t].status == "failed"
    assert not p.add(t, "known", now + timedelta(hours=23))
    assert p.add(t, "known", now + timedelta(seconds=gt.TILE_FAILED_TTL_S))  # 1일 뒤 다시


def test_retried_tiles_wait_behind_first_time_tiles():
    p = TilePlan()
    a, b = Tile(0, 1, 0), Tile(0, 2, 0)
    p.add(a, "lookup", T0)
    p.add(b, "known", T0)
    p.failed(a, T0)
    later = T0 + timedelta(seconds=gt.TILE_RETRY_S[0])
    assert p.next_due(later) == b


def test_a_done_tile_is_rechecked_once_per_process():
    """한 칸 조회가 done 타일 안에서 칸을 찾았다 = 그 타일 응답에 없던 칸(DB 쓰기를 잃었거나 서버가 조용히 잘랐다). 한 번만 다시 묻는다(되풀이하지 않는다)."""
    p = TilePlan()
    t = Tile(0, 9, 9)
    p.add(t, "known", T0)
    p.finish(p.next_due(T0) or t, "done", 10, T0)
    assert p.recheck(t, "GR4_LOST", T0) and p.rechecking(t) == "GR4_LOST"
    assert p.next_due(T0) == t
    assert not p.recheck(t, "GR4_OTHER", T0)
    p.finish(t, "done", 11, T0)
    assert not p.recheck(t, "GR4_LOST", T0) and p.next_due(T0) is None
    assert not p.recheck(Tile(0, 8, 8), "GR4_X", T0)  # done 이 아닌 타일은 되묻지 않는다(대기열에 넣는 건 seed_at)


# ---- 재기동: 상태는 Redis 해시에 --------------------------------------------------------------------------------------------------


def test_states_survive_a_restart_and_expired_failures_reopen():
    p = TilePlan()
    for t, status in (
        (Tile(0, 1, 1), "done"),
        (Tile(0, 2, 2), "split"),
        (Tile(1, 4, 4), "incomplete"),
        (Tile(0, 3, 3), "failed"),
    ):
        p.states[t] = gt.TileState(status, T0, 7)
    fields = {t.key: gt.encode_state(s) for t, s in p.states.items()}
    fields["bad key"] = fields["0/1/1"]
    fields["0/9/9"] = b"not json"
    fields["0/8/8"] = orjson.dumps({"status": "maybe", "at": "2026-10-01T06:00:00Z", "cells": 1}).decode()
    fields["0/7/7"] = orjson.dumps({"status": "done", "at": "2026-10-01T06:00:00", "cells": 1}).decode()  # 시간대 없음
    q = TilePlan()
    assert q.load({k.encode(): v for k, v in fields.items()}) == 4
    assert q.states == p.states
    assert all(q.covered(t, T0 + timedelta(hours=1)) for t in p.states)
    later = T0 + timedelta(seconds=gt.TILE_FAILED_TTL_S)
    assert q.covered(Tile(0, 1, 1), later) and q.covered(Tile(0, 2, 2), later)
    assert not q.covered(Tile(1, 4, 4), later) and not q.covered(Tile(0, 3, 3), later)
    assert orjson.loads(fields["0/1/1"]) == {"status": "done", "at": "2026-10-01T06:00:00Z", "cells": 7}
