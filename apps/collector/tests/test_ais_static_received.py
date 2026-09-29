"""Class B 부분 정적 정보가 저장된 값을 지우던 결함 — 수집기 쪽(재현).

관찰(코드): ShipBook 은 ais 재시작 · 제거(ttl 30분 · 선박 수 상한) 뒤 빈 레코드(14칸 모두 None)에서 시작해 받은 조각만 채운다. Class B 는 메시지 24A(선명)와
24B(호출부호 · 선종 · 크기)가 따로 오는데, 둘이 다른 발행(10 s)에 들어가면 첫 발행의 static 은 call_sign · ship_type · dim_* 가 None 이다. 발행 메시지는
'받지 않아서 None' 과 '빈 값으로 받아서 None' 을 구별하지 않으므로 api 저장(ShipWriter · STATIC_SQL)이 DB 행의 호출부호 · 크기를 NULL 로 덮는다.
"""

from __future__ import annotations

import time

import pytest
from fakes import FakeRedis
from test_ais_helpers import decode, dumps, static24

from wakeline_collector.ais.book import ShipBook
from wakeline_collector.ais.parse import go_time
from wakeline_collector.ais.queue import RawQueue
from wakeline_collector.ais.shards import ShardSet
from wakeline_collector.ais.sink import AisSink
from wakeline_collector.ais.worker import Worker
from wakeline_collector.publisher import STREAM_SHIPS

M = 416009981


def _sink() -> tuple[FakeRedis, Worker, AisSink]:
    r, q, book, shards = FakeRedis(), RawQueue(1000), ShipBook("aisstream"), ShardSet("aisstream")
    shards.add(None)
    w = Worker(q, book)
    return r, w, AisSink(r, book=book, shards=shards, worker=w, queue=q, provider="aisstream", raw_ref="-")  # type: ignore[arg-type]


async def _publish_24a_after_a_restart() -> dict:
    r, w, sink = _sink()  # 새 책 = ais 재시작 뒤
    w.handle(dumps(static24(M, part_b=False, time_utc=go_time(time.time()))))
    assert await sink.flush() == 1
    ((_sid, fields),) = r.streams[STREAM_SHIPS]
    return decode(fields)


async def test_24a_alone_after_a_restart_publishes_nulls_for_the_parts_not_received():
    payload = await _publish_24a_after_a_restart()
    (st,) = payload["static"]
    assert st["name"] == "BLUE HOLE"
    assert (st["call_sign"], st["ship_type"], st["dim_a"], st["dim_b"]) == (None, None, None, None)
    # 고치기 전(재현): 어떤 필드를 받았는지 싣지 않는다 — None 이 '받지 않음' 인지 '빈 값으로 받음' 인지 메시지로 알 수 없다
    assert "static_received" not in payload


@pytest.mark.xfail(strict=True, reason="재현: 발행 메시지가 받은 정적 필드를 밝히지 않는다(고치면 통과 — 이 표시를 지운다)")
async def test_the_published_message_says_which_static_fields_were_received():
    payload = await _publish_24a_after_a_restart()
    assert payload["static_received"] == {str(M): ["name"]}
