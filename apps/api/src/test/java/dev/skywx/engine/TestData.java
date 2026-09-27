package dev.skywx.engine;

import dev.skywx.domain.AircraftState;
import dev.skywx.domain.GeoJson;
import dev.skywx.domain.SigmetRecord;
import org.locationtech.jts.geom.Coordinate;
import org.locationtech.jts.geom.MultiPolygon;
import org.locationtech.jts.geom.Polygon;

import java.time.Instant;

final class TestData {
    static final Instant NOW = Instant.parse("2026-09-27T05:10:00Z");

    static MultiPolygon box(double lomin, double lamin, double lomax, double lamax) {
        Polygon p = GeoJson.GF.createPolygon(new Coordinate[]{new Coordinate(lomin, lamin), new Coordinate(lomax, lamin),
                new Coordinate(lomax, lamax), new Coordinate(lomin, lamax), new Coordinate(lomin, lamin)});
        return GeoJson.GF.createMultiPolygon(new Polygon[]{p});
    }

    /** 126–128E, 35–37N, FL140–210, 유효 NOW-1h ~ NOW+3h */
    static SigmetRecord sigmet(String id, Integer baseFt, Integer topFt) {
        return new SigmetRecord(id, "RKRR", "RKRR INCHEON", "RKSI", "F02", "ICE", "SEV", baseFt == null ? 0 : baseFt, topFt,
                NOW.minusSeconds(3600), NOW.plusSeconds(3 * 3600), box(126, 35, 128, 37), null, null, null, null, "RAW", "awc_isigmet", NOW);
    }

    static AircraftState ac(String hex, double lat, double lon, Integer alt, boolean ground) {
        return ac(hex, lat, lon, alt, ground, 450.0, 90.0);
    }

    static AircraftState ac(String hex, double lat, double lon, Integer alt, boolean ground, Double gs, Double track) {
        return new AircraftState(hex, "TST" + hex.substring(3), null, null, null, lat, lon, alt, gs, track, 0.0, ground, "1200",
                NOW, "adsb_lol", NOW, 0, false);
    }
}
