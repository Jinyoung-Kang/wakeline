package dev.wakeline.aircraft.web;

import com.fasterxml.jackson.annotation.JsonInclude;
import dev.wakeline.aircraft.core.AircraftState;
import dev.wakeline.aircraft.core.Snapshot;
import dev.wakeline.aircraft.core.SnapshotStore;

import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * 항공기 JSON(계약 §1) — WS(snapshot · diff · selected)와 REST(/aircraft · 상세 · GeoJSON)가 같은 인코딩과 같은 sources 모양을 쓴다.
 * 예전에는 WS 쪽(WsMessages · WsHub)에 있어 REST 컨트롤러가 WS 패키지를 import 했다(api-review E6 · §2.5-6).
 */
public final class AircraftJson {
    private AircraftJson() {}

    /** 항공기 인코딩(계약 §1). LITE: 줌 > 5. WORLD: 줌 ≤ 5(좌표 소수 3자리, vrate·quality 제외). FULL: 선택 항공기·REST 상세. */
    public enum Encoding { LITE, WORLD, FULL }

    /** 피드 stale 기준(계약 §1): 지역 60 s · 전세계 300 s */
    public static final int REGION_STALE_S = 60;
    public static final int GLOBAL_STALE_S = 300;

    /**
     * 피드(스코프) 하나의 출처·지연. lag_s = now − fetched_at(수집 이력이 없으면 null), stale = 지연이 임계(지역 60 s · 전세계 300 s)를
     * 넘었거나 수집 이력이 없음. provider 가 없으면 null.
     */
    public record Source(String provider, Instant fetchedAt, Double lagS, boolean stale) {}

    /** global 은 전세계 피드가 없으면 null(키는 남긴다). */
    public record Sources(Source region, @JsonInclude(JsonInclude.Include.ALWAYS) Source global) {}

    /** 스냅샷 sources(계약 §1): 스코프별 provider·fetched_at·lag_s·stale. 전세계 피드가 한 번도 없으면 global = null. REST /aircraft meta 도 같은 모양을 쓴다. */
    public static Sources sources(SnapshotStore.View view, Instant now) {
        return new Sources(source(view.region(), now, REGION_STALE_S),
                hasFeed(view.global()) ? source(view.global(), now, GLOBAL_STALE_S) : null);
    }

    private static boolean hasFeed(Snapshot s) {
        return s.fetchedAt() != null && !Instant.EPOCH.equals(s.fetchedAt());
    }

    static Source source(Snapshot s, Instant now, int staleS) {
        boolean known = hasFeed(s);
        String provider = s.provider() == null || s.provider().isBlank() || "-".equals(s.provider()) ? null : s.provider();
        if (!known) return new Source(provider, null, null, true); // 수집 이력 없음 = 현재 아님
        double lag = (now.toEpochMilli() - s.fetchedAt().toEpochMilli()) / 1000.0;
        return new Source(provider, s.fetchedAt(), Math.round(lag * 10) / 10.0, lag > staleS);
    }

    /**
     * 항공기 하나를 인코딩한다. null 인 값은 넣지 않는다(모르는 값을 0·false 로 채우지 않는다).
     * seen_at·fetched_at 은 ISO-8601(UTC) 문자열.
     */
    public static Map<String, Object> encode(AircraftState a, Encoding enc) {
        Map<String, Object> m = new LinkedHashMap<>(enc == Encoding.FULL ? 24 : 16);
        m.put("hex", a.hex());
        put(m, "callsign", a.callsign());
        if (enc == Encoding.WORLD) {
            m.put("lat", round3(a.lat()));
            m.put("lon", round3(a.lon()));
        } else {
            m.put("lat", a.lat());
            m.put("lon", a.lon());
        }
        put(m, "alt_ft", a.altFt());
        put(m, "gs_kt", a.gsKt());
        put(m, "track_deg", a.trackDeg());
        if (enc != Encoding.WORLD) put(m, "vrate_fpm", a.vrateFpm());
        m.put("on_ground", a.onGround());
        put(m, "squawk", a.squawk());
        put(m, "seen_at", a.seenAt() == null ? null : a.seenAt().toString());
        put(m, "provider", a.provider());
        if (enc != Encoding.WORLD) m.put("quality", a.quality());
        if (enc == Encoding.FULL) {
            put(m, "registration", a.registration());
            put(m, "type_code", a.typeCode());
            put(m, "category", a.category());
            put(m, "fetched_at", a.fetchedAt() == null ? null : a.fetchedAt().toString());
        }
        return m;
    }

    /** 이전 시그니처 호환(REST 가 쓴다): detail "full" → FULL, world → WORLD, 그 밖 → LITE. */
    public static Map<String, Object> encode(AircraftState a, String detail, boolean world) {
        return encode(a, encodingFor(detail, world));
    }

    public static Encoding encodingFor(String detail, boolean world) {
        if (world) return Encoding.WORLD;
        return "full".equals(detail) ? Encoding.FULL : Encoding.LITE;
    }

    private static void put(Map<String, Object> m, String k, Object v) {
        if (v != null) m.put(k, v);
    }

    static double round3(double v) {
        return Math.round(v * 1000) / 1000.0;
    }
}
