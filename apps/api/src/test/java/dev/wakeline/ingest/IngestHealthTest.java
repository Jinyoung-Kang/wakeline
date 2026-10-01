package dev.wakeline.ingest;

import dev.wakeline.aircraft.core.Snapshot;
import dev.wakeline.aircraft.core.SnapshotStore;
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

    /**
     * 리뷰 cto-2026-10 A1(B1): 관심 지역 스냅샷이 아직 없으면 health() 가 던졌다 — Boot 4 의 withDetail 은 null 값을 받지 않는다(region_lag_s = null).
     * 그 순간(기동 유예 · 유예 뒤 스냅샷 없음)이 바로 이 지표가 알려야 하는 상태인데 /actuator/health/ingest 와 /actuator/health 가 500 이었다.
     * 상태 표(액추에이터 기본 HTTP 대응 — application.yml 은 바꾸지 않는다): 유예 중 UNKNOWN 200 · 유예 뒤 스냅샷 없음 DOWN 503 · 스냅샷 있음 UP 200.
     * 모르는 지연은 키를 뺀다(0 을 지어내지 않는다).
     */
    @Test
    void healthStatesAndTheirHttpCodesWithAndWithoutARegionSnapshot() {
        var http = org.springframework.boot.health.actuate.endpoint.HttpCodeStatusMapper.getDefault();
        org.springframework.boot.health.contributor.Health starting = health.health();
        assertThat(starting.getStatus()).isEqualTo(Status.UNKNOWN);
        assertThat(http.getStatusCode(starting.getStatus())).isEqualTo(200);
        assertThat(starting.getDetails()).isEmpty();

        clock.addAndGet(IngestHealthIndicator.STARTUP_GRACE_MS + 1);
        org.springframework.boot.health.contributor.Health down = health.health();
        assertThat(down.getStatus()).isEqualTo(Status.DOWN);
        assertThat(http.getStatusCode(down.getStatus())).isEqualTo(503);
        assertThat(down.getDetails()).containsOnlyKeys("reasons").containsEntry("reasons", java.util.List.of("no_region_snapshot"));

        regionFetchedSecondsAgo(10);
        org.springframework.boot.health.contributor.Health up = health.health();
        assertThat(up.getStatus()).isEqualTo(Status.UP);
        assertThat(http.getStatusCode(up.getStatus())).isEqualTo(200);
        assertThat(up.getDetails()).containsOnlyKeys("region_lag_s").containsEntry("region_lag_s", 10L);
    }
}
