package dev.wakeline.route;

import dev.wakeline.domain.AircraftState;
import org.junit.jupiter.api.Test;
import org.springframework.data.redis.RedisConnectionFailureException;

import java.time.Instant;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicLong;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 노선 읽기(계약 v4 §A): 콜사인 정규화(trim·대문자·형식), 콜사인별 5 s 메모리 캐시, Redis 오류 → unavailable, 캐시 상한.
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
        assertThat(reader.cached()).isEqualTo(RouteReader.MAX_ENTRIES);
        reader.forCallsign("FRESH1"); // 모두 5 s 안 — 치울 것이 없으면 비운다
        assertThat(reader.cached()).isEqualTo(1);
        for (int i = 0; i < RouteReader.MAX_ENTRIES - 2; i++) reader.forCallsign("DS" + i);
        clock.addAndGet(RouteReader.TTL_MS);
        reader.forCallsign("FRESH2");
        reader.forCallsign("FRESH3"); // 상한에 닿으면 만료된 것만 치운다
        assertThat(reader.cached()).isEqualTo(2);
    }
}
