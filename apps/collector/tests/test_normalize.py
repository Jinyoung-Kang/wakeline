from datetime import UTC, datetime, timedelta

from wakeline_collector.normalize import Rejected, from_opensky, from_readsb, normalize_opensky, normalize_readsb

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


def test_readsb_ground_keeps_altitude_unknown_not_zero():
    """COL-2: readsb 는 지상일 때 기압고도를 주지 않는다 → 0 ft 로 만들지 않고 null(on_ground 는 따로)."""
    s = from_readsb({"hex": "abcdef", "alt_baro": "ground", "lat": 1.0, "lon": 2.0, "seen_pos": 0}, "adsb_fi", NOW)
    assert s is not None and s.on_ground is True and s.alt_ft is None
    assert s.model_dump(mode="json")["alt_ft"] is None
    # alt_geom(기하 고도)은 다른 양이라 대신 쓰지 않는다
    s = from_readsb(
        {"hex": "abcdef", "alt_baro": "ground", "alt_geom": 75, "lat": 1.0, "lon": 2.0, "seen_pos": 0}, "adsb_fi", NOW
    )
    assert s is not None and s.alt_ft is None


def test_readsb_no_position_returns_none():
    assert from_readsb({"hex": "abcdef", "alt_baro": 1000}, "adsb_lol", NOW) is None


def test_readsb_missing_gs_track_is_quality_1_and_calc_track_used():
    s = from_readsb(
        {"hex": "abcdef", "alt_baro": 30100, "calc_track": 287, "lat": 36.9, "lon": 123.0, "seen_pos": 36.7}, "adsb_lol", NOW
    )
    assert s is not None and s.gs_kt is None and s.track_deg == 287 and s.quality == 1


def test_readsb_invalid_squawk_dropped():
    s = from_readsb({"hex": "abcdef", "squawk": "8888", "lat": 1, "lon": 1, "seen_pos": 1}, "adsb_lol", NOW)
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


# ---- COL-2 · DH-13 (정직성) --------------------------------------------------------------------------------------------
def _os_vec(**kw):
    v = ["71c0a1", "KAL081 ", "KR", 1790485200, 1790485200, 126.44, 37.46, 10668.0, False, 241.8, 82.5, 0.0, None, 10900.0]
    v += ["1234", False, 0, 5]
    idx = {"time_pos": 3, "lon": 5, "lat": 6, "baro": 7, "on_ground": 8, "icao": 0}
    for k, val in kw.items():
        v[idx[k]] = val
    return v


def test_opensky_ground_uses_reported_baro_altitude():
    s = from_opensky(_os_vec(on_ground=True, baro=7.62), NOW)
    assert s is not None and s.on_ground is True and s.alt_ft == 25  # 7.62 m = 25 ft, 0 으로 덮지 않는다


def test_opensky_ground_without_baro_is_null():
    s = from_opensky(_os_vec(on_ground=True, baro=None), NOW)
    assert s is not None and s.on_ground is True and s.alt_ft is None


def test_readsb_without_position_time_is_quarantined_not_stamped_now():
    """DH-13: seen_pos 가 없으면 수신 시각(fetched_at)을 관측 시각으로 꾸며 내지 않는다."""
    ac = {"hex": "abcdef", "alt_baro": 1000, "lat": 36.0, "lon": 127.0}
    r = normalize_readsb(ac, "adsb_fi", NOW)
    assert isinstance(r, Rejected) and r.rule == "no_position_time" and r.hex == "abcdef"
    assert from_readsb(ac, "adsb_fi", NOW) is None


def test_opensky_without_time_position_is_quarantined():
    for tpos in (None, 0):
        r = normalize_opensky(_os_vec(time_pos=tpos), NOW)
        assert isinstance(r, Rejected) and r.rule == "no_position_time" and r.hex == "71c0a1"


def test_rejection_reasons():
    assert normalize_readsb({"hex": "abcdef"}, "adsb_lol", NOW) == Rejected("no_position", "abcdef")
    r = normalize_readsb({"hex": "~abc12", "lat": 1, "lon": 1, "seen_pos": 1}, "adsb_lol", NOW)
    assert isinstance(r, Rejected) and r.rule == "invalid_record" and r.hex is None  # 비 ICAO 주소
    r = normalize_readsb({"hex": "abcdef", "lat": 1, "lon": 1, "seen_pos": 1e300}, "adsb_lol", NOW)
    assert isinstance(r, Rejected) and r.rule == "invalid_record"  # 날짜 범위 초과
    r = normalize_readsb({"hex": "abcdef", "lat": 95, "lon": 1, "seen_pos": 1}, "adsb_lol", NOW)
    assert isinstance(r, Rejected) and r.rule == "invalid_record" and r.detail["errors"] == ["lat"]
    assert normalize_opensky(["71c0a1"], NOW).rule == "invalid_record"  # type: ignore[union-attr]
    r = normalize_opensky(_os_vec(icao="xyz"), NOW)
    assert isinstance(r, Rejected) and r.rule == "invalid_record"
    r = normalize_opensky(_os_vec(lat=None), NOW)
    assert isinstance(r, Rejected) and r.rule == "no_position"
    r = normalize_opensky(_os_vec(time_pos=1e20), NOW)
    assert isinstance(r, Rejected) and r.rule == "invalid_record"
    r = normalize_opensky(_os_vec(baro=100000.0), NOW)  # 328,084 ft → 스키마 범위 밖
    assert isinstance(r, Rejected) and r.rule == "invalid_record" and r.detail["errors"] == ["alt_ft"]


def test_readsb_nan_and_bool_values_are_unknown():
    s = from_readsb({"hex": "abcdef", "lat": 1, "lon": 1, "seen_pos": 1, "gs": float("nan"), "track": True}, "adsb_lol", NOW)
    assert s is not None and s.gs_kt is None and s.track_deg is None and s.quality == 1
