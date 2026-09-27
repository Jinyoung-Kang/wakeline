package dev.skywx.config;

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

    /** @return {count, ttlSeconds}. Redis 장애 시 {0, 60} — 제한을 열어 두되(가용성 우선) 지표로 남긴다. */
    @SuppressWarnings("unchecked")
    public long[] hit(String bucket, String ip, int windowS) {
        try {
            long window = System.currentTimeMillis() / 1000 / windowS;
            List<Long> r = redis.execute(script, List.of("rl:" + bucket + ":" + ip + ":" + window), String.valueOf(windowS));
            if (r == null || r.size() < 2) return new long[]{0, windowS};
            return new long[]{r.get(0), r.get(1)};
        } catch (RuntimeException e) {
            return new long[]{0, windowS};
        }
    }
}
