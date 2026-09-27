package dev.skywx.ingest;

import dev.skywx.domain.AircraftState;

import java.time.Instant;
import java.util.Map;

/** 불변 스냅샷. 갱신은 참조 교체(락 없음). version 은 단조 증가. */
public record Snapshot(long version, String scope, String provider, Instant fetchedAt, Instant receivedAt,
                       String rawRef, Map<String, AircraftState> states) {

    public static Snapshot empty(String scope) {
        return new Snapshot(0, scope, "-", Instant.EPOCH, Instant.EPOCH, "-", Map.of());
    }

    public double lagSeconds(Instant now) {
        return fetchedAt.equals(Instant.EPOCH) ? -1 : (now.toEpochMilli() - fetchedAt.toEpochMilli()) / 1000.0;
    }

    public boolean stale(Instant now, int thresholdS) {
        double lag = lagSeconds(now);
        return lag < 0 || lag > thresholdS;
    }
}
