package dev.wakeline.route;

import com.fasterxml.jackson.annotation.JsonInclude;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.PropertyNamingStrategies;
import tools.jackson.databind.json.JsonMapper;
import tools.jackson.databind.node.JsonNodeFactory;
import tools.jackson.databind.node.ObjectNode;

import java.time.Instant;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 노선 캐시 값 다시 검사(계약 v4 §A): 수집기가 쓴 wakeline:route:{CALLSIGN} 값을 믿지 않는다. 값은 모두 합성(실제 노선 자료가 아니다).
 */
public class RouteInfoTest {
    public static final ObjectMapper JSON = JsonMapper.builder()
            .propertyNamingStrategy(PropertyNamingStrategies.SNAKE_CASE)
            .changeDefaultPropertyInclusion(i -> i.withValueInclusion(JsonInclude.Include.NON_NULL))
            .build();
    static final JsonNodeFactory F = JsonNodeFactory.instance;

    /** 합성 공항(가상 코드·좌표). */
    static ObjectNode airport(String icao, String iata, String name, double lat, double lon) {
        ObjectNode a = F.objectNode();
        a.put("icao", icao);
        if (iata != null) a.put("iata", iata);
        a.put("name", name);
        a.put("city", "Testville");
        a.put("country", "Testland");
        a.put("country_iso", "ZZ");
        a.put("lat", lat);
        a.put("lon", lon);
        return a;
    }

    /** 수집기 캐시 값 모양(계약 v4 §A) — 합성. */
    public static ObjectNode cached(String status, String callsign) {
        ObjectNode n = F.objectNode();
        n.put("v", 1);
        n.put("status", status);
        n.put("callsign", callsign);
        n.put("fetched_at", "2026-09-28T03:21:00+00:00");
        n.putNull("airline");
        n.putNull("origin");
        n.putNull("destination");
        n.putNull("midpoint");
        return n;
    }

    public static ObjectNode found(String callsign) {
        ObjectNode n = cached("found", callsign);
        ObjectNode al = F.objectNode();
        al.put("name", "Synthetic Air");
        al.put("icao", "SYN");
        al.put("iata", "S9");
        n.set("airline", al);
        n.set("origin", airport("ZZAA", "ZAA", "Alpha Test Airport", 37.5, 126.8));
        n.set("destination", airport("ZZBB", null, "Bravo Test Airport", 34.4, 135.2));
        return n;
    }

    static RouteInfo parse(String callsign, JsonNode n) { return RouteInfo.fromCache(callsign, n.toString(), JSON); }

    @Test void foundIsRevalidated() {
        RouteInfo r = parse("SYN736", found("SYN736"));
        assertThat(r.status()).isEqualTo(RouteInfo.FOUND);
        assertThat(r.callsign()).isEqualTo("SYN736");
        assertThat(r.source()).isEqualTo("adsbdb");
        assertThat(r.fetchedAt()).isEqualTo(Instant.parse("2026-09-28T03:21:00Z"));
        assertThat(r.airline()).isEqualTo(new RouteInfo.Airline("Synthetic Air", "SYN", "S9"));
        assertThat(r.origin()).isEqualTo(new RouteInfo.Airport("ZZAA", "ZAA", "Alpha Test Airport", "Testville", "Testland", "ZZ", 37.5, 126.8));
        assertThat(r.destination().iata()).isNull();
        assertThat(r.midpoint()).isNull();
    }

    @Test void serializesSnakeCaseWithoutNullKeys() {
        JsonNode j = JSON.valueToTree(parse("SYN736", found("SYN736")));
        assertThat(j.path("fetched_at").asString()).isEqualTo("2026-09-28T03:21:00Z");
        assertThat(j.path("origin").path("country_iso").asString()).isEqualTo("ZZ");
        assertThat(j.path("destination").has("iata")).isFalse();
        assertThat(j.has("midpoint")).isFalse();
        assertThat(j.path("source").asString()).isEqualTo("adsbdb");
        // 이름 전략이 없는 매퍼(단독 MockMvc 등)에서도 같은 키
        JsonNode plain = JsonMapper.builder().build().valueToTree(RouteInfo.pending("SYN736"));
        assertThat(plain.has("fetched_at")).isFalse();
        assertThat(plain.has("airline")).isFalse();
        assertThat(JsonMapper.builder().build().valueToTree(parse("SYN736", found("SYN736"))).has("fetched_at")).isTrue();
    }

    @Test void pendingUnavailableAndNotFound() {
        assertThat(RouteInfo.fromCache("SYN1", null, JSON).status()).isEqualTo(RouteInfo.PENDING);
        assertThat(RouteInfo.noCallsign().callsign()).isNull();
        RouteInfo nf = parse("SYN1", cached("not_found", "SYN1"));
        assertThat(nf.status()).isEqualTo(RouteInfo.NOT_FOUND);
        assertThat(nf.fetchedAt()).isNotNull();
        assertThat(nf.origin()).isNull();
        // 조회 실패는 '노선 없음' 이 아니라 '실패'
        assertThat(parse("SYN1", cached("error", "SYN1")).status()).isEqualTo(RouteInfo.UNAVAILABLE);
        // 형식이 틀린 값도 실패로(없다고 말하지 않는다)
        for (String bad : new String[]{"", "not json", "[]", "{}", "{\"v\":2,\"status\":\"found\",\"callsign\":\"SYN1\"}",
                "{\"v\":\"1\",\"status\":\"not_found\",\"callsign\":\"SYN1\"}", "{\"v\":1,\"status\":\"weird\",\"callsign\":\"SYN1\"}",
                "{\"v\":1,\"status\":\"not_found\",\"callsign\":\"OTHER\"}", "{\"v\":1,\"status\":\"not_found\"}",
                "{\"v\":1,\"status\":7,\"callsign\":\"SYN1\"}", "x".repeat(RouteInfo.MAX_RAW + 1)}) {
            RouteInfo r = RouteInfo.fromCache("SYN1", bad, JSON);
            assertThat(r.status()).as(bad.length() > 40 ? "oversized" : bad).isEqualTo(RouteInfo.UNAVAILABLE);
            assertThat(r.callsign()).isEqualTo("SYN1");
        }
    }

