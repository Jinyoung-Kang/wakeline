"""후보 5: AIS 가 Redis 장애 중에 재시작되면 모은 위치(ShipBook — ADR-033)는 얼마나 사라지고, 그 구간이 공백(ais_gap)으로 남는가 — 모의 실행.

실제 코드: ais.book.ShipBook · ais.shards.ShardSet · ais.sink.AisSink(main.py 의 기동 순서 — read_previous_status → load_previous → add(None) →
restore_leftover, 종료 순서 — shards.on_stopped → sink.final). Redis = tests/fakes.FakeRedis(down 이면 모든 명령 ConnectionError), 시계는 손으로.
선박 2척이 15 s 마다 보고. 시각(초, T0 = 분 경계):
  0–14   Redis 정상 — 발행 · 상태 쓰기
  15–199 Redis 장애 — 프로세스 1 이 분당 첫 위치를 모은다(hold)
  200    프로세스 1 종료(SIGTERM — 마지막 발행 · 상태 쓰기 실패)
  A: Redis 가 300 에 돌아온다(프로세스 2 는 장애 중 210 에 기동)   B: Redis 가 205 에 돌아온다(프로세스 2 는 그 뒤 210 에 기동)
api 와 같은 줄이기(MMSI 별 60 s 창마다 첫 보고)로 행을 세고, ais_gap 항목을 본다.
실행: cd apps/collector && uv run --offline python ../../docs/qa/2026-10-aws/evidence/collector/c5_ais_restart_during_redis_outage.py
"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path.cwd() / "tests"))

from fakes import FakeRedis  # noqa: E402
from test_ais_helpers import decode  # noqa: E402

from wakeline_collector.ais.book import ShipBook  # noqa: E402
from wakeline_collector.ais.parse import Position, iso_ms  # noqa: E402
from wakeline_collector.ais.queue import RawQueue  # noqa: E402
from wakeline_collector.ais.shards import ShardSet  # noqa: E402
from wakeline_collector.ais.sink import AisSink  # noqa: E402
from wakeline_collector.ais.worker import Worker  # noqa: E402
from wakeline_collector.publisher import STREAM_SHIPS  # noqa: E402

T0 = 1_800_000_000.0
SHIPS = ("440000001", "440000002")


class Clock:
    def __init__(self) -> None:
        self.t = T0

    def __call__(self) -> float:
        return self.t


def pos(mmsi: str, t: float) -> Position:
    return Position(mmsi=mmsi, lat=35.0, lon=129.0 + (t - T0) / 10_000, sog_kn=10.0, cog_deg=90.0, heading_deg=90, nav_status=0,
                    rot=0, position_source="epfs", seen_at=iso_ms(t), t=t, msg_type="PositionReport", cls="A")


class Proc:
    """ais 프로세스 하나(수신 · 발행 부분) — main._run 의 기동 순서 그대로(fixture: 구역 하나, scope 없음)."""

    def __init__(self, r: FakeRedis, clock: Clock) -> None:
        self.clock = clock
        self.book = ShipBook("aisstream")
        self.shards = ShardSet("aisstream", wall=clock)
        q = RawQueue(100)
        self.sink = AisSink(r, book=self.book, shards=self.shards, worker=Worker(q, self.book), queue=q,  # type: ignore[arg-type]
                            provider="aisstream", raw_ref="-", wall=clock)

    async def start(self) -> None:
        self.shards.load_previous(await self.sink.read_previous_status())
        self.feed = self.shards.add(None).feed
        self.shards.restore_leftover()
        self.feed.on_subscribed("", deflate=None, state="receiving")

    def receive(self, t: float) -> None:
        self.clock.t = t
        for m in SHIPS:
            self.feed.on_message(t)
            self.book.apply_position(pos(m, t), t)

    async def tick(self) -> None:
        await self.sink.publish_gaps()
        await self.sink.flush()
        await self.sink.write_status()

    async def stop(self) -> None:
        self.shards.on_stopped()
        await self.sink.final()


def rows_like_the_api(r: FakeRedis) -> tuple[dict[str, list[int]], list[dict]]:
    kept: dict[str, int] = {}
    rows: dict[str, list[int]] = {}
    gaps = []
    for _, f in r.streams.get(STREAM_SHIPS, []):
        p = decode(f)
        if f["kind"] == "ais_gap":
            gaps.append(p)
            continue
        for s in p["ships"]:
            from datetime import datetime

            w = int(datetime.fromisoformat(s["seen_at"].replace("Z", "+00:00")).timestamp() - T0) // 60
            if s["mmsi"] in kept and w <= kept[s["mmsi"]]:
                continue
            kept[s["mmsi"]] = w
            rows.setdefault(s["mmsi"], []).append(w)
    return rows, gaps


async def scenario(name: str, redis_back_at: float) -> None:
    r, clock = FakeRedis(), Clock()
    p1 = Proc(r, clock)
    await p1.start()
    held_at_stop = 0
    for t in range(0, 200, 15):
        r.down = 15 <= t
        p1.receive(T0 + t)
        if t % 10 == 0 or t % 15 == 0:
            await p1.tick()
    held_at_stop = p1.book.backlog
    clock.t = T0 + 200
    await p1.stop()  # 마지막 발행 · 상태 쓰기 — Redis 장애라 실패
    clock.t = T0 + 205
    r.down = redis_back_at > T0 + 205
    p2 = Proc(r, clock)
    clock.t = T0 + 210
    await p2.start()
    for t in range(210, 400, 15):
        r.down = T0 + t < redis_back_at
        p2.receive(T0 + t)
        await p2.tick()
    clock.t = T0 + 400
    r.down = False
    await p2.tick()
    await p2.tick()
    rows, gaps = rows_like_the_api(r)
    print(f"[{name}] 프로세스 1 이 멈출 때 메모리에만 있던 분당 위치: {held_at_stop}건(선박 {len(SHIPS)}척 × 장애 분 수)")
    for m in SHIPS:
        print(f"  {m} 저장될 분(창 번호, T0 기준): {rows.get(m)} — 빠진 분: {sorted(set(range(0, 7)) - set(rows.get(m, [])))}")
    print(f"  ais_gap: {gaps or '없음'}")


async def main() -> None:
    await scenario("A Redis 가 프로세스 2 기동 뒤에 돌아옴", T0 + 300)
    await scenario("B Redis 가 프로세스 2 기동 전에 돌아옴", T0 + 205)


asyncio.run(main())
