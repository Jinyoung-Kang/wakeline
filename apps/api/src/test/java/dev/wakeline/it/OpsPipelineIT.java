package dev.wakeline.it;

import dev.wakeline.ingest.StreamConsumer;
import dev.wakeline.ingest.StreamMetrics;
import dev.wakeline.ops.OpsUserService;
import io.micrometer.core.instrument.MeterRegistry;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIf;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.data.redis.connection.stream.MapRecord;
import org.springframework.data.redis.connection.stream.RecordId;
import org.springframework.data.redis.connection.stream.StreamInfo;
import org.springframework.data.redis.core.RedisCallback;
import org.springframework.data.redis.core.StringRedisTemplate;
import tools.jackson.databind.JsonNode;

import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicReference;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * R-18(api 부분): 운영자용 데이터 손실 신호 GET /api/v1/ops/pipeline — 수집기 heartbeat(wakeline:collector)·ais 상태 해시(wakeline:ais:status)를
 * 읽기만 하고(두 해시의 스트림 바이트 예산 트림 수 stream_budget_trims 포함 — R-14), api 자신의 드롭·강제 해제·DLQ·스트림 보존 창 손실 수를 싣는다. heartbeat 가 오래됐거나 필드가 없으면 null(모름) — 마지막 값을
 * 지금 값처럼 보이지 않는다. 다른 운영 GET 과 같은 규칙: 익명은 404, 세션이 있으면 CSRF 헤더 없이 GET.
 * 스트림 보존 창: 두 해시의 stream_retention_s(시간 트림 목표 — 수집기 설정)·stream_budget_bytes(바이트 예산)를 그대로 싣고, api 는 30 s 스트림 지표가
 * 읽은 XINFO STREAM first-entry 로 지금 − 첫 엔트리 시각(stream_window_s)을 싣는다 — 예산 트림은 창을 줄일 뿐 손실이 아니다.
 */
@EnabledIf("dev.wakeline.DbTestSupport#dockerAvailable")
class OpsPipelineIT extends IntegrationTest {
    static final String PW = "pipeline-horse-battery-staple";
    static final String COLLECTOR = "wakeline:collector";
    static final String AIS = "wakeline:ais:status";

    @Autowired OpsUserService users;
    @Autowired MeterRegistry meters;
    @Autowired StreamMetrics streamMetrics;
    @org.springframework.boot.test.web.server.LocalManagementPort int managementPort;

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
            for (String f : new String[]{"publish_dropped", "db_dropped", "db_pending", "stream_budget_trims", "stream_retention_s", "stream_budget_bytes",
                    "heartbeat_age_s", "log_sent", "log_dropped"})
                assertThat(none.path("collector").has(f) && none.path("collector").get(f).isNull()).as("collector." + f).isTrue();
            for (String f : new String[]{"dropped_total", "quarantined_total", "stream_budget_trims", "stream_retention_s", "stream_budget_bytes",
                    "log_sent", "log_dropped", "reconnects_quick_total", "loop_lag_max_s", "loop_stalls_total", "queue_wait_max_s", "ws_queue_max",
                    "ws_queue_limit", "ping_rtt_max_s", "ping_timeout_s", "diag_window_s", "queue_depth_max", "queue_limit", "reconnect_quick_window_s",
                    "reconnect_warn_count", "reconnect_warn_window_s", "loop_tick_s", "loop_stall_s", "loop_warn_s", "loop_warn_every_s"})
                assertThat(none.path("ais").has(f) && none.path("ais").get(f).isNull()).as("ais." + f).isTrue();
            JsonNode api = none.path("api");
            for (String f : new String[]{"track_queue_dropped", "ship_queue_dropped", "receipts_force_released", "dlq", "stream_trim_loss_events",
                    "log_sent", "log_dropped", "log_suppressed"})
                assertThat(api.path(f).isIntegralNumber() && api.path(f).asLong() >= 0).as("api." + f).isTrue();
            assertThat(api.has("last_stream_trim_loss")).isTrue();
            JsonNode loss = api.get("last_stream_trim_loss");
            if (!loss.isNull()) assertThat(loss.path("stream").asString()).startsWith("wakeline:");
            // 스트림 보존 창: 두 키가 늘 있고 값은 초(숫자) 또는 모름(null)
            for (String s : new String[]{"aircraft", "ships"}) {
                JsonNode w = api.path("stream_window_s");
                assertThat(w.has(s) && (w.get(s).isNull() || w.get(s).isNumber() && w.get(s).asDouble() >= 0)).as("api.stream_window_s." + s).isTrue();
            }
            assertThat(Instant.parse(none.path("generated_at").asString())).isBeforeOrEqualTo(Instant.now());

