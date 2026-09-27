package dev.wakeline.it;

import org.springframework.data.redis.connection.stream.MapRecord;
import org.springframework.data.redis.connection.stream.RecordId;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.json.JsonMapper;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.Base64;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicLong;
import java.util.zip.GZIPOutputStream;

/**
 * 수집기가 발행하는 것과 같은 모양의 스트림 엔트리(스키마 stream_envelope.v1 + gzip+base64 payload)를 만든다.
 * fetched_at 은 JVM 안에서 엄격히 증가한다 — api 는 스코프별로 더 새 fetched_at 만 실시간 상태에 반영한다(REL-8).
 */
final class Streams {
    static final String AIRCRAFT = "wakeline:aircraft";
    static final String SIGMET = "wakeline:sigmet";
    static final String RADAR = "wakeline:radar";
    static final String DLQ = "wakeline:dlq";
    static final ObjectMapper JSON = JsonMapper.builder().build();
    private static final AtomicLong clock = new AtomicLong();

    private Streams() {}

    /** 지금(ms) 이상이면서 직전 값보다 큰 시각. */
    static Instant nextFetchedAt() {
        long now = System.currentTimeMillis();
        return Instant.ofEpochMilli(clock.updateAndGet(prev -> Math.max(prev + 1, now)));
    }

    static Map<String, String> envelope(String kind, String scope, String provider, Instant fetchedAt, Object payload, int count) {
        Map<String, String> f = new LinkedHashMap<>();
        f.put("schema_version", "1");
        f.put("kind", kind);
        f.put("scope", scope);
        f.put("provider", provider);
        f.put("fetched_at", fetchedAt.toString());
        f.put("raw_ref", "fixture:it");
        f.put("encoding", "gzip+base64");
        f.put("count", String.valueOf(count));
        f.put("run_id", "it");
        f.put("payload", gz64(payload instanceof String s ? s : JSON.writeValueAsString(payload)));
        return f;
    }

    /** 항공기 상태 1건(스키마 aircraft_state.v1). 값이 없는 필드는 싣지 않는다. */
    static Map<String, Object> state(String hex, double lat, double lon, Integer altFt, Instant seenAt, Instant fetchedAt) {
        Map<String, Object> s = new LinkedHashMap<>();
        s.put("hex", hex);
        s.put("callsign", "IT" + hex.substring(2).toUpperCase());
        s.put("registration", "HL" + hex.substring(3).toUpperCase());
        s.put("type_code", "A21N");
        s.put("lat", lat);
        s.put("lon", lon);
        s.put("alt_ft", altFt);
        s.put("gs_kt", 450.0);
        s.put("track_deg", 90.0);
        s.put("vrate_fpm", 0.0);
        s.put("on_ground", false);
        s.put("squawk", "1200");
        s.put("seen_at", seenAt.toString());
        s.put("provider", "fixture");
        s.put("fetched_at", fetchedAt.toString());
        s.put("quality", 0);
        s.put("estimated", false);
        return s;
    }

    static Map<String, String> aircraft(String scope, Instant fetchedAt, List<Map<String, Object>> states) {
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("region", Map.of("lat", 36.5, "lon", 127.8, "radius_nm", 250));
        payload.put("states", states);
        return envelope("aircraft", scope, "fixture", fetchedAt, payload, states.size());
    }

    /** 관측 판정용 SIGMET: 사각형 [lon0,lat0]–[lon1,lat1], 고도대 base–top(ft), 지금 유효. */
    static Map<String, Object> sigmet(String id, double lon0, double lat0, double lon1, double lat1, int baseFt, int topFt, Instant fetchedAt) {
        Map<String, Object> s = new LinkedHashMap<>();
        s.put("id", id);
        s.put("fir_id", "RKRR");
        s.put("fir_name", "INCHEON FIR");
        s.put("issuer", "RKSI");
        s.put("series_id", "IT" + Math.abs(id.hashCode() % 100));
        s.put("hazard", "TS");
        s.put("qualifier", "EMBD");
        s.put("base_ft", baseFt);
        s.put("base_source", "json");
        s.put("top_ft", topFt);
        s.put("top_source", "json");
        s.put("valid_from", fetchedAt.minusSeconds(600).toString());
        s.put("valid_to", fetchedAt.plusSeconds(7200).toString());
        s.put("geometry", Map.of("type", "MultiPolygon", "coordinates",
                List.of(List.of(List.of(List.of(lon0, lat0), List.of(lon1, lat0), List.of(lon1, lat1), List.of(lon0, lat1), List.of(lon0, lat0))))));
        s.put("raw_text", "RKRR SIGMET " + id + " VALID EMBD TS OBS");
        s.put("provider", "fixture");
        s.put("fetched_at", fetchedAt.toString());
        return s;
    }

    static Map<String, String> sigmets(Instant fetchedAt, List<Map<String, Object>> sigmets) {
        return envelope("sigmet", "-", "fixture", fetchedAt, Map.of("sigmets", sigmets), sigmets.size());
    }

    static Map<String, String> radar(Instant fetchedAt, long generated) {
        Map<String, Object> p = new LinkedHashMap<>();
        p.put("host", "https://tilecache.rainviewer.com");
        p.put("generated", generated);
        p.put("past", List.of(Map.of("time", generated - 600, "path", "/v2/radar/" + (generated - 600)), Map.of("time", generated, "path", "/v2/radar/" + generated)));
        return envelope("radar", "-", "fixture", fetchedAt, p, 2);
    }

    /** 수집기 ACL 사용자로 XADD. @return 엔트리 id */
    static String xadd(String stream, Map<String, String> fields) {
        RecordId id = ItStack.collector().opsForStream().add(MapRecord.create(stream, new HashMap<>(fields)));
        if (id == null) throw new IllegalStateException("XADD returned null");
        return id.getValue();
    }

    static String gz64(String json) {
        try {
            var bos = new ByteArrayOutputStream();
            try (var g = new GZIPOutputStream(bos)) { g.write(json.getBytes(StandardCharsets.UTF_8)); }
            return Base64.getEncoder().encodeToString(bos.toByteArray());
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }
}
