package dev.skywx.ws;

import dev.skywx.domain.AircraftState;

import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** WS 프로토콜 v1 메시지(9.5절). 원시 JSON + 버전 번호(ADR-008). 필드는 snake_case. */
public final class WsMessages {
    private WsMessages() {}

    public record Welcome(String type, String sessionId, Instant serverTime, long snapshotVersion, Map<String, Object> limits) {
        public static Welcome of(String sid, long v, double maxBbox, int diffS, int resyncS) {
            return new Welcome("welcome", sid, Instant.now(), v, Map.of("max_bbox_area", maxBbox, "diff_interval_s", diffS, "resync_interval_s", resyncS));
        }
    }

    public record SnapshotMsg(String type, long v, Instant ts, String scope, String provider, Instant fetchedAt, double lagS, boolean stale,
                              long sigmetsVersion, List<Map<String, Object>> aircraft) {}

    public record DiffMsg(String type, long v, Instant ts, List<Map<String, Object>> upsert, List<String> remove) {}

    public record ErrorMsg(String type, String code, String title, String detail) {}

    public record Simple(String type) {}

    /** lite: 지도 렌더·보간에 필요한 최소 필드. full: 스키마 전체. world(줌 ≤ 5): 소수점 2자리·필드 6개. */
    public static Map<String, Object> encode(AircraftState a, String detail, boolean world) {
        Map<String, Object> m = new LinkedHashMap<>(world ? 6 : 12);
        m.put("hex", a.hex());
        if (world) {
            m.put("lat", Math.round(a.lat() * 100) / 100.0);
            m.put("lon", Math.round(a.lon() * 100) / 100.0);
            m.put("alt_ft", a.altFt());
            m.put("track_deg", a.trackDeg());
            m.put("callsign", a.callsign());
            return m;
        }
        m.put("callsign", a.callsign());
        m.put("lat", a.lat());
        m.put("lon", a.lon());
        m.put("alt_ft", a.altFt());
        m.put("gs_kt", a.gsKt());
        m.put("track_deg", a.trackDeg());
        m.put("vrate_fpm", a.vrateFpm());
        m.put("on_ground", a.onGround());
        m.put("squawk", a.squawk());
        m.put("seen_at", a.seenAt());
        m.put("quality", a.quality());
        if ("full".equals(detail)) {
            m.put("registration", a.registration());
            m.put("type_code", a.typeCode());
            m.put("category", a.category());
            m.put("provider", a.provider());
            m.put("fetched_at", a.fetchedAt());
            m.put("estimated", false);
        }
        return m;
    }
}
