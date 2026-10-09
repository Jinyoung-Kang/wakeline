package dev.wakeline.weather.web;

import dev.wakeline.platform.web.Etags;
import dev.wakeline.platform.web.Meta;
import dev.wakeline.platform.web.Problem;
import dev.wakeline.weather.core.WarningRecord;
import dev.wakeline.weather.core.WarningStore;
import dev.wakeline.weather.data.WarningRepository;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.http.CacheControl;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;
import java.util.regex.Pattern;

/**
 * 기상특보(계약 v5 §G49 · ADR-036 · SPEC F3). 지금 발효 중인 특보는 메모리(수집기가 5분마다 보낸 마지막 목록)에서, 이력은 DB(V20)에서 답한다.
 * 받은 적이 없으면 received false · 빈 목록(빈 목록 '특보 없음'과 구분). 오래됨은 meta.stale(15분 — 수집 주기 5분의 세 배)과 fetched_at 으로.
 * 출처: 기상청 API허브 특보현황 — 원문(raw)을 함께 싣는다. 선박 위치와 구역을 잇지 않는다(구역 경계 자료 없음 — SPEC F9 보류).
 */
@org.springframework.context.annotation.Profile("!cli & !migrate")
@RestController
@RequestMapping("/api/v1")
public class WarningController {
    static final String SOURCE = "기상청 API허브 특보현황";
    static final int STALE_AFTER_S = 900;
    private static final Pattern ZONE = Pattern.compile("^[LS][0-9]{7}$");
    private final WarningStore store;
    private final WarningRepository repo;

    public WarningController(WarningStore store, WarningRepository repo) {
        this.store = store;
        this.repo = repo;
    }

    @GetMapping("/warnings")
    public ResponseEntity<Map<String, Object>> warnings(HttpServletRequest req) {
        WarningStore.State st = store.state();
        String etag = "\"w" + st.version() + "\"";
        CacheControl cc = CacheControl.maxAge(30, TimeUnit.SECONDS).cachePublic();
        if (Etags.notModified(etag, req.getHeader("If-None-Match"))) return ResponseEntity.status(304).eTag(etag).cacheControl(cc).build();
        List<Map<String, Object>> items = new ArrayList<>(st.warnings().size());
        for (WarningRecord w : st.warnings()) items.add(item(w));
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("received", st.received());
        m.put("items", items);
        m.put("dropped", st.dropped());
        m.put("source", SOURCE);
        m.put("meta", Meta.of(req, st.provider(), st.received() ? st.fetchedAt() : null, STALE_AFTER_S));
        return ResponseEntity.ok().eTag(etag).cacheControl(cc).body(m);
    }

    @GetMapping("/warnings/history")
    public ResponseEntity<Map<String, Object>> history(@RequestParam(required = false) Instant from, @RequestParam(required = false) Instant to,
                                                       @RequestParam(required = false) String zone, @RequestParam(defaultValue = "200") int limit,
                                                       HttpServletRequest req) {
        Instant end = to == null ? Instant.now() : to;
        Instant start = from == null ? end.minusSeconds(86400) : from;
        if (!start.isBefore(end) || end.toEpochMilli() - start.toEpochMilli() > 30L * 86400_000) throw Problem.badRequest("BAD_RANGE", "range must be within 30 d");
        if (zone != null && !ZONE.matcher(zone).matches()) throw Problem.badRequest("BAD_ZONE", "zone: [LS] + 7 digits");
        int lim = Math.max(1, Math.min(limit, 500));
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("items", repo.history(start, end, zone, lim));
        m.put("source", SOURCE);
        m.put("meta", Meta.of(req, "db", Instant.now(), 60));
        return ResponseEntity.ok().cacheControl(CacheControl.maxAge(60, TimeUnit.SECONDS).cachePublic()).body(m);
    }

    static Map<String, Object> item(WarningRecord w) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("zone_code", w.zoneCode());
        m.put("zone_name", w.zoneName());
        m.put("parent_code", w.parentCode());
        m.put("parent_name", w.parentName());
        m.put("sea", w.sea());
        m.put("kind", w.kind());
        m.put("level", w.level());
        m.put("command", w.command());
        m.put("preliminary", w.preliminary());
        m.put("issued_at", w.issuedAt());
        m.put("effective_at", w.effectiveAt());
        m.put("effective_from", w.effectiveFrom());
        m.put("effective_to", w.effectiveTo());
        m.put("effective_text", w.effectiveText());
        m.put("end_notice", w.endNotice());
        m.put("raw", w.raw());
        return m;
    }
}