    @Test void invalidAirportsAreDropped_noOriginOrDestinationMeansNotFound() {
        ObjectNode n = found("SYN2");
        n.set("origin", airport("zzaa", "ZAA", "Lower", 37, 127));             // 소문자 ICAO
        n.set("midpoint", airport("ZZCC", "ZCC", "Mid", 91, 0));               // 위도 범위 밖
        RouteInfo r = parse("SYN2", n);
        assertThat(r.status()).isEqualTo(RouteInfo.FOUND);
        assertThat(r.origin()).isNull();
        assertThat(r.destination().icao()).isEqualTo("ZZBB");
        assertThat(r.midpoint()).isNull();

        ObjectNode none = found("SYN3");
        ObjectNode noName = airport("ZZDD", "ZDD", "x", 1, 2);
        noName.remove("name");
        none.set("origin", noName);
        ObjectNode textLat = airport("ZZEE", "ZEE", "y", 1, 2);
        textLat.put("lat", "1.0");
        none.set("destination", textLat);
        none.set("midpoint", airport("ZZFF", "ZFF", "Only Midpoint", 1, 2));
        RouteInfo nf = parse("SYN3", none);
        assertThat(nf.status()).isEqualTo(RouteInfo.NOT_FOUND);
        assertThat(nf.midpoint()).as("a lone midpoint is not a route").isNull();
        assertThat(nf.airline()).isNull();

        ObjectNode weird = found("SYN4");
        weird.put("origin", "ZZAA");
        ObjectNode lon = airport("ZZGG", "ZGG", "Far", 0, 180.5);
        weird.set("destination", lon);
        assertThat(parse("SYN4", weird).status()).isEqualTo(RouteInfo.NOT_FOUND);
    }

    @Test void optionalFieldsFailIndividually() {
        ObjectNode n = found("SYN5");
        ObjectNode o = airport("ZZAA", "ZA", "Alpha", 10, 20); // IATA 2자
        o.put("country_iso", "zzz");
        o.put("city", 42);
        o.putNull("country");
        n.set("origin", o);
        ObjectNode al = F.objectNode();
        al.put("icao", "SY");  // 3자가 아님
        al.put("iata", "S9X"); // 2자가 아님
        al.put("name", "  ");
        n.set("airline", al);
        n.put("fetched_at", "2026-09-28T03:21:00"); // 시간대 없음
        RouteInfo r = parse("SYN5", n);
        assertThat(r.origin()).isEqualTo(new RouteInfo.Airport("ZZAA", null, "Alpha", null, null, null, 10, 20));
        assertThat(r.airline()).as("nothing valid left").isNull();
        assertThat(r.fetchedAt()).isNull();
        ObjectNode partial = F.objectNode();
        partial.put("icao", "SYN");
        n.set("airline", partial);
        assertThat(parse("SYN5", n).airline()).isEqualTo(new RouteInfo.Airline(null, "SYN", null));
        n.put("airline", "Synthetic");
        assertThat(parse("SYN5", n).airline()).isNull();
        n.put("fetched_at", "2026-09-28T03:21:00.123456Z");
        assertThat(parse("SYN5", n).fetchedAt()).isEqualTo(Instant.parse("2026-09-28T03:21:00.123456Z"));
        n.put("fetched_at", "x".repeat(41));
        assertThat(parse("SYN5", n).fetchedAt()).isNull();
    }

    @Test void textIsStrippedOfControlAndFormatCharactersAndTruncated() {
        ObjectNode n = found("SYN6");
        ObjectNode o = airport("ZZAA", "ZAA", "‮Evil\u0007 Name​ ", 10, 20);
        o.put("city", "C".repeat(200));
        n.set("origin", o);
        ObjectNode d = airport("ZZBB", "ZBB", "\u0001\u0002", 10, 20); // 지우면 빈 이름 → 공항 없음
        n.set("destination", d);
        RouteInfo r = parse("SYN6", n);
        assertThat(r.origin().name()).isEqualTo("Evil Name");
        assertThat(r.origin().city()).hasSize(RouteInfo.PLACE_MAX);
        assertThat(r.destination()).isNull();
        // 코드포인트 기준으로 자른다(서로게이트 쌍을 가르지 않는다)
        ObjectNode e = found("SYN7");
        e.set("origin", airport("ZZAA", "ZAA", "🛫".repeat(130), 10, 20));
        String name = parse("SYN7", e).origin().name();
        assertThat(name.codePointCount(0, name.length())).isEqualTo(RouteInfo.NAME_MAX);
    }
}
