package dev.wakeline.platform.web;

import dev.wakeline.platform.data.RedisBreaker;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.springframework.boot.test.system.CapturedOutput;
import org.springframework.boot.test.system.OutputCaptureExtension;
import org.springframework.dao.QueryTimeoutException;
import org.springframework.data.redis.RedisConnectionFailureException;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.data.redis.core.script.RedisScript;

import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * 공개 API 요청 제한의 Redis 장애 동작. 리뷰 cto-2026-10 A4(B10): 예전에는 열린 것을 아무도 몰랐다 — 이제 wakeline_rate_limiter_errors_total{bucket} 로
 * 세고 WARN 은 분에 한 번(스택 없음). ADR-032(QA 2026-10 신뢰성 개선 제안 3): Redis 를 쓰지 못하면 제한을 여는 대신 api 메모리 안에서 같은 창 · 같은
 * 한도로 세고, Redis 무응답이면 차단기가 열려 다음 요청부터 Redis 를 기다리지 않는다(예전: 요청마다 명령 상한 3 s). 보안 경로(hitStrict)는 전처럼
 * 던지되(호출자가 503) 차단기가 열린 동안은 Redis 를 부르지 않는다.
 */
@ExtendWith(OutputCaptureExtension.class)
class RateLimiterTest {
    /** 확인(PING)이 늘 답하는 차단기 — 확인은 부른 스레드에서 곧바로. */
    static RedisBreaker breaker() {
        return new RedisBreaker(() -> { }, System::currentTimeMillis, Runnable::run, new SimpleMeterRegistry());
    }

    /** 스크립트 호출을 세고 정해 둔 예외를 던지는 Redis(연결 없음). */
    static final class FailingRedis extends StringRedisTemplate {
        final AtomicInteger calls = new AtomicInteger();
        final RuntimeException error;
        FailingRedis(RuntimeException error) { this.error = error; }
        @Override public <T> T execute(RedisScript<T> script, List<String> keys, Object... args) {
            calls.incrementAndGet();
            throw error;
        }
    }

    final AtomicLong clock = new AtomicLong(1_790_000_000_000L); // 창 경계에서 20 s 지난 시각(1_790_000_000 % 60 = 20)
    final SimpleMeterRegistry meters = new SimpleMeterRegistry();

    @Test
    void aRedisFailureCountsThePublicLimitInMemoryAndIsCountedAndWarnedOncePerMinute(CapturedOutput out) {
        RateLimiter limiter = new RateLimiter(new StringRedisTemplate(), breaker(), meters, clock::get); // 연결 없음 — 무응답이 아닌 Redis 오류
        for (int i = 1; i <= 3; i++) assertThat(limiter.hit("api", "1.2.3.4", 60)).containsExactly(i, 40);
        assertThat(limiter.hit("api", "5.6.7.8", 60)).as("IP 마다 따로").containsExactly(1, 40);
        assertThat(meters.find("wakeline_rate_limiter_errors_total").tag("bucket", "api").counter().count()).isEqualTo(4.0);
        assertThat(meters.find("wakeline_rate_limiter_local_total").tag("bucket", "api").tag("result", "counted").counter().count()).isEqualTo(4.0);
        assertThat(out.getAll().split("rate limiter: Redis failed", -1)).as("one WARN, not one per request").hasSize(2);
        assertThat(out.getAll()).contains("'api' limit is counted in memory");
        assertThatThrownBy(() -> limiter.hitStrict("login", "1.2.3.4", 60)).isInstanceOf(RuntimeException.class);
    }

    @Test
    void whileRedisDoesNotAnswerThePublicLimitSkipsRedisAndStillLimits() {
        FailingRedis redis = new FailingRedis(new QueryTimeoutException("Redis command timed out"));
        RedisBreaker b = new RedisBreaker(() -> { throw new QueryTimeoutException("still paused"); }, clock::get, Runnable::run, meters);
        RateLimiter limiter = new RateLimiter(redis, b, meters, clock::get);
        assertThat(limiter.hit("api", "1.2.3.4", 60)).containsExactly(1, 40); // 무응답을 본 요청 — 차단기가 열린다
        assertThat(b.isOpen()).isTrue();
        long[] last = null;
        for (int i = 0; i < 120; i++) last = limiter.hit("api", "1.2.3.4", 60);
        assertThat(redis.calls.get()).as("열린 동안은 Redis 를 부르지 않는다 — 기다림이 없다").isEqualTo(1);
        assertThat(last).as("한도(분당 120 등)는 메모리 안에서도 걸린다 — 필터가 count > limit 이면 429").containsExactly(121, 40);
        assertThat(meters.find("wakeline_rate_limiter_errors_total").tag("bucket", "api").counter().count()).as("Redis 오류는 한 번").isEqualTo(1.0);
        clock.addAndGet(40_000); // 다음 창
        assertThat(limiter.hit("api", "1.2.3.4", 60)).as("창이 바뀌면 처음부터").containsExactly(1, 60);
    }

    @Test
    void whileRedisDoesNotAnswerTheStrictLimitFailsAtOnceAs503() {
        FailingRedis redis = new FailingRedis(new RedisConnectionFailureException("Unable to connect to Redis"));
        RedisBreaker b = new RedisBreaker(() -> { throw new RedisConnectionFailureException("down"); }, clock::get, Runnable::run, meters);
        RateLimiter limiter = new RateLimiter(redis, b, meters, clock::get);
        assertThatThrownBy(() -> limiter.hitStrict("login", "1.2.3.4", 60)).isInstanceOf(RedisConnectionFailureException.class);
        assertThat(b.isOpen()).isTrue();
        for (int i = 0; i < 5; i++)
            assertThatThrownBy(() -> limiter.hitStrict("login", "1.2.3.4", 60))
                    .isInstanceOf(RedisConnectionFailureException.class)
                    .satisfies(e -> assertThat(ProblemAdvice.isUnavailable(e)).as("ProblemAdvice 가 503 + Retry-After 로 답하는 부류").isTrue());
        assertThat(redis.calls.get()).as("열린 동안 로그인 제한은 Redis 를 기다리지 않는다").isEqualTo(1);
    }

    @Test
    void theInMemoryTableHasAKeyCapSoRequestsCannotGrowIt() {
        RateLimiter limiter = new RateLimiter(new StringRedisTemplate(), breaker(), meters, clock::get);
        for (int i = 0; i < RateLimiter.LOCAL_MAX_KEYS; i++) limiter.hitLocal("api", "ip-" + i, 60);
        assertThat(limiter.hitLocal("api", "one-more", 60)).as("상한을 넘은 새 열쇠는 세지 않고 연다").containsExactly(0, 40);
        assertThat(limiter.hitLocal("api", "ip-7", 60)).as("이미 있는 열쇠는 계속 센다").containsExactly(2, 40);
        assertThat(meters.find("wakeline_rate_limiter_local_total").tag("result", "open").counter().count()).isEqualTo(1.0);
        clock.addAndGet(60_000);
        assertThat(limiter.hitLocal("api", "one-more", 60)).as("다음 창은 새 표").containsExactly(1, 40);
    }
}
