package dev.wakeline.portcalls;

import dev.wakeline.domain.ShipState;
import dev.wakeline.domain.ShipStatic;
import dev.wakeline.ingest.ShipStore;
import dev.wakeline.route.RouteInfoTest;
import org.junit.jupiter.api.Test;
import org.springframework.data.redis.RedisConnectionFailureException;
import tools.jackson.databind.JsonNode;

import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicLong;
import java.util.function.Function;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 입출항 읽기(ADR-022): 호출부호 정규화(수집기와 같은 벡터), 호출부호별 5 s 메모리 캐시, Redis 오류 → error(cache), 캐시 상한,
 * MMSI → 호출부호(카드와 같은 정적 정보). Redis 는 가짜(키 → 값).
 */
class PortCallReaderTest {
    static final Path VECTORS = Path.of("../../schemas/vectors/call-sign-cases.v1.json").toAbsolutePath().normalize();

    final Map<String, String> redis = new HashMap<>();
    final List<String> gets = new ArrayList<>();
    final AtomicLong clock = new AtomicLong(1_000_000);
    volatile boolean down;
    final PortCallReader reader = new PortCallReader(key -> {
        gets.add(key);
        if (down) throw new RedisConnectionFailureException("down");
        return redis.get(key);
    }, RouteInfoTest.JSON, clock::get);

    @Test void callSignRuleMatchesTheSharedVectors() throws Exception {
        JsonNode doc = RouteInfoTest.JSON.readTree(Files.readString(VECTORS));
        assertThat(doc.path("version").asInt()).isEqualTo(1);
        assertThat(doc.path("cases").size()).isGreaterThanOrEqualTo(15);
        for (JsonNode c : doc.path("cases")) {
            String in = c.path("input").isNull() ? null : c.path("input").asString();
            String want = c.path("expected").isNull() ? null : c.path("expected").asString();
            assertThat(PortCallReader.normalizeCallSign(in)).as(String.valueOf(in)).isEqualTo(want);
        }
    }

    @Test void invalidCallSignIsNeverLookedUp() {
        assertThat(reader.forCallSign("AB")).isEqualTo(PortCallsInfo.noCallSign());
        assertThat(reader.forCallSign(null).status()).isEqualTo("no_call_sign");
        assertThat(reader.forStatic(null).status()).as("static not received yet — the call sign is unknown, not absent").isEqualTo("no_static");
        assertThat(gets).isEmpty();
    }

    @Test void readsTheCollectorKey_andCachesPerCallSignForFiveSeconds() {
        assertThat(reader.forCallSign(" 230025 ").status()).isEqualTo("pending");
        redis.put("wakeline:portcalls:230025", PortCallsInfoTest.sample().toString());
        assertThat(reader.forCallSign("230025").status()).as("still the cached pending for 5 s").isEqualTo("pending");
        clock.addAndGet(PortCallReader.TTL_MS);
        PortCallsInfo ok = reader.forCallSign("230025");
        assertThat(ok.status()).isEqualTo("ok");
        assertThat(reader.forCallSign("230025")).isSameAs(ok);
        assertThat(gets).containsExactly("wakeline:portcalls:230025", "wakeline:portcalls:230025");
        clock.addAndGet(-10_000); // 시계가 뒤로 가면 캐시를 믿지 않는다
        reader.forCallSign("230025");
        assertThat(gets).hasSize(3);
    }

    @Test void redisErrorIsACacheError_andIsCachedToo() {
        down = true;
        PortCallsInfo e = reader.forCallSign("230025");
        assertThat(e.status()).isEqualTo("error");
        assertThat(e.errorKind()).isEqualTo("cache");
        down = false;
        assertThat(reader.forCallSign("230025")).isSameAs(e);
        redis.put("wakeline:portcalls:230025", "{broken");
        clock.addAndGet(PortCallReader.TTL_MS);
        assertThat(reader.forCallSign("230025").errorKind()).isEqualTo("cache");
    }

    /** 수요 한도(DemandService)가 세지 않는 호출부호 = 캐시에 수집기의 결과가 있다(새 조회를 일으키지 않는다). 캐시를 읽지 못하면 모른다(false). */
    @Test void known_isTrueOnlyForACollectorResult() {
        String key = "wakeline:portcalls:230025";
        assertThat(reader.known("230025")).as("no value yet — a lookup is needed").isFalse();
        String[] values = {
                PortCallsInfoTest.sample().toString(),
                PortCallsInfoTest.sample().put("status", "none").toString(),
                PortCallsInfoTest.sample().put("status", "error").put("error_kind", "http").toString(),
                PortCallsInfoTest.sample().put("status", "disabled").put("reason", "no_key").toString()};
        for (String v : values) {
            redis.put(key, v);
            clock.addAndGet(PortCallReader.TTL_MS);
            assertThat(reader.known("230025")).as(v).isTrue();
        }
        redis.put(key, "{broken");
        clock.addAndGet(PortCallReader.TTL_MS);
        assertThat(reader.known("230025")).as("unreadable value — unknown").isFalse();
        down = true;
        clock.addAndGet(PortCallReader.TTL_MS);
        assertThat(reader.known("230025")).as("Redis down — unknown").isFalse();
        assertThat(reader.known("AB")).as("not a call sign").isFalse();
    }

    @Test void cacheIsBounded() {
        for (int i = 0; i < PortCallReader.MAX_ENTRIES + 10; i++) reader.forCallSign(String.format("CS%05d", i));
        assertThat(reader.cached()).isLessThanOrEqualTo(PortCallReader.MAX_ENTRIES);
    }

    @Test void mmsiToCallSign_usesTheSameStaticAsTheCard() {
        ShipStore store = new ShipStore();
        Instant t = Instant.parse("2026-09-29T03:00:00Z");
        ShipState live = new ShipState("440000001", 35.1, 129.1, 0.0, null, null, 5, null, "epfs", t, "aisstream", "PositionReport", "A");
        ShipStatic st = new ShipStatic("440000001", "BUKWANG 9", " 230025 ", null, 80, null, null, null, null, null, null, null, null, null, null, t,
                "aisstream");
        ShipStatic noCs = new ShipStatic("440000002", "NO CS", null, null, 70, null, null, null, null, null, null, null, null, null, null, t, "aisstream");
        store.apply(List.of(live), List.of(st, noCs), t, "aisstream", t.toEpochMilli());
        Function<String, String> cs = PortCallReader.callSigns(store);
        assertThat(cs.apply("440000001")).isEqualTo("230025");
        assertThat(cs.apply("440000002")).as("static without a call sign").isNull();
        assertThat(cs.apply("440000009")).as("unknown ship").isNull();
        assertThat(reader.forStatic(st).status()).isEqualTo("pending");
    }
}
