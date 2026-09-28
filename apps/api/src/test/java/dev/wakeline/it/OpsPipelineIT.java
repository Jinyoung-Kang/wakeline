package dev.wakeline.it;

import dev.wakeline.ops.OpsUserService;
import io.micrometer.core.instrument.MeterRegistry;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIf;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.data.redis.core.StringRedisTemplate;
import tools.jackson.databind.JsonNode;

import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * R-18(api 부분): 운영자용 데이터 손실 신호 GET /api/v1/ops/pipeline — 수집기 heartbeat(wakeline:collector)·ais 상태 해시(wakeline:ais:status)를
 * 읽기만 하고(두 해시의 스트림 바이트 예산 트림 수 stream_budget_trims 포함 — R-14), api 자신의 드롭·강제 해제·DLQ·스트림 보존 창 손실 수를 싣는다. heartbeat 가 오래됐거나 필드가 없으면 null(모름) — 마지막 값을
 * 지금 값처럼 보이지 않는다. 다른 운영 GET 과 같은 규칙: 익명은 404, 세션이 있으면 CSRF 헤더 없이 GET.
 */
@EnabledIf("dev.wakeline.DbTestSupport#dockerAvailable")
class OpsPipelineIT extends IntegrationTest {
    static final String PW = "pipeline-horse-battery-staple";
    static final String COLLECTOR = "wakeline:collector";
    static final String AIS = "wakeline:ais:status";

    @Autowired OpsUserService users;
    @Autowired MeterRegistry meters;

    /** 로그인한 운영자(쿠키만 — GET 에는 CSRF 헤더가 필요 없다). */
    OpsBrowser login() { return OpsBrowser.login(this, users, "it-pipeline", PW); }

    static Map<Object, Object> snapshot(String key) { return new LinkedHashMap<>(ItStack.admin().opsForHash().entries(key)); }

    static void restore(String key, Map<Object, Object> before) {
        ItStack.admin().delete(key);
        if (!before.isEmpty()) ItStack.admin().opsForHash().putAll(key, before);
    }

    @Test
    void anonymousIs404() {
        assertProblem(get("/api/v1/ops/pipeline"), 404, "NOT_FOUND", "/api/v1/ops/pipeline");
    }

