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
