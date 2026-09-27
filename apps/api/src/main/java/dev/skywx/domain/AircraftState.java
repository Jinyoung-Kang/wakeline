package dev.skywx.domain;

import java.time.Instant;

/** schemas/aircraft_state.v1.json 과 같은 계약. 서버 값은 항상 estimated=false. */
public record AircraftState(
        String hex, String callsign, String registration, String typeCode, String category,
        double lat, double lon, Integer altFt, Double gsKt, Double trackDeg, Double vrateFpm,
        boolean onGround, String squawk, Instant seenAt, String provider, Instant fetchedAt,
        int quality, boolean estimated) {

    public boolean emergency() {
        return "7500".equals(squawk) || "7600".equals(squawk) || "7700".equals(squawk);
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
