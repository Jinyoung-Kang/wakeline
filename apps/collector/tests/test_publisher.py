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


def _stream_bytes(r: FakeRedis, stream: str) -> int:
    return sum(len(k) + len(v) for _sid, f in r.streams.get(stream, []) for k, v in f.items())


async def test_restart_counts_entries_already_in_the_stream_toward_the_byte_budget(monkeypatch):
    """리뷰(ADR-011 Redis 여유 계산): 새 프로세스의 예산 계산에 재시작 전 항목이 빠지면, 예산이 창을 줄일 만큼 발행량이 클 때
    스트림이 최대 2.5 h 동안 예산의 두 배까지 남았다(두 스트림이 겹치면 maxmemory 256 MiB 를 넘는 최악). 첫 XADD 전에 스트림의
    보존 창 안 항목을 되읽어 계산에 넣으므로 재시작 뒤에도 예산 + 한 항목을 넘지 않는다."""
    from wakeline_collector.publisher import STREAM_AIRCRAFT

    budget = 1_000_000
    monkeypatch.setitem(pubmod.STREAM_BUDGET_BYTES, STREAM_AIRCRAFT, budget)
    clk = [1_790_000_000.0]
    r = FakeRedis(clock=lambda: clk[0])
    before = Publisher(r)  # type: ignore[arg-type]
    before._clock = lambda: clk[0]
    for _ in range(50):  # 1 s 마다 100 KB — 예산이 창을 줄인다
        await before.publish(STREAM_AIRCRAFT, {"payload": "x" * 100_000})
        clk[0] += 1.0
    assert _stream_bytes(r, STREAM_AIRCRAFT) <= budget
    after = Publisher(r)  # type: ignore[arg-type] — 재시작(같은 스트림, 빈 계산)
    after._clock = lambda: clk[0]
    peak = 0
    for _ in range(30):
        await after.publish(STREAM_AIRCRAFT, {"payload": "y" * 100_000})
        peak = max(peak, _stream_bytes(r, STREAM_AIRCRAFT))
        clk[0] += 1.0
    assert peak <= budget, peak  # 전에는 재시작 전 약 1 MB + 새 항목 — 두 배 가까이
    assert after.budget_trims[STREAM_AIRCRAFT] > 0


async def test_restart_does_not_count_entries_older_than_the_retention_window(monkeypatch):
    """되읽기는 보존 창(MINID 기준) 안의 항목만 센다 — 더 오래된 것은 첫 XADD 의 MINID 가 지운다."""
    from wakeline_collector.publisher import STREAM_AIRCRAFT, STREAM_RETENTION_S

    monkeypatch.setitem(pubmod.STREAM_BUDGET_BYTES, STREAM_AIRCRAFT, 1_000_000)
    clk = [1_790_000_000.0]
    r = FakeRedis(clock=lambda: clk[0])
    before = Publisher(r)  # type: ignore[arg-type]
    before._clock = lambda: clk[0]
    for _ in range(9):
        await before.publish(STREAM_AIRCRAFT, {"payload": "x" * 100_000})
    clk[0] += STREAM_RETENTION_S + 60
    after = Publisher(r)  # type: ignore[arg-type]
    after._clock = lambda: clk[0]
    await after.publish(STREAM_AIRCRAFT, {"payload": "y" * 100_000})
    assert [f["payload"][0] for _sid, f in r.streams[STREAM_AIRCRAFT]] == ["y"]
    assert after.budget_trims[STREAM_AIRCRAFT] == 0  # 창 밖 항목은 예산 계산에 들지 않았다(시간 트림)


