"""격자 기하 채우기의 bbox 타일 계획(ADR-023 2026-10-01 bbox 개정) — 해양수산부 격자4단계 WFS 를 칸 하나가 아니라 상자 하나로 묻는다.

- 타일: EPSG:5179(m)에 고정한 정사각형. level 0 은 원점에서 TILE_M(32 km) 간격, 나누면 한 변이 절반(level 1 = 16 km · 2 = 8 km · 3 = 4 km). 키 "level/ix/iy".
  32 km 는 모형(칸이 빈틈없이 깔렸다고 본 합성 서버 — 확인한 두 호출 28 · 450칸을 재현, tests/wfs_tiles)으로 176–201칸 · 113–129 KB — 확인한 450칸 ·
  289 KB 응답의 절반 아래다(maxFeatures · 응답 크기의 서버 상한은 확인하지 않았다 — 확인한 범위 안에 머문다).
- 어디를 묻는가 — 칸의 위치는 WFS 기하(꼭짓점)에서만 온다. 칸 번호의 글자에서 위치를 읽지 않는다(번호 체계는 확인하지 않았다 — 사용자 규칙):
  ① 아는 칸(marine_grid4)의 중심이 든 타일(칸이 많은 타일 먼저) ② 한 칸 조회로 찾은 칸의 타일 ③ 받은 타일의 가장자리에 걸친 칸 — 지금 스냅샷에서
  위치를 모르던 칸일 때 — 의 꼭짓점이 든 이웃 타일. 어느 경우든 이미 끝났거나 대기 중인 타일은 다시 넣지 않는다.
- 순서: 나눈 타일(시작한 상자를 먼저 끝낸다) → 한 칸 조회 · 가장자리 · 다시 묻기(지금 배가 있는 곳) → 아는 칸(칸이 많은 타일 먼저). 같으면 넣은 순서.
  오류가 났던 타일은 처음 묻는 타일 뒤(한 칸 조회와 같은 규칙).
- 결과(status): done(다시 묻지 않는다) · split(잘렸을 수 있어 넷으로 — 자식이 맡는다) · incomplete(가장 작은 타일(4 km)도 잘렸을 수 있음) ·
  failed(연달아 TILE_MAX_FAILURES 번 오류). incomplete · failed 는 TILE_FAILED_TTL_S(1일) 뒤 다시 넣을 수 있다. done 에 기한이 없는 까닭: 칸의 기하는
  바뀌지 않는다고 본다(한 칸 조회도 찾은 칸은 다시 묻지 않는다 — 같은 규칙). 대신 한 칸 조회가 done 타일 안에서 칸을 찾으면(그 타일 응답에 없던 칸 —
  DB 쓰기를 잃었거나 서버가 조용히 잘랐다) 그 타일을 이 프로세스에서 한 번 다시 묻는다(recheck — 되풀이하지 않는다).
- 상태는 작업이 Redis 해시 wakeline:traffic_grid:tiles(키 → {"status","at","cells"})에 적고 기동 때 읽는다(load) — 재기동해도 끝난 타일을 다시 묻지 않는다.
  대기열(무엇을 물을지)은 메모리다 — 다시 시작하면 아는 칸에서 다시 만든다(끝난 타일은 빠진다).
TILE_M · MAX_LEVEL · 물러나기 단계 · 연달아 실패 5번 · 1일은 선택값이다(잰 값이 아니다).
"""

from __future__ import annotations

import itertools
import math
import re
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any

import orjson

from wakeline_collector.marine_grid import Cell, wgs84_to_tm5179

TILE_M = 32_000
MAX_LEVEL = 3
TILE_RETRY_S = (300, 1800, 7200, 21600)
TILE_MAX_FAILURES = 5
TILE_FAILED_TTL_S = 86400
STATUSES = ("done", "split", "incomplete", "failed")
SOURCES = ("split", "recheck", "lookup", "edge", "known")
_RANK = {"split": 0, "recheck": 1, "lookup": 1, "edge": 1, "known": 2}
_KEY = re.compile(r"([0-3])/(-?\d{1,6})/(-?\d{1,6})")


@dataclass(frozen=True, slots=True, order=True)
class Tile:
    level: int
    ix: int
    iy: int

    @property
    def size(self) -> int:
        return TILE_M >> self.level

    @property
    def box(self) -> tuple[int, int, int, int]:
        """EPSG:5179 (xmin, ymin, xmax, ymax) m — WFS bbox 그대로."""
        s = self.size
        return self.ix * s, self.iy * s, (self.ix + 1) * s, (self.iy + 1) * s

    @property
    def key(self) -> str:
        return f"{self.level}/{self.ix}/{self.iy}"

    def children(self) -> tuple[Tile, ...]:
        return tuple(Tile(self.level + 1, 2 * self.ix + dx, 2 * self.iy + dy) for dy in (0, 1) for dx in (0, 1))

    def parent(self) -> Tile | None:
        return None if self.level == 0 else Tile(self.level - 1, self.ix >> 1, self.iy >> 1)


def tile_at(x: float, y: float, level: int = 0) -> Tile:
    s = TILE_M >> level
    return Tile(level, math.floor(x / s), math.floor(y / s))


def parse_key(key: str) -> Tile | None:
    m = _KEY.fullmatch(key)
    return None if m is None else Tile(int(m[1]), int(m[2]), int(m[3]))


def cell_xy(cell: Cell) -> tuple[float, float]:
    """칸 중심의 EPSG:5179 좌표 — WFS 가 준 기하(위경도로 푼 모서리)에서만."""
    return wgs84_to_tm5179((cell.lat_min + cell.lat_max) / 2, (cell.lon_min + cell.lon_max) / 2)


