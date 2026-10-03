"""Redis 장애 중 선박 위치(QA 2026-10 신뢰성 개선 제안 2 · ADR-033 · 계약 v5 §G46).

발행(XADD)이 실패하는 동안 수신은 계속된다. 예전에는 '바뀜' 표시만 되돌려 복구 뒤 첫 발행이 그때의 최신값 하나만 실었다 — api 는 MMSI 별
60 s 창마다 첫 보고 하나를 저장하므로(ShipWriter · ShipRepository.WINDOW_S) 장애 동안의 분이 DB 에서 빠졌고(redis 150 s pause: 분당 선박 행
244–284 → 116 · 137), 그 빈 곳을 설명하는 공백 기록도 없었다. 이제 발행이 실패하면 MMSI 별 분당 첫 위치를 모아 두었다가(상한 BACKFILL_MAX)
복구 뒤 시간 순서대로 최신값보다 먼저 보내고, 상한을 넘겨 모으지 못한 구간은 ais_gap(구역 없음 — 모든 선박)으로 남긴다.
"""

from __future__ import annotations

from collections.abc import Iterable
from datetime import datetime
from typing import Any

from fakes import FakeRedis
from test_ais_helpers import decode, validator

from wakeline_collector.ais import sink as sink_mod
from wakeline_collector.ais.book import ShipBook
from wakeline_collector.ais.parse import Position, iso_ms
from wakeline_collector.ais.queue import RawQueue
from wakeline_collector.ais.shards import ShardSet
from wakeline_collector.ais.sink import AisSink
from wakeline_collector.ais.worker import Worker
from wakeline_collector.publisher import STREAM_SHIPS

ENV = validator("stream_envelope.v1.json")
SHIPS = validator("stream_envelope.v1.json", "/$defs/ships_payload")
GAP = validator("stream_envelope.v1.json", "/$defs/ais_gap_payload")

T0 = 1_800_000_000.0  # 분 경계(1_800_000_000 / 60 = 30,000,000)
WINDOW_S = 60  # api ShipRepository.WINDOW_S


class Clock:
    def __init__(self, t: float) -> None:
        self.t = t

    def __call__(self) -> float:
        return self.t


def _setup(**book_kw: Any) -> tuple[FakeRedis, ShipBook, AisSink, Clock]:
    r = FakeRedis()
    clock = Clock(T0)
    book = ShipBook("aisstream", **book_kw)
    shards = ShardSet("aisstream")
    shards.add(None)
    q = RawQueue(100)
    sink = AisSink(r, book=book, shards=shards, worker=Worker(q, book), queue=q, provider="aisstream", raw_ref="-", wall=clock)  # type: ignore[arg-type]
    return r, book, sink, clock


