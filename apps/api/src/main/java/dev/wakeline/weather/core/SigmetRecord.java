package dev.wakeline.weather.core;

import org.locationtech.jts.geom.MultiPolygon;

import java.time.Instant;

/**
 * 구조화된 SIGMET(schemas/sigmet.v1.json). geometry 가 null 이면 판정 제외(excludedReason).
 * baseSource: json | assumed_surface(AWC 하한 null → 판정은 SFC 가정). null = 출처 정보 없음(이전 형식 메시지).
 * topSource: json | raw_text | raw_text_lower_bound | unknown(상한 미발표 → topFt null, 판정은 무제한 가정).
 * raw_text_lower_bound(DH-4): 원문이 "TOP ABV FLnnn" — topFt 는 발표된 값이지만 상한이 아니라 '상한의 하한'(FLnnn 이상)이다.
 * 판정은 상한을 무제한으로 가정한다(그 값을 상한으로 쓰면 FLnnn 위의 항공기를 조용히 빠뜨린다). 가정은 근거에 남긴다.
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
    public static final String TOP_RAW_TEXT_LOWER_BOUND = "raw_text_lower_bound";
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

    /** 발표된 상한 값이 상한이 아니라 하한(TOP ABV FLnnn — 'FLnnn 이상')인가. */
    public boolean topIsLowerBound() { return TOP_RAW_TEXT_LOWER_BOUND.equals(topSource) && topFt != null; }

    /** 판정에 쓰는 상한: 발표된 상한 값, 상한 미발표·'이상'(하한)이면 null(= 무제한 가정). 관측·예측이 같은 값을 쓴다. */
    public Integer judgedTopFt() { return topIsLowerBound() ? null : topFt; }

    /** 상한 null(미발표·'이상')은 판정에서 무제한으로 가정한다(가정임을 근거에 남긴다: topAssumedUnbounded). */
    public boolean bandContains(int altFt) {
        Integer top = judgedTopFt();
        return altFt >= baseFt && (top == null || altFt <= top);
    }

    /** 판정에서 상한을 무제한으로 가정했는가(상한 미발표, 또는 'FLnnn 이상'만 발표). */
    public boolean topAssumedUnbounded() { return judgedTopFt() == null; }

    /** 판정에서 하한을 지표(SFC)로 가정했는가(AWC 하한 null). */
    public boolean baseAssumedSurface() { return BASE_ASSUMED_SURFACE.equals(baseSource); }
}
