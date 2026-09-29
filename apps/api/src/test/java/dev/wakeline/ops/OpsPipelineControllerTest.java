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
        return new OpsPipelineController(redis(), new SimpleMeterRegistry(), beans.getBeanProvider(StreamConsumer.class),
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

    @Test
    void windowIsUnknownWithoutStreamMetrics() {
        OpsPipelineController.Pipeline p = controller(null).pipeline();
        assertThat(p.api().streamWindowS()).isNotNull();
        assertThat(p.api().streamWindowS().aircraft()).isNull();
        assertThat(p.api().streamWindowS().ships()).isNull();
    }
}
