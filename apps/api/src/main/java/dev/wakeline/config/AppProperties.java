package dev.wakeline.config;

import org.slf4j.LoggerFactory;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.boot.context.properties.bind.DefaultValue;

import java.util.ArrayList;
import java.util.List;

/**
 * wakeline.* 설정. 값의 출처는 compose 환경변수 → .env.
 * wsResyncIntervalS: 줌 > 5 세션의 주기 전체 스냅샷(30 s), wsResyncWorldIntervalS: 줌 ≤ 5(전세계) 세션(120 s, 계약 §1).
 * allowedOrigins: 브라우저 Origin 명시 허용 목록(WAKELINE_ALLOWED_ORIGINS, 쉼표 구분) — 쓰는 곳은 정리한 {@link #originPatterns()}.
 */
@ConfigurationProperties(prefix = "wakeline")
public record AppProperties(
        String trustedProxy,
        String regionCenter,
        int regionRadiusNm,
        int publicRateLimitPerMin,
        int wsMaxConn,
        int wsMaxConnPerIp,
        int wsDiffIntervalS,
        int wsResyncIntervalS,
        double maxBboxAreaSqdeg,
        int fixtureMode,
        String schemasDir,
        int trackRetentionHours,
        int summaryRetentionDays,
        @DefaultValue("120") int wsResyncWorldIntervalS,
        @DefaultValue({"http://localhost:8700", "http://127.0.0.1:8700"}) List<String> allowedOrigins
) {
    public double regionLat() { return Double.parseDouble(regionCenter.split(",")[0].trim()); }
    public double regionLon() { return Double.parseDouble(regionCenter.split(",")[1].trim()); }
    public boolean fixture() { return fixtureMode == 1; }

    /** {@link #allowedOrigins} 가 비었거나 쓸 값이 없을 때(전부 막히거나 전부 열리지 않게). */
    public static final List<String> DEFAULT_ALLOWED_ORIGINS = List.of("http://localhost:8700", "http://127.0.0.1:8700");

    /**
     * 허용 Origin 목록을 정리한 것(WS 핸드셰이크 — ws.OriginAllowList). 항목은 정확한 origin("http://localhost:8700") 또는 Spring origin 패턴
     * ("http://localhost:[*]").
     */
    public List<String> originPatterns() { return normalizeOrigins(allowedOrigins); }

    /** 공백·끝 '/' 제거, 빈 값·"*" 제거, 중복 제거. 결과가 비면 기본 목록({@link #DEFAULT_ALLOWED_ORIGINS}). */
    static List<String> normalizeOrigins(List<String> raw) {
        List<String> out = new ArrayList<>();
        if (raw != null) {
            for (String r : raw) {
                if (r == null) continue;
                String o = r.trim();
                while (o.endsWith("/")) o = o.substring(0, o.length() - 1);
                if (o.isEmpty()) continue;
                if (o.equals("*")) { LoggerFactory.getLogger(AppProperties.class).warn("wakeline.allowed-origins: '*' ignored — list explicit origins"); continue; }
                if (!out.contains(o)) out.add(o);
            }
        }
        if (out.isEmpty()) {
            LoggerFactory.getLogger(AppProperties.class).warn("wakeline.allowed-origins is empty — using default {}", DEFAULT_ALLOWED_ORIGINS);
            return DEFAULT_ALLOWED_ORIGINS;
        }
        return List.copyOf(out);
    }
}
