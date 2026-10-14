"""QA-1241(AWS 출시 QA · 신뢰성 · AIS 공백 기록): ais 가 Redis 보다 먼저 일어나면 그 앞의 수신 공백(정지 · 재시작)이 ingest_gap 에 남지 않는다.

ais 는 기동 때 **한 번만** 이전 실행의 상태 해시(wakeline:ais:status)를 읽어 정지 동안의 공백을 잇는다(main._run → AisSink.read_previous_status →
ShardSet.load_previous — 실패하면 빈 dict, WARN "previous ais status unavailable … no gap carried over" 뒤 다시 읽지 않는다). Redis 가 그 순간 답하지
않으면(AWS 데모의 매일 아침 부팅 — dockerd 는 compose depends_on 없이 ais · redis 를 동시에 띄운다 · Redis 장애 중 ais 재시작) 이전 실행의 마지막 수신부터
이번 첫 수신까지의 공백이 영영 기록되지 않는다. 그 사이 선박 위치는 DB 에 없는데 공백 기록(/api/v1/ais/gaps · 재생 화면)도 없어, '자료 없음'이 아니라
'선박이 없었다'로 보인다(제품 규칙 — 모르면 모른다고). Redis 가 먼저 준비된 같은 재시작은 'ais process restart' 공백을 남긴다(아래 전제 확인).
스택 B 재현(라이브): tools/qa/rel_ais_restart_redis_down.sh A — Redis 정지 중 ais 재시작 → 2.5분치 위치가 없고 ingest_gap 0행.

기대: Redis 가 기동 뒤에 답해도 이전 실행이 남긴 공백(정지 시각 → 이번 첫 수신)을 남긴다.
실행: cd apps/collector && uv run --offline pytest tests/qa/test_qa_1241_ais_restart_gap_lost_when_redis_is_late.py -q
"""

from __future__ import annotations

from datetime import datetime

from fakes import FakeRedis
from test_ais_helpers import decode

from wakeline_collector.ais.book import ShipBook
from wakeline_collector.ais.parse import Position, iso_ms
from wakeline_collector.ais.queue import RawQueue
from wakeline_collector.ais.shards import ShardSet
from wakeline_collector.ais.sink import AisSink
from wakeline_collector.ais.worker import Worker
from wakeline_collector.publisher import STREAM_SHIPS

T0 = 1_800_000_000.0  # 첫 실행 시작
STOP = T0 + 60  # 첫 실행이 정상 종료(Redis 정상 — 마지막 상태 해시를 쓴다)
BOOT = T0 + 15 * 3600  # 밤새 정지 뒤 부팅(평일 18:00 → 다음 날 09:00 KST)
SHIPS = ("440000001", "440000002")


class Clock:
    def __init__(self, t: float) -> None:
        self.t = t

    def __call__(self) -> float:
        return self.t


def _pos(mmsi: str, t: float) -> Position:
    return Position(
        mmsi=mmsi,
        lat=35.0,
        lon=129.0,
        sog_kn=10.0,
        cog_deg=90.0,
        heading_deg=90,
        nav_status=0,
        rot=0,
        position_source="epfs",
        seen_at=iso_ms(t),
        t=t,
        msg_type="PositionReport",
        cls="A",
    )


class Proc:
    """ais 프로세스 하나 — main._run 의 기동 · 종료 순서 그대로(구역 하나)."""

    def __init__(self, r: FakeRedis, clock: Clock) -> None:
        self.clock = clock
        self.book = ShipBook("aisstream")
        self.shards = ShardSet("aisstream", wall=clock)
        q = RawQueue(100)
        self.sink = AisSink(
            r,
            book=self.book,
            shards=self.shards,
            worker=Worker(q, self.book),
            queue=q,  # type: ignore[arg-type]
            provider="aisstream",
            raw_ref="-",
            wall=clock,
        )

    async def start(self) -> None:
        self.shards.load_previous(await self.sink.read_previous_status())  # main._run 과 같다 — 기동 때 한 번
        self.feed = self.shards.add(None).feed
        self.shards.restore_leftover()
        self.feed.on_subscribed("", deflate=None, state="receiving")

    async def receive_and_tick(self, t: float) -> None:
        self.clock.t = t
        for m in SHIPS:
            self.feed.on_message(t)
            self.book.apply_position(_pos(m, t), t)
        await self.sink.publish_gaps()
        await self.sink.flush()
        await self.sink.write_status()

    async def stop(self) -> None:
        self.shards.on_stopped()
        await self.sink.final()


def _gaps(r: FakeRedis) -> list[dict]:
    return [decode(f) for _, f in r.streams.get(STREAM_SHIPS, []) if f["kind"] == "ais_gap"]


def _epoch(s: str) -> float:
    return datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()


async def _overnight(redis_late_at_boot: bool) -> list[dict]:
    r, clock = FakeRedis(), Clock(T0)
    p1 = Proc(r, clock)
    await p1.start()
    for t in range(0, 60, 15):
        await p1.receive_and_tick(T0 + t)
    clock.t = STOP
    await p1.stop()  # 정상 종료 — Redis 가 답한다
    clock.t = BOOT
    r.down = redis_late_at_boot  # 부팅: dockerd 가 ais 를 Redis 준비 전에 띄웠다
    p2 = Proc(r, clock)
    await p2.start()
    r.down = False  # 1 s 뒤 Redis 준비(AOF 적재 끝)
    for t in range(1, 120, 15):
        await p2.receive_and_tick(BOOT + t)
    return _gaps(r)


def _covers_the_stop(gaps: list[dict]) -> bool:
    return any(_epoch(g["started_at"]) <= STOP and _epoch(g["ended_at"]) >= BOOT for g in gaps)


async def test_qa_1241_precondition_redis_ready_first_records_the_overnight_gap():
    gaps = await _overnight(redis_late_at_boot=False)
    assert _covers_the_stop(gaps), gaps  # Redis 가 먼저 준비되면 'ais process restart' 공백이 남는다(지금도 통과)


async def test_qa_1241_overnight_gap_is_recorded_even_if_redis_answers_after_ais_start():
    gaps = await _overnight(redis_late_at_boot=True)
    assert _covers_the_stop(gaps), (
        f"Redis 가 ais 기동 1 s 뒤에 답했을 뿐인데 밤새 정지({iso_ms(STOP)} → {iso_ms(BOOT)})의 공백이 기록되지 않았다 — 발행된 ais_gap: {gaps}"
    )
