package dev.skywx.config;

import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.boot.context.properties.bind.DefaultValue;

import java.util.List;

/**
 * skywx.* 설정. 값의 출처는 compose 환경변수 → .env.
 * wsResyncIntervalS: 줌 > 5 세션의 주기 전체 스냅샷(30 s), wsResyncWorldIntervalS: 줌 ≤ 5(전세계) 세션(120 s, 계약 §1).
 * allowedOrigins: WS 핸드셰이크 Origin 명시 허용 목록(SKYWX_ALLOWED_ORIGINS, 쉼표 구분).
 */
@ConfigurationProperties(prefix = "skywx")
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
}
