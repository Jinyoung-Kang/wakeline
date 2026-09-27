package dev.wakeline.config;

import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.data.redis.core.script.DefaultRedisScript;
import org.springframework.stereotype.Component;

import java.util.List;

/** IP당 분당 요청 제한(2차, Redis Lua). edge 의 limit_req 가 1차. 외부 공급자 예산과는 완전히 분리된 카운터다. */
@Component
public class RateLimiter {
    private static final String LUA = """
            local n = redis.call('INCR', KEYS[1])
            if n == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
            local ttl = redis.call('TTL', KEYS[1])
            return {n, ttl}
            """;
    private final StringRedisTemplate redis;
    private final DefaultRedisScript<List> script;

    public RateLimiter(StringRedisTemplate redis) {
        this.redis = redis;
        this.script = new DefaultRedisScript<>(LUA, List.class);
    }

    /**
     * 공개 API 용(가용성 우선). @return {count, ttlSeconds}. Redis 장애 시 {0, window} — 제한을 연다(edge 의 1차 제한은 그대로 남는다).
     */
    public long[] hit(String bucket, String ip, int windowS) {
        try {
            return hitStrict(bucket, ip, windowS);
        } catch (RuntimeException e) {
            return new long[]{0, windowS};
        }
    }

    /**
     * 보안 경로용(로그인 등, 실패 시 닫힘). Redis 오류·빈 응답이면 예외를 던진다 — 호출자가 503 으로 거절한다(SEC-6).
     * @return {count, ttlSeconds}
     */
    @SuppressWarnings("unchecked")
    public long[] hitStrict(String bucket, String ip, int windowS) {
        long window = System.currentTimeMillis() / 1000 / windowS;
        List<Long> r = redis.execute(script, List.of("rl:" + bucket + ":" + ip + ":" + window), String.valueOf(windowS));
        if (r == null || r.size() < 2) throw new IllegalStateException("rate limiter returned no result");
        return new long[]{r.get(0), r.get(1)};
    }
}
