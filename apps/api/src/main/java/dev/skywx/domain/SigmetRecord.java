package dev.skywx.domain;

import org.locationtech.jts.geom.MultiPolygon;

import java.time.Instant;

/** 구조화된 SIGMET(schemas/sigmet.v1.json). geometry 가 null 이면 판정 제외(excludedReason). */
public record SigmetRecord(
        String id, String firId, String firName, String issuer, String seriesId,
        String hazard, String qualifier, int baseFt, Integer topFt,
        Instant validFrom, Instant validTo, MultiPolygon geometry, String excludedReason,
        String moveDir, String moveSpd, String chng, String rawText, String provider, Instant fetchedAt) {

    public boolean validAt(Instant t) { return !t.isBefore(validFrom) && t.isBefore(validTo); }

    public boolean bandContains(int altFt) { return altFt >= baseFt && (topFt == null || altFt <= topFt); }
}
