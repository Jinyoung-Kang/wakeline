package dev.wakeline.domain;

import org.locationtech.jts.geom.MultiPolygon;

import java.time.Instant;

/**
 * 구조화된 SIGMET(schemas/sigmet.v1.json). geometry 가 null 이면 판정 제외(excludedReason).
 * baseSource: json | assumed_surface(AWC 하한 null → 판정은 SFC 가정). null = 출처 정보 없음(이전 형식 메시지).
 * topSource: json | raw_text | unknown(상한 미발표 → topFt null, 판정은 무제한 가정).
 */
public record SigmetRecord(
        String id, String firId, String firName, String issuer, String seriesId,
        String hazard, String qualifier, int baseFt, Integer topFt,
        Instant validFrom, Instant validTo, MultiPolygon geometry, String excludedReason,
        String moveDir, String moveSpd, String chng, String rawText, String provider, Instant fetchedAt,
        String baseSource, String topSource) {

    public static final String BASE_JSON = "json";
    public static final String BASE_ASSUMED_SURFACE = "assumed_surface";
    public static final String TOP_JSON = "json";
    public static final String TOP_RAW_TEXT = "raw_text";
    public static final String TOP_UNKNOWN = "unknown";

    /** 이전 시그니처 호환(출처 필드 없음 → null, 즉 '출처 정보 없음'). */
    public SigmetRecord(String id, String firId, String firName, String issuer, String seriesId,
                        String hazard, String qualifier, int baseFt, Integer topFt,
                        Instant validFrom, Instant validTo, MultiPolygon geometry, String excludedReason,
                        String moveDir, String moveSpd, String chng, String rawText, String provider, Instant fetchedAt) {
        this(id, firId, firName, issuer, seriesId, hazard, qualifier, baseFt, topFt, validFrom, validTo, geometry, excludedReason,
                moveDir, moveSpd, chng, rawText, provider, fetchedAt, null, topFt == null ? TOP_UNKNOWN : null);
    }

    public boolean validAt(Instant t) { return !t.isBefore(validFrom) && t.isBefore(validTo); }

    /** 상한 null 은 '발표되지 않음' — 판정은 무제한으로 가정한다(가정임을 근거에 남긴다: topAssumedUnbounded). */
    public boolean bandContains(int altFt) { return altFt >= baseFt && (topFt == null || altFt <= topFt); }

    /** 판정에서 상한을 무제한으로 가정했는가(상한 미발표). */
    public boolean topAssumedUnbounded() { return topFt == null; }

    /** 판정에서 하한을 지표(SFC)로 가정했는가(AWC 하한 null). */
    public boolean baseAssumedSurface() { return BASE_ASSUMED_SURFACE.equals(baseSource); }
}
