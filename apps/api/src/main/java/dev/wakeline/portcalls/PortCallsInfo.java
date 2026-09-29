package dev.wakeline.portcalls;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.annotation.JsonProperty;
import dev.wakeline.route.RouteInfo;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

import java.time.Instant;
import java.time.LocalDate;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * 선택 선박의 한국 항만 입출항(ADR-022) — WS ship_selected.port_calls. 원천은 해양수산부 선박운항정보(PORT-MIS, 공공데이터포털)이고
 * 조회는 수집기만 한다(ADR-001). 수집기가 wakeline:portcalls:{호출부호} 에 쓴 값을 믿지 않고 다시 검사한다:
 * <ul>
 *   <li>status: ok · none(최근 30일 기록 없음) · pending(캐시 없음 — 조회 전·조회 중) · error(수집기 조회 실패, 또는 캐시를 읽을 수 없음 → error_kind cache) ·
 *       disabled(묻지 않음 — disabled_reason no_key · fixture · operator) · no_call_sign(정적 정보에 호출부호가 없거나 형식 밖 — 조회하지 않는다) ·
 *       no_static(AIS 정적 정보를 아직 받지 못해 호출부호를 모른다 — 받으면 조회) · limited(캐시가 비었는데 이 세션의 조회가 남용 한도에 걸려
 *       임대에 오르지 않았다 — limited_by session · ip · capacity. 조회 중이 아니다). 뒤의 세 상태는 api 만 안다(수집기 값에 있으면 읽을 수 없는 값).</li>
 *   <li>공개 화면에는 수집기의 오류 원문을 싣지 않는다 — 종류(error_kind)와 모양을 검사한 코드(error_code: HTTP 상태 · resultCode)만.
 *       원문(예산 수치 등)은 운영 화면 공급자 상태·로그에만 있다.</li>
 *   <li>items: 최근 신고 순(시각 모름은 뒤) · 최대 {@value #MAX_ITEMS}건. 코드는 모양만 검사하고, 문자열은 제어·서식 문자를 빼고 자른다
 *       ({@link RouteInfo#text}). 모르는 값은 키 없음(null) — 지어 채우지 않는다. reported_name 은 PORT-MIS 에 신고된 선명(AIS 선명과 다를 수 있다 —
 *       화면이 비교해 밝힌다).</li>
 *   <li>entry_at · exit_at 은 같은 종류의 신고 시각이 하나로 정해질 때만(수집기 규칙). 여럿이면 null 이고 reports 에 신고가 모두 있다.</li>
 * </ul>
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record PortCallsInfo(String status, @JsonProperty("call_sign") String callSign, @JsonProperty("fetched_at") Instant fetchedAt,
                            @JsonProperty("window_days") int windowDays, @JsonProperty("window_from") String windowFrom,
                            @JsonProperty("window_to") String windowTo, String source, List<PortCall> items, Boolean truncated, Boolean incomplete,
                            @JsonProperty("error_kind") String errorKind, @JsonProperty("error_code") String errorCode,
                            @JsonProperty("disabled_reason") String disabledReason, @JsonProperty("limited_by") String limitedBy) {
    public static final String SOURCE = "해양수산부 선박운항정보(PORT-MIS)";
    public static final int WINDOW_DAYS = 30;
    public static final int MAX_ITEMS = 20;
    static final int MAX_REPORTS = 8;
    static final int TEXT_MAX = 80;
    /** 캐시 값 크기 상한(20건 × 신고 몇 개 — 보통 10 KB 안팎). */
    static final int MAX_RAW = 64 * 1024;

    public static final String OK = "ok";
    public static final String NONE = "none";
    public static final String PENDING = "pending";
    public static final String ERROR = "error";
    public static final String DISABLED = "disabled";
    public static final String NO_CALL_SIGN = "no_call_sign";
    public static final String NO_STATIC = "no_static";
    public static final String LIMITED = "limited";
    /** limited 의 이유: 세션 한도 · 접속 주소(IP) 한도 · 서버 상한(임대 20개 · IP 표). */
    public static final Set<String> LIMITED_BY = Set.of("session", "ip", "capacity");
    /** api 가 캐시 값을 읽지 못함(Redis 오류 · 형식이 다른 값). 나머지는 수집기가 쓴 종류 그대로. */
    public static final String KIND_CACHE = "cache";
    static final Set<String> ERROR_KINDS = Set.of("budget", "rate_limited", "http", "provider", "response", "network", "internal", KIND_CACHE);
    static final Set<String> DISABLED_REASONS = Set.of("no_key", "fixture", "operator");

    static final Pattern CALL_SIGN = Pattern.compile("^[A-Z0-9]{3,7}$");
    static final Pattern PORT_AUTHORITY_CODE = Pattern.compile("^[0-9]{3}$");
    static final Pattern PORT_CODE = Pattern.compile("^[A-Z0-9]{2,10}$");
    static final Pattern ERROR_CODE = Pattern.compile("^[A-Za-z0-9_]{1,16}$");
    static final Pattern DATE = Pattern.compile("^[0-9]{4}-[0-9]{2}-[0-9]{2}$");

    /** 입출항 한 건(수집기 값의 items[]). */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record PortCall(@JsonProperty("port_authority_code") String portAuthorityCode, @JsonProperty("port_authority") String portAuthority,
                           @JsonProperty("entry_at") Instant entryAt, @JsonProperty("exit_at") Instant exitAt, List<Report> reports, String purpose,
                           @JsonProperty("prev_port") Port prevPort, @JsonProperty("next_port") Port nextPort, @JsonProperty("dest_port") Port destPort,
                           @JsonProperty("reported_name") String reportedName, String kind, String nationality) {
        /** 정렬 기준 = 알려진 시각(입항·출항·신고) 중 가장 늦은 것. 없으면 null. */
        Instant latest() {
            Instant best = null;
            for (Instant t : new Instant[]{entryAt, exitAt}) if (t != null && (best == null || t.isAfter(best))) best = t;
            if (reports != null) for (Report r : reports) if (r.at() != null && (best == null || r.at().isAfter(best))) best = r.at();
            return best;
        }
    }

    /** 입출항 신고 하나: kind = 입항·출항(원문), at = 신고 시각, type = 신고 구분(예: 최초). */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record Report(String kind, Instant at, String type) {}

    /** 항구(국가+항구 코드 · 이름) — 둘 다 없으면 항구 자체가 없다. */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record Port(String code, String name) {}

    public static PortCallsInfo noCallSign() { return status(NO_CALL_SIGN, null, null); }

    /** AIS 정적 정보를 아직 받지 못했다 — 호출부호를 모른다('없음' 이 아니다). */
    public static PortCallsInfo noStatic() { return status(NO_STATIC, null, null); }

    /** 캐시가 비었는데 이 세션의 조회가 남용 한도에 걸렸다(ADR-022) — 조회 중이 아니다. by ∈ {@link #LIMITED_BY}. */
    public static PortCallsInfo limited(String callSign, String by) {
        if (!LIMITED_BY.contains(by)) throw new IllegalArgumentException("unknown limit: " + by);
        return new PortCallsInfo(LIMITED, callSign, null, WINDOW_DAYS, null, null, SOURCE, null, null, null, null, null, null, by);
    }

    public static PortCallsInfo pending(String callSign) { return status(PENDING, callSign, null); }

    /** api 가 캐시 값을 읽지 못했다(Redis 오류 · 형식이 다른 값) — '기록 없음' 으로 말하지 않는다. */
    public static PortCallsInfo unreadable(String callSign) {
        return new PortCallsInfo(ERROR, callSign, null, WINDOW_DAYS, null, null, SOURCE, null, null, null, KIND_CACHE, null, null, null);
    }

    private static PortCallsInfo status(String status, String callSign, Instant fetchedAt) {
        return new PortCallsInfo(status, callSign, fetchedAt, WINDOW_DAYS, null, null, SOURCE, null, null, null, null, null, null, null);
    }

    /**
     * 캐시 원문 → 값. raw 가 null 이면 pending(아직 조회 전·조회 중). 형식이 틀리면(버전·호출부호 불일치·모르는 상태·ok 인데 항목 없음 포함)
     * error(cache) — 읽을 수 없는 값을 '기록 없음' 으로 말하지 않는다.
     */
    public static PortCallsInfo fromCache(String callSign, String raw, ObjectMapper json) {
        if (raw == null) return pending(callSign);
        if (raw.isEmpty() || raw.length() > MAX_RAW) return unreadable(callSign);
        JsonNode n;
        try {
            n = json.readTree(raw);
        } catch (RuntimeException e) {
            return unreadable(callSign);
        }
        if (n == null || !n.isObject()) return unreadable(callSign);
        JsonNode v = n.get("v");
        if (v == null || !v.isIntegralNumber() || v.asLong() != 1) return unreadable(callSign);
        JsonNode cs = n.get("call_sign");
        if (cs == null || !cs.isString() || !callSign.equals(cs.asString())) return unreadable(callSign);
        JsonNode st = n.get("status");
        String status = st != null && st.isString() ? st.asString() : "";
        Instant fetchedAt = RouteInfo.time(n.get("fetched_at"));
        String[] window = window(n.get("window"));
        return switch (status) {
            case OK -> {
                List<PortCall> items = items(n.get("items"));
                if (items.isEmpty()) yield unreadable(callSign); // ok 인데 읽을 항목이 없다 — '기록 없음' 이 아니다
                boolean more = items.size() > MAX_ITEMS || bool(n.get("truncated"));
                yield new PortCallsInfo(OK, callSign, fetchedAt, WINDOW_DAYS, window[0], window[1], SOURCE,
                        List.copyOf(items.subList(0, Math.min(items.size(), MAX_ITEMS))), more ? Boolean.TRUE : null,
                        bool(n.get("incomplete")) ? Boolean.TRUE : null, null, null, null, null);
            }
            case NONE -> new PortCallsInfo(NONE, callSign, fetchedAt, WINDOW_DAYS, window[0], window[1], SOURCE, null, null,
                    bool(n.get("incomplete")) ? Boolean.TRUE : null, null, null, null, null);
            case ERROR -> {
                String kind = RouteInfo.text(n.get("error_kind"), 32);
                String code = RouteInfo.text(n.get("error_code"), 32);
                yield new PortCallsInfo(ERROR, callSign, fetchedAt, WINDOW_DAYS, null, null, SOURCE, null, null, null,
                        kind != null && ERROR_KINDS.contains(kind) && !KIND_CACHE.equals(kind) ? kind : "internal",
                        code != null && ERROR_CODE.matcher(code).matches() ? code : null, null, null);
            }
            case DISABLED -> {
                String reason = RouteInfo.text(n.get("reason"), 32);
                // 묻지 않았다 — 조회 결과가 아니므로 fetched_at 은 싣지 않는다(route 의 disabled 와 같다)
                yield new PortCallsInfo(DISABLED, callSign, null, WINDOW_DAYS, null, null, SOURCE, null, null, null, null, null,
                        reason != null && DISABLED_REASONS.contains(reason) ? reason : null, null);
            }
            default -> unreadable(callSign);
        };
    }

    /** window {from, to, days}: 날짜 둘 다 달력에 있고 from ≤ to · days = 30 일 때만. 아니면 [null, null](모름). */
    static String[] window(JsonNode w) {
        String[] none = {null, null};
        if (w == null || !w.isObject()) return none;
        JsonNode days = w.get("days");
        if (days == null || !days.isIntegralNumber() || days.asLong() != WINDOW_DAYS) return none;
        LocalDate from = date(w.get("from")), to = date(w.get("to"));
        if (from == null || to == null || from.isAfter(to)) return none;
        return new String[]{from.toString(), to.toString()};
    }

    private static LocalDate date(JsonNode n) {
        if (n == null || !n.isString() || !DATE.matcher(n.asString()).matches()) return null;
        try {
            return LocalDate.parse(n.asString());
        } catch (DateTimeParseException e) {
            return null;
        }
    }

    private static boolean bool(JsonNode n) { return n != null && n.isBoolean() && n.asBoolean(); }

    /** items[] → 검사한 항목(객체가 아닌 원소는 버린다) · 최근 신고 순(시각 모름은 뒤, 같은 시각은 받은 순서). */
    static List<PortCall> items(JsonNode arr) {
        List<PortCall> out = new ArrayList<>();
        if (arr == null || !arr.isArray()) return out;
        int seen = 0;
        for (JsonNode it : arr) {
            if (++seen > MAX_ITEMS * 4) break; // 수집기는 20건까지만 쓴다 — 비정상적으로 긴 배열을 다 읽지 않는다
            PortCall p = item(it);
            if (p != null) out.add(p);
        }
        out.sort(Comparator.comparing(PortCall::latest, Comparator.nullsLast(Comparator.reverseOrder())));
        return out;
    }

    static PortCall item(JsonNode n) {
        if (n == null || !n.isObject()) return null;
        List<Report> reports = new ArrayList<>();
        JsonNode rs = n.get("reports");
        if (rs != null && rs.isArray()) {
            for (JsonNode r : rs) {
                if (reports.size() >= MAX_REPORTS) break;
                if (r == null || !r.isObject()) continue;
                Report rep = new Report(RouteInfo.text(r.get("kind"), TEXT_MAX), RouteInfo.time(r.get("at")), RouteInfo.text(r.get("type"), TEXT_MAX));
                if (rep.kind() != null || rep.at() != null || rep.type() != null) reports.add(rep);
            }
        }
        return new PortCall(code(n.get("port_authority_code"), PORT_AUTHORITY_CODE), RouteInfo.text(n.get("port_authority"), TEXT_MAX),
                RouteInfo.time(n.get("entry_at")), RouteInfo.time(n.get("exit_at")), reports.isEmpty() ? null : List.copyOf(reports),
                RouteInfo.text(n.get("purpose"), TEXT_MAX), port(n.get("prev_port")), port(n.get("next_port")), port(n.get("dest_port")),
                RouteInfo.text(n.get("reported_name"), TEXT_MAX), RouteInfo.text(n.get("kind"), TEXT_MAX), RouteInfo.text(n.get("nationality"), TEXT_MAX));
    }

    static Port port(JsonNode n) {
        if (n == null || !n.isObject()) return null;
        String code = code(n.get("code"), PORT_CODE), name = RouteInfo.text(n.get("name"), TEXT_MAX);
        return code == null && name == null ? null : new Port(code, name);
    }

    private static String code(JsonNode n, Pattern p) {
        return n != null && n.isString() && p.matcher(n.asString()).matches() ? n.asString() : null;
    }
}
