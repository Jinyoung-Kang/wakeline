package dev.wakeline.ws;

import dev.wakeline.route.RouteInfo;
import dev.wakeline.route.RouteInfoTest;
import dev.wakeline.route.RouteReader;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIf;
import org.springframework.data.redis.connection.RedisStandaloneConfiguration;
import org.springframework.data.redis.connection.lettuce.LettuceClientConfiguration;
import org.springframework.data.redis.connection.lettuce.LettuceConnectionFactory;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.testcontainers.containers.GenericContainer;
import org.testcontainers.utility.DockerImageName;
import tools.jackson.databind.JsonNode;

import java.time.Duration;
import java.time.Instant;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;

import static dev.wakeline.ws.RouteSelectionLookupTest.await;
import static dev.wakeline.ws.RouteSelectionLookupTest.plane;
import static dev.wakeline.ws.RouteSelectionLookupTest.route;
import static dev.wakeline.ws.WsTestKit.ac;
import static dev.wakeline.ws.WsTestKit.ofType;
import static org.assertj.core.api.Assertions.assertThat;

/**
 * 계약 v5 §G21 을 실제 Redis 로(이 시험 전용 컨테이너 — 앱 · 다른 시험과 섞이지 않는다): 컨테이너를 멈추면(docker pause — TCP 연결은 열린 채 답이 없다,
 * 서버가 멈춘 경우) Lettuce 의 GET 은 명령 상한까지 기다린다. 그동안 선택 항공기를 고른 세션의 pong · 항공기 diff · heartbeat ping 은 제때 가고, selected 는
 * 곧바로 pending 으로, 늦어도 마감(= 명령 상한)에 unavailable 로 나간다. 다시 풀면 캐시가 지난 뒤 실제 노선을 보낸다.
 * <p>명령 상한은 이 시험이 고른 1.5 s(시험 시간을 줄이려고 — 운영은 application.yml spring.data.redis.timeout 3 s). 마감은 운영 배선과 같게 그 값에서 온다.
 * heartbeat 의 status 는 WsTestKit 의 가짜라 Redis 를 읽지 않는다(운영의 status 는 우편함에서 Redis 를 읽는다 — §G21 '남은 것').
 * <p>같은 동안 REST 항공기 상세의 노선 읽기(RouteReader.forCallsign — 진행 중인 WS 읽기에 붙는다)도 명령 상한 안에 unavailable 로 답한다(리뷰 2026-09-30 #1).
 */
@EnabledIf("dev.wakeline.DbTestSupport#dockerAvailable")
class RoutePausedRedisTest {
    static final Duration COMMAND_TIMEOUT = Duration.ofMillis(1_500);
    static GenericContainer<?> container;
    static LettuceConnectionFactory factory;
    static volatile boolean paused;

    @BeforeAll
    static void startRedis() {
        container = new GenericContainer<>(DockerImageName.parse("redis:8-alpine")).withExposedPorts(6379);
        container.start();
        factory = new LettuceConnectionFactory(new RedisStandaloneConfiguration(container.getHost(), container.getMappedPort(6379)),
                LettuceClientConfiguration.builder().commandTimeout(COMMAND_TIMEOUT).build());
        factory.afterPropertiesSet();
        factory.start();
    }

    @AfterAll
    static void stopRedis() {
        unpause();
        if (factory != null) factory.destroy();
        if (container != null) container.stop();
    }

    static void pause() {
        container.getDockerClient().pauseContainerCmd(container.getContainerId()).exec();
        paused = true;
    }

    static void unpause() {
        if (!paused) return;
        container.getDockerClient().unpauseContainerCmd(container.getContainerId()).exec();
        paused = false;
    }

