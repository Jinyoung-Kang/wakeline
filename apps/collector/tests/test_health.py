from datetime import UTC, datetime, timedelta

from skywx_collector.health import is_healthy, region_age_s

NOW = datetime(2026, 9, 27, 12, 0, tzinfo=UTC)


def _iso(dt):
    return dt.isoformat().replace("+00:00", "Z")


def test_recent_region_heartbeat_is_healthy():
    assert is_healthy({"region_at": _iso(NOW - timedelta(seconds=10)), "fixture": "0"}, NOW)
    assert is_healthy({"region_at": _iso(NOW - timedelta(seconds=89)), "fixture": "1"}, NOW)


def test_stale_missing_or_garbage_is_unhealthy():
    assert not is_healthy({"region_at": _iso(NOW - timedelta(seconds=91))}, NOW)
    assert not is_healthy({}, NOW)
    assert not is_healthy({"region_at": ""}, NOW)
    assert not is_healthy({"region_at": "yesterday"}, NOW)
    assert not is_healthy({"region_at": "2026-09-27T11:59:50"}, NOW)  # 시간대 없음
    assert not is_healthy({"region_at": _iso(NOW + timedelta(minutes=5))}, NOW)  # 미래


def test_age():
    assert region_age_s({"region_at": _iso(NOW - timedelta(seconds=30))}, NOW) == 30


def test_health_main_returns_1_when_redis_unreachable(monkeypatch, capsys):
    from skywx_collector import health
    from skywx_collector.config import settings

    monkeypatch.setattr(settings, "redis_host", "127.0.0.1")
    monkeypatch.setattr(settings, "redis_port", 1)  # 닫힌 포트
    monkeypatch.setattr(settings, "redis_password", "s3cret-not-printed")
    assert health.main() == 1
    out = capsys.readouterr()
    assert "unhealthy" in out.err and "s3cret" not in out.err + out.out
