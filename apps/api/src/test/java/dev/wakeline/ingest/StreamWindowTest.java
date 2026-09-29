package dev.wakeline.ingest;

import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import org.junit.jupiter.api.Test;
import org.springframework.data.redis.RedisSystemException;
import org.springframework.data.redis.connection.stream.StreamInfo;
import org.springframework.data.redis.core.StreamOperations;
import org.springframework.data.redis.core.StringRedisTemplate;

import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicLong;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.doReturn;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * 스트림 보존 창(ops/pipeline api.stream_window_s · wakeline_stream_window_seconds{stream}): 지금 − XINFO STREAM first-entry id 의 시각.
 * 30 s 스트림 지표 측정에서 첫 엔트리 시각만 기억하고, 창은 요청(스크레이프) 시각에 계산한다. 스트림이 없거나 비었거나 Redis 를 읽지
 * 못했거나 측정이 오래됐으면 null(모름) — 0 이나 마지막 값으로 채우지 않는다.
 */
class StreamWindowTest {
    static final long T0 = 1_790_000_000_000L;
    final AtomicLong clock = new AtomicLong(T0);

    /** Redis 가 돌려주는 XINFO STREAM 응답 모양(키·값 쌍 목록) — first-entry 는 [id, [field, value, …]] 또는 nil. */
    static StreamInfo.XInfoStream xinfo(long length, long added, String firstId) {
        List<Object> first = firstId == null ? null : List.of(firstId, List.of("kind", "aircraft"));
        return StreamInfo.XInfoStream.fromList(Arrays.asList("length", length, "entries-added", added, "first-entry", first,
                "last-entry", first));
    }

    @Test
    void firstEntryTimeIsTheMillisecondPartOfTheFirstEntryId() {
        Map<String, Object> raw = xinfo(3, 10, T0 + "-4").getRaw();
        assertThat(StreamMetrics.firstEntryMs(raw)).isEqualTo((double) T0);
        assertThat(StreamMetrics.compute(raw, null).firstEntryMs()).isEqualTo((double) T0);
        // 원시 [id, fields] 모양 · 바이트 배열 id 도 같은 값
        Map<String, Object> list = new HashMap<>(Map.of("first-entry", List.of((T0 + "-0").getBytes(StandardCharsets.UTF_8), List.of())));
        assertThat(StreamMetrics.firstEntryMs(list)).isEqualTo((double) T0);
    }

    @Test
    void emptyMissingOrMalformedFirstEntryIsUnknown() {
        assertThat(StreamMetrics.firstEntryMs(xinfo(0, 12, null).getRaw())).as("empty stream: first-entry nil").isNaN();
        assertThat(StreamMetrics.firstEntryMs(null)).as("no XINFO answer").isNaN();
        assertThat(StreamMetrics.firstEntryMs(Map.of("length", 0L))).isNaN();
        assertThat(StreamMetrics.firstEntryMs(Map.of("first-entry", Map.of()))).isNaN();
        assertThat(StreamMetrics.firstEntryMs(Map.of("first-entry", List.of()))).isNaN();
        assertThat(StreamMetrics.firstEntryMs(Map.of("first-entry", Map.of("abc", List.of())))).isNaN();
        assertThat(StreamMetrics.firstEntryMs(Map.of("first-entry", "1790000000000-0"))).as("not an entry").isNaN();
        assertThat(StreamMetrics.compute(null, null).firstEntryMs()).isNaN();
        // 4개 값만 가진 측정(이전 호출부)도 첫 엔트리는 모름
        assertThat(new StreamMetrics.Sample(0, 0, 0, 0).firstEntryMs()).isNaN();
    }

    @Test
    void windowIsNowMinusFirstEntryAndNullWhenUnknownStaleOrFarInTheFuture() {
        long sampled = T0 + 9_000_000;
        assertThat(StreamMetrics.window(T0, sampled, T0 + 9_000_000)).isEqualTo(9000.0);
        assertThat(StreamMetrics.window(T0, T0 + 6_120_000, T0 + 6_120_049)).isEqualTo(6120.0);   // 0.1 s 로 반올림
        assertThat(StreamMetrics.window(T0, T0 + 6_120_000, T0 + 6_120_051)).isEqualTo(6120.1);
        assertThat(StreamMetrics.window(Double.NaN, sampled, sampled)).as("first entry unknown").isNull();
        assertThat(StreamMetrics.window(T0, -1, sampled)).as("never sampled").isNull();
        assertThat(StreamMetrics.window(T0, sampled, sampled + StreamMetrics.WINDOW_SAMPLE_MAX_AGE_MS)).isEqualTo(9120.0);
        assertThat(StreamMetrics.window(T0, sampled, sampled + StreamMetrics.WINDOW_SAMPLE_MAX_AGE_MS + 1))
                .as("sample too old: the first entry may have been trimmed since").isNull();
        assertThat(StreamMetrics.window(T0 + 30_000, T0, T0)).as("small clock skew → 0").isEqualTo(0.0);
        assertThat(StreamMetrics.window(T0 + 61_000, T0, T0)).as("first entry far in the future → untrusted").isNull();
    }