    @Test
    void reportsCollectorAisAndApiLossSignalsWithNullForUnknown() {
        OpsBrowser b = login();
        Map<Object, Object> collectorBefore = snapshot(COLLECTOR), aisBefore = snapshot(AIS);
        StringRedisTemplate col = ItStack.collector(), ais = ItStack.ais();
        try {
            // 수집기·ais 가 아무것도 쓰지 않았다 → 모두 모름(null) — 0 으로 채우지 않는다
            ItStack.admin().delete(COLLECTOR);
            ItStack.admin().delete(AIS);
            JsonNode none = b.get("/api/v1/ops/pipeline").json();
            for (String f : new String[]{"publish_dropped", "db_dropped", "db_pending", "stream_budget_trims", "heartbeat_age_s", "log_sent", "log_dropped"})
                assertThat(none.path("collector").has(f) && none.path("collector").get(f).isNull()).as("collector." + f).isTrue();
            for (String f : new String[]{"dropped_total", "quarantined_total", "stream_budget_trims", "log_sent", "log_dropped"})
                assertThat(none.path("ais").has(f) && none.path("ais").get(f).isNull()).as("ais." + f).isTrue();
            JsonNode api = none.path("api");
            for (String f : new String[]{"track_queue_dropped", "ship_queue_dropped", "receipts_force_released", "dlq", "stream_trim_loss_events",
                    "log_sent", "log_dropped", "log_suppressed"})
                assertThat(api.path(f).isIntegralNumber() && api.path(f).asLong() >= 0).as("api." + f).isTrue();
            assertThat(api.has("last_stream_trim_loss")).isTrue();
            JsonNode loss = api.get("last_stream_trim_loss");
            if (!loss.isNull()) assertThat(loss.path("stream").asString()).startsWith("wakeline:");
            assertThat(Instant.parse(none.path("generated_at").asString())).isBeforeOrEqualTo(Instant.now());

            // 최근 heartbeat → 수집기가 센 값 그대로
            Instant now = Instant.now();
            ItStack.hset(col, COLLECTOR, Map.of("region_at", now.toString(), "publish_dropped", "3", "db_dropped", "2", "db_pending", "7",
                    "db_failures", "1", "stream_budget_trims", "5", "log_sent", "12", "log_dropped", "1"));
            ItStack.hset(ais, AIS, Map.of("updated_at", now.toString(), "dropped_total", "4", "quarantined_total", "1", "stream_budget_trims", "2",
                    "log_sent", "9", "log_dropped", "0"));
            JsonNode fresh = b.get("/api/v1/ops/pipeline").json();
            assertThat(fresh.path("collector").path("publish_dropped").asLong()).isEqualTo(3);
            assertThat(fresh.path("collector").path("db_dropped").asLong()).isEqualTo(2);
            assertThat(fresh.path("collector").path("db_pending").asLong()).isEqualTo(7);
            assertThat(fresh.path("collector").path("heartbeat_age_s").asDouble()).isBetween(0.0, 30.0);
            assertThat(fresh.path("ais").path("dropped_total").asLong()).isEqualTo(4);
            assertThat(fresh.path("ais").path("quarantined_total").asLong()).isEqualTo(1);
            // R-14: 바이트 예산 때문에 보존 창(2.5 h)보다 일찍 자른 XADD 수 — 수집기(항공기 스트림)·ais(선박 스트림)가 센 값 그대로
            assertThat(fresh.path("collector").path("stream_budget_trims").asLong()).isEqualTo(5);
            assertThat(fresh.path("ais").path("stream_budget_trims").asLong()).isEqualTo(2);
            // 계약 v5 §C2: 시스템 로그 싱크의 자기 지표 — 수집기·ais 가 heartbeat/상태 해시에 센 값 그대로
            assertThat(fresh.path("collector").path("log_sent").asLong()).isEqualTo(12);
            assertThat(fresh.path("collector").path("log_dropped").asLong()).isEqualTo(1);
            assertThat(fresh.path("ais").path("log_sent").asLong()).isEqualTo(9);
            assertThat(fresh.path("ais").path("log_dropped").asLong()).isEqualTo(0);

            // 형식이 틀린 값은 모름
            col.opsForHash().put(COLLECTOR, "db_pending", "-1");
            col.opsForHash().put(COLLECTOR, "db_dropped", "many");
            col.opsForHash().put(COLLECTOR, "stream_budget_trims", "");
            ais.opsForHash().put(AIS, "stream_budget_trims", "1.5");
            JsonNode bad = b.get("/api/v1/ops/pipeline").json();
            assertThat(bad.path("collector").get("db_pending").isNull()).isTrue();
            assertThat(bad.path("collector").get("db_dropped").isNull()).isTrue();
            assertThat(bad.path("collector").path("publish_dropped").asLong()).isEqualTo(3);
            assertThat(bad.path("collector").get("stream_budget_trims").isNull()).isTrue();
            assertThat(bad.path("ais").get("stream_budget_trims").isNull()).isTrue();
            assertThat(bad.path("ais").path("dropped_total").asLong()).isEqualTo(4);
            ais.opsForHash().put(AIS, "stream_budget_trims", "2");

            // 오래된 heartbeat(수집기·ais 멈춤) → 마지막 값은 지금 값이 아니다(null), 나이는 그대로 보인다
            Instant old = now.minusSeconds(600);
            col.opsForHash().put(COLLECTOR, "region_at", old.toString());
            ais.opsForHash().put(AIS, "updated_at", old.toString());
            JsonNode stale = b.get("/api/v1/ops/pipeline").json();
            assertThat(stale.path("collector").get("publish_dropped").isNull()).isTrue();
            assertThat(stale.path("collector").path("heartbeat_age_s").asDouble()).isBetween(590.0, 660.0);
            assertThat(stale.path("ais").get("dropped_total").isNull()).isTrue();
            assertThat(stale.path("ais").get("quarantined_total").isNull()).isTrue();
            assertThat(stale.path("collector").get("stream_budget_trims").isNull()).isTrue();
            assertThat(stale.path("ais").get("stream_budget_trims").isNull()).isTrue();
            for (String f : new String[]{"log_sent", "log_dropped"}) {
                assertThat(stale.path("collector").get(f).isNull()).as("stale collector." + f).isTrue();
                assertThat(stale.path("ais").get(f).isNull()).as("stale ais." + f).isTrue();
            }

            // api 자신의 지표(이 프로세스 기동 뒤 누계)
            long dropped = fresh.path("api").path("track_queue_dropped").asLong();
            meters.counter("wakeline_track_rows_total", "result", "dropped").increment(5);
            assertThat(b.get("/api/v1/ops/pipeline").json().path("api").path("track_queue_dropped").asLong()).isEqualTo(dropped + 5);

            // 영구 손실(재시도하지 않고 버린 행 · 처리 중 예외로 건너뛴 메시지 · 리스너 오류)도 같은 화면에서 보인다(R-18 후속)
            JsonNode before = b.get("/api/v1/ops/pipeline").json().path("api");
            for (String f : new String[]{"track_rows_failed", "ship_rows_failed", "stream_apply_errors", "listener_errors"})
                assertThat(before.path(f).isIntegralNumber()).as("api." + f).isTrue();
            meters.counter("wakeline_track_rows_total", "result", "failed").increment(2);
            meters.counter("wakeline_ship_rows_total", "result", "failed").increment(3);
            meters.counter("wakeline_stream_messages_total", "result", "apply_error").increment(4);
            meters.counter("wakeline_event_listener_errors_total", "event", "it", "listener", "it").increment(6);
            JsonNode after = b.get("/api/v1/ops/pipeline").json().path("api");
            assertThat(after.path("track_rows_failed").asLong()).isEqualTo(before.path("track_rows_failed").asLong() + 2);
            assertThat(after.path("ship_rows_failed").asLong()).isEqualTo(before.path("ship_rows_failed").asLong() + 3);
            assertThat(after.path("stream_apply_errors").asLong()).isEqualTo(before.path("stream_apply_errors").asLong() + 4);
            assertThat(after.path("listener_errors").asLong()).isEqualTo(before.path("listener_errors").asLong() + 6);

            // 계약 v5 §C2: api 자신의 로그 싱크 지표(wakeline_log_events_total{result}) — 싣지 못하고 버린 것 · 억제한 것도 보인다
            meters.counter("wakeline_log_events_total", "result", "dropped").increment(7);
            meters.counter("wakeline_log_events_total", "result", "suppressed").increment(3);
            JsonNode logs = b.get("/api/v1/ops/pipeline").json().path("api");
            assertThat(logs.path("log_dropped").asLong()).isEqualTo(after.path("log_dropped").asLong() + 7);
            assertThat(logs.path("log_suppressed").asLong()).isEqualTo(after.path("log_suppressed").asLong() + 3);
            assertThat(logs.path("log_sent").asLong()).isGreaterThanOrEqualTo(after.path("log_sent").asLong());
        } finally {
            restore(COLLECTOR, collectorBefore);
            restore(AIS, aisBefore);
        }
    }
}
