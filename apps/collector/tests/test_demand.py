"""수요 임대 읽기(읽기 전용·검증·상한·순위·만료) · 수요 상태 쓰기(ADR-013, 계약 v2 §A1·§A2)."""

from __future__ import annotations

import math

import orjson
from fakes import FakeRedis

from wakeline_collector.demand import (
    FOCUS_KEY,
    FOCUS_META_KEY,
    HOT_KEY,
    HOT_META_KEY,
    MAX_FOCUS_HEXES,
    MAX_HOT_CELLS,
    STATUS_KEY,
    Demand,
    DemandPoller,
    DemandStatus,
    parse_cell_key,
    parse_meta,
    status_value,
)

NOW_MS = 1_790_000_000_000.0


class ReadOnlyRedis(FakeRedis):
    """쓰기 명령이 오면 실패 — 수집기는 임대를 읽기만 한다(ACL %R~)."""

    writes: list[str]

    def __init__(self) -> None:
        super().__init__()
        self.writes = []
        self.armed = False

    async def zadd(self, key, mapping):  # type: ignore[override]
        if self.armed:
            self.writes.append(f"zadd {key}")
        return await super().zadd(key, mapping)

    async def hset(self, key, field=None, value=None, mapping=None):  # type: ignore[override]
        if self.armed:
            self.writes.append(f"hset {key}")
        return await super().hset(key, field, value, mapping)

    async def delete(self, *keys):  # type: ignore[override]
        self.writes.append(f"del {keys}")
        return await super().delete(*keys)


def test_parse_cell_key():
    assert parse_cell_key("35.5:139.5:150") == (35.5, 139.5, 150)
    assert parse_cell_key("-33.0:-151.5:50") == (-33.0, -151.5, 50)
    assert parse_cell_key("0.0:180.0:250") == (0.0, 180.0, 250)
    for bad in ("35.3:139.5:150", "35.5:139.5:120", "35.5:139.5:300", "86.0:10.0:50", "10.0:181.0:50", "a:b:c", "", "35.5:139.5"):
        assert parse_cell_key(bad) is None, bad
    assert parse_cell_key(None) is None  # type: ignore[arg-type]
    assert parse_cell_key("35.5:139.5:150\n") is None


def test_parse_meta_is_defensive():
    assert parse_meta(orjson.dumps({"sessions": 3, "first_at": 1_790_000_000_000}).decode()) == (3, 1_790_000_000_000)
    assert parse_meta('{"sessions": 2, "first_at": 1790000000}') == (2, 1_790_000_000_000)  # 초 → ms
    assert parse_meta('{"sessions": 1, "first_at": "2026-09-28T00:00:00Z"}')[1] == 1_790_553_600_000
    for raw in (None, "", "not json", "[1,2]", '{"sessions": true}', '{"sessions": -1}', "x" * 2000):
        s, f = parse_meta(raw)
        assert s == 0 and f == math.inf, raw
    assert parse_meta('{"sessions": 1, "first_at": "yesterday"}') == (1, math.inf)
    assert parse_meta('{"sessions": 1, "first_at": "2026-09-28T00:00:00"}') == (1, math.inf)  # 시간대 없음
    assert parse_meta('{"sessions": 1, "first_at": false}') == (1, math.inf)


async def _seed(r: FakeRedis) -> None:
    await r.zadd(HOT_KEY, {"35.5:139.5:150": NOW_MS + 30_000, "1.0:103.5:100": NOW_MS + 50_000, "bad-key": NOW_MS + 50_000})
    await r.zadd(HOT_KEY, {"22.0:114.0:200": NOW_MS - 1})  # 만료
    await r.hset(HOT_META_KEY, mapping={"35.5:139.5:150": '{"sessions": 1, "first_at": 1}', "1.0:103.5:100": '{"sessions": 4}'})
    await r.zadd(
        FOCUS_KEY, {"abcdef": NOW_MS + 60_000, "ABCDEF": NOW_MS + 60_000, "71c0a1": NOW_MS + 10_000, "000001": NOW_MS - 5}
    )
    await r.hset(FOCUS_META_KEY, mapping={"71c0a1": '{"sessions": 2, "first_at": 5}'})


