package dev.wakeline.portcalls;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.annotation.JsonProperty;

import java.time.Instant;
import java.util.List;
import java.util.Set;

/**
 * 선택 선박의 한국 항만 입출항(ADR-022 개정) — WS ship_selected.port_calls. 원천은 해양수산부 선박운항정보(PORT-MIS, 공공데이터포털)이고, 수집기가
 * 항만청 10곳의 KST 날짜별 신고를 모두 받아 둔 DB 색인(port_call · port_call_coverage — V15)을 {@link PortCallReader} 가 AIS 호출부호로 찾는다.
 * 선택은 외부 호출을 만들지 않는다(예전에는 선택마다 clsgn 으로 물었으나 원천이 clsgn 으로 거르지 않았다 — docs/review/evidence 마지막 절).
 * <ul>
 *   <li>status: ok(색인에 기록이 있다 — items) · none(10곳 모두 30일 창을 오늘까지 빈 곳 없이 색인했고 {@value #STALE_AFTER_S} s 안에 갱신했는데 기록이
 *       없다 — 그때만) ·
 *       incomplete(기록을 못 찾았지만 색인이 빈 곳이 있거나 오래됐다 — index.gaps 에 어느 항만청이 어떻게) · disabled(수집기가 색인하지 않는다 —
 *       disabled_reason no_key · fixture · operator) · no_call_sign(AIS 호출부호가 없다 — call_sign_state not_received: 아직 받지 않음 · unusable: 받았지만
 *       찾는 형식 밖) · error(api 가 색인을 읽지 못했다 — '기록 없음' 으로 바꾸지 않는다).</li>
 *   <li>index(ok · none · incomplete): 10곳 · complete · refreshed_at(10곳의 꼬리 갱신 중 가장 오래된 것 — 최근 3일은 이 시각까지 올라온 신고가 색인에
 *       있다. 더 오래된 날은 하루에 한 번쯤 다시 받는다) · stale_after_s · gaps(항만청마다 not_indexed · partial(창 앞쪽 일부만) · behind(오늘 목록을
 *       아직 색인하지 않았다 — 범위 끝이 오늘보다 앞) · stale(갱신이 오래됐다) · unindexed_days(창 안에 끝까지 색인하지 못한 날 — 그 날짜들) — 범위와
 *       갱신 시각을 함께).</li>
 *   <li>items: 최근 순 · 최대 {@value #MAX_ITEMS}건(더 있으면 truncated). 모르는 값은 키 없음(null) — 지어 채우지 않는다. 입항 · 출항 시각은 판(최종 → 최초)
 *       으로 고른 +09:00 신고 시각이고 판 이름(entry_revision · exit_revision)을 함께 싣는다. 출항이 없으면 아직 입항 중이거나 색인이 그 뒤를
 *       다시 읽지 않았다(read_at = 이 기록을 마지막으로 읽은 때). reported_name = PORT-MIS 에 신고된 선명(AIS 선명과 다를 수 있다 — 화면이 비교한다).</li>
 * </ul>
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record PortCallsInfo(String status, @JsonProperty("call_sign") String callSign, @JsonProperty("call_sign_state") String callSignState,
                            @JsonProperty("window_days") int windowDays, @JsonProperty("window_from") String windowFrom,
                            @JsonProperty("window_to") String windowTo, String source, List<PortCall> items, Boolean truncated, Index index,
                            @JsonProperty("disabled_reason") String disabledReason) {
    public static final String SOURCE = "해양수산부 선박운항정보(PORT-MIS)";
    public static final int WINDOW_DAYS = 30;
    public static final int MAX_ITEMS = 20;
    /** 이보다 오래된 꼬리 갱신은 '오래됨' — 그 항만청이 있으면 '기록 없음' 이라 하지 않는다(수집기 갱신 주기 1 h 의 두 배). */
    public static final long STALE_AFTER_S = 7_200;

    public static final String OK = "ok";
    public static final String NONE = "none";
    public static final String INCOMPLETE = "incomplete";
    public static final String DISABLED = "disabled";
    public static final String NO_CALL_SIGN = "no_call_sign";
    public static final String ERROR = "error";
    /** no_call_sign 의 까닭: 아직 받지 않음(정적 정보가 없거나 호출부호 칸이 비었다) · 받았지만 찾는 형식(영문 대문자 · 숫자 3–7자) 밖. */
    public static final String NOT_RECEIVED = "not_received";
    public static final String UNUSABLE = "unusable";
    public static final Set<String> DISABLED_REASONS = Set.of("no_key", "fixture", "operator");
    /** 색인 빈 곳의 종류. */
    public static final String NOT_INDEXED = "not_indexed";
    public static final String PARTIAL = "partial";
    public static final String BEHIND = "behind";
    public static final String STALE = "stale";
    public static final String UNINDEXED_DAYS = "unindexed_days";

    /** 입출항 한 건(port_call 한 행). */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record PortCall(@JsonProperty("port_authority_code") String portAuthorityCode, @JsonProperty("port_authority") String portAuthority,
                           @JsonProperty("listed_date") String listedDate, @JsonProperty("entry_at") Instant entryAt,
                           @JsonProperty("entry_revision") String entryRevision, @JsonProperty("exit_at") Instant exitAt,
                           @JsonProperty("exit_revision") String exitRevision, String berth, String purpose, @JsonProperty("first_port") Port firstPort,
                           @JsonProperty("prev_port") Port prevPort, @JsonProperty("next_port") Port nextPort, @JsonProperty("dest_port") Port destPort,
                           @JsonProperty("reported_name") String reportedName, String kind, String nationality, @JsonProperty("read_at") Instant readAt) {}

    /** 항구(국가+항구 코드 · 이름) — 둘 다 없으면 항구 자체가 없다. */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record Port(String code, String name) {}

    /** 색인 상태: 항만청 수 · 완전한가 · 가장 오래된 꼬리 갱신 · 오래됨 기준 · 빈 곳. */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record Index(int authorities, boolean complete, @JsonProperty("refreshed_at") Instant refreshedAt,
                        @JsonProperty("stale_after_s") long staleAfterS, List<Gap> gaps) {}

    /**
     * 항만청 하나의 빈 곳: issues(not_indexed · partial · behind · stale · unindexed_days) · 지금 범위 · 마지막 꼬리 갱신(모르면 키 없음) ·
     * unindexed_days(창 안에서 끝까지 색인하지 못한 날 — 오름차순, 없으면 키 없음).
     */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record Gap(@JsonProperty("port_authority_code") String portAuthorityCode, @JsonProperty("port_authority") String portAuthority,
                      List<String> issues, @JsonProperty("covered_from") String coveredFrom, @JsonProperty("covered_to") String coveredTo,
                      @JsonProperty("refreshed_at") Instant refreshedAt, @JsonProperty("unindexed_days") List<String> unindexedDays) {
        /** 끝까지 색인하지 못한 날이 없는 빈 곳. */
        public Gap(String portAuthorityCode, String portAuthority, List<String> issues, String coveredFrom, String coveredTo, Instant refreshedAt) {
            this(portAuthorityCode, portAuthority, issues, coveredFrom, coveredTo, refreshedAt, null);
        }
    }

    public static PortCallsInfo noCallSign(String state) {
        return new PortCallsInfo(NO_CALL_SIGN, null, state, WINDOW_DAYS, null, null, SOURCE, null, null, null, null);
    }

    public static PortCallsInfo disabled(String callSign, String reason) {
        if (!DISABLED_REASONS.contains(reason)) throw new IllegalArgumentException("unknown reason: " + reason);
        return new PortCallsInfo(DISABLED, callSign, null, WINDOW_DAYS, null, null, SOURCE, null, null, null, reason);
    }

    /** api 가 색인을 읽지 못했다(DB 오류 · 시간 초과) — '기록 없음' 으로 말하지 않는다. */
    public static PortCallsInfo error(String callSign) {
        return new PortCallsInfo(ERROR, callSign, null, WINDOW_DAYS, null, null, SOURCE, null, null, null, null);
    }

    /** 색인을 읽은 결과: 기록이 있으면 ok, 없으면 색인이 완전할 때만 none · 아니면 incomplete. */
    public static PortCallsInfo found(String callSign, String from, String to, List<PortCall> items, boolean truncated, Index index) {
        String status = !items.isEmpty() ? OK : index.complete() ? NONE : INCOMPLETE;
        return new PortCallsInfo(status, callSign, null, WINDOW_DAYS, from, to, SOURCE, items.isEmpty() ? null : List.copyOf(items),
                truncated && !items.isEmpty() ? Boolean.TRUE : null, index, null);
    }
}
