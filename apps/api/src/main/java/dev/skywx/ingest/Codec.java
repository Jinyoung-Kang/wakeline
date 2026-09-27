package dev.skywx.ingest;

import dev.skywx.domain.AircraftState;
import dev.skywx.domain.GeoJson;
import dev.skywx.domain.SigmetRecord;
import tools.jackson.databind.JsonNode;

import java.time.Instant;

/** 스트림 payload(JsonNode) → 도메인 레코드. 없는 값은 null 로 둔다(추정하지 않는다). */
public final class Codec {
    private Codec() {}

    public static AircraftState aircraft(JsonNode n) {
        return new AircraftState(
                n.path("hex").asString(), text(n, "callsign"), text(n, "registration"), text(n, "type_code"), text(n, "category"),
                n.path("lat").asDouble(), n.path("lon").asDouble(), integer(n, "alt_ft"), dbl(n, "gs_kt"), dbl(n, "track_deg"), dbl(n, "vrate_fpm"),
                n.path("on_ground").asBoolean(false), text(n, "squawk"), Instant.parse(n.path("seen_at").asString()),
                n.path("provider").asString(), Instant.parse(n.path("fetched_at").asString()), n.path("quality").asInt(0), false);
    }

    public static SigmetRecord sigmet(JsonNode n) {
        return new SigmetRecord(
                n.path("id").asString(), n.path("fir_id").asString(), text(n, "fir_name"), text(n, "issuer"), n.path("series_id").asString(),
                n.path("hazard").asString(), text(n, "qualifier"), n.path("base_ft").asInt(0), integer(n, "top_ft"),
                Instant.parse(n.path("valid_from").asString()), Instant.parse(n.path("valid_to").asString()),
                GeoJson.toMultiPolygon(n.get("geometry")), text(n, "excluded_reason"),
                text(n, "move_dir"), text(n, "move_spd"), text(n, "chng"), n.path("raw_text").asString(""),
                n.path("provider").asString(), Instant.parse(n.path("fetched_at").asString()));
    }

    static String text(JsonNode n, String f) {
        JsonNode v = n.get(f);
        return v == null || v.isNull() ? null : v.asString();
    }

    static Integer integer(JsonNode n, String f) {
        JsonNode v = n.get(f);
        return v == null || v.isNull() ? null : v.asInt();
    }

    static Double dbl(JsonNode n, String f) {
        JsonNode v = n.get(f);
        return v == null || v.isNull() ? null : v.asDouble();
    }
}
