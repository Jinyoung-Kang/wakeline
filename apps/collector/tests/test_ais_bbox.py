"""구독 영역 설정: 형식·범위 검증, 구역('|') 나누기(계약 v4 §D), 정규화, aisstream 구독 형식, 런타임 설정 감시."""

from __future__ import annotations

import asyncio

import pytest
from fakes import FakeRedis

from wakeline_collector.ais.bbox import (
    DEFAULT_BBOXES,
    GLOBAL_BBOXES,
    MAX_BOXES,
    MAX_SHARDS,
    MAX_TEXT,
    BboxState,
    ShardsState,
    format_bboxes,
    format_shards,
    parse_bboxes,
    parse_shards,
    to_subscription,
)
from wakeline_collector.ais.config import AisSettings
from wakeline_collector.ais.runtime import FIELD, SETTINGS_KEY, BboxWatcher

OPS = "-90,-180,90,0|-90,45,90,180"  # 운영 권장값(계약 v4 §D)


def test_parse_default_and_global():
    assert parse_bboxes(DEFAULT_BBOXES) == ((18.0, 105.0, 46.0, 150.0),)
    assert parse_bboxes(GLOBAL_BBOXES) == ((-90.0, -180.0, 90.0, 180.0),)


def test_parse_multiple_boxes_whitespace_trailing_separator():
    boxes = parse_bboxes(" 18, 105, 46 ,150 ; 30.5,-10.25,40,5 ;")
    assert boxes == ((18.0, 105.0, 46.0, 150.0), (30.5, -10.25, 40.0, 5.0))
    assert format_bboxes(boxes) == "18,105,46,150;30.5,-10.25,40,5"
    assert parse_bboxes(format_bboxes(boxes)) == boxes


@pytest.mark.parametrize(
    "bad",
    [
        "",
        " ; ",
        "18,105,46",
        "18,105,46,150,1",
        "a,105,46,150",
        "nan,105,46,150",
        "18,inf,46,150",
        "91,105,46,150",
        "18,105,46,181",
        "18,105,18,150",  # 넓이 0
        ";".join(["1,1,2,2"] * (MAX_BOXES + 1)),
        "1" * 2000,
    ],
)
def test_parse_rejects(bad):
    with pytest.raises(ValueError):
        parse_bboxes(bad)


def test_parse_rejects_non_string():
    with pytest.raises(ValueError):
        parse_bboxes(None)  # type: ignore[arg-type]


def test_subscription_shape():
    assert to_subscription(parse_bboxes("18,105,46,150;-1,-2,3,4")) == [
        [[18.0, 105.0], [46.0, 150.0]],
        [[-1.0, -2.0], [3.0, 4.0]],
    ]
    assert format_bboxes(((-0.0, 0.0, 1.0000001, 2.5),)) == "0,0,1,2.5"


async def test_bbox_state_versioning_and_wait():
    st = BboxState(parse_bboxes(DEFAULT_BBOXES))
    boxes, v = st.snapshot()
    assert v == 0 and st.set(boxes) is False  # 같은 값은 바뀐 것이 아니다
    waiter = asyncio.create_task(st.wait_change(v))
    await asyncio.sleep(0)
    assert not waiter.done()
    assert st.set(parse_bboxes(GLOBAL_BBOXES)) is True
    await asyncio.wait_for(waiter, 1)
    assert st.snapshot()[1] == 1
    await asyncio.wait_for(st.wait_change(0), 0.1)  # 이미 바뀐 뒤면 바로 돌아온다


async def test_watcher_applies_runtime_override_and_reverts():
    r = FakeRedis()
    default = parse_shards(DEFAULT_BBOXES)
    st = ShardsState(default)
    w = BboxWatcher(r, st, default)  # type: ignore[arg-type]
    assert await w.refresh() == "same"  # 설정 없음 → 기본값
    await r.hset(SETTINGS_KEY, FIELD, GLOBAL_BBOXES)
    assert await w.refresh() == "changed" and st.snapshot()[0] == (parse_bboxes(GLOBAL_BBOXES),)
    await r.hset(SETTINGS_KEY, FIELD, "garbage")
    assert await w.refresh() == "invalid" and st.snapshot()[0] == (parse_bboxes(GLOBAL_BBOXES),)  # 현재 구독 유지
    assert w.invalid == 1
    await r.hset(SETTINGS_KEY, FIELD, "")
    assert await w.refresh() == "changed" and st.snapshot()[0] == default  # 지우면 환경변수 기본값
    r.down = True
    assert await w.refresh() == "error" and st.snapshot()[0] == default and w.errors == 1


async def test_watcher_applies_shard_settings_and_keeps_current_on_invalid():
    r = FakeRedis()
    default = parse_shards(DEFAULT_BBOXES)
    st = ShardsState(default)
    w = BboxWatcher(r, st, default)  # type: ignore[arg-type]
    await r.hset(SETTINGS_KEY, FIELD, OPS)
    assert await w.refresh() == "changed" and len(st.snapshot()[0]) == 2
    for bad in ("1,1,2,2|3,3,4,4|5,5,6,6|7,7,8,8", "1,1,2,2||3,3,4,4", "1,1,2,2|"):
        await r.hset(SETTINGS_KEY, FIELD, bad)
        assert await w.refresh() == "invalid" and format_shards(st.snapshot()[0]) == OPS
    await r.hset(SETTINGS_KEY, FIELD, " -90 , -180,90,0 | -90,45,90,180 ")  # 공백만 다름 → 같은 설정
    assert await w.refresh() == "same" and st.snapshot()[1] == 1


