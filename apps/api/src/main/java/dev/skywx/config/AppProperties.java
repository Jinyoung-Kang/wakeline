package dev.skywx.config;

import org.springframework.boot.context.properties.ConfigurationProperties;

/** skywx.* 설정. 값의 출처는 compose 환경변수 → .env. */
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
        int summaryRetentionDays
) {
    public double regionLat() { return Double.parseDouble(regionCenter.split(",")[0].trim()); }
    public double regionLon() { return Double.parseDouble(regionCenter.split(",")[1].trim()); }
    public boolean fixture() { return fixtureMode == 1; }
}