            // 최근 heartbeat → 수집기가 센 값 그대로
            Instant now = Instant.now();
            ItStack.hset(col, COLLECTOR, Map.of("region_at", now.toString(), "publish_dropped", "3", "db_dropped", "2", "db_pending", "7",
                    "db_failures", "1", "stream_budget_trims", "5", "log_sent", "12", "log_dropped", "1", "stream_retention_s", "9000",
                    "stream_budget_bytes", "67108864"));
            ItStack.hset(ais, AIS, Map.of("updated_at", now.toString(), "dropped_total", "4", "quarantined_total", "1", "stream_budget_trims", "2",
                    "log_sent", "9", "log_dropped", "0", "stream_retention_s", "9000", "stream_budget_bytes", "33554432"));
            // ais 수신 진단(ADR-014 부록 C): 최근 창 최댓값(초는 소수) · 고른 상한 · 누적 수 — JSON 이름 그대로
            ItStack.hset(ais, AIS, Map.of("loop_lag_max_s", "0.03", "ws_queue_max", "3", "ws_queue_limit", "64", "ping_rtt_max_s", "0.31",
                    "ping_timeout_s", "20", "reconnects_quick_total", "2", "diag_window_s", "60"));
            ItStack.hset(ais, AIS, Map.of("queue_depth_max", "12", "queue_limit", "20000", "reconnect_quick_window_s", "30", "reconnect_warn_count", "3",
                    "reconnect_warn_window_s", "1800", "loop_tick_s", "0.5", "loop_stall_s", "1", "loop_warn_s", "5", "loop_warn_every_s", "60"));
            JsonNode fresh = b.get("/api/v1/ops/pipeline").json();
            assertThat(fresh.path("ais").path("queue_depth_max").asLong()).isEqualTo(12);
            assertThat(fresh.path("ais").path("queue_limit").asLong()).isEqualTo(20000);
            assertThat(fresh.path("ais").path("reconnect_quick_window_s").asDouble()).isEqualTo(30.0);
            assertThat(fresh.path("ais").path("reconnect_warn_count").asLong()).isEqualTo(3);
            assertThat(fresh.path("ais").path("reconnect_warn_window_s").asDouble()).isEqualTo(1800.0);
            assertThat(fresh.path("ais").path("loop_tick_s").asDouble()).isEqualTo(0.5);
            assertThat(fresh.path("ais").path("loop_stall_s").asDouble()).isEqualTo(1.0);
            assertThat(fresh.path("ais").path("loop_warn_s").asDouble()).isEqualTo(5.0);
            assertThat(fresh.path("ais").path("loop_warn_every_s").asDouble()).isEqualTo(60.0);
            assertThat(fresh.path("ais").path("loop_lag_max_s").asDouble()).isEqualTo(0.03);
            assertThat(fresh.path("ais").path("ws_queue_max").asLong()).isEqualTo(3);
            assertThat(fresh.path("ais").path("ws_queue_limit").asLong()).isEqualTo(64);
            assertThat(fresh.path("ais").path("ping_rtt_max_s").asDouble()).isEqualTo(0.31);
            assertThat(fresh.path("ais").path("ping_timeout_s").asDouble()).isEqualTo(20.0);
            assertThat(fresh.path("ais").path("reconnects_quick_total").asLong()).isEqualTo(2);
            assertThat(fresh.path("ais").path("diag_window_s").asDouble()).isEqualTo(60.0);
            assertThat(fresh.path("ais").get("queue_wait_max_s").isNull()).as("not written → unknown").isTrue();
            assertThat(fresh.path("collector").path("publish_dropped").asLong()).isEqualTo(3);
            assertThat(fresh.path("collector").path("db_dropped").asLong()).isEqualTo(2);
            assertThat(fresh.path("collector").path("db_pending").asLong()).isEqualTo(7);
            assertThat(fresh.path("collector").path("heartbeat_age_s").asDouble()).isBetween(0.0, 30.0);
            assertThat(fresh.path("ais").path("dropped_total").asLong()).isEqualTo(4);
            assertThat(fresh.path("ais").path("quarantined_total").asLong()).isEqualTo(1);
            // R-14: 바이트 예산 때문에 보존 창(2.5 h)보다 일찍 자른 XADD 수 — 수집기(항공기 스트림)·ais(선박 스트림)가 센 값 그대로
            assertThat(fresh.path("collector").path("stream_budget_trims").asLong()).isEqualTo(5);
            assertThat(fresh.path("ais").path("stream_budget_trims").asLong()).isEqualTo(2);
            // 스트림 보존 창의 목표(시간 트림, 수집기 설정)와 바이트 예산 — 해시의 값 그대로
            assertThat(fresh.path("collector").path("stream_retention_s").asLong()).isEqualTo(9000);
            assertThat(fresh.path("collector").path("stream_budget_bytes").asLong()).isEqualTo(67_108_864L);
            assertThat(fresh.path("ais").path("stream_retention_s").asLong()).isEqualTo(9000);
            assertThat(fresh.path("ais").path("stream_budget_bytes").asLong()).isEqualTo(33_554_432L);
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
            col.opsForHash().put(COLLECTOR, "stream_retention_s", "2.5h");
            ais.opsForHash().put(AIS, "stream_budget_bytes", "-1");
            JsonNode bad = b.get("/api/v1/ops/pipeline").json();
            assertThat(bad.path("collector").get("db_pending").isNull()).isTrue();
            assertThat(bad.path("collector").get("db_dropped").isNull()).isTrue();
            assertThat(bad.path("collector").path("publish_dropped").asLong()).isEqualTo(3);
            assertThat(bad.path("collector").get("stream_budget_trims").isNull()).isTrue();
            assertThat(bad.path("ais").get("stream_budget_trims").isNull()).isTrue();
            assertThat(bad.path("ais").path("dropped_total").asLong()).isEqualTo(4);
            assertThat(bad.path("collector").get("stream_retention_s").isNull()).isTrue();
            assertThat(bad.path("collector").path("stream_budget_bytes").asLong()).isEqualTo(67_108_864L);
            assertThat(bad.path("ais").get("stream_budget_bytes").isNull()).isTrue();
            assertThat(bad.path("ais").path("stream_retention_s").asLong()).isEqualTo(9000);
            ais.opsForHash().put(AIS, "stream_budget_trims", "2");
            col.opsForHash().put(COLLECTOR, "stream_retention_s", "9000");
            ais.opsForHash().put(AIS, "stream_budget_bytes", "33554432");

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
            for (String f : new String[]{"log_sent", "log_dropped", "stream_retention_s", "stream_budget_bytes"}) {
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

    // ---------- 스트림 보존 창(api.stream_window_s · wakeline_stream_window_seconds) ----------

    static final Duration WAIT = Duration.ofSeconds(15);

    /** 스트림의 마지막 id 보다 큰, 이 시험이 고른 id 의 ms(지금 이상). */
    static long nextIdMs(String stream) {
        long lastMs = 0;
        try {
            StreamInfo.XInfoStream info = ItStack.admin().opsForStream().info(stream);
            String last = info == null ? null : info.lastGeneratedId();
            if (last != null) lastMs = Long.parseLong(last.split("-")[0]);
        } catch (RuntimeException e) {
            // 스트림이 아직 없다 — 지금으로
        }
        return Math.max(System.currentTimeMillis(), lastMs + 1);
    }

    static long pending(String stream) {
        var p = ItStack.admin().opsForStream().pending(stream, StreamConsumer.GROUP);
        return p == null ? 0 : p.getTotalPendingMessages();
    }

    /** 관리자 계정으로 XTRIM(정확히) — MINID id 또는 MAXLEN n. */
    static void xtrim(String stream, String strategy, String threshold) {
        ItStack.admin().execute((RedisCallback<Object>) c -> c.execute("XTRIM", bytes(stream), bytes(strategy), bytes(threshold)));
    }

    static byte[] bytes(String s) { return s.getBytes(StandardCharsets.UTF_8); }

    /** 스트림 지표를 다시 읽고 GET 한다 — 창이 조건을 만족할 때까지(동시에 돈 예약 측정이 트림 전 값을 덮어쓸 수 있어 몇 번 되풀이). */
    JsonNode windowAfterRefresh(OpsBrowser b, java.util.function.Predicate<JsonNode> ok, long[] around) {
        AtomicReference<JsonNode> last = new AtomicReference<>();
        await("stream window sampled", WAIT, () -> {
            streamMetrics.refresh();
            long before = System.currentTimeMillis();
            JsonNode w = b.get("/api/v1/ops/pipeline").json().path("api").path("stream_window_s");
            long after = System.currentTimeMillis();
            last.set(w);
            around[0] = before;
            around[1] = after;
            return ok.test(w);
        });
        return last.get();
    }

    /**
     * 창 = 요청 시각 − 첫 엔트리 id 의 ms(XINFO STREAM first-entry, 30 s 측정). 시험이 고른 id 로 항공기·선박 스트림에 한 건씩 싣고, 읽혀
     * ACK 된 뒤 그보다 앞의 엔트리를 지운다(MINID) → 첫 엔트리가 그 id 다. 측정 없이 1.2 s 뒤 다시 GET 하면 창이 그만큼 자란다 — 측정 시각에
     * 계산하는 구현은 그대로다. 빈 스트림은 모름(null). 없는 스트림·Redis 오류는 단위 시험(StreamWindowTest).
     */
    @Test
    void streamWindowIsRequestTimeMinusTheFirstEntryIdOfTheAircraftAndShipsStreams() throws Exception {
        OpsBrowser b = login();
        long aMs = nextIdMs(Streams.AIRCRAFT);
        Instant fa = Streams.nextFetchedAt();
        RecordId aId = ItStack.collector().opsForStream().add(MapRecord.create(Streams.AIRCRAFT, new HashMap<>(Streams.aircraft("region", fa,
                List.of(Streams.state("a7e0f1", 39.9, 131.9, 35000, fa, fa))))).withId(RecordId.of(aMs, 0)));
        long sMs = nextIdMs(Streams.SHIPS);
        Instant fs = Streams.nextFetchedAt();
        RecordId sId = ItStack.ais().opsForStream().add(MapRecord.create(Streams.SHIPS, new HashMap<>(Streams.ships(fs,
                List.of(Streams.shipState("440790001", 0.5, 170.0, fs)), List.of()))).withId(RecordId.of(sMs, 0)));
        assertThat(aId.getValue()).isEqualTo(aMs + "-0");
        assertThat(sId.getValue()).isEqualTo(sMs + "-0");
        // 읽고 저장(ACK)까지 끝난 뒤에만 앞을 지운다 — 읽지 않은 엔트리를 지우면 손실(R-14)이 된다
        await("entries consumed and acknowledged", WAIT, () ->
                StreamTrimLossIT.StreamConsumerIds.compare(StreamTrimLossIT.lastDelivered(Streams.AIRCRAFT), aId.getValue()) >= 0
                        && StreamTrimLossIT.StreamConsumerIds.compare(StreamTrimLossIT.lastDelivered(Streams.SHIPS), sId.getValue()) >= 0
                        && pending(Streams.AIRCRAFT) == 0 && pending(Streams.SHIPS) == 0);
        xtrim(Streams.AIRCRAFT, "MINID", aId.getValue());
        xtrim(Streams.SHIPS, "MINID", sId.getValue());
        assertThat(ItStack.admin().opsForStream().info(Streams.AIRCRAFT).firstEntryId()).isEqualTo(aId.getValue());
        assertThat(ItStack.admin().opsForStream().info(Streams.SHIPS).firstEntryId()).isEqualTo(sId.getValue());

        long[] t = new long[2];
        JsonNode w = windowAfterRefresh(b, x -> x.path("aircraft").isNumber() && x.path("ships").isNumber()
                && x.path("aircraft").asDouble() <= (System.currentTimeMillis() - aMs) / 1000.0 + 0.05
                && x.path("ships").asDouble() <= (System.currentTimeMillis() - sMs) / 1000.0 + 0.05, t);
        assertThat(w.path("aircraft").asDouble()).as("aircraft window = request time − first entry id ms")
                .isBetween((t[0] - aMs) / 1000.0 - 0.05, (t[1] - aMs) / 1000.0 + 0.05);
        assertThat(w.path("ships").asDouble()).as("ships window = request time − first entry id ms")
                .isBetween((t[0] - sMs) / 1000.0 - 0.05, (t[1] - sMs) / 1000.0 + 0.05);

        // 창은 요청 시각에 계산된다: 측정(refresh) 없이 1.2 s 뒤 다시 GET → 그 사이 시간만큼 자란다(측정 시각 계산이면 0).
        // 두 값 모두 0.1 s 반올림이라 ±0.1 s. 예약 측정(30 s)이 사이에 돌아도 첫 엔트리는 그대로라 결과는 같다.
        Thread.sleep(1_200);
        long u0 = System.currentTimeMillis();
        JsonNode later = b.get("/api/v1/ops/pipeline").json().path("api").path("stream_window_s");
        long u1 = System.currentTimeMillis();
        for (String k : new String[]{"aircraft", "ships"})
            assertThat(later.path(k).asDouble() - w.path(k).asDouble()).as(k + " window grows with request time, no new sample")
                    .isBetween((u0 - t[1]) / 1000.0 - 0.1, (u1 - t[0]) / 1000.0 + 0.1).isGreaterThanOrEqualTo(1.1);

        // Prometheus 게이지도 같은 값(스크레이프 시각 기준)
        long g0 = System.currentTimeMillis();
        double gauge = meters.get("wakeline_stream_window_seconds").tag("stream", Streams.AIRCRAFT).gauge().value();
        long g1 = System.currentTimeMillis();
        assertThat(gauge).isBetween((g0 - aMs) / 1000.0 - 0.05, (g1 - aMs) / 1000.0 + 0.05);
        var prom = HTTP.send(java.net.http.HttpRequest.newBuilder(java.net.URI.create("http://127.0.0.1:" + managementPort + "/actuator/prometheus")).build(),
                java.net.http.HttpResponse.BodyHandlers.ofString());
        assertThat(prom.body()).contains("wakeline_stream_window_seconds{stream=\"wakeline:aircraft\"}")
                .contains("wakeline_stream_window_seconds{stream=\"wakeline:ships\"}");

        // 빈 스트림(모두 읽고 지움) → 첫 엔트리가 없다 = 모름(null). 0 으로 채우지 않는다
        xtrim(Streams.SHIPS, "MAXLEN", "0");
        JsonNode empty = windowAfterRefresh(b, x -> x.path("ships").isNull(), t);
        assertThat(empty.has("ships") && empty.get("ships").isNull()).isTrue();
        assertThat(empty.path("aircraft").asDouble()).isBetween((t[0] - aMs) / 1000.0 - 0.05, (t[1] - aMs) / 1000.0 + 0.05);
        assertThat(meters.get("wakeline_stream_window_seconds").tag("stream", Streams.SHIPS).gauge().value()).isNaN();
    }
}
