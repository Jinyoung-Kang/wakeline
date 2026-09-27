package dev.wakeline.ingest;

import dev.wakeline.domain.AisGap;
import dev.wakeline.domain.ShipState;
import dev.wakeline.domain.ShipStatic;
import tools.jackson.databind.JsonNode;

import java.time.Instant;

/**
 * 선박 스트림 payload(스키마 검증을 통과한 JsonNode) → 도메인 레코드. 없는 값은 null 로 둔다(추정하지 않는다).
 * 스키마가 표현하지 못하는 의미 검사만 여기서 한다(실패 = 검증 실패 → DLQ): 공백의 끝이 시작보다 뒤.
 */
public final class ShipCodec {
    private ShipCodec() {}

    public static ShipState state(JsonNode n) {
        return new ShipState(n.path("mmsi").asString(), n.path("lat").asDouble(), n.path("lon").asDouble(),
                Codec.dbl(n, "sog_kn"), Codec.dbl(n, "cog_deg"), Codec.integer(n, "heading_deg"), Codec.integer(n, "nav_status"),
                Codec.integer(n, "rot"), n.path("position_source").asString(), Instant.parse(n.path("seen_at").asString()),
                n.path("provider").asString(), Codec.text(n, "msg_type"), Codec.text(n, "class"));
    }

    public static ShipStatic stat(JsonNode n) {
        return new ShipStatic(n.path("mmsi").asString(), Codec.text(n, "name"), Codec.text(n, "call_sign"), Codec.integer(n, "imo"),
                Codec.integer(n, "ship_type"), Codec.integer(n, "dim_a"), Codec.integer(n, "dim_b"), Codec.integer(n, "dim_c"), Codec.integer(n, "dim_d"),
                Codec.dbl(n, "draught_m"), Codec.text(n, "destination"), Codec.integer(n, "eta_month"), Codec.integer(n, "eta_day"),
                Codec.integer(n, "eta_hour"), Codec.integer(n, "eta_minute"), Instant.parse(n.path("updated_at").asString()), n.path("provider").asString());
    }

    /** ais_gap payload. 끝이 시작보다 뒤가 아니면 IllegalArgumentException(검증 실패). */
    public static AisGap gap(JsonNode n, String provider) {
        Instant s = Instant.parse(n.path("started_at").asString());
        Instant e = Instant.parse(n.path("ended_at").asString());
        if (!e.isAfter(s)) throw new IllegalArgumentException("ais_gap: ended_at must be after started_at");
        return new AisGap(s, e, n.path("reason").asString(), provider);
    }
}