async def test_watcher_accepts_bytes_and_runs_until_stop():
    class BytesRedis(FakeRedis):
        async def hget(self, key, field):
            return b"10,100,20,110"

    default = parse_shards(DEFAULT_BBOXES)
    st = ShardsState(default)
    stop = asyncio.Event()
    w = BboxWatcher(BytesRedis(), st, default, interval_s=0.01)  # type: ignore[arg-type]
    task = asyncio.create_task(w.run(stop))
    await asyncio.sleep(0.05)
    stop.set()
    await asyncio.wait_for(task, 1)
    assert st.snapshot()[0] == (((10.0, 100.0, 20.0, 110.0),),)


# ── 구역 나누기(계약 v4 §D) ──────────────────────────────────


def test_parse_shards_without_separator_is_one_shard():
    for text in (DEFAULT_BBOXES, " 18, 105, 46 ,150 ; 30.5,-10.25,40,5 ;", GLOBAL_BBOXES):
        assert parse_shards(text) == (parse_bboxes(text),)
        assert format_shards(parse_shards(text)) == format_bboxes(parse_bboxes(text))


def test_parse_shards_splits_on_pipe_and_normalizes_each_shard():
    shards = parse_shards(" -90,-180,90,0 |-90,45,90,180;10,10,20,20; ")
    assert shards == (((-90.0, -180.0, 90.0, 0.0),), ((-90.0, 45.0, 90.0, 180.0), (10.0, 10.0, 20.0, 20.0)))
    assert [format_bboxes(s) for s in shards] == ["-90,-180,90,0", "-90,45,90,180;10,10,20,20"]
    assert format_shards(shards) == "-90,-180,90,0|-90,45,90,180;10,10,20,20"
    assert parse_shards(format_shards(shards)) == shards
    assert len(parse_shards("1,1,2,2|3,3,4,4|5,5,6,6")) == MAX_SHARDS


def test_parse_shards_allows_16_boxes_per_shard():
    shard = ";".join(["1,1,2,2"] * MAX_BOXES)
    shards = parse_shards("|".join([shard] * MAX_SHARDS))  # 3 × 16 상자, 407자
    assert [len(s) for s in shards] == [MAX_BOXES] * MAX_SHARDS


@pytest.mark.parametrize(
    "bad",
    [
        "1,1,2,2|3,3,4,4|5,5,6,6|7,7,8,8",  # 구역 4개(키당 연결 3개)
        "1,1,2,2||3,3,4,4",  # 빈 구역
        "1,1,2,2|",  # 끝의 '|' = 빈 구역
        "|1,1,2,2",
        " | ",
        "1,1,2,2| ; ",
        "1,1,2,2|" + ";".join(["1,1,2,2"] * (MAX_BOXES + 1)),  # 한 구역 상자 17개
        "1,1,2,2|91,1,2,2",  # 범위 밖
        "1,1,2,2|1,1,1,2",  # 넓이 0
        "1,1,2,2|x",
        "1,1,2,2|" + "1" * MAX_TEXT,  # 전체 1,024자 초과
    ],
)
def test_parse_shards_rejects(bad):
    with pytest.raises(ValueError):
        parse_shards(bad)


def test_parse_shards_error_names_the_shard():
    with pytest.raises(ValueError, match="shard 2: no bounding box"):
        parse_shards("1,1,2,2||3,3,4,4")
    with pytest.raises(ValueError, match="more than 3 shards"):
        parse_shards("1,1,2,2|3,3,4,4|5,5,6,6|7,7,8,8")


def test_parse_shards_rejects_settings_whose_normalized_form_exceeds_the_limit():
    # 1e-6 는 4자지만 정규화하면 0.000001(8자) — 상태 해시 bbox(1,024자 제한)가 넘치지 않게 설정 자체를 거부한다
    box = "1e-6,1e-6,2e-6,2e-6"
    text = "|".join([";".join([box] * MAX_BOXES)] * MAX_SHARDS)
    assert len(text) <= MAX_TEXT
    with pytest.raises(ValueError, match="normalized"):
        parse_shards(text)
    # 구역 하나의 정규화 문자열(공백 scope)은 가장 긴 숫자로 채워도 767자 — 스키마 상한 1,024 안
    widest = ";".join(["-89.123456,-179.123456,-89.654321,-179.654321"] * MAX_BOXES)
    assert len(format_bboxes(parse_bboxes(widest))) == 16 * 45 + 15 <= 767
    assert len(format_bboxes(parse_bboxes(";".join([box] * MAX_BOXES)))) <= 767


def test_parse_bboxes_rejects_a_pipe():
    with pytest.raises(ValueError):
        parse_bboxes(OPS)  # 구역 하나의 문법에는 '|' 가 없다


def test_parse_shards_rejects_non_string():
    with pytest.raises(ValueError):
        parse_shards(None)  # type: ignore[arg-type]


def test_env_setting_accepts_shards_and_rejects_bad_grammar():
    assert AisSettings(ais_bboxes=OPS).ais_bboxes == OPS
    with pytest.raises(ValueError):
        AisSettings(ais_bboxes="1,1,2,2|3,3,4,4|5,5,6,6|7,7,8,8")
    with pytest.raises(ValueError):
        AisSettings(ais_bboxes="1,1,2,2||3,3,4,4")


async def test_shards_state_versioning():
    st = ShardsState(parse_shards(OPS))
    shards, v = st.snapshot()
    assert v == 0 and st.set(parse_shards(" -90,-180,90,0|-90,45,90,180 ")) is False
    waiter = asyncio.create_task(st.wait_change(v))
    await asyncio.sleep(0)
    assert st.set(parse_shards(DEFAULT_BBOXES)) is True
    await asyncio.wait_for(waiter, 1)
    assert st.snapshot() == (parse_shards(DEFAULT_BBOXES), 1)