def _pos(mmsi: str, t: float, lat: float = 35.0, lon: float = 129.0) -> Position:
    return Position(
        mmsi=mmsi,
        lat=lat,
        lon=lon,
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


def _receive(book: ShipBook, clock: Clock, *reports: tuple[str, float]) -> None:
    """(MMSI, 시각) 마다 조금씩 움직인 위치를 받는다(시각 = 수신 시각)."""
    for mmsi, t in reports:
        clock.t = t
        assert book.apply_position(_pos(mmsi, t, lon=129.0 + (t - T0) / 10_000), t) == "accepted"


def _entries(r: FakeRedis) -> list[dict[str, Any]]:
    out = []
    for _, fields in r.streams.get(STREAM_SHIPS, []):
        errs = [e.message for e in ENV.iter_errors(fields)]
        payload = decode(fields)
        errs += [e.message for e in (SHIPS if fields["kind"] == "ships" else GAP).iter_errors(payload)]
        assert not errs, errs[:3]
        out.append({"kind": fields["kind"], **payload})
    return out


def _rows_like_the_api(entries: Iterable[dict[str, Any]]) -> dict[str, list[str]]:
    """api ShipWriter 의 줄이기를 그대로: 메시지 순서대로, MMSI 별로 앞서 고른 창보다 뒤인 창의 첫 보고만 행이 된다."""
    kept: dict[str, int] = {}
    rows: dict[str, list[str]] = {}
    for e in entries:
        if e["kind"] != "ships":
            continue
        for s in e["ships"]:
            w = int(datetime.fromisoformat(s["seen_at"].replace("Z", "+00:00")).timestamp()) // WINDOW_S
            if s["mmsi"] in kept and w <= kept[s["mmsi"]]:
                continue
            kept[s["mmsi"]] = w
            rows.setdefault(s["mmsi"], []).append(s["seen_at"])
    return rows


async def test_a_redis_outage_keeps_the_first_position_of_each_minute_and_publishes_them_before_the_latest():
    r, book, sink, clock = _setup()
    _receive(book, clock, ("440000001", T0 + 5), ("440000002", T0 + 6))
    assert await sink.flush() == 1  # 장애 전: 평소대로

    r.down = True
    _receive(book, clock, ("440000001", T0 + 15), ("440000001", T0 + 25), ("440000002", T0 + 26))
    assert await sink.flush() == 0  # 실패 — 이때부터 분당 첫 위치를 모은다
    _receive(book, clock, ("440000001", T0 + 65), ("440000001", T0 + 75), ("440000002", T0 + 70))
    assert await sink.flush() == 0
    _receive(book, clock, ("440000001", T0 + 130), ("440000001", T0 + 140), ("440000002", T0 + 131))
    _receive(book, clock, ("440000001", T0 + 190), ("440000002", T0 + 185), ("440000002", T0 + 199))
    assert await sink.flush() == 0
    # 메모리에는 (MMSI, 분)마다 하나만 — 같은 분의 다음 위치(75 · 140 · 199)는 모으지 않는다
    assert book.backlog == 8 and book.backfill_dropped == 0

    r.down = False
    clock.t = T0 + 205
    await sink.flush()
    rows = _rows_like_the_api(_entries(r))
    # 분마다 한 행 — 장애 동안의 분(창 1 · 2 · 3)이 빠지지 않는다. 각 분은 그 분에 처음 받은 위치
    assert rows["440000001"] == [iso_ms(T0 + 5), iso_ms(T0 + 65), iso_ms(T0 + 130), iso_ms(T0 + 190)]
    assert rows["440000002"] == [iso_ms(T0 + 6), iso_ms(T0 + 70), iso_ms(T0 + 131), iso_ms(T0 + 185)]
    # 최신값(지도 · 메모리 상태)은 마지막에 — MMSI 별로 마지막으로 실린 위치가 가장 새 것
    last = {}
    for e in _entries(r):
        for s in e.get("ships", []):
            last[s["mmsi"]] = s["seen_at"]
    assert last == {"440000001": iso_ms(T0 + 190), "440000002": iso_ms(T0 + 199)}
    assert not [e for e in _entries(r) if e["kind"] == "ais_gap"], "모두 모았으면 공백이 아니다"
    # 다 보낸 뒤에는 모으지 않는다(평소 발행은 그대로)
    assert not book.holding and book.backlog == 0
    _receive(book, clock, ("440000001", T0 + 250))
    before = len(r.streams[STREAM_SHIPS])
    assert await sink.flush() == 1 and "backfill" not in _entries(r)[before]


async def test_samples_beyond_the_cap_become_one_gap_for_every_ship():
    r, book, sink, clock = _setup(backfill_max=3)
    _receive(book, clock, ("440000001", T0 + 5))
    assert await sink.flush() == 1
    r.down = True
    _receive(book, clock, ("440000001", T0 + 10))
    assert await sink.flush() == 0  # 표본 1(보내지 못한 최신값)
    _receive(book, clock, ("440000001", T0 + 70), ("440000001", T0 + 130))  # 표본 2 · 3 — 상한
    _receive(book, clock, ("440000001", T0 + 190), ("440000001", T0 + 250), ("440000002", T0 + 251))  # 모으지 못함(창 3 개)
    assert await sink.flush() == 0
    assert book.backlog == 3 and book.backfill_dropped == 3

    r.down = False
    clock.t = T0 + 260
    await sink.flush()
    await sink.publish_gaps()
    entries = _entries(r)
    gaps = [e for e in entries if e["kind"] == "ais_gap"]
    assert len(gaps) == 1
    (gap,) = gaps
    assert gap["started_at"] == iso_ms(T0 + 190) and gap["ended_at"] == iso_ms(T0 + 260)
    assert "scope" not in gap, "구역 없음 — 모든 선박의 항적에 적용"
    assert "redis" in gap["reason"] and "3" in gap["reason"]
    rows = _rows_like_the_api(entries)
    assert rows["440000001"] == [iso_ms(T0 + 5), iso_ms(T0 + 70), iso_ms(T0 + 130), iso_ms(T0 + 250)]  # 마지막 줄은 최신값
    assert sink.status_fields()["backfill_dropped_total"] == "3"


async def test_a_failure_while_sending_the_held_samples_keeps_the_rest_in_order(monkeypatch):
    monkeypatch.setattr(sink_mod, "CHUNK", 2)
    r, book, sink, clock = _setup()
    r.down = True
    _receive(book, clock, *[(f"44000000{i}", T0 + i) for i in range(1, 6)])
    assert await sink.flush() == 0  # 표본 5(보내지 못한 최신값)
    _receive(book, clock, *[(f"44000000{i}", T0 + 60 + i) for i in range(1, 6)])  # 표본 5 더
    r.down = False
    calls = {"n": 0}
    orig = r.xadd

    async def flaky(stream, fields, **kw):
        calls["n"] += 1
        if calls["n"] == 2:
            raise OSError("reset")
        return await orig(stream, fields, **kw)

    r.xadd = flaky  # type: ignore[method-assign]
    assert await sink.flush() == 1 and book.holding and book.backlog == 8
    assert await sink.flush() >= 5
    rows = _rows_like_the_api(_entries(r))
    assert all(len(v) == 2 for v in rows.values()) and len(rows) == 5, rows
    assert not book.holding


async def test_the_start_of_holding_is_logged_once_per_outage_even_when_another_warning_took_the_throttle(caplog):
    r, book, sink, clock = _setup()
    _receive(book, clock, ("440000001", T0 + 5))
    r.down = True
    assert await sink.write_status() is False  # 상태 쓰기 실패 경고가 60 s 경고 몫을 먼저 가져간다
    with caplog.at_level("WARNING", logger="ais.sink"):
        assert await sink.flush() == 0
        _receive(book, clock, ("440000001", T0 + 65))
        await sink.flush()
    started = [m for m in caplog.messages if "holding the first position of each minute" in m]
    assert len(started) == 1, caplog.messages


async def test_normal_operation_holds_nothing():
    r, book, sink, clock = _setup()
    for k in range(5):
        _receive(book, clock, ("440000001", T0 + 60 * k))
        assert await sink.flush() == 1
    assert not book.holding and book.backlog == 0
    assert all("backfill" not in e for e in _entries(r))
    assert sink.status_fields()["backfill_pending"] == "0"
