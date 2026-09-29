"""Class B 부분 정적 정보가 저장된 값을 지우던 결함 — 수집기 쪽(재현 · 고침, 계약 v5 §G19).

관찰(코드, 고치기 전): ShipBook 은 ais 재시작 · 제거(ttl 30분 · 선박 수 상한) 뒤 빈 레코드(14칸 모두 None)에서 시작해 받은 조각만 채운다. Class B 는 메시지
24A(선명)와 24B(호출부호 · 선종 · 크기)가 따로 오는데, 둘이 다른 발행(10 s)에 들어가면 첫 발행의 static 은 call_sign · ship_type · dim_* 가 None 이다.
발행 메시지는 '받지 않아서 None' 과 '빈 값으로 받아서 None' 을 구별하지 않았으므로 api 저장(ShipWriter · STATIC_SQL)이 DB 행의 호출부호 · 크기를 NULL 로 덮었다.

고침: 레코드가 시작된 뒤 실제로 받은 필드를 들고 있다가 payload `static_received`(MMSI → 필드, STATIC_FIELDS 순서)로 함께 싣는다 — static 항목 밖에
(항목은 additionalProperties false 라 이전 api 가 메시지 전체를 거절한다). api 는 저장 행에서 받은 필드만 덮는다.
"""

from __future__ import annotations

import time

from fakes import FakeRedis
from test_ais_book import Clock, static
from test_ais_helpers import T0_EPOCH, decode, dumps, static5, static24, validator

from wakeline_collector.ais.book import ShipBook, received_fields
from wakeline_collector.ais.parse import STATIC_FIELDS, go_time
from wakeline_collector.ais.queue import RawQueue
from wakeline_collector.ais.shards import ShardSet
from wakeline_collector.ais.sink import AisSink
from wakeline_collector.ais.worker import Worker
from wakeline_collector.publisher import STREAM_SHIPS

M = 416009981
SHIPS = validator("stream_envelope.v1.json", "/$defs/ships_payload")
DIMS = ["dim_a", "dim_b", "dim_c", "dim_d"]
PART_B = ["call_sign", "ship_type", *DIMS]


def _sink() -> tuple[FakeRedis, Worker, AisSink]:
    r, q, book, shards = FakeRedis(), RawQueue(1000), ShipBook("aisstream"), ShardSet("aisstream")
    shards.add(None)
    w = Worker(q, book)
    return r, w, AisSink(r, book=book, shards=shards, worker=w, queue=q, provider="aisstream", raw_ref="-")  # type: ignore[arg-type]


async def _flush(r: FakeRedis, sink: AisSink) -> dict:
    assert await sink.flush() == 1
    payload = decode(r.streams[STREAM_SHIPS][-1][1])
    errs = [f"{e.json_path}: {e.message}" for e in SHIPS.iter_errors(payload)]
    assert not errs, errs[:5]
    return payload


async def test_24a_alone_after_a_restart_says_only_the_name_was_received():
    r, w, sink = _sink()  # 새 책 = ais 재시작 뒤
    w.handle(dumps(static24(M, part_b=False, time_utc=go_time(time.time()))))
    payload = await _flush(r, sink)
    (st,) = payload["static"]
    assert st["name"] == "BLUE HOLE"
    assert (st["call_sign"], st["ship_type"], st["dim_a"], st["dim_b"]) == (None, None, None, None)
    # 고친 뒤: None 이 '받지 않음' 이라고 밝힌다 — api 가 저장된 호출부호 · 크기를 지우지 않는다
    assert payload["static_received"] == {str(M): ["name"]}
    assert set(st) == {"mmsi", *STATIC_FIELDS, "updated_at", "provider"}, (
        "the static item itself is unchanged (older apis reject extra keys)"
    )


async def test_a_later_24b_adds_its_fields_and_message_5_is_all_fields():
    r, w, sink = _sink()
    now = time.time()
    w.handle(dumps(static24(M, part_b=False, time_utc=go_time(now))))
    await _flush(r, sink)
    w.handle(dumps(static24(M, part_b=True, time_utc=go_time(now + 5))))
    p2 = await _flush(r, sink)
    assert p2["static_received"] == {str(M): ["name", *PART_B]}
    assert p2["static"][0]["call_sign"] == "BX12"
    w.handle(dumps(static5(431009876, time_utc=go_time(now + 6))))
    p3 = await _flush(r, sink)
    assert p3["static_received"] == {"431009876": list(STATIC_FIELDS)}


async def test_an_explicit_empty_value_in_a_received_part_is_marked_received():
    """24B 의 빈 호출부호(선박이 비워 보냈다)는 None 이지만 받은 필드다 — 값이 같은 None 이어도 받은 필드가 늘면 '바뀜' 으로 다시 싣는다."""
    r, w, sink = _sink()
    now = time.time()
    w.handle(dumps(static24(M, part_b=False, time_utc=go_time(now))))
    await _flush(r, sink)
    w.handle(
        dumps(
            static24(
                M, part_b=True, time_utc=go_time(now + 5), CallSign="", ShipType=0, Dimension={"A": 0, "B": 0, "C": 0, "D": 0}
            )
        )
    )
    p = await _flush(r, sink)
    (st,) = p["static"]
    assert (st["call_sign"], st["ship_type"], st["dim_a"]) == (None, None, None)
    assert p["static_received"] == {str(M): ["name", *PART_B]}
    assert st["updated_at"].startswith(go_time(now + 5)[:10])