    @Test void aPausedRedis_pongsAndDiffsKeepTheirCadence_andTheRouteAnswersWithinTheBound() throws Exception {
        StringRedisTemplate redis = new StringRedisTemplate(factory);
        redis.opsForValue().set("wakeline:route:SYN736", RouteInfoTest.found("SYN736").toString());
        AtomicLong clock = new AtomicLong(1_000_000);
        RouteReader reader = new RouteReader(key -> redis.opsForValue().get(key), RouteInfoTest.JSON, clock::get, new SimpleMeterRegistry(),
                COMMAND_TIMEOUT); // 실제 Lettuce GET · 운영처럼 명령 상한이 REST 기다림의 상한
        ExecutorService pool = Executors.newVirtualThreadPerTaskExecutor();
        ThreadPoolExecutor lookups = RouteLookups.boundedExecutor(2, SelectionLookups.DEFAULT_QUEUE);
        try (WsTestKit k = new WsTestKit(pool, 5_000, 200, 5)) {
            k.hub.useRouteLookups(new RouteLookups(lookups, RouteLookups.deadlineMs(COMMAND_TIMEOUT), k.meters));
            k.hub.setRouteSource(RouteLookups.of(reader));
            Instant now = Instant.now();
            k.publish("region", now, ac("aaa001", 35, 129, 30000, now, "adsb_lol"), plane("bbb001", "SYN736", 36, 128, now));
            FakeWsSession f = k.subscribed("s", "1.1.1.1");
            WsSession s = k.handler.session("s");
            await(s::idle);
            assertThat(redis.opsForValue().get("wakeline:route:none")).isNull(); // 연결을 미리 맺는다(연결 맺기 상한이 아니라 명령 상한을 본다)

            pause();
            try {
                long t0 = System.nanoTime();
                k.msg(f, "{\"type\":\"select\",\"hex\":\"bbb001\"}");
                await(() -> !ofType(f, "selected").isEmpty());
                assertThat((System.nanoTime() - t0) / 1_000_000).as("selected at once").isLessThan(500);
                assertThat(route(ofType(f, "selected").getFirst())).isEqualTo(RouteInfo.PENDING);
                long tRest = System.nanoTime(); // REST 항공기 상세가 같은 콜사인을 묻는다 — 진행 중인 WS 읽기에 붙는다
                CompletableFuture<long[]> rest = CompletableFuture.supplyAsync(() -> {
                    RouteInfo r = reader.forCallsign("SYN736");
                    return new long[] {RouteInfo.UNAVAILABLE.equals(r.status()) ? 1 : 0, (System.nanoTime() - tRest) / 1_000_000};
                }, pool);
                for (int i = 1; i <= 3; i++) { // Redis 가 멈춘 동안에도 주기가 그대로
                    int pongs = ofType(f, "pong").size(), diffs = ofType(f, "diff").size(), pings = ofType(f, "ping").size();
                    long ti = System.nanoTime();
                    k.msg(f, "{\"type\":\"ping\"}");
                    k.publish("region", now.plusSeconds(10L * i), ac("aaa001", 35 + 0.1 * i, 129, 30000, now.plusSeconds(10L * i), "adsb_lol"),
                            plane("bbb001", "SYN736", 36, 128, now));
                    k.hub.heartbeat();
                    await(() -> ofType(f, "pong").size() > pongs && ofType(f, "diff").size() > diffs && ofType(f, "ping").size() > pings);
                    assertThat((System.nanoTime() - ti) / 1_000_000).as("round %d while Redis is paused", i).isLessThan(500);
                    k.msg(f, "{\"type\":\"pong\"}");
                }
                await(() -> RouteInfo.UNAVAILABLE.equals(route(ofType(f, "selected").getLast())));
                long ms = (System.nanoTime() - t0) / 1_000_000;
                assertThat(ms).as("unavailable within the bound (the Redis command timeout, %d ms)", COMMAND_TIMEOUT.toMillis())
                        .isBetween(COMMAND_TIMEOUT.toMillis() - 100, COMMAND_TIMEOUT.toMillis() + 2_000);
                assertThat(RouteSelectionLookupTest.outcome(k, "deadline") + RouteSelectionLookupTest.outcome(k, "ok"))
                        .as("one answer — at the deadline or by the command timeout, whichever came first").isEqualTo(1.0);
                long[] r = rest.get(5, TimeUnit.SECONDS);
                assertThat(r[0]).as("REST answered unavailable").isEqualTo(1);
                assertThat(r[1]).as("REST within the Redis command timeout (%d ms)", COMMAND_TIMEOUT.toMillis()).isLessThan(COMMAND_TIMEOUT.toMillis() + 1_000);
            } finally {
                unpause();
            }
            await(() -> s.routeLookup == null || s.routeLookup.settled); // 멈춘 동안의 GET 이 끝났다(명령 상한)
            clock.addAndGet(RouteReader.TTL_MS); // 실패 기억(5 s)이 지나면 다시 읽는다
            k.publish("region", now.plusSeconds(40), ac("aaa001", 35.5, 129, 30000, now.plusSeconds(40), "adsb_lol"),
                    plane("bbb001", "SYN736", 36.1, 128, now.plusSeconds(40)));
            await(() -> RouteInfo.FOUND.equals(route(ofType(f, "selected").getLast())));
            JsonNode found = ofType(f, "selected").getLast();
            assertThat(found.path("route").path("origin").path("icao").asString()).isEqualTo("ZZAA");
        } finally {
            lookups.shutdownNow();
            pool.shutdownNow();
        }
    }
}
