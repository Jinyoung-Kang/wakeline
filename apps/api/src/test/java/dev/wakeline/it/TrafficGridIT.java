package dev.wakeline.it;

import dev.wakeline.rest.TrafficGridReader;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIf;
import org.springframework.beans.factory.annotation.Autowired;
import tools.jackson.databind.JsonNode;

import java.time.Duration;
import java.time.Instant;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.time.temporal.ChronoUnit;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 연안 교통량 REST(ADR-023) — 수집기 ACL 사용자로 스냅샷을 SET EX(수집기와 같은 명령 · 같은 권한)하고 공개 /traffic/grid 를 본다:
 * 공개 캐시 · ETag → 304 · 요청 제한 헤더, 오래됨(regDt 15분 초과)이면 칸 없음, heartbeat 가 꺼짐을 알리면 disabled, 스냅샷이 없으면 no_data.
 * 기다림은 REST 가 아니라 읽기 빈(5 s 메모)을 본다 — 요청 제한을 쓰지 않게.
 */
@EnabledIf("dev.wakeline.DbTestSupport#dockerAvailable")
class TrafficGridIT extends IntegrationTest {
    @Autowired TrafficGridReader reader;

    boolean status(String s) { return s.equals(reader.read().status()); }
    static final DateTimeFormatter ISO_KST = DateTimeFormatter.ISO_OFFSET_DATE_TIME.withZone(ZoneOffset.ofHours(9));

    /** 수집기 build_payload 와 같은 모양(합성 값). */
    static String snapshot(Instant reg, int vmtc) {
        return ("{\"v\":1,\"reg_dt_kst\":\"%s\",\"reg_dt_utc\":\"%s\",\"fetched_at\":\"%s\",\"total\":3,\"total_count\":3,\"partial\":false,\"rejected\":0,"
                + "\"resolved\":2,\"unresolved\":1,\"pending\":0,\"not_found\":1,\"off_grid\":0,\"cell_deg\":0.025,"
                + "\"cells\":[[\"GR4_F2K41_C3\",37.45,126.6,%d,34.0],[\"GR4_F2K41_D3\",37.425,126.6,102,100.0]]}")
                .formatted(ISO_KST.format(reg), reg, reg.plusSeconds(61), vmtc);
    }

    static void publish(String value) {
        ItStack.collector().opsForValue().set("wakeline:traffic_grid", value, Duration.ofSeconds(1200));
    }

    @Test
    void servesTheSnapshotWithEtagCacheAndRateLimitHeaders() {
        Instant reg = Instant.now().truncatedTo(ChronoUnit.SECONDS).minusSeconds(90);
        try {
            clearHeartbeat();
            publish(snapshot(reg, 12));
            assertThat(ItStack.admin().getExpire("wakeline:traffic_grid")).isBetween(1100L, 1200L);
            await("snapshot visible", Duration.ofSeconds(10), () -> status("ok"));
            Res r = get("/api/v1/traffic/grid");
            assertThat(r.status()).isEqualTo(200);
            assertThat(r.header("Content-Type")).startsWith("application/json");
            assertThat(r.header("Cache-Control")).contains("public").contains("max-age=30");
            assertThat(r.header("X-RateLimit-Limit")).isNotBlank();
            String etag = r.header("ETag");
            assertThat(etag).matches("^\"t[0-9a-f]{16}\"$");
            JsonNode b = r.json();
            assertThat(b.path("available").asBoolean()).isTrue();
            assertThat(b.path("reg_dt_utc").asString()).isEqualTo(reg.toString());
            assertThat(b.path("reg_dt_kst").asString()).endsWith("+09:00");
            assertThat(b.path("cells").size()).isEqualTo(2);
            assertThat(b.path("cells").get(0).get(0).asString()).isEqualTo("GR4_F2K41_C3");
            assertThat(b.path("not_found").asInt()).isEqualTo(1);
            assertThat(b.path("source").path("note").asString()).isEqualTo("5분 집계 — 격자별 선박 척수(개별 위치 아님)");
            assertThat(b.path("meta").path("provider").asString()).isEqualTo("komsa_traffic");

            Res again = get("/api/v1/traffic/grid", headers("If-None-Match", etag));
            assertThat(again.status()).isEqualTo(304);
            assertThat(again.body()).isEmpty();

            // 내용이 바뀌면 ETag 도 바뀐다(메모 5 s 뒤)
            publish(snapshot(reg, 13));
            await("new content", Duration.ofSeconds(10), () -> !etag.equals(reader.read().etag()));
            assertThat(get("/api/v1/traffic/grid", headers("If-None-Match", etag)).status()).isEqualTo(200);

            // 오래된 자료(regDt 15분 초과)는 칸을 싣지 않는다
            publish(snapshot(reg.minusSeconds(1000), 12));
            await("stale", Duration.ofSeconds(10), () -> status("stale"));
            JsonNode stale = get("/api/v1/traffic/grid").json();
            assertThat(stale.path("available").asBoolean()).isFalse();
            assertThat(stale.path("cells").size()).isZero();
            assertThat(stale.path("reg_dt_utc").asString()).isEqualTo(reg.minusSeconds(1000).toString());
        } finally {
            ItStack.deleteKeys("wakeline:traffic_grid");
        }
    }

    @Test
    void disabledCollectorAndMissingSnapshotAreHonestEmptyStates() {
        try {
            ItStack.deleteKeys("wakeline:traffic_grid");
            ItStack.hset(ItStack.collector(), "wakeline:collector", Map.of("traffic_grid_state", "no_key", "traffic_grid_at", Instant.now().toString()));
            await("disabled", Duration.ofSeconds(10), () -> status("disabled"));
            JsonNode d = get("/api/v1/traffic/grid").json();
            assertThat(d.path("disabled_reason").asString()).isEqualTo("no_key");
            assertThat(d.path("available").asBoolean()).isFalse();
            assertThat(d.path("cells").size()).isZero();
            ItStack.hset(ItStack.collector(), "wakeline:collector", Map.of("traffic_grid_state", "active", "traffic_grid_at", Instant.now().toString()));
            await("no data", Duration.ofSeconds(10), () -> status("no_data"));
            JsonNode n = get("/api/v1/traffic/grid").json();
            assertThat(n.has("reg_dt_utc")).as("unknown values have no key (non_null)").isFalse();
            assertThat(n.has("total")).isFalse();
            assertThat(d.has("disabled_reason") && n.has("disabled_reason")).isFalse();
            assertThat(n.path("meta").path("stale").asBoolean()).isTrue();
        } finally {
            clearHeartbeat();
        }
    }

    /** 이 시험이 쓰는 heartbeat 필드만 지운다(다른 필드는 다른 시험의 것). */
    static void clearHeartbeat() {
        ItStack.admin().opsForHash().delete("wakeline:collector", "traffic_grid_state", "traffic_grid_at");
    }
}