def test_book_received_bits_follow_the_parts_and_restart_with_the_record():
    clock = Clock()
    b = ShipBook("aisstream", ttl_s=100, mono=clock)
    assert b.apply_static(static(mmsi="416009981", name="BLUE HOLE"), T0_EPOCH) == "changed"
    assert b.drain_received()[2] == {"416009981": ["name"]}
    # 받은 필드만 늘어도(값은 그대로 None) '바뀜' — 새 시각
    assert b.apply_static(static(mmsi="416009981", t=T0_EPOCH + 5, call_sign=None), T0_EPOCH + 5) == "changed"
    _, statics, received = b.drain_received()
    assert received == {"416009981": ["name", "call_sign"]} and statics[0]["call_sign"] is None
    # 같은 조각 되풀이 → unchanged, 30분 재발행(refresh)도 받은 필드는 그대로
    assert b.apply_static(static(mmsi="416009981", t=T0_EPOCH + 6, name="BLUE HOLE"), T0_EPOCH + 6) == "unchanged"
    assert b.apply_static(static(mmsi="416009981", t=T0_EPOCH + 7, bogus=1), T0_EPOCH + 7) == "unchanged"
    # 발행 실패 → 다시 표시 → 다음 꺼내기도 받은 필드를 싣는다
    b.mark_dirty([], ["416009981"])
    assert b.drain_received()[2] == {"416009981": ["name", "call_sign"]}
    # 제거(ttl) 뒤 새 레코드 → 받은 필드도 새로 시작
    clock.t += 101
    assert b.evict() == 1
    b.apply_static(static(mmsi="416009981", t=T0_EPOCH + 200, ship_type=37), T0_EPOCH + 200)
    assert b.drain_received()[2] == {"416009981": ["ship_type"]}
    # drain() 은 예전 모양 그대로(위치 · 정적 정보)
    b.apply_static(static(mmsi="416009981", t=T0_EPOCH + 201, name="X"), T0_EPOCH + 201)
    states, statics = b.drain()
    assert states == [] and len(statics) == 1
    assert received_fields(0) == [] and received_fields((1 << len(STATIC_FIELDS)) - 1) == list(STATIC_FIELDS)


async def test_auxiliary_craft_24b_does_not_claim_its_size_was_received():
    """보조 선박(98MIDxxxx) 24B 는 크기 자리에 모선 MMSI 가 실린다 — 크기 키를 싣지 않으므로 받은 필드에도 없다(api 가 저장된 크기를 지우지 않는다)."""
    r, w, sink = _sink()
    w.handle(dumps(static24(984401234, part_b=True, time_utc=go_time(time.time()), CallSign="TENDER1", ShipType=50)))
    p = await _flush(r, sink)
    assert p["static_received"] == {"984401234": ["call_sign", "ship_type"]}


async def test_split_parts_carry_only_their_own_mmsis(monkeypatch):
    from wakeline_collector.ais import sink as sink_mod

    monkeypatch.setattr(sink_mod, "CHUNK", 2)
    r, w, sink = _sink()
    now = time.time()
    mmsis = [416009981, 416009982, 416009983]
    for m in mmsis:
        w.handle(dumps(static24(m, part_b=False, time_utc=go_time(now))))
    assert await sink.flush() == 2
    payloads = [decode(f) for _sid, f in r.streams[STREAM_SHIPS]]
    for p in payloads:
        assert set(p["static_received"]) == {s["mmsi"] for s in p["static"]}
        assert not list(SHIPS.iter_errors(p))
    assert sorted(m for p in payloads for m in p["static_received"]) == [str(m) for m in mmsis]


def test_schema_rejects_unknown_fields_bad_keys_and_duplicates():
    base = {"ships": [], "static": [], "stats": {"msgs": 0, "msgs_per_s": 0, "dropped": 0, "quarantined": 0, "connected": True}}
    ok = {**base, "static_received": {str(M): ["name", "call_sign"]}}
    assert not list(SHIPS.iter_errors(ok))
    assert not list(SHIPS.iter_errors(base)), "absent = an older collector (the api treats null as not received)"
    for bad in ({str(M): ["vendor"]}, {"41600998": ["name"]}, {str(M): ["name", "name"]}, {str(M): "name"}):
        assert list(SHIPS.iter_errors({**base, "static_received": bad})), bad
    enum = SHIPS.schema["properties"]["static_received"]["additionalProperties"]["items"]["enum"]
    assert enum == list(STATIC_FIELDS)
