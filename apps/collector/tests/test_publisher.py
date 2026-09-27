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

    async def xadd(self, stream, fields, maxlen=None, approximate=True):
        import asyncio

        self._check()
        await asyncio.sleep(self._rnd.uniform(0.001, 0.02))
        return await super().xadd(stream, fields, maxlen, approximate)


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


async def test_oversized_entry_is_counted_not_queued(monkeypatch):
    monkeypatch.setattr(pubmod, "QUEUE_MAX_BYTES", 10)
    r = FakeRedis()
    r.down = True
    p = Publisher(r)  # type: ignore[arg-type]
    await p.publish("s", {"big": "x" * 50})
    assert p.queued == 0 and p.dropped == 1
