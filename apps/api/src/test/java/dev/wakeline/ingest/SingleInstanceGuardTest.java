package dev.wakeline.ingest;

import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIf;
import org.springframework.data.redis.connection.RedisStandaloneConfiguration;
import org.springframework.data.redis.connection.lettuce.LettuceClientConfiguration;
import org.springframework.data.redis.connection.lettuce.LettuceConnectionFactory;
import org.springframework.data.redis.connection.stream.Consumer;
import org.springframework.data.redis.connection.stream.ReadOffset;
import org.springframework.data.redis.connection.stream.StreamOffset;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.testcontainers.containers.GenericContainer;
import org.testcontainers.utility.DockerImageName;

import java.time.Duration;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * R-79 단일 인스턴스 가드를 실제 Redis 로(앱 컨텍스트와 섞이지 않게 전용 컨테이너): 두 번째 인스턴스는 기동 실패, 정상 종료는 임대를 풀어
 * 곧바로 다시 띄울 수 있음, 실행 중 가로채기는 경보, Redis 장애는 기동을 막지 않음, 다른 이름의 활성 소비자 감지.
 */
@EnabledIf("dev.wakeline.DbTestSupport#dockerAvailable")
class SingleInstanceGuardTest {
    static GenericContainer<?> container;
    static LettuceConnectionFactory factory;
    static LettuceConnectionFactory dead;
    StringRedisTemplate redis;

    @BeforeAll
    static void startRedis() {
        container = new GenericContainer<>(DockerImageName.parse("redis:8-alpine")).withExposedPorts(6379);
        container.start();
        factory = factory(container.getHost(), container.getMappedPort(6379));
        dead = factory("127.0.0.1", 1);
    }

    static LettuceConnectionFactory factory(String host, int port) {
        var f = new LettuceConnectionFactory(new RedisStandaloneConfiguration(host, port),
                LettuceClientConfiguration.builder().commandTimeout(Duration.ofSeconds(2)).build());
        f.afterPropertiesSet();
        f.start();
        return f;
    }

    @AfterAll
    static void stopRedis() {
        if (factory != null) factory.destroy();
        if (dead != null) dead.destroy();
        if (container != null) container.stop();
    }

    @BeforeEach
    void clean() {
        redis = new StringRedisTemplate(factory);
        redis.getConnectionFactory().getConnection().serverCommands().flushAll();
    }

    SingleInstanceGuard guard(StringRedisTemplate r, String id) {
        return new SingleInstanceGuard(r, new SimpleMeterRegistry(), id, Duration.ofSeconds(15), Duration.ofMillis(300), Duration.ofMillis(50));
    }

    @Test
    void aSecondInstanceFailsToStartWhileTheFirstHoldsTheLease() {
        SingleInstanceGuard first = guard(redis, "first"), second = guard(redis, "second");
        first.start();
        assertThat(first.isRunning()).isTrue();
        assertThat(redis.opsForValue().get(SingleInstanceGuard.KEY)).isEqualTo("first");
        assertThat(redis.getExpire(SingleInstanceGuard.KEY)).isBetween(1L, 15L);

        assertThatThrownBy(second::start).isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("another api instance").hasMessageContaining("first").hasMessageContaining("api-1");
        assertThat(second.isRunning()).isFalse();
        assertThat(second.conflict()).isTrue();

        // 정상 종료는 자기 임대만 푼다 → 다음 인스턴스가 곧바로 뜬다
        second.stop(); // 시작하지 못한 가드의 stop 은 아무것도 하지 않는다
        assertThat(redis.opsForValue().get(SingleInstanceGuard.KEY)).isEqualTo("first");
        first.stop();
        assertThat(redis.hasKey(SingleInstanceGuard.KEY)).isFalse();
        SingleInstanceGuard next = guard(redis, "next");
        next.start();
        assertThat(redis.opsForValue().get(SingleInstanceGuard.KEY)).isEqualTo("next");
    }

    /** 죽은 이전 프로세스의 임대: 기다리는 동안 만료되면 잡는다(재기동이 실패하지 않는다). */
    @Test
    void aStaleLeaseFromACrashedProcessIsTakenOverOnceItExpires() {
        redis.opsForValue().set(SingleInstanceGuard.KEY, "crashed", Duration.ofMillis(150));
        SingleInstanceGuard g = guard(redis, "restarted");
        g.start();
        assertThat(redis.opsForValue().get(SingleInstanceGuard.KEY)).isEqualTo("restarted");
    }

    @Test
    void renewalExtendsTheLeaseAndFlagsATakeover() {
        SingleInstanceGuard g = guard(redis, "me");
        g.renew(); // 시작 전에는 아무것도 하지 않는다
        assertThat(redis.hasKey(SingleInstanceGuard.KEY)).isFalse();
        g.start();
        redis.expire(SingleInstanceGuard.KEY, Duration.ofSeconds(2));
        g.renew();
        assertThat(redis.getExpire(SingleInstanceGuard.KEY)).isGreaterThan(2L);
        assertThat(g.conflict()).isFalse();

        redis.opsForValue().set(SingleInstanceGuard.KEY, "intruder", Duration.ofSeconds(15));
        g.renew();
        assertThat(g.conflict()).isTrue();
        g.renew(); // 1분 안의 반복은 로그 없이
        assertThat(redis.opsForValue().get(SingleInstanceGuard.KEY)).isEqualTo("intruder");
        g.stop(); // 남의 임대는 지우지 않는다
        assertThat(redis.opsForValue().get(SingleInstanceGuard.KEY)).isEqualTo("intruder");
    }

    @Test
    void redisOutageDoesNotBlockStartup() {
        SingleInstanceGuard g = guard(new StringRedisTemplate(dead), "offline");
        g.start();
        assertThat(g.isRunning()).isTrue();
        g.renew();
        g.stop();
        assertThat(g.foreignConsumers()).isEmpty();
        assertThat(g.getPhase()).isLessThan(Integer.MAX_VALUE - 150);
    }

    @Test
    void otherActiveConsumerNamesInTheGroupAreReported() {
        SingleInstanceGuard g = guard(redis, "me");
        assertThat(g.foreignConsumers()).as("no stream/group yet").isEmpty();
        redis.opsForStream().add(StreamConsumer.S_AIRCRAFT, Map.of("k", "v"));
        redis.opsForStream().createGroup(StreamConsumer.S_AIRCRAFT, ReadOffset.from("0"), StreamConsumer.GROUP);
        redis.opsForStream().read(Consumer.from(StreamConsumer.GROUP, StreamConsumer.CONSUMER), StreamOffset.create(StreamConsumer.S_AIRCRAFT, ReadOffset.lastConsumed()));
        assertThat(g.foreignConsumers()).isEmpty();
        redis.opsForStream().read(Consumer.from(StreamConsumer.GROUP, "api-2"), StreamOffset.create(StreamConsumer.S_AIRCRAFT, ReadOffset.lastConsumed()));
        assertThat(g.foreignConsumers()).containsExactly(StreamConsumer.S_AIRCRAFT + "/api-2");
        g.checkForeignConsumers(); // WARN 한 줄
        assertThat(SingleInstanceGuard.defaultInstanceId()).contains(":" + ProcessHandle.current().pid() + ":");
    }
}
