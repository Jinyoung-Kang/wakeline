"""ShipBook: 위치 게이트(점프·미래·오래됨·순서), 정적 정보 병합·재발행, 바뀐 선박 꺼내기, 메모리 상한."""

from __future__ import annotations

import orjson
from test_ais_helpers import T0_EPOCH

from wakeline_collector.ais.book import STATE_FIELDS, ShipBook
from wakeline_collector.ais.parse import STATIC_FIELDS, Position, StaticPart, iso_ms


class Clock:
    def __init__(self) -> None:
        self.t = 1000.0

    def __call__(self) -> float:
        return self.t


def pos(mmsi="440091020", *, lat=37.0, lon=126.0, t=T0_EPOCH, sog=10.0, cls="A") -> Position:
    return Position(
        mmsi,
        lat,
        lon,
        sog,
        90.0,
        91,
        0 if cls == "A" else None,
        0 if cls == "A" else None,
        "epfs",
        iso_ms(t),
        t,
        "PositionReport",
        cls,
    )


def static(mmsi="431009876", t=T0_EPOCH, **fields) -> StaticPart:
    return StaticPart(mmsi, fields, iso_ms(t), t)


def test_accept_duplicate_out_of_order():
    b = ShipBook("aisstream")
    assert b.apply_position(pos(), T0_EPOCH) == "accepted"
    assert b.apply_position(pos(), T0_EPOCH) == "duplicate"
    assert b.apply_position(pos(t=T0_EPOCH - 5), T0_EPOCH) == "out_of_order"
    assert b.apply_position(pos(t=T0_EPOCH + 5, lat=37.001), T0_EPOCH + 5) == "accepted"
    states, statics = b.drain()
    assert len(states) == 1 and statics == []
    s = states[0]
    assert tuple(s) == STATE_FIELDS
    assert s["lat"] == 37.001 and s["provider"] == "aisstream" and s["class"] == "A" and s["seen_at"].endswith("Z")
    assert b.drain() == ([], [])  # 표시가 지워졌다


def test_position_jump_is_quarantined_and_not_a_reference():
    b = ShipBook("aisstream")
    b.apply_position(pos(lat=37.0), T0_EPOCH)
    # 30 s 뒤 60 NM 북쪽(1° ≈ 60 NM) → 격리
    assert b.apply_position(pos(lat=38.0, t=T0_EPOCH + 30), T0_EPOCH + 30) == "position_jump"
    # 격리한 위치는 기준이 되지 않는다: 원래 위치 근처는 계속 받아들인다
    assert b.apply_position(pos(lat=37.01, t=T0_EPOCH + 40), T0_EPOCH + 40) == "accepted"
    # 받아들인 마지막 위치(t+40)에서 60 s 를 넘긴 뒤의 큰 이동은 받아들인다(창 밖)
    assert b.apply_position(pos(lat=38.0, t=T0_EPOCH + 101), T0_EPOCH + 101) == "accepted"
    # 정확히 50 NM 이하 이동은 창 안이라도 통과
    assert b.apply_position(pos(lat=38.0 + 49.9 / 60, t=T0_EPOCH + 110), T0_EPOCH + 110) == "accepted"


def test_time_gates():
    b = ShipBook("aisstream")
    assert b.apply_position(pos(t=T0_EPOCH + 31), T0_EPOCH) == "seen_in_future"
    assert b.apply_position(pos(t=T0_EPOCH - 601), T0_EPOCH) == "stale_position"
    assert len(b) == 0  # 격리된 것은 기억하지도 않는다
    assert b.apply_static(static(t=T0_EPOCH + 100), T0_EPOCH) == "seen_in_future"
    assert b.apply_static(static(t=T0_EPOCH - 700), T0_EPOCH) == "stale_position"


def test_static_merge_partial_messages():
    clock = Clock()
    b = ShipBook("fixture", mono=clock)
    assert b.apply_static(static(name="BLUE HOLE"), T0_EPOCH) == "changed"  # 24A
    assert b.apply_static(static(t=T0_EPOCH + 5, call_sign="BX12", ship_type=37, dim_a=10), T0_EPOCH + 5) == "changed"  # 24B
    _, statics = b.drain()
    assert len(statics) == 1
    s = statics[0]
    assert set(s) == {"mmsi", *STATIC_FIELDS, "updated_at", "provider"}
    assert (s["name"], s["call_sign"], s["ship_type"], s["dim_a"], s["imo"]) == ("BLUE HOLE", "BX12", 37, 10, None)
    assert s["updated_at"] == iso_ms(T0_EPOCH + 5) and s["provider"] == "fixture"
    # 메시지 5 의 '값 없음'(None)은 이전 값을 지운다(선박이 목적지를 비웠다)
    b.apply_static(static(t=T0_EPOCH + 6, destination="BUSAN"), T0_EPOCH + 6)
    b.drain()
    assert b.apply_static(static(t=T0_EPOCH + 7, destination=None), T0_EPOCH + 7) == "changed"
    assert b.drain()[1][0]["destination"] is None
    # 알 수 없는 필드는 무시
    assert b.apply_static(static(t=T0_EPOCH + 8, bogus=1), T0_EPOCH + 8) == "unchanged"


