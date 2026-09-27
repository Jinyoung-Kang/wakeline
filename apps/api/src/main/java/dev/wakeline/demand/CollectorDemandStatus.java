package dev.wakeline.demand;

import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

import java.time.Instant;
import java.time.format.DateTimeParseException;
import java.util.Set;

/**
 * 수집기가 wakeline:demand:status 에 쓴 한 필드(계약 v2 §A2 · v3 §C): {state, interval_s, last_success_at, last_error, provider}.
 * state disabled = 운영자가 공급자를 꺼서 조회하지 않음(호출 상한과 구분한다).
 * 수집기 값은 믿지 않는다 — 크기·상태 값·범위를 다시 검사하고, 맞지 않으면 없는 것으로 본다(화면은 '대기').
 * last_error·provider 는 화면에 내보내지 않는다(내부 사유 문구).
 */
public record CollectorDemandStatus(String state, Integer intervalS, Instant lastSuccessAt) {
    public static final Set<String> STATES = Set.of("active", "throttled", "not_found", "error", "disabled");
    static final int MAX_RAW = 1024;
    static final int MAX_INTERVAL_S = 3600;
    /** active 로 믿을 최근 성공의 최소 창 — 그 뒤로는 max(이 값, 주기 × 3). */
    static final long ACTIVE_MIN_WINDOW_MS = 15_000;

    /** 원문 JSON → 값. 형식이 틀리면 null. */
    public static CollectorDemandStatus parse(String raw, ObjectMapper json) {
        if (raw == null || raw.isEmpty() || raw.length() > MAX_RAW) return null;
        JsonNode n;
        try {
            n = json.readTree(raw);
        } catch (RuntimeException e) {
            return null;
        }
        if (n == null || !n.isObject()) return null;
        JsonNode st = n.get("state");
        if (st == null || !st.isString() || !STATES.contains(st.asString())) return null;
        Integer interval = null;
        JsonNode iv = n.get("interval_s");
        if (iv != null && iv.isIntegralNumber() && iv.asLong() >= 1 && iv.asLong() <= MAX_INTERVAL_S) interval = iv.asInt();
        Instant last = null;
        JsonNode ls = n.get("last_success_at");
        if (ls != null && ls.isString() && ls.asString().length() <= 40) {
            try {
                last = Instant.parse(ls.asString());
            } catch (DateTimeParseException ignored) {
                // 읽을 수 없는 시각은 모름
            }
        }
        return new CollectorDemandStatus(st.asString(), interval, last);
    }

    /**
     * 지금도 조회가 돌고 있다고 말할 수 있는가: state active 이고 마지막 성공이 max(15 s, 주기 × 3) 안.
     * 수집기가 멈추면 상태 필드는 마지막 값으로 남는다(TTL 없음) — 오래된 active 를 믿지 않는다.
     */
    public boolean activeAt(long nowMs) {
        if (!"active".equals(state) || lastSuccessAt == null) return false;
        long window = Math.max(ACTIVE_MIN_WINDOW_MS, intervalS == null ? 0 : intervalS * 3_000L);
        return nowMs - lastSuccessAt.toEpochMilli() <= window;
    }
}
