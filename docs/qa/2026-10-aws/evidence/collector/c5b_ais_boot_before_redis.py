"""후보 5 덧붙임(AWS 리뷰 C-4 와 같은 것으로 보임): 부팅 때 ais 가 Redis 보다 먼저 떠 첫 읽기가 실패하면 밤 · 주말 공백이 남는가.
(아래는 c5 의 공용 부분 설명) AIS 가 Redis 장애 중에 재시작되면 모은 위치(ShipBook — ADR-033)는 얼마나 사라지고, 그 구간이 공백(ais_gap)으로 남는가 — 모의 실행.

실제 코드: ais.book.ShipBook · ais.shards.ShardSet · ais.sink.AisSink(main.py 의 기동 순서 — read_previous_status → load_previous → add(None) →
restore_leftover, 종료 순서 — shards.on_stopped → sink.final). Redis = tests/fakes.FakeRedis(down 이면 모든 명령 ConnectionError), 시계는 손으로.
선박 2척이 15 s 마다 보고. 시각(초, T0 = 분 경계):
  0–14   Redis 정상 — 발행 · 상태 쓰기
  15–199 Redis 장애 — 프로세스 1 이 분당 첫 위치를 모은다(hold)
  200    프로세스 1 종료(SIGTERM — 마지막 발행 · 상태 쓰기 실패)
  A: Redis 가 300 에 돌아온다(프로세스 2 는 장애 중 210 에 기동)   B: Redis 가 205 에 돌아온다(프로세스 2 는 그 뒤 210 에 기동)
api 와 같은 줄이기(MMSI 별 60 s 창마다 첫 보고)로 행을 세고, ais_gap 항목을 본다.
실행: cd apps/collector && uv run --offline python ../../docs/qa/2026-10-aws/evidence/collector/c5b_ais_boot_before_redis.py
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


async def boot_scenario(name: str, redis_ready_at: float) -> None:
    """프로세스 1 은 Redis 가 정상일 때 멈춘다(밤 · 주말 정지 — 상태 stopped · 공백 열림이 Redis 에 남음). 프로세스 2 는 부팅 때 Redis 보다 먼저 떠서
    첫 읽기(read_previous_status)가 실패한다(dockerd 가 순서 없이 띄움 · Redis AOF LOADING)."""
    r, clock = FakeRedis(), Clock()
    p1 = Proc(r, clock)
    await p1.start()
    for t in range(0, 60, 15):
        p1.receive(T0 + t)
        await p1.tick()
    clock.t = T0 + 60
    await p1.stop()
    st = await r.hgetall("wakeline:ais:status")
    print(f"[{name}] 프로세스 1 종료 뒤 상태 해시: state={st.get('state')} gap_open_since={st.get('gap_open_since')}")
    boot = T0 + 63 * 3600  # 주말(약 63 h) 뒤 부팅
    clock.t = boot
    r.down = redis_ready_at > boot
    p2 = Proc(r, clock)
    await p2.start()
    for t in range(5, 120, 15):
        r.down = boot + t < redis_ready_at
        p2.receive(boot + t)
        await p2.tick()
    _, gaps = rows_like_the_api(r)
    st = await r.hgetall("wakeline:ais:status")
    print(f"  ais_gap: {gaps or '없음'}")
    print(f"  프로세스 2 뒤 상태 해시: state={st.get('state')} gap_open_since={st.get('gap_open_since')!r} last_gap={st.get('last_gap_started_at')!r}")


async def main() -> None:
    await boot_scenario("C Redis 가 ais 보다 먼저 준비됨", T0)
    await boot_scenario("D ais 가 Redis 보다 2 s 먼저 뜸(첫 읽기 실패)", T0 + 63 * 3600 + 2)


asyncio.run(main())
