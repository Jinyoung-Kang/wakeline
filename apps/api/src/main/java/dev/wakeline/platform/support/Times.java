package dev.wakeline.platform.support;

import java.time.Instant;

/** 수집기가 Redis 에 쓴 시각 문자열 해석(api-review §2.5-2 — 예전에는 StatusService.isoInstant 를 레이더 · 교통 · 날씨가 빌려 썼다). */
public final class Times {
    private Times() {}

    /** 시간대가 있는 ISO 시각만. 아니면 null. */
    public static Instant isoInstant(Object v) {
        if (v == null) return null;
        try {
            return java.time.OffsetDateTime.parse(String.valueOf(v).trim()).toInstant();
        } catch (java.time.format.DateTimeParseException e) {
            return null;
        }
    }
}