def test_static_unchanged_is_republished_only_after_refresh_interval():
    clock = Clock()
    b = ShipBook("aisstream", static_refresh_s=1800, mono=clock)
    b.apply_static(static(name="A"), T0_EPOCH)
    b.drain()
    clock.t += 60
    assert b.apply_static(static(t=T0_EPOCH + 60, name="A"), T0_EPOCH + 60) == "unchanged"
    assert b.drain() == ([], [])
    clock.t += 1800
    assert b.apply_static(static(t=T0_EPOCH + 1900, name="A"), T0_EPOCH + 1900) == "refresh"
    statics = b.drain()[1]
    assert statics[0]["updated_at"] == iso_ms(T0_EPOCH)  # 내용이 바뀐 시각 그대로


def test_mark_dirty_after_failed_publish():
    b = ShipBook("aisstream")
    b.apply_position(pos(mmsi="111111111"), T0_EPOCH)
    b.apply_static(static(mmsi="111111111", name="X"), T0_EPOCH)
    states, statics = b.drain()
    b.mark_dirty([s["mmsi"] for s in states] + ["999999999"], [s["mmsi"] for s in statics])
    assert b.dirty == (1, 1)
    # 그사이 새 위치가 오면 다시 꺼낼 때 최신값
    b.apply_position(pos(mmsi="111111111", lat=37.01, t=T0_EPOCH + 3), T0_EPOCH + 3)
    states, statics = b.drain()
    assert [s["lat"] for s in states] == [37.01] and len(statics) == 1


def test_ttl_eviction_and_cap():
    clock = Clock()
    b = ShipBook("aisstream", max_ships=3, ttl_s=100, mono=clock)
    for i in range(3):
        b.apply_position(pos(mmsi=f"44000000{i}"), T0_EPOCH)
        clock.t += 1
    # 네 번째 → 가장 오래 갱신되지 않은 것(…0)이 빠진다
    b.apply_position(pos(mmsi="440000003"), T0_EPOCH)
    assert len(b) == 3 and b.evicted == 1
    states, _ = b.drain()
    assert {s["mmsi"] for s in states} == {"440000001", "440000002", "440000003"}
    # 갱신하면 LRU 뒤로 간다
    clock.t += 1
    b.apply_position(pos(mmsi="440000001", t=T0_EPOCH + 1, lat=37.001), T0_EPOCH + 1)
    clock.t += 101
    b.apply_position(pos(mmsi="440000002", t=T0_EPOCH + 2, lat=37.002), T0_EPOCH + 2)
    assert b.evict() == 2  # …3, …1 은 100 s 넘게 갱신 없음
    assert len(b) == 1 and b.evicted == 3
    assert b.evict() == 0


def test_auxiliary_craft_24b_keeps_a_size_known_from_message_19():
    """보조 선박 24B 는 크기 키를 싣지 않는다: 메시지 19 로 받은 크기는 남고, 처음 보는 보조 선박의 크기는 모름(None)으로 나간다."""
    from test_ais_helpers import static24

    from wakeline_collector.ais.parse import parse_message

    def part(msg: dict) -> StaticPart:
        sp = parse_message(orjson.dumps(msg)).static
        assert sp is not None
        return StaticPart(mmsi=sp.mmsi, fields=sp.fields, seen_at=sp.seen_at, t=T0_EPOCH)

    b = ShipBook("aisstream")
    b.apply_static(static(mmsi="984401234", dim_a=6, dim_b=4, dim_c=2, dim_d=1), T0_EPOCH)  # 메시지 19 에서 온 크기
    b.drain()
    aux = static24(984401234, part_b=True, CallSign="TENDER1", ShipType=50, Dimension={"A": 209, "B": 444, "C": 1, "D": 0})
    assert b.apply_static(part(aux), T0_EPOCH) == "changed"
    s = b.drain()[1][0]
    assert (s["call_sign"], s["dim_a"], s["dim_b"], s["dim_c"], s["dim_d"]) == ("TENDER1", 6, 4, 2, 1)
    fresh = static24(984409999, part_b=True, CallSign="TENDER2", ShipType=50, Dimension={"A": 209, "B": 444, "C": 1, "D": 0})
    b.apply_static(part(fresh), T0_EPOCH)
    s2 = next(x for x in b.drain()[1] if x["mmsi"] == "984409999")
    assert (s2["dim_a"], s2["dim_b"], s2["dim_c"], s2["dim_d"]) == (None, None, None, None)
