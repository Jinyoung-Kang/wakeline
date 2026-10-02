package dev.wakeline.platform.data;

import io.lettuce.core.RedisCommandTimeoutException;
import io.lettuce.core.RedisConnectionException;
import io.micrometer.core.instrument.Counter;
import io.micrometer.core.instrument.Gauge;
import io.micrometer.core.instrument.MeterRegistry;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.dao.QueryTimeoutException;
import org.springframework.data.redis.RedisConnectionFailureException;
import org.springframework.data.redis.connection.RedisConnection;
import org.springframework.data.redis.core.RedisCallback;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.stereotype.Component;

import java.util.concurrent.Executor;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.LongSupplier;

/**
 * Redis 무응답 차단기(ADR-032) — 요청 경로의 Redis 호출이 Redis 가 답하지 않을 때마다 명령 상한(application.yml spring.data.redis.timeout 3 s)을
 * 기다리지 않게 한다. QA 2026-10(신뢰성 개선 제안 3): Redis 가 멈춘 동안 공개 REST 가 모두 3.0–3.1 s(공개 요청 제한기), /status 는 12 s(제한기 +
 * 상태의 Redis 조회 셋), 로그인 503 은 6 s 걸렸다.
 * <ul>
 *   <li>쓰는 쪽: 공개 요청 제한기(RateLimiter — 열린 동안 api 메모리 안에서 같은 한도로 센다 · 보안 경로는 곧바로 503)와 공개 상태(StatusService — 열린 동안
 *       Redis 조회를 건너뛰고 '읽지 못함' 표시). 스트림 소비 · 수요 임대 · 운영 경로는 쓰지 않는다(요청이 기다리는 길이 아니거나, 이미 503 으로 답한다).</li>
 *   <li>여는 것: 무응답(연결 실패 · 명령 시간 초과 — {@link #isNoAnswer})을 한 번 보면 {@value #OPEN_MS} ms 동안 연다. 다른 Redis 오류(WRONGTYPE ·
 *       LOADING 등 — Redis 가 곧바로 답한 것)는 열지 않는다: 기다림을 만들지 않고, 한 명령의 오류로 다른 쓰는 쪽까지 Redis 를 건너뛰게 하지 않는다.</li>
 *   <li>닫는 것: 연 시간이 지난 뒤 처음 묻는 쪽이 뒤 스레드 하나로 PING 을 보낸다 — 답하면 닫고, 아니면 다시 {@value #OPEN_MS} ms 연다. 요청은 확인을
 *       기다리지 않는다(확인이 끝날 때까지 계속 건너뛴다). 묻는 쪽에는 /healthz(IngestHealthIndicator)도 있다 — edge 컨테이너 헬스체크가 주기적으로
 *       부르므로 공개 요청이 없어도 Redis 가 돌아오면 닫힌다.</li>
 *   <li>보이는 것: 지표 wakeline_redis_breaker_open(0 · 1) · wakeline_redis_breaker_opened_total, WARN(닫힘 → 열림 한 번) · INFO(다시 닫힘, 열려 있던 시간),
 *       /healthz 의 reasons 에 redis_unavailable(열린 동안 — 요청 경로가 무응답을 본 때에만 열리므로 요청이 없으면 소비 정지 쪽 원인이 먼저 보인다).</li>
 * </ul>
 */
@Component
public class RedisBreaker {
    private static final Logger log = LoggerFactory.getLogger(RedisBreaker.class);
    /** 무응답을 본 뒤 Redis 를 건너뛰는 시간(그 뒤 PING 으로 확인). 명령 상한(3 s)보다 길게 — 확인이 끝나기 전에 다시 확인하지 않는다. */
    public static final long OPEN_MS = 5_000;

    /** PING 한 번(답하지 않으면 던진다). */
    @FunctionalInterface
    public interface Ping { void ping(); }

    private final Ping ping;
    private final LongSupplier clockMs;
    private final Executor prober;
    private final Counter opened;
    private final AtomicBoolean probing = new AtomicBoolean();
    private volatile boolean open;
    private volatile long openUntilMs;
    private volatile long openedAtMs;

