package dev.wakeline.status;

import java.time.Instant;
import java.util.Map;
import java.util.function.Function;

/**
 * 수집기 heartbeat 해시(wakeline:collector)에서 '수집기가 마지막으로 보고한 시각'을 고른다. 운영 /ops/pipeline 의 heartbeat_age_s
 * (OpsPipelineController)와 공개 /status 의 adsb_fi_rps_1m 신선도(StatusService)가 같은 규칙을 쓴다 — 예전에는 두 곳이 같은 계산을 따로 가졌다.
 */
public final class CollectorHeartbeat {
    private CollectorHeartbeat() {}

    /**
     * 이름이 _at 으로 끝나는 필드 중 시각으로 읽힌 가장 늦은 값. 읽히는 값이 없으면 null. time 은 값 하나를 시각으로 읽는다(못 읽으면 null —
     * 그 필드는 건너뛴다).
     */
    public static Instant latestReport(Map<?, ?> hash, Function<Object, Instant> time) {
        Instant newest = null;
        for (var e : hash.entrySet()) {
            if (!String.valueOf(e.getKey()).endsWith("_at")) continue;
            Instant t = time.apply(e.getValue());
            if (t != null && (newest == null || t.isAfter(newest))) newest = t;
        }
        return newest;
    }
}
