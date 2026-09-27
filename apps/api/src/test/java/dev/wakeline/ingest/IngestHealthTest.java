package dev.wakeline.ingest;

import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import org.junit.jupiter.api.Test;
import org.springframework.boot.health.contributor.Status;
import tools.jackson.databind.json.JsonMapper;

import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.atomic.AtomicLong;

import static org.assertj.core.api.Assertions.assertThat;

/** REL-20: 수집 경로 헬스(자기 그룹)와 스트림 지표 해석. */
class IngestHealthTest {
    final AtomicLong clock = new AtomicLong(1_790_000_000_000L);
    final SnapshotStore snapshots = new SnapshotStore();
    long readAgeMs = 500;
    final StreamConsumer consumer = new StreamConsumer(null, new SchemaValidator(), snapshots, new SigmetStore(), new RadarStore(), e -> { },
            JsonMapper.builder().build(), new SimpleMeterRegistry()) {
        @Override public long lastReadAgeMs() { return readAgeMs; }
    };
    StreamMetrics.Sample aircraftSample = new StreamMetrics.Sample(0, 0, 0, 0);
    final StreamMetrics metrics = new StreamMetrics(null, new SimpleMeterRegistry()) {
        @Override public Sample sample(String stream) { return aircraftSample; }
    };
    final IngestHealthIndicator health = new IngestHealthIndicator(snapshots, consumer, metrics, clock::get);

    void regionFetchedSecondsAgo(long s) {
        Instant f = Instant.ofEpochMilli(clock.get()).minusSeconds(s);
        snapshots.replace(new Snapshot(snapshots.nextVersion(), "region", "adsb_lol", f, f, "-", Map.of()));
    }

    @Test
    void startingThenUpThenDegradedByReason() {
        assertThat(health.verdict().status()).isEqualTo(Status.UNKNOWN);       // 기동 직후, 스냅샷 없음
        clock.addAndGet(IngestHealthIndicator.STARTUP_GRACE_MS + 1);
        assertThat(health.verdict().reasons()).containsExactly("no_region_snapshot");
        regionFetchedSecondsAgo(10);
        assertThat(health.verdict().status()).isEqualTo(Status.UP);
        assertThat(health.health().getStatus()).isEqualTo(Status.UP);
        regionFetchedSecondsAgo(121);
        assertThat(health.verdict().reasons()).containsExactly("region_feed_lag");
        assertThat(health.health().getStatus()).isEqualTo(Status.DOWN);
        regionFetchedSecondsAgo(5);
        readAgeMs = 31_000;
        aircraftSample = new StreamMetrics.Sample(150, 3, 0, 7);
        assertThat(health.verdict().reasons()).containsExactly("consumer_stalled", "consumer_behind", "unread_trimmed");
        readAgeMs = -1; // 기동 뒤 한 번도 읽지 못함
        aircraftSample = new StreamMetrics.Sample(Double.NaN, Double.NaN, Double.NaN, Double.NaN); // 모름은 DOWN 사유가 아니다
        assertThat(health.verdict().reasons()).containsExactly("consumer_stalled");
    }

    @Test
    void streamSamplesAreComputedFromRawXinfo() {
        Map<String, Object> stream = new HashMap<>(Map.of("length", 200L, "entries-added", 1_250L));
        Map<String, Object> group = new HashMap<>(Map.of("lag", 3L, "pending", 2L, "entries-read", 1_047L));
        StreamMetrics.Sample s = StreamMetrics.compute(stream, group);
        assertThat(s.lag()).isEqualTo(3.0);
        assertThat(s.pending()).isEqualTo(2.0);
        assertThat(s.trimmedEntries()).isEqualTo(1_050.0);
        assertThat(s.unreadTrimmed()).isEqualTo(3.0);            // 1250 − 1047 − 200
        group.put("lag", null);
        group.put("entries-read", "1247".getBytes(StandardCharsets.UTF_8));
        StreamMetrics.Sample t = StreamMetrics.compute(stream, group);
        assertThat(t.lag()).isNaN();                              // Redis 가 셀 수 없음 → 모름
        assertThat(t.unreadTrimmed()).isZero();
        assertThat(StreamMetrics.compute(null, null).trimmedEntries()).isNaN();
        assertThat(StreamMetrics.num(Map.of("x", "abc"), "x")).isNaN();
        assertThat(StreamMetrics.num(Map.of("x", " 12 "), "x")).isEqualTo(12.0);
    }

    @Test
    void refreshFailureLeavesUnknownNotStale() {
        StreamMetrics real = new StreamMetrics(new org.springframework.data.redis.core.StringRedisTemplate(), new SimpleMeterRegistry());
        real.refresh(); // 연결 팩토리 없음 → 조회 실패
        assertThat(real.sample(StreamConsumer.S_AIRCRAFT).lag()).isNaN();
    }
}
