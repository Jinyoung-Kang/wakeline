"""ais 헬스체크: heartbeat 신선도 + (최근 메시지 | 공백 열린 채 재연결 중 | 키 없음 disabled)."""

from __future__ import annotations

import json
import subprocess
import sys
from datetime import UTC, datetime, timedelta

import pytest

from wakeline_collector.ais import health

NOW = datetime(2026, 9, 28, 3, 0, 0, tzinfo=UTC)


def ago(s: float) -> str:
    return (NOW - timedelta(seconds=s)).isoformat().replace("+00:00", "Z")


@pytest.mark.parametrize(
    ("h", "ok"),
    [
        ({"updated_at": ago(3), "state": "receiving", "last_msg_at": ago(1)}, True),
        ({"updated_at": ago(3), "state": "receiving", "last_msg_at": ago(119)}, True),
        ({"updated_at": ago(3), "state": "receiving", "last_msg_at": ago(121)}, False),  # 연결은 됐는데 조용함 → 비정상
        ({"updated_at": ago(3), "state": "backoff", "last_msg_at": ago(600), "gap_open_since": ago(600)}, True),
        ({"updated_at": ago(3), "state": "connecting", "gap_open_since": ago(600)}, True),
        ({"updated_at": ago(3), "state": "subscribed", "gap_open_since": ago(600)}, True),
        ({"updated_at": ago(3), "state": "stopped", "gap_open_since": ago(600)}, False),
        ({"updated_at": ago(3), "state": "backoff"}, False),  # 한 번도 받지 못했고 공백도 없음(처음부터 실패)
        ({"updated_at": ago(3), "state": "disabled"}, True),
        ({"updated_at": ago(61), "state": "receiving", "last_msg_at": ago(1)}, False),  # 프로세스가 멈췄다
        ({"state": "receiving", "last_msg_at": ago(1)}, False),
        ({"updated_at": "garbage", "state": "receiving", "last_msg_at": ago(1)}, False),
        ({"updated_at": "2026-09-28T03:00:00", "state": "receiving", "last_msg_at": ago(1)}, False),  # 시간대 없음
        ({"updated_at": ago(-600), "state": "receiving", "last_msg_at": ago(1)}, False),  # 미래
        ({}, False),
    ],
)
def test_evaluate(h, ok):
    assert health.evaluate(h, NOW)[0] is ok


def shard(state: str, last: float | None = None, gap: float | None = None) -> dict:
    return {
        "scope": "1,1,2,2",
        "state": state,
        "connected": state in ("subscribed", "receiving"),
        "last_msg_at": None if last is None else ago(last),
        "gap_open_since": None if gap is None else ago(gap),
    }


def with_shards(*shards: dict, top_state: str = "backoff", **top: str) -> dict:
    return {"updated_at": ago(3), "state": top_state, "shards": json.dumps(list(shards)), **top}


@pytest.mark.parametrize(
    ("h", "ok"),
    [
        # 한 구역이라도 120 s 안에 받고 있으면 정상(계약 v4 §D)
        (with_shards(shard("receiving", 1), shard("backoff", 600, 600)), True),
        (with_shards(shard("receiving", 1), shard("stopped", 600, 600), top_state="stopped"), True),
        (with_shards(shard("receiving", 1), shard("backoff")), True),  # 다른 구역은 처음부터 실패 중이어도
        # 받는 구역이 없으면: 공백이 열린 구역이 모두 다시 붙는 중이어야 정상
        (with_shards(shard("backoff", 600, 600), shard("connecting", 300, 300)), True),
        (with_shards(shard("subscribed", 600, 600), shard("backoff", 300, 300)), True),
        (with_shards(shard("backoff", 600, 600), shard("backoff")), True),
        (with_shards(shard("backoff", 600, 600), shard("stopped", 300, 300), top_state="stopped"), False),
        (with_shards(shard("receiving", 121), shard("receiving", 200)), False),  # 모두 조용하고 공백도 없다
        (with_shards(shard("backoff"), shard("connecting")), False),  # 한 번도 받지 못했고 공백도 없다
        (with_shards(shard("receiving", -600)), False),  # 미래 시각은 믿지 않는다
        # 합계 state disabled(키 없음)는 구역과 상관없이 정상
        (with_shards(shard("disabled"), shard("disabled"), top_state="disabled"), True),
        # shards 가 비었거나 깨졌으면 합계 필드(v4 이전 규칙)
        ({"updated_at": ago(3), "state": "receiving", "last_msg_at": ago(1), "shards": "[]"}, True),
        ({"updated_at": ago(3), "state": "receiving", "last_msg_at": ago(1), "shards": "{broken"}, True),
        ({"updated_at": ago(3), "state": "receiving", "last_msg_at": ago(500), "shards": "[1, 2]"}, False),
        # heartbeat 가 오래됐으면 구역이 받고 있어도 비정상
        ({**with_shards(shard("receiving", 1)), "updated_at": ago(61)}, False),
    ],
)
def test_evaluate_with_shards(h, ok):
    assert health.evaluate(h, NOW)[0] is ok


def test_evaluate_with_shards_explains_itself():
    ok, why = health.evaluate(with_shards(shard("receiving", 4), shard("backoff", 600, 600)), NOW)
    assert ok and why == "1/2 shard(s) receiving, last message 4 s ago"
    ok, why = health.evaluate(with_shards(shard("backoff", 600, 600), shard("stopped", 300, 300)), NOW)
    assert not ok and "backoff,stopped" in why


class FakeSyncRedis:
    status: dict | Exception = {}
    closed = False

    def __init__(self, **kw):
        assert kw["username"] == "wakeline_ais" and kw["password"] == "pw" and kw["socket_timeout"] == 2

    def hgetall(self, key):
        assert key == health.KEY
        if isinstance(FakeSyncRedis.status, Exception):
            raise FakeSyncRedis.status
        return FakeSyncRedis.status

    def close(self):
        FakeSyncRedis.closed = True


def test_main_exit_codes(monkeypatch, capsys):
    import redis

    monkeypatch.setattr(redis, "Redis", FakeSyncRedis)
    monkeypatch.setenv("REDIS_USERNAME", "wakeline_ais")
    monkeypatch.setenv("REDIS_PASSWORD", "pw")
    monkeypatch.setenv("AISSTREAM_API_KEY", "k-should-not-print")
    now = datetime.now(UTC)
    FakeSyncRedis.status = {"updated_at": now.isoformat(), "state": "receiving", "last_msg_at": now.isoformat()}
    assert health.main() == 0
    FakeSyncRedis.status = {"updated_at": now.isoformat(), "state": "backoff"}
    assert health.main() == 1
    FakeSyncRedis.status = ConnectionError("down")
    assert health.main() == 1
    out = capsys.readouterr()
    assert "k-should-not-print" not in out.out + out.err
    assert FakeSyncRedis.closed


def test_health_does_not_import_the_ingest_stack():
    # 헬스체크는 5 s 제한 안에서 돈다 — websockets·수신 코드를 불러오지 않는다(새 인터프리터에서 확인)
    code = "import sys, wakeline_collector.ais.health as h; print(any(m.startswith(('websockets', 'wakeline_collector.ais.client')) for m in sys.modules))"
    out = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, check=True, timeout=30)
    assert out.stdout.strip() == "False"
