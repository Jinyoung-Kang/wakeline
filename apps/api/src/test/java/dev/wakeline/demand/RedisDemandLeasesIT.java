package dev.wakeline.demand;

import dev.wakeline.it.ItStack;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIf;
import org.springframework.data.redis.connection.RedisStandaloneConfiguration;
import org.springframework.data.redis.connection.lettuce.LettuceClientConfiguration;
import org.springframework.data.redis.connection.lettuce.LettuceConnectionFactory;
import org.springframework.data.redis.core.StringRedisTemplate;

import java.time.Duration;
import java.util.List;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 임대 키의 만료가 api 와 Redis 의 시계 차이에 끌려가지 않는다(ADR-013 "임대는 최대 60 s").
 * <p>
 * 실제로 본 흔들림: DemandIT 의 "PTTL ≤ 60,000" 이 PTTL 60,012 로 한 번 실패했다. 원인 — 키 만료를 PEXPIREAT(api 시계의 절대 epoch ms)로 걸었다.
 * Redis 는 그 시각을 제 시계로 재므로, Redis 시계가 api 시계보다 δ 늦으면 키가 60 s + δ 산다(시험: api 는 호스트 JVM, Redis 는 Docker VM —
 * 시계가 따로 논다). 점수(만료 epoch ms)는 계약 그대로 두고, 키 만료만 api 시계로 잰 남은 시간(PEXPIRE)으로 건다 — 키는 쓴 뒤 60 s 를 넘겨 살지 않는다.
 * <p>
 * 시험은 api 시계가 Redis 보다 5 s 앞선 경우(PEXPIREAT 면 키가 60 s 를 넘겨 산다)와 5 s 뒤진 경우(PEXPIREAT 면 키가 55 s 만에 사라진다)를 주입한
 * 시계로 만든다 — 두 방향 모두 옛 코드에서 실패한다. 앱(다른 통합 테스트가 띄운 컨텍스트)이 같은 키를 쓰지 않도록 논리 DB 1 을 쓴다.
 */
@EnabledIf("dev.wakeline.DbTestSupport#dockerAvailable")
class RedisDemandLeasesIT {
    static final long SKEW_MS = 5_000;
    static final long LEASE_MS = 60_000;
    static LettuceConnectionFactory factory;
    static StringRedisTemplate redis;

    @BeforeAll
    static void connect() {
        RedisStandaloneConfiguration cfg = new RedisStandaloneConfiguration(ItStack.redisHost(), ItStack.redisPort());
        cfg.setPassword(ItStack.REDIS_ADMIN_PW);
        cfg.setDatabase(1);
        factory = new LettuceConnectionFactory(cfg, LettuceClientConfiguration.builder().commandTimeout(Duration.ofSeconds(5)).build());
        factory.afterPropertiesSet();
        factory.start();
        redis = new StringRedisTemplate(factory);
        redis.afterPropertiesSet();
    }

    @AfterAll
    static void close() {
        if (redis != null) redis.delete(List.of(DemandLeases.HOT, DemandLeases.HOT_META, DemandLeases.FOCUS, DemandLeases.FOCUS_META));
        if (factory != null) factory.destroy();
    }

    @Test
    void keyExpiryIsTheRemainingLeaseOnTheApiClock_notAnAbsoluteTimeRedisReadsOnItsOwnClock() {
        // api 시계가 Redis(여기서는 이 호스트와 같은 벽시계)보다 SKEW_MS 앞선다
        long apiNow = System.currentTimeMillis() + SKEW_MS;
        RedisDemandLeases leases = new RedisDemandLeases(redis, () -> System.currentTimeMillis() + SKEW_MS);
        long expiresAt = apiNow + LEASE_MS;
        leases.replace(List.of(new DemandLeases.Lease("c:1:2", "{}")), List.of(new DemandLeases.Lease("a0f0e1", "{}")), expiresAt);

        for (String key : List.of(DemandLeases.HOT, DemandLeases.HOT_META, DemandLeases.FOCUS, DemandLeases.FOCUS_META)) {
            Long ttl = redis.getExpire(key, TimeUnit.MILLISECONDS);
            assertThat(ttl).as("PTTL of " + key + " (api clock %d ms ahead of Redis)", SKEW_MS).isBetween(1L, LEASE_MS);
        }
        // 점수는 계약 그대로 — api 가 정한 만료 epoch ms(수집기는 ZRANGEBYSCORE now +inf 로 읽는다)
        assertThat(redis.opsForZSet().score(DemandLeases.HOT, "c:1:2")).isEqualTo((double) expiresAt);
        assertThat(redis.opsForZSet().score(DemandLeases.FOCUS, "a0f0e1")).isEqualTo((double) expiresAt);
    }

    @Test
    void keyExpiryIsTheFullRemainingLease_evenWhenTheApiClockIsBehindRedis() {
        // api 시계가 Redis 보다 SKEW_MS 뒤진다 — PEXPIREAT(api 의 절대 시각)였다면 Redis 가 그 시각을 SKEW_MS 먼저 맞아 키가 약 55 s 만에 사라진다
        long apiNow = System.currentTimeMillis() - SKEW_MS;
        RedisDemandLeases leases = new RedisDemandLeases(redis, () -> System.currentTimeMillis() - SKEW_MS);
        long expiresAt = apiNow + LEASE_MS;
        leases.replace(List.of(new DemandLeases.Lease("c:1:2", "{}")), List.of(new DemandLeases.Lease("a0f0e1", "{}")), expiresAt);

        for (String key : List.of(DemandLeases.HOT, DemandLeases.HOT_META, DemandLeases.FOCUS, DemandLeases.FOCUS_META)) {
            Long ttl = redis.getExpire(key, TimeUnit.MILLISECONDS);
            // 아래 끝 여유 2 s = 스크립트 · 읽기 사이 지난 시간(시계 차이는 PEXPIRE 에 들어가지 않는다)
            assertThat(ttl).as("PTTL of " + key + " (api clock %d ms behind Redis)", SKEW_MS).isBetween(LEASE_MS - 2_000, LEASE_MS);
        }
    }
}
