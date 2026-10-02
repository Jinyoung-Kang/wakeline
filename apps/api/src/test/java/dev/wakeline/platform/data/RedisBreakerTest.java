package dev.wakeline.platform.data;

import io.lettuce.core.RedisCommandTimeoutException;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.springframework.boot.test.system.CapturedOutput;
import org.springframework.boot.test.system.OutputCaptureExtension;
import org.springframework.dao.QueryTimeoutException;
import org.springframework.data.redis.RedisConnectionFailureException;
import org.springframework.data.redis.RedisSystemException;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * ADR-032 Redis 무응답 차단기: 무응답(연결 실패 · 명령 시간 초과)을 보면 OPEN_MS 동안 열고, 그 뒤 뒤에서 PING 한 번으로 확인해 답하면 닫는다. 요청은
 * 확인을 기다리지 않는다(확인은 실행기에 넘긴다 — 이 시험은 실행기를 손으로 돌린다).
 */
@ExtendWith(OutputCaptureExtension.class)
class RedisBreakerTest {
    final AtomicLong clock = new AtomicLong(1_000_000);
    final AtomicBoolean redisAnswers = new AtomicBoolean(false);
    final AtomicInteger pings = new AtomicInteger();
    final List<Runnable> probes = new ArrayList<>();
    final SimpleMeterRegistry meters = new SimpleMeterRegistry();
    final RedisBreaker breaker = new RedisBreaker(() -> {
        pings.incrementAndGet();
        if (!redisAnswers.get()) throw new QueryTimeoutException("Redis command timed out");
    }, clock::get, probes::add, meters);

    double gauge() { return meters.get("wakeline_redis_breaker_open").gauge().value(); }

    @Test
    void onlyNoAnswerErrorsOpenIt() {
        assertThat(RedisBreaker.isNoAnswer(new QueryTimeoutException("timed out"))).isTrue();
        assertThat(RedisBreaker.isNoAnswer(new RedisConnectionFailureException("refused"))).isTrue();
        assertThat(RedisBreaker.isNoAnswer(new RedisSystemException("wrapped", new RedisCommandTimeoutException("timed out")))).isTrue();
        assertThat(RedisBreaker.isNoAnswer(new RedisSystemException("WRONGTYPE", new IllegalStateException("WRONGTYPE")))).isFalse();
        assertThat(RedisBreaker.isNoAnswer(new IllegalStateException("RedisConnectionFactory is required"))).isFalse();
        assertThat(breaker.failed(new RedisSystemException("WRONGTYPE", null))).isFalse();
        assertThat(breaker.available()).as("Redis 가 곧바로 답한 오류는 다른 쓰는 쪽을 막지 않는다").isTrue();
    }

    @Test
    void opensOnNoAnswerThenAOnePingProbeAfterTheOpenTimeClosesIt(CapturedOutput out) {
        assertThat(breaker.failed(new QueryTimeoutException("Redis command timed out after 3 second(s)"))).isTrue();
        breaker.failed(new QueryTimeoutException("another request, same outage"));
        assertThat(breaker.isOpen()).isTrue();
        assertThat(gauge()).isEqualTo(1.0);
        assertThat(meters.get("wakeline_redis_breaker_opened_total").counter().count()).as("열림 한 번").isEqualTo(1.0);
        assertThat(out.getAll().split("redis does not answer", -1)).as("WARN 은 열릴 때 한 번").hasSize(2);

        clock.addAndGet(RedisBreaker.OPEN_MS - 1);
        assertThat(breaker.available()).isFalse();
        assertThat(probes).as("연 시간 안에는 확인하지 않는다").isEmpty();

        clock.addAndGet(1);
        assertThat(breaker.available()).as("확인을 시작하지만 이번 요청은 기다리지 않고 건너뛴다").isFalse();
        assertThat(breaker.available()).isFalse();
        assertThat(probes).as("확인은 한 번에 하나").hasSize(1);
        probes.removeFirst().run(); // Redis 아직 멈춤 — 다시 OPEN_MS 연다
        assertThat(pings.get()).isEqualTo(1);
        assertThat(breaker.isOpen()).isTrue();
        clock.addAndGet(RedisBreaker.OPEN_MS - 1);
        assertThat(breaker.available()).isFalse();
        assertThat(probes).as("실패한 확인 뒤에도 연 시간을 지킨다").isEmpty();

        clock.addAndGet(1);
        redisAnswers.set(true);
        assertThat(breaker.available()).isFalse();
        probes.removeFirst().run();
        assertThat(breaker.isOpen()).isFalse();
        assertThat(breaker.available()).isTrue();
        assertThat(gauge()).isEqualTo(0.0);
        assertThat(out.getAll()).contains("redis answers again — breaker closed after " + (2 * RedisBreaker.OPEN_MS) + " ms");

        breaker.failed(new RedisConnectionFailureException("refused again"));
        assertThat(meters.get("wakeline_redis_breaker_opened_total").counter().count()).as("다시 열리면 다시 센다").isEqualTo(2.0);
    }

    @Test
    void aRejectedProbeIsRetriedByTheNextCaller() {
        AtomicInteger attempts = new AtomicInteger();
        RedisBreaker b = new RedisBreaker(() -> { }, clock::get, r -> {
            if (attempts.incrementAndGet() == 1) throw new java.util.concurrent.RejectedExecutionException("busy");
            r.run();
        }, meters);
        b.failed(new QueryTimeoutException("timed out"));
        clock.addAndGet(RedisBreaker.OPEN_MS);
        assertThat(b.available()).isFalse();
        assertThat(b.isOpen()).isTrue();
        assertThat(b.available()).as("확인 표시가 남아 영영 확인하지 않는 일은 없다 — 다음 묻는 쪽이 다시 시작한다").isFalse();
        assertThat(attempts.get()).isEqualTo(2);
        assertThat(b.isOpen()).isFalse();
        assertThat(b.available()).isTrue();
    }
}