    @org.springframework.beans.factory.annotation.Autowired
    public RedisBreaker(StringRedisTemplate redis, MeterRegistry meters) {
        this(() -> redis.execute((RedisCallback<String>) RedisConnection::ping), System::currentTimeMillis,
                r -> Thread.ofVirtual().name("redis-breaker-probe").start(r), meters);
    }

    /** 시험용: PING · 시계 · 확인을 돌릴 실행기를 바꿔 쓴다. */
    public RedisBreaker(Ping ping, LongSupplier clockMs, Executor prober, MeterRegistry meters) {
        this.ping = ping;
        this.clockMs = clockMs;
        this.prober = prober;
        this.opened = Counter.builder("wakeline_redis_breaker_opened_total")
                .description("Redis 무응답(연결 실패 · 명령 시간 초과)으로 차단기를 연 횟수(닫힘 → 열림)").register(meters);
        Gauge.builder("wakeline_redis_breaker_open", this, b -> b.open ? 1 : 0)
                .description("1 = Redis 가 답하지 않아 요청 경로가 Redis 를 건너뛰는 중(공개 요청 제한은 api 메모리 안에서 센다)").register(meters);
    }

    /**
     * 지금 Redis 를 불러도 되는가. 열린 동안 false — 연 시간이 지났으면 뒤에서 한 번 확인을 시작하고(이미 확인 중이면 그대로) 이번에는 false.
     */
    public boolean available() {
        if (!open) return true;
        if (clockMs.getAsLong() >= openUntilMs && probing.compareAndSet(false, true)) {
            try {
                prober.execute(this::probe);
            } catch (RuntimeException e) { // 실행기가 받지 않음 — 다음 묻는 쪽이 다시 시도한다
                probing.set(false);
            }
        }
        return false;
    }

    /** 지금 열려 있는가(지표 · /healthz). 확인을 시작하지 않는다. */
    public boolean isOpen() { return open; }

    /**
     * 쓰는 쪽이 Redis 호출의 예외를 알린다. 무응답이면 연다(이미 열렸으면 연 시간을 늘린다).
     * @return 무응답으로 본 것인가(그 밖의 오류는 false — 차단기를 건드리지 않는다)
     */
    public boolean failed(Throwable e) {
        if (!isNoAnswer(e)) return false;
        long now = clockMs.getAsLong();
        openUntilMs = Math.max(openUntilMs, now + OPEN_MS);
        if (!open) {
            synchronized (this) {
                if (!open) {
                    openedAtMs = now;
                    open = true;
                    opened.increment();
                    log.warn("redis does not answer — request paths skip Redis for {} ms at a time until a PING is answered "
                            + "(public rate limit counted in memory, login and client error reports answer 503): {}", OPEN_MS, e.toString());
                }
            }
        }
        return true;
    }

    /** Redis 가 답하지 않았다는 예외인가 — 연결 실패 · 명령 시간 초과(Spring 번역 · Lettuce 원인 모두). */
    public static boolean isNoAnswer(Throwable e) {
        for (Throwable c = e; c != null; c = c.getCause() == c ? null : c.getCause())
            if (c instanceof RedisConnectionFailureException || c instanceof QueryTimeoutException
                    || c instanceof RedisCommandTimeoutException || c instanceof RedisConnectionException) return true;
        return false;
    }

    /** 열린 동안 Redis 를 건너뛰었다는 예외(실패 시 닫히는 쪽이 던진다) — 연결 실패와 같은 부류라 ProblemAdvice 가 503 + Retry-After 로 답한다. */
    public static RedisConnectionFailureException skipped() {
        return new RedisConnectionFailureException("redis does not answer (breaker open) — skipped");
    }

    private void probe() {
        try {
            ping.ping();
            close();
        } catch (RuntimeException e) {
            openUntilMs = clockMs.getAsLong() + OPEN_MS;
            log.debug("redis breaker probe failed: {}", e.toString());
        } finally {
            probing.set(false);
        }
    }

    private synchronized void close() {
        if (!open) return;
        open = false;
        log.info("redis answers again — breaker closed after {} ms", clockMs.getAsLong() - openedAtMs);
    }
}
