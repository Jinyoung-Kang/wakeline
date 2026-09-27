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