async def test_seeding_waits_for_redis_and_happens_once(monkeypatch):
    """첫 발행 때 Redis 가 안 되면 발행은 로컬 큐로 가고, 되읽기는 Redis 가 돌아온 뒤 한 번만 한다."""
    from wakeline_collector.publisher import STREAM_AIRCRAFT

    monkeypatch.setitem(pubmod.STREAM_BUDGET_BYTES, STREAM_AIRCRAFT, 1_000_000)
    clk = [1_790_000_000.0]
    r = FakeRedis(clock=lambda: clk[0])
    for _ in range(9):
        await r.xadd(STREAM_AIRCRAFT, {"payload": "x" * 100_000})
    reads: list[str] = []
    real = r.xrevrange

    async def counting(stream, *a, **kw):
        reads.append(stream)
        return await real(stream, *a, **kw)

    r.xrevrange = counting  # type: ignore[method-assign]
    p = Publisher(r)  # type: ignore[arg-type]
    p._clock = lambda: clk[0]
    r.down = True
    assert await p.publish(STREAM_AIRCRAFT, {"payload": "y" * 100_000}) is None and p.queued == 1
    r.down = False
    for _ in range(3):
        await p.publish(STREAM_AIRCRAFT, {"payload": "z" * 100_000})
    assert _stream_bytes(r, STREAM_AIRCRAFT) <= 1_000_000
    assert p.queued == 0 and reads.count(STREAM_AIRCRAFT) >= 1
    n = len(reads)
    await p.publish(STREAM_AIRCRAFT, {"payload": "w" * 100_000})
    assert len(reads) == n  # 한 번 되읽었으면 다시 읽지 않는다


async def test_seeding_denied_by_acl_logs_once_and_publishing_continues(monkeypatch, caplog):
    """되읽기가 거부되면(NOPERM 등 ResponseError) 경고 한 번 뒤 예전처럼 이 프로세스가 보낸 것만 센다 — 발행은 막지 않는다."""
    import logging

    from redis.exceptions import NoPermissionError

    from wakeline_collector.publisher import STREAM_AIRCRAFT

    r = FakeRedis()

    async def denied(*_a, **_kw):
        raise NoPermissionError("NOPERM this user has no permissions to run the 'xrevrange' command")

    r.xrevrange = denied  # type: ignore[method-assign]
    p = Publisher(r)  # type: ignore[arg-type]
    with caplog.at_level(logging.WARNING, logger="publisher"):
        for i in range(3):
            assert await p.publish(STREAM_AIRCRAFT, {"i": str(i)}) is not None
    warns = [m for m in caplog.messages if "not counted" in m]
    assert len(warns) == 1 and "NoPermissionError" in warns[0], caplog.messages
    assert len(r.streams[STREAM_AIRCRAFT]) == 3


async def test_seeding_reads_only_the_streams_this_process_publishes():
    """수집기 Publisher 는 선박 스트림에 쓰지 않는다 — 되읽기도 발행하는 스트림에서만, 개수 트림 스트림은 되읽지 않는다."""
    from wakeline_collector.publisher import STREAM_AIRCRAFT, STREAM_RADAR

    r = FakeRedis()
    reads: list[str] = []
    real = r.xrevrange

    async def counting(stream, *a, **kw):
        reads.append(stream)
        return await real(stream, *a, **kw)

    r.xrevrange = counting  # type: ignore[method-assign]
    p = Publisher(r)  # type: ignore[arg-type]
    await p.publish(STREAM_RADAR, {"i": "1"})
    await p.publish(STREAM_AIRCRAFT, {"i": "1"})
    assert reads == [STREAM_AIRCRAFT]


def test_publisher_reports_the_trim_settings_it_uses_per_time_trimmed_stream():
    """heartbeat stream_retention_s · stream_budget_bytes 의 원천: 이 Publisher 의 StreamTrim 설정(시간 트림 스트림만)."""
    from wakeline_collector.publisher import STREAM_AIRCRAFT, STREAM_RADAR, STREAM_SHIPS

    p = Publisher(None)  # type: ignore[arg-type]
    assert p.stream_limits(STREAM_AIRCRAFT) == (9000.0, 80 * 2**20)
    assert p.stream_limits(STREAM_SHIPS) == (9000.0, 32 * 2**20)
    assert p.stream_limits(STREAM_RADAR) is None  # 개수 트리밍 스트림 — 보존 창·예산이 없다
    assert pubmod.limit_fields(p.stream_limits(STREAM_AIRCRAFT)) == {
        "stream_retention_s": "9000",
        "stream_budget_bytes": "83886080",
    }
    assert pubmod.limit_fields(None) == {"stream_retention_s": "", "stream_budget_bytes": ""}  # 모름 — 0 이 아니다


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
