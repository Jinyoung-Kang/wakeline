package dev.wakeline.it;

import dev.wakeline.ws.WsHub;
import io.micrometer.core.instrument.MeterRegistry;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIf;
import org.springframework.beans.factory.annotation.Autowired;
import tools.jackson.databind.JsonNode;

import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * R-72: 수집기가 쓰는 wakeline:radar_kr:meta 해시 — 공개 /status 는 검증한 필드만 싣고(원본 해시를 통째로 내보내지 않는다), /radar/kr 는
 * 형식이 틀린 값에 500 대신 '쓸 수 없음'(모르는 값은 null)으로 답하고 센다.
 */
@EnabledIf("dev.wakeline.DbTestSupport#dockerAvailable")
class RadarKrIT extends IntegrationTest {
    static final String PNG_1X1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

    @Autowired WsHub hub;
    @Autowired MeterRegistry meters;

    static Map<String, String> meta(String now, String live) {
        return Map.ofEntries(Map.entry("available", "1"), Map.entry("status", "200"), Map.entry("note", "internal note"), Map.entry("latest_tm", live),
                Map.entry("product", "HSR"), Map.entry("cmp", "HSR"), Map.entry("coordinates", "[[121.8,39.9],[132.9,39.9],[132.9,31.6],[121.8,31.6]]"),
                Map.entry("width", "640"), Map.entry("height", "480"), Map.entry("projection", "EPSG:3857"), Map.entry("grid", "{\"nx\":2305,\"ny\":2881}"),
                Map.entry("legend", "[{\"dbz\":10,\"color\":\"#00c8ff\"}]"), Map.entry("min_dbz", "0.5"), Map.entry("stations", "KSN,GDK"),
                Map.entry("observed_cells", "1234"), Map.entry("fetched_at", now), Map.entry("checked_at", now), Map.entry("secret_like", "should-not-leak"));
    }

    @Test
    void publicStatusCarriesOnlyValidatedRadarFields() {
        String now = Instant.now().toString(), live = "202609281210";
        try {
            ItStack.hset(ItStack.collector(), "wakeline:radar_kr:meta", meta(now, live));
            await("status cache refreshed", Duration.ofSeconds(10), () -> hub.status().get("radar_kr") instanceof Map<?, ?> m && live.equals(m.get("latest_tm")));
            JsonNode kr = get("/api/v1/status").json().path("radar_kr");
            List<String> keys = new ArrayList<>();
            kr.propertyNames().forEach(keys::add);
            assertThat(keys).containsExactlyInAnyOrder("available", "status", "latest_tm", "fetched_at", "checked_at");
            assertThat(kr.path("available").isBoolean() && kr.path("available").asBoolean()).isTrue();
            assertThat(kr.path("status").asString()).isEqualTo("200");
            assertThat(kr.toString()).doesNotContain("should-not-leak").doesNotContain("internal note").doesNotContain("observed_cells");

            // 틀린 값은 모름(키 없음)
            ItStack.hset(ItStack.collector(), "wakeline:radar_kr:meta", Map.of("available", "yes", "latest_tm", "12:10", "fetched_at", "yesterday", "status", "OK!"));
            await("status cache refreshed", Duration.ofSeconds(10), () -> hub.status().get("radar_kr") instanceof Map<?, ?> m && !m.containsKey("latest_tm"));
            JsonNode bad = get("/api/v1/status").json().path("radar_kr");
            assertThat(bad.has("available")).isFalse();
            assertThat(bad.has("fetched_at")).isFalse();
            assertThat(bad.has("status")).isFalse();
        } finally {
            ItStack.deleteKeys("wakeline:radar_kr:*");
        }
    }

    double parseErrors() {
        return meters.find("wakeline_radar_kr_parse_errors_total").counters().stream().mapToDouble(io.micrometer.core.instrument.Counter::count).sum();
    }

    @Test
    void malformedCollectorValuesMakeTheKmaRadarUnavailableInsteadOf500() {
        String now = Instant.now().toString(), live = "202609281220";
        double before = parseErrors();
        try {
            ItStack.collector().opsForValue().set("wakeline:radar_kr:frame:" + live, PNG_1X1);
            ItStack.collector().opsForValue().set("wakeline:radar_kr:frames",
                    "[{\"tm\":\"%s\",\"obs_tm\":\"%s\",\"fetched_at\":\"%s\",\"echo_cells\":12}]".formatted(live, live, now));
            Map<String, String> m = new java.util.HashMap<>(meta(now, live));
            m.put("width", "six-hundred");         // Integer.parseInt 이 던졌다
            m.put("coordinates", "[[121.8,39.9],"); // readTree 가 던졌다
            m.put("fetched_at", "yesterday");       // Instant.parse 가 던졌다
            ItStack.hset(ItStack.collector(), "wakeline:radar_kr:meta", m);
            Res r = get("/api/v1/radar/kr");
            assertThat(r.status()).as(r.body()).isEqualTo(200);
            JsonNode body = r.json();
            assertThat(body.path("available").asBoolean(true)).as("cannot be placed on the map without coordinates and size").isFalse();
            assertThat(body.path("georeferenced").asBoolean(true)).isFalse();
            assertThat(body.has("image_size")).isFalse();
            assertThat(body.has("coordinates")).isFalse();
            assertThat(body.path("meta").has("fetched_at")).isFalse();
            assertThat(parseErrors()).isGreaterThanOrEqualTo(before + 3);

            // 목록 자체가 JSON 이 아니어도 500 이 아니다
            ItStack.collector().opsForValue().set("wakeline:radar_kr:frames", "{not json");
            Res broken = get("/api/v1/radar/kr");
            assertThat(broken.status()).isEqualTo(200);
            assertThat(broken.json().path("frames").size()).isZero();
            assertThat(broken.json().path("available").asBoolean(true)).isFalse();
        } finally {
            ItStack.deleteKeys("wakeline:radar_kr:*");
        }
    }
}
