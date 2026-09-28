from datetime import UTC, datetime

from fakes import FakeRedis

from wakeline_collector import publisher as pubmod
from wakeline_collector.publisher import Publisher, decode_payload


async def test_queue_caps_by_count_and_bytes(monkeypatch):
    monkeypatch.setattr(pubmod, "QUEUE_MAX", 3)
    monkeypatch.setattr(pubmod, "QUEUE_MAX_BYTES", 1000)
    r = FakeRedis()
    r.down = True
    p = Publisher(r)  # type: ignore[arg-type]
    for i in range(5):
        await p.publish("s", {"i": str(i)})
    assert p.queued == 3 and p.dropped == 2
    await p.publish("s", {"big": "x" * 900})  # 바이트 상한 → 오래된 것부터 버림
    assert p._queued_bytes <= 1000
    r.down = False
    await p.publish("s", {"i": "last"})
    assert p.queued == 0 and r.streams["s"][-1][1] == {"i": "last"}


def test_envelope_run_id_optional_and_payload_roundtrip():
    p = Publisher(None)  # type: ignore[arg-type]
    env = p.envelope(
        kind="sigmet", scope="-", provider="awc", fetched_at=datetime.now(UTC), raw_ref="r", count=0, payload={"a": 1}
    )
    assert "run_id" not in env and decode_payload(env["payload"]) == {"a": 1}
    env = p.envelope(
        kind="sigmet", scope="-", provider="awc", fetched_at=datetime.now(UTC), raw_ref="r", count=0, payload={}, run_id="7"
    )
    assert env["run_id"] == "7"


# ---- COL-1: 동시 발행 경쟁 -----------------------------------------------------------------------------------------------
class SlowRedis(FakeRedis):
    """XADD 가 1–20 ms 걸리는 Redis(리뷰 재현 조건)."""

    def __init__(self, seed: int) -> None:
        super().__init__()
        import random

        self._rnd = random.Random(seed)

    async def xadd(self, stream, fields, **kw):
        import asyncio

        self._check()
        await asyncio.sleep(self._rnd.uniform(0.001, 0.02))
        return await super().xadd(stream, fields, **kw)


async def test_concurrent_publish_after_recovery_sends_each_entry_once_in_order():
    import asyncio

    for seed in range(8):
        r = SlowRedis(seed)
        p = Publisher(r)  # type: ignore[arg-type]
        r.down = True
        for i in range(6):
            await p.publish("s", {"q": str(i)})
        assert p.queued == 6
        r.down = False
        results = await asyncio.gather(*(p.publish("s", {"new": str(k)}) for k in range(3)), return_exceptions=True)
        assert not [x for x in results if isinstance(x, BaseException)]  # IndexError 없음
        sent = [f for _sid, f in r.streams["s"]]
        assert sent[:6] == [{"q": str(i)} for i in range(6)]  # 밀린 것 먼저, 한 번씩, 순서대로
        assert sorted(f["new"] for f in sent[6:]) == ["0", "1", "2"] and len(sent) == 9
        assert p.queued == 0 and p._queued_bytes == 0


async def test_publish_returns_stream_id_or_none():
    r = FakeRedis()
    p = Publisher(r)  # type: ignore[arg-type]
    assert await p.publish("s", {"a": "1"}) == "1-0"
    r.down = True
    assert await p.publish("s", {"a": "2"}) is None and p.queued == 1


