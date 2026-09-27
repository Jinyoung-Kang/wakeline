from datetime import UTC, datetime, timedelta

from skywx_collector.normalize import from_opensky, from_readsb

NOW = datetime(2026, 9, 27, 5, 10, 5, tzinfo=UTC)


def test_readsb_basic_units_kept():
    ac = {
        "hex": "71C0A1",
        "flight": "KAL081  ",
        "r": "HL8001",
        "t": "B77W",
        "alt_baro": 35000,
        "gs": 470.0,
        "track": 82.5,
        "baro_rate": 64,
        "squawk": "1234",
        "lat": 37.4602,
        "lon": 126.4407,
        "seen_pos": 2.0,
        "category": "A5",
    }
    s = from_readsb(ac, "adsb_lol", NOW)
    assert s is not None
    assert s.hex == "71c0a1" and s.callsign == "KAL081" and s.registration == "HL8001" and s.type_code == "B77W"
    assert s.alt_ft == 35000 and s.gs_kt == 470.0 and s.track_deg == 82.5 and s.vrate_fpm == 64
    assert s.seen_at == NOW - timedelta(seconds=2) and s.quality == 0 and s.estimated is False


def test_readsb_ground():
    s = from_readsb({"hex": "abcdef", "alt_baro": "ground", "lat": 1.0, "lon": 2.0, "seen_pos": 0}, "adsb_fi", NOW)
    assert s is not None and s.on_ground is True and s.alt_ft == 0


def test_readsb_no_position_returns_none():
    assert from_readsb({"hex": "abcdef", "alt_baro": 1000}, "adsb_lol", NOW) is None


def test_readsb_missing_gs_track_is_quality_1_and_calc_track_used():
    s = from_readsb(
        {"hex": "abcdef", "alt_baro": 30100, "calc_track": 287, "lat": 36.9, "lon": 123.0, "seen_pos": 36.7}, "adsb_lol", NOW
    )
    assert s is not None and s.gs_kt is None and s.track_deg == 287 and s.quality == 1


def test_readsb_invalid_squawk_dropped():
    s = from_readsb({"hex": "abcdef", "squawk": "8888", "lat": 1, "lon": 1}, "adsb_lol", NOW)
    assert s is not None and s.squawk is None


def test_opensky_unit_conversion():
    vec = [
        "71c0a1",
        "KAL081 ",
        "Republic of Korea",
        1790485200,
        1790485200,
        126.44,
        37.46,
        10668.0,
        False,
        241.8,
        82.5,
        0.0,
        None,
        10900.0,
        "1234",
        False,
        0,
        5,
    ]
    s = from_opensky(vec, NOW)
    assert s is not None
    assert s.alt_ft == 35000 and s.gs_kt == 470.0 and s.vrate_fpm == 0 and s.provider == "opensky"
    assert s.seen_at == datetime.fromtimestamp(1790485200, UTC)


def test_opensky_missing_position_none():
    assert from_opensky(["71c0a1", None, "", None, 1, None, None, 1000.0, False, 1, 1, 1], NOW) is None
