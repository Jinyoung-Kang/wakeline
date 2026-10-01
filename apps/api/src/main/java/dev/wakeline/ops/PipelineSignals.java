package dev.wakeline.ops;

import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.stereotype.Component;

import java.util.Map;

/**
 * 데이터 손실 신호(/api/v1/ops/pipeline)가 읽는 수집기 해시 — 수집기 heartbeat(wakeline:collector)와 ais 상태(wakeline:ais:status). 예전에는
 * OpsPipelineController 가 직접 읽었다(리뷰 cto-2026-10 api §2.5 phase 3 · ADR-028: 컨트롤러는 Redis 를 쓰지 않는다). 해시는 읽기만 하고, 값의 형식 ·
 * 신선도 판단은 컨트롤러가 그대로 한다. 해시가 없거나 Redis 를 읽지 못하면 빈 맵 — 모두 모름(null)이 된다.
 */
@org.springframework.context.annotation.Profile("!cli & !migrate")
@Component
public class PipelineSignals {
    private final StringRedisTemplate redis;

    public PipelineSignals(StringRedisTemplate redis) { this.redis = redis; }

    /** 수집기 heartbeat 해시(wakeline:collector). */
    public Map<Object, Object> collector() { return hash("wakeline:collector"); }

    /** ais 상태 해시(wakeline:ais:status). */
    public Map<Object, Object> ais() { return hash("wakeline:ais:status"); }

    private Map<Object, Object> hash(String key) {
        try {
            Map<Object, Object> h = redis.opsForHash().entries(key);
            return h == null ? Map.of() : h;
        } catch (RuntimeException e) {
            return Map.of(); // Redis 를 읽지 못하면 모두 모름
        }
    }
}