async def test_poller_reads_validates_ranks_and_never_writes():
    r = ReadOnlyRedis()
    await _seed(r)
    r.armed = True
    p = DemandPoller(r, now_ms=lambda: NOW_MS)  # type: ignore[arg-type]
    d = await p.poll()
    assert [c.key for c in d.hot] == ["1.0:103.5:100", "35.5:139.5:150"]  # 세션 수 많은 순, 만료·형식 오류 제외
    assert (d.hot[0].lat, d.hot[0].lon, d.hot[0].radius_nm, d.hot[0].sessions) == (1.0, 103.5, 100, 4)
    assert d.focus_hexes == ["71c0a1", "abcdef"]  # 대문자 hex 는 거절
    assert d.ignored_hot == 1 and d.ignored_focus == 1
    assert d.fields == {"hot:1.0:103.5:100", "hot:35.5:139.5:150", "focus:71c0a1", "focus:abcdef"}
    assert r.writes == []


async def test_poller_caps_leases():
    r = FakeRedis()
    cells = {f"{i}.0:10.0:50": NOW_MS + 60_000 for i in range(10)}
    await r.zadd(HOT_KEY, cells)
    await r.hset(HOT_META_KEY, mapping={k: orjson.dumps({"sessions": int(k.split(".")[0])}).decode() for k in cells})
    await r.zadd(FOCUS_KEY, {f"{i:06x}": NOW_MS + 60_000 for i in range(80)})
    d = await DemandPoller(r, now_ms=lambda: NOW_MS).poll()  # type: ignore[arg-type]
    assert len(d.hot) == MAX_HOT_CELLS and [c.sessions for c in d.hot] == [9, 8, 7, 6, 5, 4]
    assert len(d.focus) == MAX_FOCUS_HEXES and d.ignored_focus == 30


async def test_poller_keeps_last_leases_until_they_expire_when_redis_fails():
    r = FakeRedis()
    await _seed(r)
    now = [NOW_MS]
    p = DemandPoller(r, now_ms=lambda: now[0])  # type: ignore[arg-type]
    await p.poll()
    r.down = True
    now[0] = NOW_MS + 20_000
    d = await p.poll()
    assert d.focus_hexes == ["abcdef"] and [c.key for c in d.hot] == ["1.0:103.5:100", "35.5:139.5:150"]
    now[0] = NOW_MS + 70_000
    d = await p.poll()
    assert d.focus == () and d.hot == () and p.errors == 2  # 임대 만료 → 호출 멈춤
    assert p.current == Demand(ignored_hot=1, ignored_focus=1)


async def test_poller_empty():
    d = await DemandPoller(FakeRedis(), now_ms=lambda: NOW_MS).poll()  # type: ignore[arg-type]
    assert d == Demand()


def test_status_value_shape():
    from datetime import UTC, datetime

    v = status_value("active", 5, datetime(2026, 9, 28, 1, 2, 3, tzinfo=UTC), None, "adsb_fi")
    assert v == {
        "state": "active",
        "interval_s": 5,
        "last_success_at": "2026-09-28T01:02:03Z",
        "last_error": None,
        "provider": "adsb_fi",
    }
    v = status_value("error", 30, None, "x" * 500 + " key=secret123", "adsb_fi")
    assert v["last_success_at"] is None and len(v["last_error"]) == 200


async def test_status_put_and_prune_including_leftovers():
    r = FakeRedis()
    await r.hset(STATUS_KEY, "focus:dead00", '{"state":"active"}')  # 이전 프로세스가 남긴 필드
    st = DemandStatus(r)  # type: ignore[arg-type]
    await st.put({"focus:abcdef": {"state": "active"}, "hot:1.0:2.0:50": {"state": "throttled"}})
    assert orjson.loads(r.kv[STATUS_KEY]["focus:abcdef"]) == {"state": "active"}
    await st.prune({"focus:abcdef", "hot:1.0:2.0:50"})
    assert set(r.kv[STATUS_KEY]) == {"focus:abcdef", "hot:1.0:2.0:50"}
    await st.prune({"hot:1.0:2.0:50"})
    assert set(r.kv[STATUS_KEY]) == {"hot:1.0:2.0:50"}
    await st.put({})
    await st.put({"focus:abcdef": {"state": "throttled"}})
    await st.delete(["focus:abcdef"])
    await st.delete([])
    assert set(r.kv[STATUS_KEY]) == {"hot:1.0:2.0:50"}
    r.down = True
    await st.put({"focus:abcdef": {"state": "active"}})
    await st.prune(set())
    await st.delete(["hot:1.0:2.0:50"])
    assert st.errors == 3  # Redis 오류는 삼킨다
    assert status_value("throttled", None, None, "provider disabled by operator", "adsb_fi")["interval_s"] is None
