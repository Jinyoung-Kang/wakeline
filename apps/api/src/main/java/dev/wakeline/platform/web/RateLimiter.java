package dev.wakeline.platform.web;

import dev.wakeline.platform.data.RedisBreaker;
import io.micrometer.core.instrument.Counter;
import io.micrometer.core.instrument.MeterRegistry;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.data.redis.core.script.DefaultRedisScript;
import org.springframework.stereotype.Component;

import java.util.List;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicLong;
import java.util.function.LongSupplier;

/**
 * IP당 분당 요청 제한(2차, Redis Lua). edge 의 limit_req 가 1차. 외부 공급자 예산과는 완전히 분리된 카운터다.
 * Redis 가 답하지 않으면({@link RedisBreaker} 가 열림 — ADR-032) Redis 를 기다리지 않는다: 공개 제한은 api 메모리 안에서 같은 창 · 같은 한도로 세고
 * (api 는 한 인스턴스 — SingleInstanceGuard), 보안 경로(로그인 · 브라우저 오류 보고)는 곧바로 실패한다(호출자가 503).
 */
@Component
public class RateLimiter {
    private static final Logger log = LoggerFactory.getLogger(RateLimiter.class);
    /** Redis 를 쓰지 못한 동안의 WARN 간격(그사이는 지표만 센다). */
    static final long WARN_INTERVAL_MS = 60_000;
    /** 메모리 안 제한의 한 창에 둘 열쇠(버킷 · IP) 수 상한 — 넘으면 새 열쇠는 세지 않고 연다(result="open"). 메모리를 요청으로 키울 수 없게. */
    static final int LOCAL_MAX_KEYS = 10_000;
    private static final String LUA = """
            local n = redis.call('INCR', KEYS[1])
            if n == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
            local ttl = redis.call('TTL', KEYS[1])
            return {n, ttl}
            """;
    private final StringRedisTemplate redis;
    private final RedisBreaker breaker;
    private final DefaultRedisScript<List> script;
    private final MeterRegistry meters;
    private final LongSupplier clockMs;
    private final AtomicLong lastWarnMs = new AtomicLong(Long.MIN_VALUE / 2);
    /** 창 길이(초) → 지금 창의 메모리 안 카운터. 창이 바뀌면 표를 새로 만든다(지난 창은 버린다). */
    private final ConcurrentHashMap<Integer, LocalWindow> local = new ConcurrentHashMap<>();

    private record LocalWindow(long id, ConcurrentHashMap<String, AtomicLong> counts) {}

    @org.springframework.beans.factory.annotation.Autowired
    public RateLimiter(StringRedisTemplate redis, RedisBreaker breaker, MeterRegistry meters) {
        this(redis, breaker, meters, System::currentTimeMillis);
    }

    /** 시험용: 시계를 바꿔 쓴다(메모리 안 제한의 창). */
    public RateLimiter(StringRedisTemplate redis, RedisBreaker breaker, MeterRegistry meters, LongSupplier clockMs) {
        this.redis = redis;
        this.breaker = breaker;
        this.meters = meters;
        this.clockMs = clockMs;
        this.script = new DefaultRedisScript<>(LUA, List.class);
    }

    /**
     * 공개 API 용(가용성 우선). @return {count, ttlSeconds}. Redis 를 쓰지 못하면(차단기가 열림 · 오류) api 메모리 안에서 같은 창으로 센다 — 예전에는
     * 제한을 열었고(edge 의 1차 제한만 남음) Redis 무응답마다 명령 상한 3 s 를 기다렸다(QA 2026-10 신뢰성 개선 제안 3).
     * Redis 오류는 wakeline_rate_limiter_errors_total{bucket}, 메모리 안에서 정한 요청은 wakeline_rate_limiter_local_total{bucket,result} 로 센다.
     * WARN 은 오류가 있는 동안 분에 한 번(리뷰 cto-2026-10 A4).
     */
    public long[] hit(String bucket, String ip, int windowS) {
        if (!breaker.available()) return hitLocal(bucket, ip, windowS);
        try {
            return hitRedis(bucket, ip, windowS);
        } catch (RuntimeException e) {
            breaker.failed(e);
            Counter.builder("wakeline_rate_limiter_errors_total").tag("bucket", bucket)
                    .description("Redis 오류로 Redis 에서 세지 못한 공개 요청 제한 호출(그 요청은 api 메모리 안에서 셌다)").register(meters).increment();
            long now = clockMs.getAsLong(), last = lastWarnMs.get();
            if (now - last >= WARN_INTERVAL_MS && lastWarnMs.compareAndSet(last, now))
                log.warn("rate limiter: Redis failed — the '{}' limit is counted in memory until Redis answers (counted in "
                        + "wakeline_rate_limiter_errors_total): {}", bucket, e.toString());
            return hitLocal(bucket, ip, windowS);
        }
    }

    /**
     * 보안 경로용(로그인 등, 실패 시 닫힘). Redis 오류·빈 응답이면 예외를 던진다 — 호출자가 503 으로 거절한다(SEC-6). 차단기가 열린 동안은 Redis 를
     * 기다리지 않고 곧바로 던진다.
     * @return {count, ttlSeconds}
     */
    public long[] hitStrict(String bucket, String ip, int windowS) {
        if (!breaker.available()) throw RedisBreaker.skipped();
        try {
            return hitRedis(bucket, ip, windowS);
        } catch (RuntimeException e) {
            breaker.failed(e);
            throw e;
        }
    }

    @SuppressWarnings("unchecked")
    private long[] hitRedis(String bucket, String ip, int windowS) {
        long window = clockMs.getAsLong() / 1000 / windowS;
        List<Long> r = redis.execute(script, List.of("rl:" + bucket + ":" + ip + ":" + window), String.valueOf(windowS));
        if (r == null || r.size() < 2) throw new IllegalStateException("rate limiter returned no result");
        return new long[]{r.get(0), r.get(1)};
    }

    /** Redis 와 같은 창(epoch 초 / 창 길이) · 같은 반환 모양으로 api 메모리 안에서 센다. */
    long[] hitLocal(String bucket, String ip, int windowS) {
        long nowS = clockMs.getAsLong() / 1000;
        long id = nowS / windowS;
        long ttl = windowS - nowS % windowS;
        LocalWindow w = local.compute(windowS, (k, old) -> old != null && old.id() == id ? old : new LocalWindow(id, new ConcurrentHashMap<>()));
        String key = bucket + ":" + ip;
        AtomicLong n = w.counts().get(key);
        if (n == null) {
            if (w.counts().size() >= LOCAL_MAX_KEYS) {
                localCounter(bucket, "open").increment();
                return new long[]{0, ttl};
            }
            n = w.counts().computeIfAbsent(key, k -> new AtomicLong());
        }
        localCounter(bucket, "counted").increment();
        return new long[]{n.incrementAndGet(), ttl};
    }

    private Counter localCounter(String bucket, String result) {
        return Counter.builder("wakeline_rate_limiter_local_total").tag("bucket", bucket).tag("result", result)
                .description("Redis 를 쓰지 못한 동안 api 메모리 안에서 정한 공개 요청 제한(counted = 셈 · open = 열쇠 수 상한이라 세지 않고 열어 둠)")
                .register(meters);
    }
}
