package dev.wakeline.route;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.annotation.JsonProperty;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.format.DateTimeParseException;
import java.util.regex.Pattern;

/**
 * 항공기 등록 노선(계약 v4 §A · ADR-016) — WS selected 와 REST 항공기 상세의 route.
 * status: found | not_found | pending(캐시 없음 — 선택 직후) | unavailable(수집기 조회 실패 또는 Redis 오류·읽을 수 없는 값) | no_callsign |
 * disabled(계약 v4 §G A-2 — fixture 모드이거나 운영자가 adsbdb 를 꺼서 수집기가 묻지 않았다).
 * 콜사인에 등록된 정기 노선이며 실제 운항 경로가 아닐 수 있다(화면이 밝힌다). 값이 없으면 키 없음. source 는 항상 "adsbdb".
 * <p>수집기가 wakeline:route:{CALLSIGN} 에 쓴 값은 믿지 않고 다시 검사한다: 코드 형식·좌표 범위를 통과하지 못한 공항은 버리고,
 * 문자열은 제어문자를 빼고 길이를 자른다. 출발·도착 공항이 둘 다 없으면 not_found.
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record RouteInfo(String status, String callsign, Airline airline, Airport origin, Airport destination, Airport midpoint,
                        @JsonProperty("fetched_at") Instant fetchedAt, String source) {
    public static final String SOURCE = "adsbdb";
    public static final String FOUND = "found";
    public static final String NOT_FOUND = "not_found";
    public static final String PENDING = "pending";
    public static final String UNAVAILABLE = "unavailable";
    public static final String NO_CALLSIGN = "no_callsign";
    public static final String DISABLED = "disabled";
    /** 캐시 값 크기 상한(공항 셋 + 항공사 — 보통 2 KB 안팎). */
    static final int MAX_RAW = 16 * 1024;
    static final int NAME_MAX = 120;
    static final int PLACE_MAX = 80;
    static final Pattern AIRPORT_ICAO = Pattern.compile("^[A-Z0-9]{4}$");
    static final Pattern AIRPORT_IATA = Pattern.compile("^[A-Z0-9]{3}$");
    static final Pattern COUNTRY_ISO = Pattern.compile("^[A-Z]{2}$");
    static final Pattern AIRLINE_ICAO = Pattern.compile("^[A-Z0-9]{3}$");
    static final Pattern AIRLINE_IATA = Pattern.compile("^[A-Z0-9]{2}$");

    /** 항공사(값이 모두 없으면 airline 자체가 없다). */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record Airline(String name, String icao, String iata) {}

    /** 공항: icao·name·lat·lon 은 반드시 있다. */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record Airport(String icao, String iata, String name, String city, String country,
                          @JsonProperty("country_iso") String countryIso, double lat, double lon) {}

    public static RouteInfo noCallsign() { return new RouteInfo(NO_CALLSIGN, null, null, null, null, null, null, SOURCE); }

    public static RouteInfo pending(String callsign) { return status(PENDING, callsign, null); }

    public static RouteInfo unavailable(String callsign) { return status(UNAVAILABLE, callsign, null); }

    /** 조회하지 않았다(운영 설정) — 조회 결과가 아니므로 fetched_at 도 없다. */
    static RouteInfo disabled(String callsign) { return status(DISABLED, callsign, null); }

    static RouteInfo notFound(String callsign, Instant fetchedAt) { return status(NOT_FOUND, callsign, fetchedAt); }

    private static RouteInfo status(String status, String callsign, Instant fetchedAt) {
        return new RouteInfo(status, callsign, null, null, null, null, fetchedAt, SOURCE);
    }

    /**
     * 캐시 원문 → 값. raw 가 null 이면 pending(아직 조회 전). 형식이 틀리면(버전·상태·콜사인 불일치 포함) unavailable —
     * 읽을 수 없는 값을 '노선 없음' 으로 말하지 않는다. 캐시 status error 도 unavailable, disabled(묻지 않음)는 disabled.
     */
    public static RouteInfo fromCache(String callsign, String raw, ObjectMapper json) {
        if (raw == null) return pending(callsign);
        if (raw.isEmpty() || raw.length() > MAX_RAW) return unavailable(callsign);
        JsonNode n;
        try {
            n = json.readTree(raw);
        } catch (RuntimeException e) {
            return unavailable(callsign);
        }
        if (n == null || !n.isObject()) return unavailable(callsign);
        JsonNode v = n.get("v");
        if (v == null || !v.isIntegralNumber() || v.asLong() != 1) return unavailable(callsign);
        JsonNode cs = n.get("callsign");
        if (cs == null || !cs.isString() || !callsign.equals(cs.asString())) return unavailable(callsign);
        JsonNode st = n.get("status");
        String status = st != null && st.isString() ? st.asString() : "";
        Instant fetchedAt = time(n.get("fetched_at"));
        return switch (status) {
            case "not_found" -> notFound(callsign, fetchedAt);
            case "disabled" -> disabled(callsign);
            case "found" -> {
                Airport origin = airport(n.get("origin")), destination = airport(n.get("destination"));
                if (origin == null && destination == null) yield notFound(callsign, fetchedAt);
                yield new RouteInfo(FOUND, callsign, airline(n.get("airline")), origin, destination, airport(n.get("midpoint")), fetchedAt, SOURCE);
            }
            default -> unavailable(callsign); // "error" 또는 모르는 상태
        };
    }

    static Airline airline(JsonNode n) {
        if (n == null || !n.isObject()) return null;
        String name = text(n.get("name"), NAME_MAX);
        String icao = code(n.get("icao"), AIRLINE_ICAO);
        String iata = code(n.get("iata"), AIRLINE_IATA);
        return name == null && icao == null && iata == null ? null : new Airline(name, icao, iata);
    }

    /** 공항 하나 — icao 형식·이름·좌표 범위 중 하나라도 틀리면 null. 선택 필드는 틀리면 그 필드만 null. */
    static Airport airport(JsonNode n) {
        if (n == null || !n.isObject()) return null;
        String icao = code(n.get("icao"), AIRPORT_ICAO);
        String name = text(n.get("name"), NAME_MAX);
        Double lat = number(n.get("lat"), 90), lon = number(n.get("lon"), 180);
        if (icao == null || name == null || lat == null || lon == null) return null;
        return new Airport(icao, code(n.get("iata"), AIRPORT_IATA), name, text(n.get("city"), PLACE_MAX), text(n.get("country"), PLACE_MAX),
                code(n.get("country_iso"), COUNTRY_ISO), lat, lon);
    }

    private static String code(JsonNode n, Pattern p) {
        return n != null && n.isString() && p.matcher(n.asString()).matches() ? n.asString() : null;
    }

    private static Double number(JsonNode n, double limit) {
        if (n == null || !n.isNumber()) return null;
        double d = n.asDouble();
        return Double.isFinite(d) && d >= -limit && d <= limit ? d : null;
    }

    /**
     * 문자열: 제어·서식 문자(방향 바꾸기 포함)를 빼고 앞뒤 공백을 지운 뒤 max 글자(코드포인트)로 자른다. 비면 null.
     * 수집기가 쓴 다른 캐시 값(한국 항만 입출항 — {@code dev.wakeline.portcalls.PortCallsInfo})도 같은 규칙으로 다시 검사한다.
     */
    public static String text(JsonNode n, int max) {
        if (n == null || !n.isString()) return null;
        String s = n.asString();
        StringBuilder b = new StringBuilder(Math.min(s.length(), max + 8));
        s.codePoints().filter(cp -> {
            int t = Character.getType(cp);
            return t != Character.CONTROL && t != Character.FORMAT;
        }).forEach(b::appendCodePoint);
        String out = b.toString().strip();
        if (out.codePointCount(0, out.length()) > max) out = out.substring(0, out.offsetByCodePoints(0, max)).strip();
        return out.isEmpty() ? null : out;
    }

    /** 시간대가 있는 ISO-8601 시각만. 틀리면 null(모름). */
    public static Instant time(JsonNode n) {
        if (n == null || !n.isString() || n.asString().length() > 40) return null;
        try {
            return OffsetDateTime.parse(n.asString()).toInstant();
        } catch (DateTimeParseException e) {
            return null;
        }
    }
}
