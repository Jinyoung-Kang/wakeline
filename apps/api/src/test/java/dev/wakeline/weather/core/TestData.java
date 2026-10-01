package dev.wakeline.weather.core;

import dev.wakeline.aircraft.core.AircraftState;
import dev.wakeline.geo.GeoJson;
import org.locationtech.jts.geom.Coordinate;
import org.locationtech.jts.geom.MultiPolygon;
import org.locationtech.jts.geom.Polygon;

import java.time.Instant;
import java.util.Set;

final class TestData {
    static final Instant NOW = Instant.parse("2026-09-27T05:10:00Z");

    static MultiPolygon box(double lomin, double lamin, double lomax, double lamax) {
        Polygon p = GeoJson.GF.createPolygon(new Coordinate[]{new Coordinate(lomin, lamin), new Coordinate(lomax, lamin),
                new Coordinate(lomax, lamax), new Coordinate(lomin, lamax), new Coordinate(lomin, lamin)});
        return GeoJson.GF.createMultiPolygon(new Polygon[]{p});
    }

    /** 126–128E, 35–37N, FL140–210, 유효 NOW-1h ~ NOW+3h */
    static SigmetRecord sigmet(String id, Integer baseFt, Integer topFt) {
        return sigmet(id, baseFt, topFt, NOW.minusSeconds(3600), NOW.plusSeconds(3 * 3600));
    }

    static SigmetRecord sigmet(String id, Integer baseFt, Integer topFt, Instant validFrom, Instant validTo) {
        return new SigmetRecord(id, "RKRR", "RKRR INCHEON", "RKSI", "F02", "ICE", "SEV", baseFt == null ? 0 : baseFt, topFt,
                validFrom, validTo, box(126, 35, 128, 37), null, null, null, null, "RAW", "awc_isigmet", NOW,
                baseFt == null ? SigmetRecord.BASE_ASSUMED_SURFACE : SigmetRecord.BASE_JSON,
                topFt == null ? SigmetRecord.TOP_UNKNOWN : SigmetRecord.TOP_JSON);
    }

    static AircraftState ac(String hex, double lat, double lon, Integer alt, boolean ground) {
        return ac(hex, lat, lon, alt, ground, 450.0, 90.0);
    }

    static AircraftState ac(String hex, double lat, double lon, Integer alt, boolean ground, Double gs, Double track) {
        return new AircraftState(hex, "TST" + hex.substring(3), null, null, null, lat, lon, alt, gs, track, 0.0, ground, "1200",
                NOW, "adsb_lol", NOW, 0, false);
    }

    /** 관측 시각·공급자를 지정한 상태(나이·신선도 검사용). */
    static AircraftState acSeen(String hex, double lat, double lon, Integer alt, Instant seenAt, String provider) {
        return acSeen(hex, lat, lon, alt, seenAt, provider, 450.0, 90.0, 0.0);
    }

    static AircraftState acSeen(String hex, double lat, double lon, Integer alt, Instant seenAt, String provider,
                                Double gs, Double track, Double vrate) {
        return new AircraftState(hex, "TST" + hex.substring(3), null, null, null, lat, lon, alt, gs, track, vrate, false, "1200",
                seenAt, provider, seenAt, 0, false);
    }

    /** 한 주기 맥락: region 스냅샷 버전 v, global 버전 gv, 두 피드 모두 살아 있음, regionHexes 는 관심 지역 스냅샷의 hex. */
    static AlertStateMachine.Cycle cycle(long v, long gv, Set<String> regionHexes) {
        return new AlertStateMachine.Cycle(v, gv, false, false, regionHexes);
    }

    /** 서쪽 경계(126E)에서 nm 만큼 서쪽의 경도(36N 기준). */
    static double westOfBox(double nm) {
        return 126 - nm / (60.0 * Math.cos(Math.toRadians(36)));
    }
}
