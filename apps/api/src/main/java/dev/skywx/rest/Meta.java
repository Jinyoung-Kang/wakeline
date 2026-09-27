package dev.skywx.rest;

import dev.skywx.config.RequestIdFilter;
import jakarta.servlet.http.HttpServletRequest;

import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;

/** 모든 데이터 응답의 meta: provider · fetched_at · lag_s · stale · generated_at · request_id (9.1절). */
public final class Meta {
    private Meta() {}

    public static Map<String, Object> of(HttpServletRequest req, String provider, Instant fetchedAt, int staleAfterS) {
        Instant now = Instant.now();
        Map<String, Object> m = new LinkedHashMap<>();
        // 수집 이력이 없는 스냅샷의 자리표시("-")는 공급자 이름이 아니다 — null(모름)로 낸다
        m.put("provider", provider == null || provider.isBlank() || "-".equals(provider) ? null : provider);
        m.put("fetched_at", fetchedAt == null || fetchedAt.equals(Instant.EPOCH) ? null : fetchedAt);
        double lag = fetchedAt == null || fetchedAt.equals(Instant.EPOCH) ? -1 : (now.toEpochMilli() - fetchedAt.toEpochMilli()) / 1000.0;
        m.put("lag_s", lag < 0 ? null : Math.round(lag * 10) / 10.0);
        m.put("stale", lag < 0 || lag > staleAfterS);
        m.put("generated_at", now);
        m.put("request_id", RequestIdFilter.current(req));
        return m;
    }
}
