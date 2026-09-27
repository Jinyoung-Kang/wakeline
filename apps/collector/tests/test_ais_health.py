"""ais 헬스체크: heartbeat 신선도 + (최근 메시지 | 공백 열린 채 재연결 중 | 키 없음 disabled)."""

from __future__ import annotations

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
