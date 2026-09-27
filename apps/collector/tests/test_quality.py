from datetime import UTC, datetime, timedelta

from wakeline_collector.models import AircraftState
from wakeline_collector.quality import AircraftGate

NOW = datetime(2026, 9, 27, 5, 10, 5, tzinfo=UTC)


def st(**kw) -> AircraftState:
    base = dict(
        hex="abcdef",
        lat=36.0,
        lon=127.0,
        alt_ft=30000,
        gs_kt=400.0,
        track_deg=90.0,
        on_ground=False,
        seen_at=NOW,
        provider="adsb_lol",
        fetched_at=NOW,
    )
    base.update(kw)
    return AircraftState(**base)


def rules(res):
    return sorted(q.rule for q in res.quarantined)


def test_speed_alt_future_rules():
    g = AircraftGate()
    res = g.apply(
        [st(gs_kt=1300.0), st(hex="abcde1", alt_ft=61000), st(hex="abcde2", seen_at=NOW + timedelta(seconds=40))], 0, NOW
    )
    assert rules(res) == ["alt_gt_60000ft", "seen_in_future", "speed_gt_1200kt"] and res.kept == []


def test_no_position_counted():
    res = AircraftGate().apply([None, None, st()], 2, NOW)
    assert rules(res) == ["no_position", "no_position"] and len(res.kept) == 1


def test_position_jump():
    g = AircraftGate()
    g.apply([st()], 0, NOW)
    later = NOW + timedelta(seconds=10)
    res = g.apply([st(lat=40.0, lon=135.0, seen_at=later)], 0, later)  # 수백 NM 점프
    assert rules(res) == ["position_jump"]


def test_normal_movement_passes():
    g = AircraftGate()
    g.apply([st()], 0, NOW)
    later = NOW + timedelta(seconds=10)
    res = g.apply([st(lat=36.02, lon=127.02, seen_at=later)], 0, later)
    assert res.quarantined == [] and len(res.kept) == 1


def test_boundary_values_pass():
    res = AircraftGate().apply([st(gs_kt=1200.0, alt_ft=60000, seen_at=NOW + timedelta(seconds=30))], 0, NOW)
    assert res.quarantined == []
