"""구독 영역 설정: 형식·범위 검증, 정규화, aisstream 구독 형식, 런타임 설정 감시."""

from __future__ import annotations

import asyncio

import pytest
from fakes import FakeRedis

from wakeline_collector.ais.bbox import (
    DEFAULT_BBOXES,
    GLOBAL_BBOXES,
    MAX_BOXES,
    BboxState,
    format_bboxes,
    parse_bboxes,
    to_subscription,
)
from wakeline_collector.ais.runtime import FIELD, SETTINGS_KEY, BboxWatcher


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
    default = parse_bboxes(DEFAULT_BBOXES)
    st = BboxState(default)
    w = BboxWatcher(r, st, default)  # type: ignore[arg-type]
    assert await w.refresh() == "same"  # 설정 없음 → 기본값
    await r.hset(SETTINGS_KEY, FIELD, GLOBAL_BBOXES)
    assert await w.refresh() == "changed" and st.snapshot()[0] == parse_bboxes(GLOBAL_BBOXES)
    await r.hset(SETTINGS_KEY, FIELD, "garbage")
    assert await w.refresh() == "invalid" and st.snapshot()[0] == parse_bboxes(GLOBAL_BBOXES)  # 현재 구독 유지
    assert w.invalid == 1
    await r.hset(SETTINGS_KEY, FIELD, "")
    assert await w.refresh() == "changed" and st.snapshot()[0] == default  # 지우면 환경변수 기본값
    r.down = True
    assert await w.refresh() == "error" and st.snapshot()[0] == default and w.errors == 1


async def test_watcher_accepts_bytes_and_runs_until_stop():
    class BytesRedis(FakeRedis):
        async def hget(self, key, field):
            return b"10,100,20,110"

    default = parse_bboxes(DEFAULT_BBOXES)
    st = BboxState(default)
    stop = asyncio.Event()
    w = BboxWatcher(BytesRedis(), st, default, interval_s=0.01)  # type: ignore[arg-type]
    task = asyncio.create_task(w.run(stop))
    await asyncio.sleep(0.05)
    stop.set()
    await asyncio.wait_for(task, 1)
    assert st.snapshot()[0] == ((10.0, 100.0, 20.0, 110.0),)
