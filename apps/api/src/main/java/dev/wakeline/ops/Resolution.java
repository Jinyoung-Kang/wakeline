package dev.wakeline.ops;

import com.fasterxml.jackson.annotation.JsonInclude;

import java.time.Instant;

/**
 * 해결 표시 한 행(ops_resolution · V13 · 계약 v5 §G13) — 활성(되돌리지 않은) 행만 이 모양으로 다닌다.
 * kind = {@value #LOG_GROUP}(key = 로그 지문 fp) | {@value #PROVIDER_ERROR}(key = 공급자 이름). upto 이하에 난 그 key 의 오류가 "해결됨"이다 —
 * upto 뒤의 새 발생은 해결되지 않은 것으로 다시 보인다(재발을 숨기지 않는다). note 가 없으면 null 로 싣는다(키를 빼지 않는다).
 */
@JsonInclude(JsonInclude.Include.ALWAYS)
public record Resolution(long id, String kind, String key, Instant upto, Instant resolvedAt, String resolvedBy, String note) {
    public static final String LOG_GROUP = "log_group";
    public static final String PROVIDER_ERROR = "provider_error";

    /** 항목 · 공급자에 붙이는 짧은 모양 {id, upto, resolved_by}. */
    @JsonInclude(JsonInclude.Include.ALWAYS)
    public record Ref(long id, Instant upto, String resolvedBy) {}

    public Ref ref() { return new Ref(id, upto, resolvedBy); }

    /** 이 해결이 그 시각의 발생을 덮는가(upto ≥ at — 같은 시각 포함). 시각을 모르면(null) 덮지 않는다 — 모르는 것을 해결됨으로 보이지 않는다. */
    public boolean covers(Instant at) { return at != null && !at.isAfter(upto); }
}
