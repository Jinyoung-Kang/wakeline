package dev.wakeline.route;

import dev.wakeline.domain.AircraftState;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import org.junit.jupiter.api.Test;
import org.springframework.data.redis.RedisConnectionFailureException;

import java.time.Instant;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 노선 읽기(계약 v4 §A): 콜사인 정규화(trim·대문자·형식), 콜사인별 5 s 메모리 캐시, Redis 오류 → unavailable, 캐시 상한.
 * 계약 v5 §G21: 캐시만 보는 {@link RouteReader#cached} · 우편함 밖 {@link RouteReader#loadAsync}(같은 콜사인 한 번 읽기 · 거절은 기억하지 않음).
 * Redis 는 가짜(키 → 값) — 값은 합성.
 */
class RouteReaderTest {
    final Map<String, String> redis = new HashMap<>();
    final List<String> gets = new ArrayList<>();
    final AtomicLong clock = new AtomicLong(1_000_000);
    volatile boolean down;
    final RouteReader reader = new RouteReader(key -> {
        gets.add(key);
        if (down) throw new RedisConnectionFailureException("down");
        return redis.get(key);
    }, RouteInfoTest.JSON, clock::get);

    static AircraftState ac(String callsign) {
        Instant t = Instant.parse("2026-09-28T03:00:00Z");
        return new AircraftState("71be01", callsign, null, null, null, 37, 127, 30000, 400.0, 90.0, 0.0, false, null, t, "adsb_fi", t, 0, false);
    }

    @Test void callsignIsTrimmedUppercasedAndValidated() {
        assertThat(RouteReader.normalizeCallsign(" syn736  ")).isEqualTo("SYN736");
        assertThat(RouteReader.normalizeCallsign("AB")).isNull();
        assertThat(RouteReader.normalizeCallsign("ABCDEFGHI")).isNull();
        assertThat(RouteReader.normalizeCallsign("SYN-736")).isNull();
        assertThat(RouteReader.normalizeCallsign("SYN 736")).isNull();
        assertThat(RouteReader.normalizeCallsign(null)).isNull();
        assertThat(reader.forCallsign("  ")).isEqualTo(RouteInfo.noCallsign());
        assertThat(reader.forAircraft(ac(null)).status()).isEqualTo(RouteInfo.NO_CALLSIGN);
        assertThat(reader.forAircraft(null)).as("no state — the callsign is unknown").isNull();
        assertThat(gets).as("an invalid callsign is never looked up").isEmpty();
    }

    /**
     * 계약 v4 §G A-1(리뷰 api-route-locode #1): trim 뒤 ASCII 가 아니면 콜사인 없음 — 대문자 변환 전에 검사한다. 'ı'(U+0131)·'ſ'(U+017F)는
     * 대문자 변환으로 ASCII I·S 가 되어, 검사하지 않으면 다른 항공기(IAB12S)의 노선 키를 읽는다. 수집기(route.normalize_callsign)와 같은 규칙.
     */
    @Test void nonAsciiCallsignIsNoCallsign_evenIfUppercasingWouldMakeItAscii() {
        assertThat("ıab12ſ".toUpperCase(java.util.Locale.ROOT)).as("the trap").isEqualTo("IAB12S");
        for (String raw : new String[]{"ıab12ſ", "zzxı12", "ZZſ123", "ＡＢＣ123", "ABC1２3", "KAL081\u00e9"}) {
            assertThat(RouteReader.normalizeCallsign(raw)).as(raw).isNull();
            assertThat(reader.forCallsign(raw)).as(raw).isEqualTo(RouteInfo.noCallsign());
        }
        assertThat(reader.forAircraft(ac("ıab12ſ")).status()).isEqualTo(RouteInfo.NO_CALLSIGN);
        assertThat(gets).as("never looked up").isEmpty();
        // 앞뒤 ASCII 공백은 trim 으로 빠진다(ASCII 검사는 trim 뒤)
        assertThat(RouteReader.normalizeCallsign("\tsyn736 \n")).isEqualTo("SYN736");
    }

    @Test void readsTheCollectorCacheKey_andCachesPerCallsignForFiveSeconds() {
        RouteInfo pending = reader.forAircraft(ac("syn736 "));
        assertThat(pending.status()).isEqualTo(RouteInfo.PENDING);
        assertThat(pending.callsign()).isEqualTo("SYN736");
        assertThat(gets).containsExactly("wakeline:route:SYN736");

        redis.put("wakeline:route:SYN736", RouteInfoTest.found("SYN736").toString());
        clock.addAndGet(4_999);
        assertThat(reader.forCallsign("SYN736").status()).as("still the cached value").isEqualTo(RouteInfo.PENDING);
        assertThat(gets).hasSize(1);
        clock.addAndGet(1);
        RouteInfo found = reader.forCallsign("SYN736");
        assertThat(found.status()).isEqualTo(RouteInfo.FOUND);
        assertThat(found.origin().icao()).isEqualTo("ZZAA");
        assertThat(gets).hasSize(2);
        assertThat(reader.forCallsign("SYN736")).isSameAs(found);
        // 시계가 뒤로 가면 캐시를 믿지 않는다
        clock.addAndGet(-10_000);
        reader.forCallsign("SYN736");
        assertThat(gets).hasSize(3);
    }

    @Test void redisErrorIsUnavailable_andIsCachedToo() {
        down = true;
        RouteInfo r = reader.forCallsign("SYN9");
        assertThat(r.status()).isEqualTo(RouteInfo.UNAVAILABLE);
        assertThat(r.callsign()).isEqualTo("SYN9");
        reader.forCallsign("SYN9");
        assertThat(gets).hasSize(1);
        down = false;
        redis.put("wakeline:route:SYN9", RouteInfoTest.cached("error", "SYN9").toString());
        clock.addAndGet(RouteReader.TTL_MS);
        assertThat(reader.forCallsign("SYN9").status()).as("collector lookup failed").isEqualTo(RouteInfo.UNAVAILABLE);
        redis.put("wakeline:route:SYN9", "{broken");
        clock.addAndGet(RouteReader.TTL_MS);
        assertThat(reader.forCallsign("SYN9").status()).isEqualTo(RouteInfo.UNAVAILABLE);
    }

    @Test void cacheIsBounded() {
        for (int i = 0; i < RouteReader.MAX_ENTRIES; i++) reader.forCallsign("CS" + i);
        assertThat(reader.cachedEntries()).isEqualTo(RouteReader.MAX_ENTRIES);
        reader.forCallsign("FRESH1"); // 모두 5 s 안 — 치울 것이 없으면 비운다
        assertThat(reader.cachedEntries()).isEqualTo(1);
        for (int i = 0; i < RouteReader.MAX_ENTRIES - 2; i++) reader.forCallsign("DS" + i);
        clock.addAndGet(RouteReader.TTL_MS);
        reader.forCallsign("FRESH2");
        reader.forCallsign("FRESH3"); // 상한에 닿으면 만료된 것만 치운다
        assertThat(reader.cachedEntries()).isEqualTo(2);
    }

    /** 계약 v5 §G21: cached 는 Redis 를 읽지 않는다(우편함에서) — 신선한 캐시만, 없거나 지났으면 null. */
    @Test void cachedNeverReadsRedis() {
        assertThat(reader.cached("SYN736")).isNull();
        assertThat(gets).isEmpty();
        RouteInfo pending = reader.forCallsign("SYN736");
        assertThat(reader.cached("SYN736")).isSameAs(pending);
        clock.addAndGet(RouteReader.TTL_MS);
        assertThat(reader.cached("SYN736")).as("expired").isNull();
        assertThat(gets).hasSize(1);
    }

    /**
     * 같은 콜사인의 동시 읽기는 하나(세션들 · REST): 기다리는 쪽은 진행 중인 읽기의 future 에 붙는다(지표 hit — Redis 를 읽지 않았다). 읽기가 끝나면 결과는
     * 캐시에 있고 진행 중 표시는 지워진다. 캐시 시각은 읽기가 끝난 때다.
     */
    @Test void concurrentLoadsOfOneCallsign_readRedisOnce() throws Exception {
        CountDownLatch hold = new CountDownLatch(1);
        List<String> reads = new CopyOnWriteArrayList<>();
        SimpleMeterRegistry meters = new SimpleMeterRegistry();
        AtomicLong t = new AtomicLong(1_000_000);
        RouteReader r = new RouteReader(key -> {
            reads.add(key);
            try {
                hold.await(10, TimeUnit.SECONDS);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
            t.addAndGet(3_000); // 느린 읽기(3 s — 명령 상한만큼)
            return RouteInfoTest.found("SYN736").toString();
        }, RouteInfoTest.JSON, t::get, meters);
        try (ExecutorService ex = Executors.newVirtualThreadPerTaskExecutor()) {
            CompletableFuture<RouteInfo> a = r.loadAsync("SYN736", ex), b = r.loadAsync("SYN736", ex);
            assertThat(b).as("the same in-flight read").isSameAs(a);
            assertThat(r.inflight()).isEqualTo(1);
            hold.countDown();
            RouteInfo found = a.get(5, TimeUnit.SECONDS);
            assertThat(found.status()).isEqualTo(RouteInfo.FOUND);
            assertThat(reads).hasSize(1);
            assertThat(r.inflight()).isZero();
            assertThat(meters.counter("wakeline_cache_requests_total", "cache", "route", "result", "miss").count()).isEqualTo(1.0);
            assertThat(meters.counter("wakeline_cache_requests_total", "cache", "route", "result", "hit").count()).as("the joined load").isEqualTo(1.0);
            t.addAndGet(RouteReader.TTL_MS - 1);
            assertThat(r.cached("SYN736")).as("cached from the end of the slow read, not its start").isSameAs(found);
            assertThat(r.loadAsync("SYN736", ex)).isCompletedWithValue(found);
            assertThat(reads).hasSize(1);
        }
    }

    /**
     * 리뷰(2026-09-30 · lane-route #1): REST 항공기 상세(forCallsign)는 같은 콜사인의 진행 중 읽기에 붙는다. 그 읽기가 WS 노선 조회 실행기의 대기열에 있으면
     * (Redis 가 멈춰 스레드가 모두 잡힘) 고치기 전에는 그 읽기가 시작해 끝날 때까지 상한 없이 기다렸다(join — 이 시험은 8 s 에 timed out). 붙은 쪽의 기다림도
     * Redis 명령 상한까지(이 시험은 400 ms — 운영은 RedisConfig.COMMAND_TIMEOUT 3 s)이고, 그때까지 끝나지 않으면 unavailable 로 답하고 센다. 진행 중인
     * 읽기(WS 가 기다리는 future)는 건드리지 않는다 — 풀리면 제 값으로 끝나고 캐시를 채운다.
     */
    @Test void restJoiningAQueuedWsRead_waitsAtMostTheRedisCommandTimeout() throws Exception {
        CountDownLatch hold = new CountDownLatch(1);
        SimpleMeterRegistry meters = new SimpleMeterRegistry();
        RouteReader r = new RouteReader(key -> {
            try {
                hold.await(30, TimeUnit.SECONDS); // 멈춘 Redis
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
            return RouteInfoTest.found(key.substring(RouteReader.KEY_PREFIX.length())).toString();
        }, RouteInfoTest.JSON, System::currentTimeMillis, meters, java.time.Duration.ofMillis(400));
        ExecutorService ws = Executors.newSingleThreadExecutor(); // WS 노선 조회 실행기 — 스레드 하나를 멈춘 읽기가 잡고 있다
        try {
            CompletableFuture<RouteInfo> busy = r.loadAsync("SYN1", ws);
            CompletableFuture<RouteInfo> queued = r.loadAsync("SYN2", ws); // 대기열에서 기다린다(아직 시작하지 않았다)
            long t0 = System.nanoTime();
            RouteInfo rest = org.junit.jupiter.api.Assertions.assertTimeoutPreemptively(java.time.Duration.ofSeconds(8), () -> r.forCallsign("SYN2"),
                    "REST must not wait for a queued WS read beyond the Redis command timeout");
            long ms = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - t0);
            assertThat(rest).isEqualTo(RouteInfo.unavailable("SYN2"));
            assertThat(ms).as("waited about the command timeout (400 ms), not until the queued read ran").isBetween(380L, 2_000L);
            assertThat(meters.counter("wakeline_route_read_wait_timeouts_total").count()).isEqualTo(1.0);
            assertThat(queued).as("the shared read is not completed by the REST timeout").isNotDone();
            assertThat(r.cached("SYN2")).as("the REST timeout is not remembered").isNull();
            hold.countDown();
            assertThat(busy.get(5, TimeUnit.SECONDS).status()).isEqualTo(RouteInfo.FOUND);
            assertThat(queued.get(5, TimeUnit.SECONDS).status()).as("the WS read still ends with its own value").isEqualTo(RouteInfo.FOUND);
            assertThat(r.forCallsign("SYN2").status()).as("then from the cache").isEqualTo(RouteInfo.FOUND);
            assertThat(meters.counter("wakeline_route_read_wait_timeouts_total").count()).isEqualTo(1.0);
        } finally {
            hold.countDown();
            ws.shutdownNow();
        }
    }

    /** 명령 상한의 기본값은 RedisConfig 의 기본값(spring.data.redis.timeout 이 없을 때 3 s)이고, 0 이하(상한 없음)는 받지 않는다. */
    @Test void theWaitBoundDefaultsToTheRedisConfigDefault_andMustBePositive() {
        assertThat(reader.commandTimeout()).isEqualTo(dev.wakeline.config.RedisConfig.DEFAULT_COMMAND_TIMEOUT).isEqualTo(java.time.Duration.ofSeconds(3));
        for (java.time.Duration bad : new java.time.Duration[] {null, java.time.Duration.ZERO, java.time.Duration.ofMillis(-1)})
            org.assertj.core.api.Assertions.assertThatThrownBy(() -> new RouteReader(k -> null, RouteInfoTest.JSON, clock::get, new SimpleMeterRegistry(), bad))
                    .as(String.valueOf(bad)).isInstanceOf(IllegalArgumentException.class);
    }

    /**
     * 운영 생성자(@Autowired — 스프링이 만든다): 명령 상한은 기본 Redis 연결과 같은 설정 식(RedisConfig.COMMAND_TIMEOUT)에서 온다 — 3 s 가 아닌 값으로 확인하고,
     * 설정이 없으면 RedisConfig 와 같은 기본 3 s. 템플릿의 연결은 맺지 않는다(이 시험은 읽지 않는다).
     */
    @Test void theProductionConstructor_takesTheWaitFromTheRedisCommandTimeoutProperty() {
        Map<Map<String, Object>, Long> cases = new java.util.LinkedHashMap<>();
        cases.put(Map.of("spring.data.redis.timeout", "2500ms"), 2_500L);
        cases.put(Map.of("spring.data.redis.timeout", "2"), 2L); // 단위가 없으면 ms(Boot 의 Duration 해석과 같다)
        cases.put(Map.of(), 3_000L);
        cases.forEach((props, ms) -> {
            try (var ctx = new org.springframework.context.annotation.AnnotationConfigApplicationContext()) {
                ctx.getEnvironment().getPropertySources().addFirst(new org.springframework.core.env.MapPropertySource("test", props));
                ctx.registerBean(tools.jackson.databind.ObjectMapper.class, () -> RouteInfoTest.JSON);
                ctx.registerBean(io.micrometer.core.instrument.MeterRegistry.class, SimpleMeterRegistry::new);
                ctx.registerBean(org.springframework.data.redis.core.StringRedisTemplate.class, () -> new org.springframework.data.redis.core.StringRedisTemplate(
                        new org.springframework.data.redis.connection.lettuce.LettuceConnectionFactory()));
                ctx.register(RouteReader.class);
                ctx.refresh();
                assertThat(ctx.getBean(RouteReader.class).commandTimeout().toMillis()).as(props.toString()).isEqualTo(ms);
            }
        });
    }

    /** 실행기가 거절하면(대기열 가득 · 종료) future 가 RejectedExecutionException 으로 끝나고 아무것도 기억하지 않는다 — 다음 읽기가 다시 읽는다. */
    @Test void aRejectedLoadIsNotRemembered() {
        CompletableFuture<RouteInfo> f = reader.loadAsync("SYN9", r -> { throw new RejectedExecutionException("full"); });
        assertThat(f).isCompletedExceptionally();
        assertThat(f.handle((v, e) -> e instanceof CompletionException c ? c.getCause() : e).join()).isInstanceOf(RejectedExecutionException.class);
        assertThat(reader.inflight()).isZero();
        assertThat(reader.cached("SYN9")).isNull();
        assertThat(gets).isEmpty();
        assertThat(reader.forCallsign("SYN9").status()).as("read now").isEqualTo(RouteInfo.PENDING);
        assertThat(gets).hasSize(1);
    }
}
