package dev.wakeline.ws;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.annotation.JsonRawValue;
import dev.wakeline.domain.AircraftState;
import dev.wakeline.domain.Alert;
import dev.wakeline.engine.PredictionAvailability;

import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * WS 프로토콜 v1 메시지(설계 9.5절 · 계약서 §1). 필드는 snake_case, null 값인 키는 보내지 않는다(없는 키 = 모름).
 * snapshot/diff 는 세션별 seq(스냅샷마다 1, diff 마다 +1)로 연속성을 판단하고, v(전역 스냅샷 버전)는 참고용이다.
 */
public final class WsMessages {
    private WsMessages() {}

    /** 항공기 인코딩(계약 §1). LITE: 줌 > 5. WORLD: 줌 ≤ 5(좌표 소수 3자리, vrate·quality 제외). FULL: 선택 항공기·REST 상세. */
    public enum Encoding { LITE, WORLD, FULL }

    public record Welcome(String type, String sessionId, Instant serverTime, long snapshotVersion, Map<String, Object> limits) {
        public static Welcome of(String sid, long v, double maxBbox, int diffS, int resyncS, int resyncWorldS, int maxMsgs, int msgWindowS, int helloTimeoutS) {
            Map<String, Object> limits = new LinkedHashMap<>();
            limits.put("max_bbox_area", maxBbox);
            limits.put("diff_interval_s", diffS);
            limits.put("resync_interval_s", resyncS);
            limits.put("resync_world_interval_s", resyncWorldS);
            limits.put("max_client_messages", maxMsgs);
            limits.put("client_message_window_s", msgWindowS);
            limits.put("hello_timeout_s", helloTimeoutS);
            return new Welcome("welcome", sid, Instant.now(), v, limits);
        }
    }

    /**
     * 피드(스코프) 하나의 출처·지연. lag_s = now − fetched_at(수집 이력이 없으면 null), stale = 지연이 임계(지역 60 s · 전세계 300 s)를
     * 넘었거나 수집 이력이 없음. provider 가 없으면 null.
     */
    public record Source(String provider, Instant fetchedAt, Double lagS, boolean stale) {}

    /** global 은 전세계 피드가 없으면 null(키는 남긴다). */
    public record Sources(Source region, @JsonInclude(JsonInclude.Include.ALWAYS) Source global) {}

    /** aircraft 는 이미 직렬화된 JSON 배열(항공기별 인코딩을 버전마다 한 번만 만들어 이어 붙인다, PERF-8). */
    public record SnapshotMsg(String type, int seq, long v, Instant ts, Sources sources, long sigmetsVersion,
                              @JsonRawValue String aircraft) {}

    /** upsert 는 이미 직렬화된 JSON 배열. 비어 있는 diff 는 보내지 않는다(seq 틈이 생기지 않게). */
    public record DiffMsg(String type, int seq, long v, Instant ts, @JsonRawValue String upsert, List<String> remove) {}

    public record AlertsMsg(String type, long version, List<Alert> alerts) {}

    public record AlertItem(String event, Alert alert) {}

    public record AlertsBatchMsg(String type, long version, List<AlertItem> items) {}

    /** state: FULL 인코딩(이미 직렬화된 JSON) 또는 null(스냅샷에 더 이상 없음 — 키는 남긴다). */
    public record SelectedMsg(String type, String hex, @JsonInclude(JsonInclude.Include.ALWAYS) @JsonRawValue String state,
                              PredictionAvailability prediction) {}

    public record ErrorMsg(String type, String code, String title, String detail) {}

    public record Simple(String type) {}

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
