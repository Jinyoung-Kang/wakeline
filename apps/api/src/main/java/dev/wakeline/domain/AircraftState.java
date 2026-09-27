package dev.wakeline.domain;

import java.time.Instant;

/** schemas/aircraft_state.v1.json 과 같은 계약. 서버 값은 항상 estimated=false. */
public record AircraftState(
        String hex, String callsign, String registration, String typeCode, String category,
        double lat, double lon, Integer altFt, Double gsKt, Double trackDeg, Double vrateFpm,
        boolean onGround, String squawk, Instant seenAt, String provider, Instant fetchedAt,
        int quality, boolean estimated) {

    /** 관심 지역 공급자(readsb 계열) 위치를 '현재' 로 보는 최대 나이(초). 계약 §1 클라이언트 staleness 와 같은 기준. */
    public static final int FRESH_MAX_AGE_S = 60;
    /** OpenSky 위치를 '현재' 로 보는 최대 나이(초). OpenSky 는 2분 주기 + time_position 지연이 있어 기준이 더 길다. */
    public static final int FRESH_MAX_AGE_OPENSKY_S = 300;

    public boolean emergency() {
        return "7500".equals(squawk) || "7600".equals(squawk) || "7700".equals(squawk);
    }

    /** 위치 나이(초) = now − seen_at. 시계 차로 음수가 될 수 있다(호출자가 필요하면 0 으로 자른다). */
    public double ageSeconds(Instant now) {
        return (now.toEpochMilli() - seenAt.toEpochMilli()) / 1000.0;
    }

    /** 이 공급자의 위치를 '현재' 로 볼 수 있는 최대 나이(초): opensky 300 s, 그 외 60 s. */
    public int freshMaxAgeS() {
        return "opensky".equals(provider) ? FRESH_MAX_AGE_OPENSKY_S : FRESH_MAX_AGE_S;
    }

    /** 판정(관측·예측)에 쓸 수 있을 만큼 최근 위치인가. 오래된 위치는 '관측' 으로 세지 않는다. */
    public boolean fresh(Instant now) {
        return ageSeconds(now) <= freshMaxAgeS();
    }

    /** diff 판정: 위치 1e-4°, 고도 25 ft, 속도 1 kt, 방위 1°, squawk/on_ground 변화 중 하나라도. */
    public boolean changedFrom(AircraftState o) {
        if (o == null) return true;
        if (Math.abs(lat - o.lat) > 1e-4 || Math.abs(lon - o.lon) > 1e-4) return true;
        if (diff(altFt, o.altFt, 25)) return true;
        if (diff(gsKt, o.gsKt, 1.0)) return true;
        if (diff(trackDeg, o.trackDeg, 1.0)) return true;
        if (onGround != o.onGround) return true;
        if (squawk == null ? o.squawk != null : !squawk.equals(o.squawk)) return true;
        return !seenAt.equals(o.seenAt) && quality != o.quality;
    }

    private static boolean diff(Number a, Number b, double tol) {
        if (a == null || b == null) return a != b;
        return Math.abs(a.doubleValue() - b.doubleValue()) > tol;
    }
}
