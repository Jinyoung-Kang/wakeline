package dev.wakeline.ingest;

import io.micrometer.core.instrument.Meter;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import org.junit.jupiter.api.Test;
import org.springframework.data.redis.connection.stream.StreamInfo;
import org.springframework.data.redis.core.StreamOperations;
import org.springframework.data.redis.core.StringRedisTemplate;

import java.util.List;
import java.util.Set;
import java.util.stream.Collectors;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.doReturn;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * 스트림 소비 지표는 api 가 소비하는 스트림 목록({@link StreamConsumer#STREAMS}) 전부를 잰다(IM-27). 지표 쪽에 따로 둔 목록이 기상특보
 * 스트림(wakeline:wxwarn)을 더할 때 빠져, 특보 스트림만 lag · pending · 보존 창 게이지가 없었다.
 */
class StreamMetricsTest {
    static final List<String> GAUGES = List.of("wakeline_stream_lag", "wakeline_stream_pending", "wakeline_stream_trimmed_entries",
            "wakeline_stream_unread_trimmed", "wakeline_stream_window_seconds");

    @Test
    void everyConsumedStreamHasEachGauge() {
        SimpleMeterRegistry meters = new SimpleMeterRegistry();
        new StreamMetrics(mock(StringRedisTemplate.class), meters, () -> 0L);
        for (String name : GAUGES) {
            Set<String> tagged = meters.find(name).gauges().stream().map(g -> g.getId().getTag("stream")).collect(Collectors.toSet());
            assertThat(tagged).as(name + "{stream}").containsExactlyInAnyOrderElementsOf(StreamConsumer.STREAMS).contains(StreamConsumer.S_WXWARN);
        }
        assertThat(meters.getMeters().stream().map(Meter::getId).filter(id -> id.getName().startsWith("wakeline_stream_")).count())
                .as("one gauge per name and stream").isEqualTo((long) GAUGES.size() * StreamConsumer.STREAMS.size());
    }

    @Test
    void refreshMeasuresTheWarningStreamToo() {
        StringRedisTemplate redis = mock(StringRedisTemplate.class);
        @SuppressWarnings("unchecked") StreamOperations<String, Object, Object> ops = mock(StreamOperations.class);
        doReturn(ops).when(redis).opsForStream();
        when(ops.groups(anyString())).thenReturn(StreamInfo.XInfoGroups.fromList(List.of()));
        when(ops.info(anyString())).thenReturn(StreamWindowTest.xinfo(3, 10, StreamWindowTest.T0 + "-0"));
        SimpleMeterRegistry meters = new SimpleMeterRegistry();
        StreamMetrics m = new StreamMetrics(redis, meters, () -> StreamWindowTest.T0 + 60_000);

        m.refresh();
        for (String s : StreamConsumer.STREAMS) {
            verify(ops).info(s);
            verify(ops).groups(s);
            assertThat(m.sample(s).trimmedEntries()).as(s + " trimmed entries").isEqualTo(7.0);
            assertThat(m.windowSeconds(s, StreamWindowTest.T0 + 60_000)).as(s + " window").isEqualTo(60.0);
        }
        assertThat(meters.get("wakeline_stream_trimmed_entries").tag("stream", StreamConsumer.S_WXWARN).gauge().value()).isEqualTo(7.0);
        assertThat(StreamWindowTest.gauge(meters, StreamConsumer.S_WXWARN)).isEqualTo(60.0);
    }
}
