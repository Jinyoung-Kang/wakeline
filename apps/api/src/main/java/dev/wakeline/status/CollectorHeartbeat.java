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

    /** 지금보다 이만큼(초) 넘게 미래인 보고 시각은 믿지 않는다(시계 차이는 이 안에서 봐준다). */
    public static final long MAX_FUTURE_S = 60;
    /** 같은 해시에 수집기가 쓰는 '다음에 움직일 때'(traffic_grid_fill_resume_at · traffic_grid_tiles_resume_at — 미래 시각). 보고 시각이 아니다. */
    static final String RESUME_SUFFIX = "_resume_at";

    /**
     * 보고 시각 = 이름이 _at 으로 끝나는 필드 중 가장 늦은 값. *_resume_at 은 보고 시각이 아니라 빼고, 지금보다 {@value #MAX_FUTURE_S} s 넘게
     * 미래인 값은 그 필드만 건너뛴다(필드 하나 때문에 heartbeat 전체를 모름으로 만들지 않는다 — IM-13). 남는 값이 없으면 null. time 은 값 하나를
     * 시각으로 읽는다(못 읽으면 null — 그 필드는 건너뛴다).
     */
    public static Instant latestReport(Map<?, ?> hash, Instant now, Function<Object, Instant> time) {
        long latestMs = now.toEpochMilli() + MAX_FUTURE_S * 1000;
        Instant newest = null;
        for (var e : hash.entrySet()) {
            String key = String.valueOf(e.getKey());
            if (!key.endsWith("_at") || key.endsWith(RESUME_SUFFIX)) continue;
            Instant t = time.apply(e.getValue());
            if (t == null || t.toEpochMilli() > latestMs) continue;
            if (newest == null || t.isAfter(newest)) newest = t;
        }
        return newest;
    }
}
