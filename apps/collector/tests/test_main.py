from skywx_collector.config import Settings
from skywx_collector.main import build_limits, make_redis


def test_redis_acl_username_passed_through():
    r = make_redis(Settings(redis_username="skywx_collector", redis_password="pw", redis_host="h", redis_port=1))
    kw = r.connection_pool.connection_kwargs
    assert kw["username"] == "skywx_collector" and kw["password"] == "pw"


def test_redis_without_username_uses_default_user():
    kw = make_redis(Settings(redis_username="", redis_password="")).connection_pool.connection_kwargs
    assert kw.get("username") is None and kw.get("password") is None


def test_every_budgeted_provider_is_snapshotted():
    limits = build_limits(Settings())
    assert {"adsb_lol", "adsb_fi", "opensky", "awc", "rainviewer", "kma_radar"} <= set(limits)
