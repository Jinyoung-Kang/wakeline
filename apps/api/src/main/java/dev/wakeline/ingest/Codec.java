package dev.wakeline.ingest;

import dev.wakeline.aircraft.core.AircraftState;
import dev.wakeline.geo.GeoJson;
import dev.wakeline.domain.SigmetRecord;
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

    /**
     * base_source·top_source 는 collector 가 채운다(계약 §4). 이전 형식 메시지(필드 없음)는 추정하지 않고 null 로 둔다.
     * top_source 값: json | raw_text | raw_text_lower_bound(원문 "TOP ABV FLnnn" — 발표값은 상한의 하한, DH-4) | unknown.
     * top_ft 가 null 이면 상한은 정의상 '알 수 없음'(계약 §4: top_ft null + unknown = 미발표)이므로 top_source 를 unknown 으로 맞춘다(결정적).
     */
    public static SigmetRecord sigmet(JsonNode n) {
        Integer top = integer(n, "top_ft");
        String topSource = text(n, "top_source");
        if (top == null) topSource = SigmetRecord.TOP_UNKNOWN;
        return new SigmetRecord(
                n.path("id").asString(), n.path("fir_id").asString(), text(n, "fir_name"), text(n, "issuer"), n.path("series_id").asString(),
                n.path("hazard").asString(), text(n, "qualifier"), n.path("base_ft").asInt(0), top,
                Instant.parse(n.path("valid_from").asString()), Instant.parse(n.path("valid_to").asString()),
                GeoJson.toMultiPolygon(n.get("geometry")), text(n, "excluded_reason"),
                text(n, "move_dir"), text(n, "move_spd"), text(n, "chng"), n.path("raw_text").asString(""),
                n.path("provider").asString(), Instant.parse(n.path("fetched_at").asString()),
                text(n, "base_source"), topSource);
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