    @Test
    void refreshRemembersTheFirstEntryAndComputesTheWindowAtRequestTime() {
        StringRedisTemplate redis = mock(StringRedisTemplate.class);
        @SuppressWarnings("unchecked") StreamOperations<String, Object, Object> ops = mock(StreamOperations.class);
        doReturn(ops).when(redis).opsForStream();
        when(ops.groups(anyString())).thenReturn(StreamInfo.XInfoGroups.fromList(List.of()));
        when(ops.info(StreamConsumer.S_AIRCRAFT)).thenReturn(xinfo(3, 10, (T0 - 6_120_000) + "-0"));
        when(ops.info(StreamConsumer.S_SHIPS)).thenThrow(new RedisSystemException("ERR no such key", new RuntimeException("ERR no such key")));
        when(ops.info(StreamConsumer.S_SIGMET)).thenReturn(xinfo(0, 4, null));
        when(ops.info(StreamConsumer.S_RADAR)).thenReturn(null);
        SimpleMeterRegistry meters = new SimpleMeterRegistry();
        StreamMetrics m = new StreamMetrics(redis, meters, clock::get);

        assertThat(m.windowSeconds(StreamConsumer.S_AIRCRAFT, clock.get())).as("before the first sample").isNull();
        assertThat(gauge(meters, StreamConsumer.S_AIRCRAFT)).isNaN();
        m.refresh();
        assertThat(m.windowSeconds(StreamConsumer.S_AIRCRAFT, clock.get())).isEqualTo(6120.0);
        assertThat(m.windowSeconds(StreamConsumer.S_AIRCRAFT, clock.get() + 15_000)).as("computed at request time").isEqualTo(6135.0);
        assertThat(m.windowSeconds(StreamConsumer.S_SHIPS, clock.get())).as("missing stream").isNull();
        assertThat(m.windowSeconds(StreamConsumer.S_SIGMET, clock.get())).as("empty stream").isNull();
        assertThat(m.windowSeconds(StreamConsumer.S_RADAR, clock.get())).as("no XINFO answer").isNull();
        assertThat(m.windowSeconds("wakeline:unknown", clock.get())).isNull();

        // 게이지(Prometheus): 스크레이프 시각의 창, 모르면 NaN
        clock.addAndGet(30_000);
        assertThat(gauge(meters, StreamConsumer.S_AIRCRAFT)).isEqualTo(6150.0);
        assertThat(gauge(meters, StreamConsumer.S_SHIPS)).isNaN();
        assertThat(gauge(meters, StreamConsumer.S_SIGMET)).isNaN();

        // 측정이 멈추면(스케줄러가 막힘) 창을 계속 늘려 보이지 않는다
        clock.addAndGet(StreamMetrics.WINDOW_SAMPLE_MAX_AGE_MS);
        assertThat(m.windowSeconds(StreamConsumer.S_AIRCRAFT, clock.get())).isNull();
        assertThat(gauge(meters, StreamConsumer.S_AIRCRAFT)).isNaN();

        // 측정이 다시 돌면 창이 돌아온다(첫 엔트리는 그대로 — 창은 그만큼 자랐다)
        m.refresh();
        assertThat(m.windowSeconds(StreamConsumer.S_AIRCRAFT, clock.get())).isEqualTo(6270.0);
    }

    /**
     * 좋은 측정 바로 다음(120 s 오래됨 한도 안쪽) 측정이 실패하면 그 자리에서 모름 — 오래됨 한도에 기대지 않는다. Redis 오류(항공기)와
     * 사이에 지워진 스트림(선박, ERR no such key) 모두 직전 첫 엔트리를 지금 값처럼 두지 않는다.
     */
    @Test
    void aFailedRefreshRightAfterAGoodOneForgetsTheFirstEntry() {
        StringRedisTemplate redis = mock(StringRedisTemplate.class);
        @SuppressWarnings("unchecked") StreamOperations<String, Object, Object> ops = mock(StreamOperations.class);
        doReturn(ops).when(redis).opsForStream();
        when(ops.groups(anyString())).thenReturn(StreamInfo.XInfoGroups.fromList(List.of()));
        when(ops.info(StreamConsumer.S_AIRCRAFT)).thenReturn(xinfo(3, 10, (T0 - 6_120_000) + "-0"));
        when(ops.info(StreamConsumer.S_SHIPS)).thenReturn(xinfo(2, 5, (T0 - 60_000) + "-0"));
        SimpleMeterRegistry meters = new SimpleMeterRegistry();
        StreamMetrics m = new StreamMetrics(redis, meters, clock::get);
        m.refresh();
        assertThat(m.windowSeconds(StreamConsumer.S_AIRCRAFT, clock.get())).isEqualTo(6120.0);
        assertThat(m.windowSeconds(StreamConsumer.S_SHIPS, clock.get())).isEqualTo(60.0);

        clock.addAndGet(30_000); // 다음 예약 측정 — 오래됨 한도(120 s)보다 한참 안쪽
        doThrow(new RedisSystemException("down", new RuntimeException("down"))).when(ops).info(StreamConsumer.S_AIRCRAFT);
        doThrow(new RedisSystemException("ERR no such key", new RuntimeException("ERR no such key"))).when(ops).info(StreamConsumer.S_SHIPS);
        m.refresh();
        for (String s : List.of(StreamConsumer.S_AIRCRAFT, StreamConsumer.S_SHIPS)) {
            assertThat(m.windowSeconds(s, clock.get())).as(s + " window after a failed refresh").isNull();
            assertThat(gauge(meters, s)).as(s + " gauge after a failed refresh").isNaN();
            assertThat(m.sample(s).firstEntryMs()).as(s + " first entry after a failed refresh").isNaN();
        }
    }

    @Test
    void redisErrorLeavesTheWindowUnknown() {
        StreamMetrics real = new StreamMetrics(new StringRedisTemplate(), new SimpleMeterRegistry());
        real.refresh(); // 연결 팩토리 없음 → 조회 실패
        assertThat(real.windowSeconds(StreamConsumer.S_AIRCRAFT, System.currentTimeMillis())).isNull();
        assertThat(real.windowSeconds(StreamConsumer.S_SHIPS, System.currentTimeMillis())).isNull();
    }

    static double gauge(SimpleMeterRegistry meters, String stream) {
        return meters.get("wakeline_stream_window_seconds").tag("stream", stream).gauge().value();
    }
}
