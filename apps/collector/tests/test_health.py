from datetime import UTC, datetime, timedelta

from wakeline_collector.health import is_healthy, region_age_s

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
    from wakeline_collector import health
    from wakeline_collector.config import settings

    monkeypatch.setattr(settings, "redis_host", "127.0.0.1")
    monkeypatch.setattr(settings, "redis_port", 1)  # 닫힌 포트
    monkeypatch.setattr(settings, "redis_password", "s3cret-not-printed")
    assert health.main() == 1
    out = capsys.readouterr()
    assert "unhealthy" in out.err and "s3cret" not in out.err + out.out


# ---- COL-5: 기준이 region_poll_s 를 따른다 ---------------------------------------------------------------------------------
def test_threshold_follows_effective_region_poll():
    from wakeline_collector.health import max_age_s

    assert max_age_s({}) == 90 and max_age_s({"region_poll_s": "10"}) == 90  # 기본 주기는 기존 기준 그대로
    assert max_age_s({"region_poll_s": "120"}) == 310  # 2.5 × 120 + 10
    assert max_age_s({"region_poll_s": "abc"}) == 90 and max_age_s({"region_poll_s": "0"}) == 90
    assert max_age_s({"region_poll_s": "100000"}) == 90  # 범위 밖(설정은 5–120 으로 잘린다) → 기본


def test_poll_120_with_one_failed_fetch_stays_healthy():
    """주기 120 s 에서 수집 1회 실패(heartbeat 간격 240 s)는 정상, 두 번 연속 실패(360 s)는 비정상."""
    h = {"region_at": _iso(NOW - timedelta(seconds=240)), "region_poll_s": "120"}
    assert is_healthy(h, NOW)
    h["region_at"] = _iso(NOW - timedelta(seconds=360))
    assert not is_healthy(h, NOW)


def test_health_main_ok_and_stale(monkeypatch, capsys):
    from wakeline_collector import health

    class R:
        data: dict[str, str] = {}

        def __init__(self, **kw):
            pass

        def hgetall(self, key):
            return dict(R.data)

        def close(self):
            pass

    import redis

    monkeypatch.setattr(redis, "Redis", R)
    R.data = {"region_at": _iso(datetime.now(UTC)), "fixture": "0", "region_poll_s": "10"}
    assert health.main() == 0 and "ok: region heartbeat" in capsys.readouterr().out
    R.data = {"region_at": _iso(datetime.now(UTC) - timedelta(seconds=400)), "region_poll_s": "120"}
    assert health.main() == 1 and "(> 310 s)" in capsys.readouterr().err
