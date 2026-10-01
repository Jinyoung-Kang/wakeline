package dev.wakeline.ops;

import dev.wakeline.ingest.StreamConsumer;
import dev.wakeline.ingest.StreamMetrics;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.support.StaticListableBeanFactory;
import org.springframework.data.redis.core.HashOperations;
import org.springframework.data.redis.core.StringRedisTemplate;

import java.time.Instant;
import java.util.HashMap;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * ops/pipeline 의 스트림 보존 창 필드: 수집기·ais 해시의 stream_retention_s(시간 트림 목표 — 수집기 설정)·stream_budget_bytes(바이트 예산)를
 * 그대로 싣고(같은 신선도 규칙), api.stream_window_s 는 30 s 스트림 지표의 첫 엔트리 시각으로 요청 시각에 계산한다. 모르면 null.
 */
class OpsPipelineControllerTest {
    static final Instant NOW = Instant.parse("2026-09-29T06:00:00Z");
    final Map<Object, Object> collector = new HashMap<>();
    final Map<Object, Object> ais = new HashMap<>();

    @SuppressWarnings("unchecked")
    StringRedisTemplate redis() {
        HashOperations<String, Object, Object> hash = mock(HashOperations.class);
        when(hash.entries("wakeline:collector")).thenReturn(collector);
        when(hash.entries("wakeline:ais:status")).thenReturn(ais);
        return new StringRedisTemplate() {
            @Override public <HK, HV> HashOperations<String, HK, HV> opsForHash() { return (HashOperations<String, HK, HV>) (HashOperations<?, ?, ?>) hash; }
        };
    }

    /** 첫 엔트리 시각을 정해 둔 지표(항공기 1.7 h 전, 선박은 모름). */
    static StreamMetrics metrics() {
        return new StreamMetrics(null, new SimpleMeterRegistry()) {
            @Override public Double windowSeconds(String stream, long nowMs) {
                assertThat(nowMs).as("computed at the request's own time").isEqualTo(NOW.toEpochMilli());
                return StreamConsumer.S_AIRCRAFT.equals(stream) ? 6120.0 : null;
            }
        };
    }

    OpsPipelineController controller(StreamMetrics metrics) {
        StaticListableBeanFactory beans = new StaticListableBeanFactory();
        if (metrics != null) beans.addBean("streamMetrics", metrics);
        return new OpsPipelineController(new PipelineSignals(redis()), new SimpleMeterRegistry(), beans.getBeanProvider(StreamConsumer.class),
                beans.getBeanProvider(StreamMetrics.class), () -> NOW);
    }

    @Test
    void passesThroughRetentionTargetAndByteBudgetWhileTheHeartbeatIsFresh() {
        collector.putAll(Map.of("region_at", NOW.minusSeconds(5).toString(), "stream_budget_trims", "0", "stream_retention_s", "9000",
                "stream_budget_bytes", "67108864"));
        ais.putAll(Map.of("updated_at", NOW.minusSeconds(2).toString(), "stream_budget_trims", "3", "stream_retention_s", "9000",
                "stream_budget_bytes", "33554432"));
        OpsPipelineController.Pipeline p = controller(metrics()).pipeline();
        assertThat(p.collector().streamRetentionS()).isEqualTo(9000L);
        assertThat(p.collector().streamBudgetBytes()).isEqualTo(67_108_864L);
        assertThat(p.ais().streamRetentionS()).isEqualTo(9000L);
        assertThat(p.ais().streamBudgetBytes()).isEqualTo(33_554_432L);
        assertThat(p.api().streamWindowS().aircraft()).isEqualTo(6120.0);
        assertThat(p.api().streamWindowS().ships()).as("ships window unknown").isNull();
    }

    @Test
    void missingMalformedOrStaleConfigurationIsUnknown() {
        collector.putAll(Map.of("region_at", NOW.minusSeconds(5).toString(), "stream_retention_s", "2.5h", "stream_budget_bytes", "-1"));
        ais.putAll(Map.of("updated_at", NOW.minusSeconds(2).toString()));
        OpsPipelineController.Pipeline p = controller(metrics()).pipeline();
        assertThat(p.collector().streamRetentionS()).isNull();
        assertThat(p.collector().streamBudgetBytes()).isNull();
        assertThat(p.ais().streamRetentionS()).isNull();
        assertThat(p.ais().streamBudgetBytes()).isNull();

        // heartbeat 가 오래됐으면 마지막 설정값도 지금 값이 아니다
        collector.putAll(Map.of("region_at", NOW.minusSeconds(600).toString(), "stream_retention_s", "9000", "stream_budget_bytes", "1024"));
        ais.putAll(Map.of("updated_at", NOW.minusSeconds(600).toString(), "stream_retention_s", "9000", "stream_budget_bytes", "1024"));
        p = controller(metrics()).pipeline();
        assertThat(p.collector().streamRetentionS()).isNull();
        assertThat(p.collector().streamBudgetBytes()).isNull();
        assertThat(p.ais().streamRetentionS()).isNull();
        assertThat(p.ais().streamBudgetBytes()).isNull();
    }

    /** ais 수신 진단(ADR-014 부록 C): 최근 창 최댓값 · 고른 상한·시간 초과 · 누적 수를 해시 값 그대로(초는 소수, 수는 정수). */
    static void putDiagnostics(Map<Object, Object> h) {
        h.put("diag_window_s", "60");
        h.put("loop_lag_max_s", "0.03");
        h.put("loop_stalls_total", "1");
        h.put("queue_wait_max_s", "0.25");
        h.put("ws_queue_max", "3");
        h.put("ws_queue_limit", "64");
        h.put("ping_rtt_max_s", "0.31");
        h.put("ping_timeout_s", "20");
        h.put("reconnects_quick_total", "2");
        // 원문 대기열 깊이 · 상한, 수집기가 고른 설정(웹이 숫자를 들고 있지 않게 해시에서 읽는다)
        h.put("queue_depth_max", "12");
        h.put("queue_limit", "20000");
        h.put("reconnect_quick_window_s", "30");
        h.put("reconnect_warn_count", "3");
        h.put("reconnect_warn_window_s", "1800");
        h.put("loop_tick_s", "0.5");
        h.put("loop_stall_s", "1");
        h.put("loop_warn_s", "5");
        h.put("loop_warn_every_s", "60");
    }

