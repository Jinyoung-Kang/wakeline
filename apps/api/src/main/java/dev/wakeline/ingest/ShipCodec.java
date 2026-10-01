package dev.wakeline.ingest;

import dev.wakeline.ships.core.AisGap;
import dev.wakeline.ships.core.AisScope;
import dev.wakeline.ships.core.ShipState;
import dev.wakeline.ships.core.ShipStatic;
import tools.jackson.databind.JsonNode;

import java.time.Instant;
import java.util.LinkedHashSet;
import java.util.Set;

/**
 * 선박 스트림 payload(스키마 검증을 통과한 JsonNode) → 도메인 레코드. 없는 값은 null 로 둔다(추정하지 않는다).
 * 스키마가 표현하지 못하는 의미 검사만 여기서 한다(실패 = 검증 실패 → DLQ): 공백의 끝이 시작보다 뒤. 공백 scope 형식은 예외 — 틀려도 공백은 받는다.
 */
public final class ShipCodec {
    private ShipCodec() {}

    public static ShipState state(JsonNode n) {
        return new ShipState(n.path("mmsi").asString(), n.path("lat").asDouble(), n.path("lon").asDouble(),
                Codec.dbl(n, "sog_kn"), Codec.dbl(n, "cog_deg"), Codec.integer(n, "heading_deg"), Codec.integer(n, "nav_status"),
                Codec.integer(n, "rot"), positionSource(Codec.text(n, "position_source")), Instant.parse(n.path("seen_at").asString()),
                n.path("provider").asString(), Codec.text(n, "msg_type"), Codec.text(n, "class"));
    }

    /** 레거시 값: 예전 수집기가 Timestamp 0~60·누락을 묶어 낸 값 — 어느 쪽인지 모른다(계약 v3 §B). */
    static final String LEGACY_GNSS = "gnss";

    /**
     * 위치 출처(계약 v3 §B): epfs · manual · estimated · inoperative 는 그대로, null(모름)은 null. 배포 전환 중 스트림에 남은 옛 "gnss" 는
     * 받자마자 null 로 바꾼다 — 0~60 과 누락이 섞인 값이라 'epfs' 로 추정하지 않는다(DB V7 도 'gnss' 를 받지 않는다).
     */
    static String positionSource(String v) {
        return v == null || LEGACY_GNSS.equals(v) ? null : v;
    }

    /** 받은 필드를 모르는 정적 정보(payload 에 static_received 가 없는 이전 수집기 · 시험). */
    public static ShipStatic stat(JsonNode n) { return stat(n, null); }

    /** 정적 정보 한 건 + 그 MMSI 의 받은 필드(계약 v5 §G19 — {@link #received}, 모르면 null). */
    public static ShipStatic stat(JsonNode n, Set<String> received) {
        return new ShipStatic(n.path("mmsi").asString(), Codec.text(n, "name"), Codec.text(n, "call_sign"), Codec.integer(n, "imo"),
                Codec.integer(n, "ship_type"), Codec.integer(n, "dim_a"), Codec.integer(n, "dim_b"), Codec.integer(n, "dim_c"), Codec.integer(n, "dim_d"),
                Codec.dbl(n, "draught_m"), Codec.text(n, "destination"), Codec.integer(n, "eta_month"), Codec.integer(n, "eta_day"),
                Codec.integer(n, "eta_hour"), Codec.integer(n, "eta_minute"), Instant.parse(n.path("updated_at").asString()), n.path("provider").asString(),
                received);
    }

    /**
     * ships payload 의 static_received(계약 v5 §G19 — MMSI → 수집기 레코드가 시작된 뒤 받은 정적 필드, 스키마가 이름을 검사했다)에서 이 MMSI 의 것.
     * 키가 없으면(받은 필드를 싣지 않는 이전 수집기 — 배포 전환 중) 또는 이 MMSI 가 빠졌으면 null(모름 — 저장은 null 을 '받지 않음' 으로 본다).
     */
    public static Set<String> received(JsonNode map, String mmsi) {
        if (map == null || !map.isObject()) return null;
        JsonNode list = map.get(mmsi);
        if (list == null || !list.isArray()) return null;
        Set<String> out = new LinkedHashSet<>();
        for (JsonNode f : list) out.add(f.asString());
        return out;
    }

    /**
     * ais_gap payload. 끝이 시작보다 뒤가 아니면 IllegalArgumentException(검증 실패).
     * scope(계약 v4 §D, 선택): 그 구역의 상자 문자열을 운영 설정과 같은 규칙({@link AisScope#parse})으로 검사한다. 없거나 비었으면 null(모든 곳에 적용),
     * 틀리면 공백은 받되 scope 는 null 로 두고 invalidScope 를 부른다 — 공백 자체는 사실이므로 버리지 않고, 구역을 추정해 좁히지 않는다.
     */
    public static AisGap gap(JsonNode n, String provider, Runnable invalidScope) {
        Instant s = Instant.parse(n.path("started_at").asString());
        Instant e = Instant.parse(n.path("ended_at").asString());
        if (!e.isAfter(s)) throw new IllegalArgumentException("ais_gap: ended_at must be after started_at");
        AisScope scope = null;
        String raw = Codec.text(n, "scope");
        if (raw != null && !raw.isBlank()) {
            try {
                scope = AisScope.parse(raw);
            } catch (IllegalArgumentException ex) {
                invalidScope.run();
            }
        }
        return new AisGap(s, e, n.path("reason").asString(), provider, scope);
    }
}
