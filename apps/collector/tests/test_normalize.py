import logging
import math
import time
from datetime import UTC, datetime, timedelta

import pytest

from wakeline_collector import normalize
from wakeline_collector.normalize import (
    Rejected,
    from_opensky,
    from_readsb,
    normalize_opensky,
    normalize_readsb,
    readsb_reference_time,
)
from wakeline_collector.quality import AircraftGate

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


def test_same_observation_fetched_twice_has_identical_seen_at():
    """관심 지역·핫 리전·집중 추적이 같은 관측을 다른 시각에 받아도 seen_at 은 같아야 한다(중복 점 방지).
    실측 응답(2026-09-28): hot now=…170004 seen_pos 2.394, focus now=…186004 seen_pos 18.394 → 둘 다 …167.610."""
    base = {"hex": "71c123", "lat": 35.5, "lon": 139.8, "alt_baro": 12000, "gs": 300, "track": 90}
    fetched_a = datetime.fromtimestamp(1790538170.104, UTC)  # 수신 시각은 서버 시각과 0.1 s 씩 다르다
    fetched_b = datetime.fromtimestamp(1790538186.011, UTC)
    a = from_readsb({**base, "seen_pos": 2.394}, "adsb_fi", fetched_a, readsb_reference_time({"now": 1790538170004}, fetched_a))
    b = from_readsb({**base, "seen_pos": 18.394}, "adsb_fi", fetched_b, readsb_reference_time({"now": 1790538186004}, fetched_b))
    assert a is not None and b is not None
    assert a.seen_at == b.seen_at == datetime.fromtimestamp(1790538167.610, UTC)
    assert a.fetched_at == fetched_a  # 수신 시각은 그대로 기록한다


def test_reference_time_falls_back_to_fetch_time_when_source_clock_is_off_or_missing():
    fetched = datetime(2026, 9, 28, 1, 0, 0, tzinfo=UTC)
    assert readsb_reference_time({}, fetched) == fetched
    assert readsb_reference_time(None, fetched) == fetched
    assert readsb_reference_time({"now": "x"}, fetched) == fetched
    assert readsb_reference_time({"now": True}, fetched) == fetched
    assert readsb_reference_time({"now": 1e30}, fetched) == fetched  # 범위 밖
    off = (fetched.timestamp() + 121) * 1000  # 창(−10 ~ +2 s) 밖이면 믿지 않는다
    assert readsb_reference_time({"now": off}, fetched) == fetched
    near = (fetched.timestamp() + 1.5) * 1000
    assert readsb_reference_time({"now": near}, fetched) == fetched + timedelta(seconds=1.5)


@pytest.fixture
def fresh_clock_fallback(monkeypatch):
    monkeypatch.setattr(normalize, "clock_fallbacks", 0)
    monkeypatch.setattr(normalize, "_clock_fallback_logged", -math.inf)


def _at(fetched: datetime, offset_s: float) -> dict:
    return {"now": (fetched.timestamp() + offset_s) * 1000}


def test_reference_time_window_is_10_s_behind_to_2_s_ahead(fresh_clock_fallback, caplog):
    """리뷰 2026-09-28b #1: 창이 품질 게이트 미래 허용(30 s)·api focus TTL(60 s)보다 넓으면 시계가 어긋났을 때
    모든 readsb 레코드가 격리·만료된다. 공급자 `now` 는 수신 시각 −10 s ~ +2 s 안에서만 쓴다."""
    fetched = datetime(2026, 9, 28, 1, 0, 0, tzinfo=UTC)
    assert readsb_reference_time(_at(fetched, -10), fetched) == fetched - timedelta(seconds=10)
    assert readsb_reference_time(_at(fetched, 2), fetched) == fetched + timedelta(seconds=2)
    assert normalize.clock_fallbacks == 0
    with caplog.at_level(logging.WARNING, logger="normalize"):
        for off in (2.5, 45, 90, 119, -10.5, -45, -90):
            assert readsb_reference_time(_at(fetched, off), fetched) == fetched
        assert readsb_reference_time({"now": "x"}, fetched) == fetched  # 값은 있는데 읽을 수 없음
        assert readsb_reference_time({}, fetched) == fetched  # 없음은 되돌림으로 세지 않는다
    assert normalize.clock_fallbacks == 8
    logged = [r for r in caplog.records if "provider clock offset" in r.getMessage()]
    assert len(logged) == 1 and "+2.5 s" in logged[0].getMessage()  # 10분에 한 번만