    @Test
    void passesThroughAisReceiveDiagnosticsWhileTheHeartbeatIsFresh() {
        ais.put("updated_at", NOW.minusSeconds(2).toString());
        putDiagnostics(ais);
        OpsPipelineController.AisSignals a = controller(metrics()).pipeline().ais();
        assertThat(a.diagWindowS()).isEqualTo(60.0);
        assertThat(a.loopLagMaxS()).isEqualTo(0.03);
        assertThat(a.loopStallsTotal()).isEqualTo(1L);
        assertThat(a.queueWaitMaxS()).isEqualTo(0.25);
        assertThat(a.wsQueueMax()).isEqualTo(3L);
        assertThat(a.wsQueueLimit()).isEqualTo(64L);
        assertThat(a.pingRttMaxS()).isEqualTo(0.31);
        assertThat(a.pingTimeoutS()).isEqualTo(20.0);
        assertThat(a.reconnectsQuickTotal()).isEqualTo(2L);
        assertThat(a.queueDepthMax()).isEqualTo(12L);
        assertThat(a.queueLimit()).isEqualTo(20000L);
        assertThat(a.reconnectQuickWindowS()).isEqualTo(30.0);
        assertThat(a.reconnectWarnCount()).isEqualTo(3L);
        assertThat(a.reconnectWarnWindowS()).isEqualTo(1800.0);
        assertThat(a.loopTickS()).isEqualTo(0.5);
        assertThat(a.loopStallS()).isEqualTo(1.0);
        assertThat(a.loopWarnS()).isEqualTo(5.0);
        assertThat(a.loopWarnEveryS()).isEqualTo(60.0);
    }

    /**
     * 통합 리뷰(2026-09-30): diag_window_s 는 수집기가 고른 초(sink.py _setting — 소수 셋째 자리까지)이고 contract_check 도 초로 본다. api 만 정수로
     * 읽어 창이 60.5 처럼 소수가 되면 조용히 null(웹은 창을 "—" 로) 이 됐다 — 다른 고른 초와 같이 초로 읽는다.
     */
    @Test
    void aFractionalDiagnosticWindowIsReadAsSecondsLikeTheOtherChosenSeconds() {
        ais.put("updated_at", NOW.minusSeconds(2).toString());
        putDiagnostics(ais);
        ais.put("diag_window_s", "60.5");
        assertThat(controller(metrics()).pipeline().ais().diagWindowS()).isEqualTo(60.5);
        ais.put("diag_window_s", "6e1"); // 지수 표기는 다른 초와 같이 모름
        assertThat(controller(metrics()).pipeline().ais().diagWindowS()).isNull();
    }

    @Test
    void emptyMalformedOrStaleDiagnosticsAreUnknown() {
        ais.put("updated_at", NOW.minusSeconds(2).toString());
        putDiagnostics(ais);
        // 수집기가 아직 표본이 없으면 빈 값(모름) · 형식이 틀리면 모름 — 0 으로 채우지 않는다
        ais.put("loop_lag_max_s", "");
        ais.put("queue_wait_max_s", "-0.5");
        ais.put("ping_rtt_max_s", "NaN");
        ais.put("ping_timeout_s", "1e400");
        ais.put("ws_queue_max", "3.5");
        ais.put("queue_depth_max", "-1");
        ais.put("loop_tick_s", ""); // 루프 측정이 없는 수집기
        ais.put("reconnect_warn_count", "3.5");
        ais.put("reconnect_warn_window_s", "1.8e3");
        OpsPipelineController.AisSignals a = controller(metrics()).pipeline().ais();
        assertThat(a.loopLagMaxS()).isNull();
        assertThat(a.queueWaitMaxS()).isNull();
        assertThat(a.pingRttMaxS()).isNull();
        assertThat(a.pingTimeoutS()).isNull();
        assertThat(a.wsQueueMax()).isNull();
        assertThat(a.queueDepthMax()).isNull();
        assertThat(a.loopTickS()).isNull();
        assertThat(a.reconnectWarnCount()).isNull();
        assertThat(a.reconnectWarnWindowS()).isNull();
        assertThat(a.reconnectsQuickTotal()).isEqualTo(2L);
        assertThat(a.loopStallS()).isEqualTo(1.0);

        putDiagnostics(ais);
        ais.put("updated_at", NOW.minusSeconds(600).toString()); // 멈춘 ais 의 마지막 값은 지금 값이 아니다
        a = controller(metrics()).pipeline().ais();
        assertThat(a.loopLagMaxS()).isNull();
        assertThat(a.reconnectsQuickTotal()).isNull();
        assertThat(a.diagWindowS()).isNull();
        assertThat(a.queueLimit()).isNull();
        assertThat(a.reconnectQuickWindowS()).isNull();
        assertThat(a.loopWarnEveryS()).isNull();
    }

    @Test
    void windowIsUnknownWithoutStreamMetrics() {
        OpsPipelineController.Pipeline p = controller(null).pipeline();
        assertThat(p.api().streamWindowS()).isNotNull();
        assertThat(p.api().streamWindowS().aircraft()).isNull();
        assertThat(p.api().streamWindowS().ships()).isNull();
    }
}
