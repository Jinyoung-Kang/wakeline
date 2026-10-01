package dev.wakeline.ingest;

import dev.wakeline.aircraft.core.SnapshotStore;
import org.springframework.boot.health.contributor.Health;
import org.springframework.boot.health.contributor.HealthIndicator;
import org.springframework.boot.health.contributor.Status;
import org.springframework.stereotype.Component;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.function.LongSupplier;

/**
 * 수집 경로 건강 상태(REL-20) — 기여자 ingestPipeline, 헬스 그룹 ingest(/actuator/health/ingest, 내부 포트)에만 넣는다. readiness·liveness 에는 넣지 않는다:
 * 수집기·공급자 장애로 api 를 재시작하거나 트래픽에서 빼면 오히려 마지막 상태·이력 조회까지 끊긴다(수집 장애는 '저하' 이지 api 장애가 아니다).
 * /healthz(edge 가 노출)는 이 값을 status ok | degraded | starting 으로 싣는다(HTTP 200 유지 — edge 헬스체크가 쓴다).
 * <ul>
 *   <li>DOWN: 관심 지역 스냅샷 지연 &gt; 120 s(region_feed_lag), 기동 뒤 120 s 가 지나도록 스냅샷 없음(no_region_snapshot),
 *       소비 루프가 30 s 넘게 XREADGROUP 에서 돌아오지 않음(consumer_stalled — BLOCK 은 2 s),
 *       그룹에 아직 전달되지 않은 항공기 엔트리 &gt; 100(consumer_behind), 그룹이 읽기 전에 지워진 엔트리 있음(unread_trimmed).</li>
 *   <li>UNKNOWN: 기동 직후(120 s 이내) 아직 스냅샷이 없음.</li>
 * </ul>
 */
@org.springframework.context.annotation.Profile("!cli & !migrate")
@Component("ingestPipelineHealthIndicator") // 기여자 이름 ingestPipeline — 그룹 이름(ingest)과 겹치면 안 된다
public class IngestHealthIndicator implements HealthIndicator {
    static final double MAX_REGION_LAG_S = 120;
    static final long STARTUP_GRACE_MS = 120_000;
    static final long MAX_READ_AGE_MS = 30_000;
    static final double MAX_STREAM_LAG = 100;

    private final SnapshotStore snapshots;
    private final StreamConsumer consumer;
    private final StreamMetrics streams;
    private final LongSupplier clockMs;
    private final long startedAtMs;

    @org.springframework.beans.factory.annotation.Autowired
    public IngestHealthIndicator(SnapshotStore snapshots, StreamConsumer consumer, StreamMetrics streams) {
        this(snapshots, consumer, streams, System::currentTimeMillis);
    }

    IngestHealthIndicator(SnapshotStore snapshots, StreamConsumer consumer, StreamMetrics streams, LongSupplier clockMs) {
        this.snapshots = snapshots;
        this.consumer = consumer;
        this.streams = streams;
        this.clockMs = clockMs;
        this.startedAtMs = clockMs.getAsLong();
    }

    /** 판정 결과: 상태와(DOWN 이면) 원인 코드. */
    public record Verdict(Status status, List<String> reasons, double regionLagS) {}

    public Verdict verdict() {
        long now = clockMs.getAsLong();
        boolean starting = now - startedAtMs < STARTUP_GRACE_MS;
        List<String> reasons = new ArrayList<>();
        double lag = snapshots.region().lagSeconds(Instant.ofEpochMilli(now));
        if (lag < 0) {
            if (!starting) reasons.add("no_region_snapshot");
        } else if (lag > MAX_REGION_LAG_S) {
            reasons.add("region_feed_lag");
        }
        long readAge = consumer.lastReadAgeMs();
        if (readAge > MAX_READ_AGE_MS || (readAge < 0 && !starting)) reasons.add("consumer_stalled");
        StreamMetrics.Sample s = streams.sample(StreamConsumer.S_AIRCRAFT);
        if (s.lag() > MAX_STREAM_LAG) reasons.add("consumer_behind");
        if (s.unreadTrimmed() > 0) reasons.add("unread_trimmed");
        Status st = !reasons.isEmpty() ? Status.DOWN : (lag < 0 && starting) ? Status.UNKNOWN : Status.UP;
        return new Verdict(st, List.copyOf(reasons), lag);
    }

    @Override
    public Health health() {
        Verdict v = verdict();
        Health.Builder b = Health.status(v.status());
        if (!v.reasons().isEmpty()) b.withDetail("reasons", v.reasons());
        // 스냅샷이 없으면 지연은 모른다 — 키를 뺀다. Boot 4 의 withDetail 은 null 을 받지 않아(던진다) 그 상태가 500 이었다(리뷰 cto-2026-10 A1)
        if (v.regionLagS() >= 0) b.withDetail("region_lag_s", Math.round(v.regionLagS()));
        return b.build();
    }
}