def test_reference_time_fallback_is_logged_again_after_10_minutes(fresh_clock_fallback, caplog, monkeypatch):
    fetched = datetime(2026, 9, 28, 1, 0, 0, tzinfo=UTC)
    with caplog.at_level(logging.WARNING, logger="normalize"):
        readsb_reference_time(_at(fetched, 60), fetched)
        monkeypatch.setattr(normalize, "_clock_fallback_logged", time.monotonic() - normalize.CLOCK_FALLBACK_LOG_S)
        readsb_reference_time(_at(fetched, -60), fetched)
    logged = [r.getMessage() for r in caplog.records if "provider clock offset" in r.getMessage()]
    assert len(logged) == 2 and "-60.0 s" in logged[1] and "2 fallbacks" in logged[1]


@pytest.mark.parametrize("skew_s", [45.0, 90.0, 119.0])
def test_skewed_provider_clock_does_not_quarantine_every_record(skew_s):
    """공급자 시계가 30~120 s 앞서도 seen_at 이 미래로 가지 않는다(전에는 전부 seen_in_future 로 격리)."""
    fetched = datetime.now(UTC)
    ref = readsb_reference_time(_at(fetched, skew_s), fetched)
    ac = {"hex": "71c123", "lat": 35.5, "lon": 139.8, "alt_baro": 12000, "gs": 300, "track": 90, "seen_pos": 1.2}
    s = normalize_readsb(ac, "adsb_fi", fetched, ref)
    assert not isinstance(s, Rejected)
    g = AircraftGate().apply([s], 0, fetched)
    assert [x.hex for x in g.kept] == ["71c123"] and g.quarantined == []
    assert s.seen_at == fetched - timedelta(seconds=1.2)


# ---- R-33: 문자열 'inf'·'Infinity' 와 넘치는 값은 레코드 하나만 격리한다 ---------------------------------------------------
@pytest.mark.parametrize("bad", ["inf", "-inf", "Infinity", "-Infinity", float("inf")])
def test_r33_readsb_non_finite_numbers_are_unknown_not_crash(bad):
    base = {"hex": "abcdef", "lat": 1, "lon": 1, "seen_pos": 1, "gs": 300, "track": 90}
    s = normalize_readsb({**base, "alt_baro": bad}, "adsb_lol", NOW)
    assert not isinstance(s, Rejected) and s.alt_ft is None
    s = normalize_readsb({**base, "gs": bad, "baro_rate": bad}, "adsb_lol", NOW)
    assert not isinstance(s, Rejected) and s.gs_kt is None and s.vrate_fpm is None and s.quality == 1
    r = normalize_readsb({**base, "lat": bad}, "adsb_lol", NOW)
    assert isinstance(r, Rejected) and r.rule == "no_position"
    r = normalize_readsb({**base, "seen_pos": bad}, "adsb_lol", NOW)
    assert isinstance(r, Rejected) and r.rule == "no_position_time"


@pytest.mark.parametrize("bad", ["inf", "-Infinity"])
def test_r33_opensky_non_finite_numbers_are_unknown_not_crash(bad):
    s = normalize_opensky(_os_vec(baro=bad), NOW)
    assert not isinstance(s, Rejected) and s.alt_ft is None
    v = _os_vec()
    v[9], v[11] = bad, bad  # velocity, vertical_rate
    s = normalize_opensky(v, NOW)
    assert not isinstance(s, Rejected) and s.gs_kt is None and s.vrate_fpm is None
    r = normalize_opensky(_os_vec(time_pos=bad), NOW)
    assert isinstance(r, Rejected) and r.rule == "no_position_time"


def test_r33_finite_value_that_overflows_after_unit_conversion_is_isolated():
    r = normalize_opensky(_os_vec(baro=1e308), NOW)  # 1e308 m × 3.28 → inf ft
    assert isinstance(r, Rejected) and r.rule == "invalid_record" and r.hex == "71c0a1"
    v = _os_vec()
    v[9] = 1e308  # 1e308 m/s × 1.94 → inf kt
    r = normalize_opensky(v, NOW)
    assert isinstance(r, Rejected) and r.rule == "invalid_record"