@dataclass(frozen=True)
class TileState:
    status: str  # done · split · incomplete · failed
    at: datetime
    cells: int = 0

    def valid(self, now: datetime) -> bool:
        return self.status in ("done", "split") or now < self.at + timedelta(seconds=TILE_FAILED_TTL_S)


def encode_state(s: TileState) -> str:
    return orjson.dumps({"status": s.status, "at": s.at.strftime("%Y-%m-%dT%H:%M:%SZ"), "cells": s.cells}).decode()


@dataclass
class _Queued:
    rank: int
    weight: int
    seq: int
    source: str
    next_try: datetime | None = None
    failures: int = 0


class TilePlan:
    """타일 대기열(메모리) · 결과(states — 작업이 Redis 에 적는다) · 이 프로세스에서 다시 물은 done 타일."""

    def __init__(self) -> None:
        self.states: dict[Tile, TileState] = {}
        self._queued: dict[Tile, _Queued] = {}
        self._seq = itertools.count()
        self._rechecked: dict[Tile, str] = {}

    @property
    def queued(self) -> int:
        return len(self._queued)

    def queued_tiles(self) -> list[Tile]:
        return list(self._queued)

    def done_count(self) -> int:
        return sum(1 for s in self.states.values() if s.status == "done")

    def covered(self, t: Tile, now: datetime) -> bool:
        s = self.states.get(t)
        return t in self._queued or (s is not None and s.valid(now))

    def leaf(self, x: float, y: float) -> Tile:
        """점이 든 가장 작은 타일 — level 0 에서 split 을 따라 내려간다."""
        t = tile_at(x, y)
        while t.level < MAX_LEVEL and (s := self.states.get(t)) is not None and s.status == "split":
            t = tile_at(x, y, t.level + 1)
        return t

    def add(self, t: Tile, source: str, now: datetime, weight: int = 1) -> bool:
        """넣었으면 True. 대기 중이면 순위만 올리고(더 급한 까닭이면) False, 끝났으면(유효한 상태) False."""
        rank = _RANK[source]
        q = self._queued.get(t)
        if q is not None:
            if rank < q.rank:
                q.rank, q.source = rank, source
            return False
        s = self.states.get(t)
        if s is not None and s.valid(now):
            return False
        self._queued[t] = _Queued(rank, weight, next(self._seq), source)
        return True

    def seed_at(self, x: float, y: float, source: str, now: datetime, weight: int = 1) -> Tile | None:
        t = self.leaf(x, y)
        return t if self.add(t, source, now, weight) else None

    def next_due(self, now: datetime) -> Tile | None:
        ready = [
            (q.failures > 0, q.rank, -q.weight, q.seq, t)
            for t, q in self._queued.items()
            if q.next_try is None or q.next_try <= now
        ]
        return min(ready)[4] if ready else None

    def has_due(self, now: datetime) -> bool:
        return any(q.next_try is None or q.next_try <= now for q in self._queued.values())

    def retries(self) -> tuple[int, datetime | None]:
        waits = [q.next_try for q in self._queued.values() if q.failures and q.next_try is not None]
        return sum(1 for q in self._queued.values() if q.failures), min(waits, default=None)

    def finish(self, t: Tile, status: str, cells: int, now: datetime) -> TileState:
        """결과를 적고 대기열에서 뺀다. split 이면 자식 넷을 넣는다(가장 작은 타일은 호출자가 incomplete 로 적는다)."""
        assert status in STATUSES
        self._queued.pop(t, None)
        s = self.states[t] = TileState(status, now, cells)
        if status == "split" and t.level < MAX_LEVEL:
            for c in t.children():
                self.add(c, "split", now)
        return s

    def failed(self, t: Tile, now: datetime) -> bool:
        """오류 한 번. TILE_MAX_FAILURES 번째면 failed 로 적고 True(호출자가 Redis 에 적는다), 아니면 물러나기만."""
        q = self._queued.get(t)
        if q is None:
            return False
        q.failures += 1
        if q.failures >= TILE_MAX_FAILURES:
            self.finish(t, "failed", 0, now)
            return True
        q.next_try = now + timedelta(seconds=TILE_RETRY_S[min(q.failures - 1, len(TILE_RETRY_S) - 1)])
        return False

    def recheck(self, t: Tile, grid_no: str, now: datetime) -> bool:
        """done 타일을 이 프로세스에서 한 번 다시 묻는다(grid_no = 그 안에서 한 칸 조회로 찾은 칸). 넣었으면 True."""
        s = self.states.get(t)
        if t in self._rechecked or t in self._queued or s is None or s.status != "done":
            return False
        self._rechecked[t] = grid_no
        self._queued[t] = _Queued(_RANK["recheck"], 1, next(self._seq), "recheck")
        return True

    def rechecking(self, t: Tile) -> str | None:
        return self._rechecked.get(t)

    def load(self, fields: dict[Any, Any]) -> int:
        """Redis 해시(키 → {"status","at","cells"}) → 상태. 형식이 틀린 항목은 버린다(그 타일은 다시 물으면 된다). 읽은 수."""
        n = 0
        for key, raw in fields.items():
            t = parse_key(key.decode() if isinstance(key, bytes) else str(key))
            if t is None:
                continue
            try:
                v = orjson.loads(raw)
                status, cells = v["status"], v["cells"]
                at = datetime.fromisoformat(str(v["at"]).replace("Z", "+00:00"))
            except (orjson.JSONDecodeError, KeyError, TypeError, ValueError):
                continue
            if status in STATUSES and isinstance(cells, int) and cells >= 0 and at.tzinfo is not None:
                self.states[t] = TileState(status, at, cells)
                n += 1
        return n