async def _outage(p: Publisher, clk: list[float], seconds: int, region_kb: int = 9, global_kb: int = 448) -> int:
    """api 가 멈춘 동안의 항공기 스트림 발행을 흉내 낸다: 관심 지역 10 s · 전세계 120 s(수요 임대는 api 가 쓰므로 없다).
    크기는 fixture 로 잰 값(관심 지역 127대 ≈ 9 KB, 전세계 6,604대 ≈ 448 KB)."""
    from wakeline_collector.publisher import STREAM_AIRCRAFT

    region, glob = "r" * (region_kb * 1024), "g" * (global_kb * 1024)
    n = 0
    for step in range(seconds // 10):
        await p.publish(STREAM_AIRCRAFT, {"scope": "region", "payload": region})
        n += 1
        if step % 12 == 0:
            await p.publish(STREAM_AIRCRAFT, {"scope": "global", "payload": glob})
            n += 1
        clk[0] += 10.0
    return n


async def test_r14_aircraft_stream_keeps_everything_published_during_a_two_hour_api_outage():
    """리뷰 R-14: MAXLEN ~200 은 약 35분 — api 가 그보다 오래 멈추면 항적이 읽히기 전에 지워졌다."""
    from wakeline_collector.publisher import STREAM_AIRCRAFT

    clk = [1_790_000_000.0]
    r = FakeRedis(clock=lambda: clk[0])
    p = Publisher(r)  # type: ignore[arg-type]
    p._clock = lambda: clk[0]
    n = await _outage(p, clk, 2 * 3600)
    assert len(r.streams[STREAM_AIRCRAFT]) == n  # 하나도 지우지 않았다


async def test_r14_aircraft_stream_is_trimmed_by_time_after_the_retention_window():
    from wakeline_collector.publisher import STREAM_AIRCRAFT, STREAM_RETENTION_S

    clk = [1_790_000_000.0]
    r = FakeRedis(clock=lambda: clk[0])
    p = Publisher(r)  # type: ignore[arg-type]
    p._clock = lambda: clk[0]
    await _outage(p, clk, 4 * 3600)
    ids = [int(sid.split("-")[0]) for sid, _ in r.streams[STREAM_AIRCRAFT]]
    oldest_age_s = (clk[0] * 1000 - min(ids)) / 1000
    assert STREAM_RETENTION_S >= 2 * 3600 and oldest_age_s <= STREAM_RETENTION_S + 10  # 시간으로 잘린다(메모리 상한)


async def test_r14_byte_budget_bounds_memory_when_the_rate_is_unexpectedly_high(monkeypatch):
    from wakeline_collector.publisher import STREAM_AIRCRAFT

    monkeypatch.setitem(pubmod.STREAM_BUDGET_BYTES, STREAM_AIRCRAFT, 1_000_000)
    clk = [1_790_000_000.0]
    r = FakeRedis(clock=lambda: clk[0])
    p = Publisher(r)  # type: ignore[arg-type]
    p._clock = lambda: clk[0]
    for _ in range(500):  # 1 s 마다 100 KB — 보존 창 안에서 예산(1 MB)을 크게 넘는다
        await p.publish(STREAM_AIRCRAFT, {"payload": "x" * 100_000})
        clk[0] += 1.0
    kept = sum(len(k) + len(v) for _sid, f in r.streams[STREAM_AIRCRAFT] for k, v in f.items())
    assert kept <= 1_000_000 and len(r.streams[STREAM_AIRCRAFT]) >= 9  # 최신 항목부터 예산만큼
    assert p.budget_trims[STREAM_AIRCRAFT] > 0  # 예산이 잘랐다는 사실을 셀 수 있다(heartbeat 로 노출)


async def test_r14_other_streams_keep_count_trim():
    """SIGMET(300 s)·레이더(60 s)는 200개로 이미 2 h 를 넘게 담는다 — 개수 트리밍 그대로."""
    from wakeline_collector.publisher import MAXLEN, STREAM_RADAR

    r = FakeRedis()
    p = Publisher(r)  # type: ignore[arg-type]
    for i in range(MAXLEN + 5):
        await p.publish(STREAM_RADAR, {"i": str(i)})
    assert len(r.streams[STREAM_RADAR]) == MAXLEN


async def test_oversized_entry_is_counted_not_queued(monkeypatch):
    monkeypatch.setattr(pubmod, "QUEUE_MAX_BYTES", 10)
    r = FakeRedis()
    r.down = True
    p = Publisher(r)  # type: ignore[arg-type]
    await p.publish("s", {"big": "x" * 50})
    assert p.queued == 0 and p.dropped == 1
