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


# ---- COR-3: 오래된 위치 ---------------------------------------------------------------------------------------------
def test_stale_position_quarantined_per_provider():
    g = AircraftGate()
    res = g.apply(
        [
            st(hex="a00001", seen_at=NOW - timedelta(seconds=299)),  # 관심 지역 기준 300 s 안
            st(hex="a00002", seen_at=NOW - timedelta(seconds=301)),
            st(hex="a00003", provider="opensky", seen_at=NOW - timedelta(seconds=599)),  # OpenSky 600 s 안
            st(hex="a00004", provider="opensky", seen_at=NOW - timedelta(seconds=601)),
        ],
        0,
        NOW,
    )
    assert [s.hex for s in res.kept] == ["a00001", "a00003"]
    assert [(q.rule, q.hex) for q in res.quarantined] == [("stale_position", "a00002"), ("stale_position", "a00004")]
    assert res.quarantined[0].detail == {"age_s": 301.0, "provider": "adsb_lol"}


def test_frozen_opensky_point_is_not_republished_as_current():
    """같은 time_position 이 계속 오면(동결) 600 s 뒤부터는 싣지 않는다."""
    g = AircraftGate()
    frozen = NOW - timedelta(seconds=30)
    assert len(g.apply([st(provider="opensky", seen_at=frozen)], 0, NOW).kept) == 1
    later = NOW + timedelta(seconds=600)
    res = g.apply([st(provider="opensky", seen_at=frozen)], 0, later)
    assert rules(res) == ["stale_position"]


def test_pre_gate_rejections_are_counted():
    from wakeline_collector.quality import Quarantine

    res = AircraftGate().apply([st()], 0, NOW, pre=[Quarantine("no_position_time", "abcdef", {})])
    assert rules(res) == ["no_position_time"] and len(res.kept) == 1


def test_last_seen_memory_is_bounded(monkeypatch):
    from wakeline_collector import quality

    monkeypatch.setattr(quality, "LAST_SEEN_MAX", 2)
    g = AircraftGate()
    old = NOW - timedelta(seconds=299)
    g.apply([st(hex="b00001", seen_at=old), st(hex="b00002", seen_at=old), st(hex="b00003", seen_at=NOW)], 0, NOW)
    later = NOW + timedelta(seconds=400)
    g.apply([st(hex="b00004", seen_at=later)], 0, later)
    assert set(g._last) == {"b00003", "b00004"}  # 10분 넘게 안 보인 항목(b00001·b00002)은 정리
