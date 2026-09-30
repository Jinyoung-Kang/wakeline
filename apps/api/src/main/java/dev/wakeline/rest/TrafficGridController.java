package dev.wakeline.rest;

import jakarta.servlet.http.HttpServletRequest;
import org.springframework.http.CacheControl;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.time.Duration;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;

/**
 * 연안 교통량 REST v1(ADR-023) — GET /api/v1/traffic/grid. 한국해양교통안전공단 실시간 해양교통정보(5분 집계)의 격자별 선박 척수 · 밀집도에
 * 해양수산부 해양격자 4단계 기하(0.025° 칸)를 붙인 스냅샷. 개별 선박 위치가 아니다.
 * <p>공개 · 캐시(public, 30 s) · ETag(내용 · 상태가 바뀔 때만) · 요청 제한(/api/** 공통). 값은 {@link TrafficGridReader} 가 검증한 것만.
 * 꺼졌거나(disabled — 이유 disabled_reason) · 자료가 없거나(no_data) · 형식이 틀리거나 regDt 가 미래이면(invalid) · 오래되면(stale — regDt 15분 초과)
 * available=false 이고 cells 는 빈 목록이다(지난 자료를 지금처럼 그리지 않는다). 시각: reg_dt_kst(공급자 벽시계, +09:00) · reg_dt_utc · fetched_at(UTC).
 * 모르는 값은 키가 없다(Jackson non_null — 이 저장소의 응답 규칙). 늘 있는 키: available · status · stale_after_s · cell_deg · cells · source · time_zone · meta.
 */
@org.springframework.context.annotation.Profile("!cli & !migrate")
@RestController
@RequestMapping("/api/v1")
public class TrafficGridController {
    static final CacheControl CACHE = CacheControl.maxAge(30, TimeUnit.SECONDS).cachePublic();
    private final TrafficGridReader reader;

    public TrafficGridController(TrafficGridReader reader) {
        this.reader = reader;
    }

    @GetMapping("/traffic/grid")
    public ResponseEntity<Map<String, Object>> grid(HttpServletRequest req) {
        TrafficGridReader.View v = reader.read();
        if (Etags.notModified(v.etag(), req.getHeader("If-None-Match"))) return ResponseEntity.status(304).eTag(v.etag()).cacheControl(CACHE).build();
        return ResponseEntity.ok().eTag(v.etag()).cacheControl(CACHE).body(body(v, req, Instant.now()));
    }

    static Map<String, Object> body(TrafficGridReader.View v, HttpServletRequest req, Instant now) {
        TrafficGridReader.Parsed p = v.parsed();
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("available", v.available());
        m.put("status", v.status());
        m.put("disabled_reason", v.disabledReason());
        m.put("reg_dt_kst", p == null ? null : p.regDtKst());
        m.put("reg_dt_utc", p == null ? null : p.regDtUtc());
        m.put("fetched_at", p == null ? null : p.fetchedAt());
        m.put("age_s", p == null ? null : Math.max(0, Duration.between(p.regDtUtc(), now).toSeconds()));
        m.put("stale_after_s", TrafficGridReader.STALE_AFTER_S);
        for (String k : List.of("total", "total_count", "partial", "rejected", "resolved", "unresolved", "pending", "not_found", "off_grid", "failed"))
            m.put(k, p == null ? null : p.counts().get(k));
        m.put("invalid_cells", p == null ? null : p.invalidCells());
        m.put("cell_deg", TrafficGridReader.CELL_DEG);
        m.put("cells", v.available() ? p.cells() : List.of());
        m.put("source", TrafficGridReader.SOURCE);
        m.put("time_zone", "reg_dt_kst is KST(UTC+9) as given by the provider; reg_dt_utc and fetched_at are UTC");
        m.put("meta", Meta.of(req, "komsa_traffic", p == null ? null : p.fetchedAt(), (int) TrafficGridReader.STALE_AFTER_S));
        return m;
    }
}
