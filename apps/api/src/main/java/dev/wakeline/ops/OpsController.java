package dev.wakeline.ops;

import dev.wakeline.config.Problem;
import dev.wakeline.rest.StatusService;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.data.domain.Range;
import org.springframework.data.redis.connection.Limit;
import org.springframework.data.redis.connection.stream.MapRecord;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.transaction.support.TransactionTemplate;
import tools.jackson.databind.JsonNode;

import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * 운영 API(인증 필요, 비인가 404). 공급자·실행 이력·품질 게이트·설정·감사·DLQ.
 * 모든 변경은 감사 기록과 원자적이다(SEC-11): DB 변경은 감사 행과 한 트랜잭션, Redis 전용 토글은 감사 행을 먼저 쓰고 Redis 쓰기가
 * 실패하면 감사 행을 롤백한다 — 감사 없이 적용된 변경도, 적용되지 않았는데 남은 감사 행도 없다.
 */
@org.springframework.context.annotation.Profile("!cli & !migrate")
@RestController
@RequestMapping("/api/v1/ops")
public class OpsController {
    private final StatusService status;
    private final JdbcClient db;
    private final StringRedisTemplate redis;
    private final SettingsService settings;
    private final AuditService audit;
    private final dev.wakeline.persist.MaintenanceJobs jobs;
    private final TransactionTemplate tx;

    public OpsController(StatusService status, JdbcClient db, StringRedisTemplate redis, SettingsService settings, AuditService audit,
                         dev.wakeline.persist.MaintenanceJobs jobs, TransactionTemplate tx) {
        this.status = status;
        this.db = db;
        this.redis = redis;
        this.settings = settings;
        this.audit = audit;
        this.jobs = jobs;
        this.tx = tx;
    }

    /** 통계 재집계(멱등). 기본은 어제(UTC). 그 날의 재집계와 감사 기록이 한 트랜잭션 — 실패하면 둘 다 없다. */
    @PostMapping("/stats/aggregate")
    public ResponseEntity<Map<String, Object>> aggregate(@RequestParam(required = false) java.time.LocalDate day, HttpServletRequest req, Authentication auth) {
        java.time.LocalDate d = day == null ? java.time.LocalDate.now(java.time.ZoneOffset.UTC).minusDays(1) : day;
        tx.executeWithoutResult(st -> {
            jobs.aggregateDay(d);
            audit.record(req, userId(auth), "STATS_AGGREGATE", d.toString(), null, null);
        });
        return ResponseEntity.ok(Map.of("day", d.toString()));
    }

    @GetMapping("/providers")
    public Map<String, Object> providers() {
        List<Map<String, Object>> list = status.providerStatuses();
        List<Map<String, Object>> switches = new java.util.ArrayList<>();
        try {
            List<MapRecord<String, Object, Object>> recs = redis.opsForStream().reverseRange("wakeline:events", Range.unbounded(), Limit.limit().count(20));
            if (recs != null) for (var r : recs) switches.add(new LinkedHashMap<>(castMap(r.getValue())));
        } catch (RuntimeException ignored) { }
        var budgets = db.sql("SELECT provider, day, calls, limit_value FROM provider_budget_day WHERE day >= CURRENT_DATE - 7 ORDER BY day DESC, provider").query().listOfRows();
        return Map.of("providers", list, "active", status.publicStatus().get("active_providers"), "collector", status.collectorHeartbeat(),
                "switches", switches, "budget_days", budgets);
    }

    @PostMapping("/providers/{name}/{action}")
    public ResponseEntity<Void> toggleProvider(@PathVariable String name, @PathVariable String action, HttpServletRequest req, Authentication auth) {
        if (!StatusService.PROVIDERS.contains(name)) throw Problem.notFound("provider not found");
        boolean disable = switch (action) { case "disable" -> true; case "enable" -> false; default -> throw Problem.notFound("no such action"); };
        String key = "wakeline:provider:" + name;
        String after = disable ? "1" : "0";
        Object before = redis.opsForHash().get(key, "disabled"); // Redis 장애면 여기서 503(아무것도 바뀌지 않음)
        Map<String, Object> beforeJson = new LinkedHashMap<>();
        beforeJson.put("disabled", before == null ? null : String.valueOf(before));
        AtomicBoolean written = new AtomicBoolean();
        try {
            tx.executeWithoutResult(st -> {
                // 감사 행을 먼저 쓴다(DB 장애면 변경 자체가 일어나지 않는다) → Redis 쓰기가 실패하면 예외로 감사 행이 롤백된다
                audit.record(req, userId(auth), disable ? "PROVIDER_DISABLE" : "PROVIDER_ENABLE", name, beforeJson, Map.of("disabled", after));
                redis.opsForHash().put(key, "disabled", after);
                written.set(true);
            });
        } catch (RuntimeException e) {
            // Redis 에는 반영됐는데 커밋이 실패한 드문 경우: 감사 없는 변경을 남기지 않도록 Redis 값을 되돌린다
            if (written.get()) restoreProviderFlag(key, before);
            throw e;
        }
        return ResponseEntity.noContent().build();
    }

    private void restoreProviderFlag(String key, Object before) {
        try {
            if (before == null) redis.opsForHash().delete(key, "disabled");
            else redis.opsForHash().put(key, "disabled", String.valueOf(before));
        } catch (RuntimeException e) {
            org.slf4j.LoggerFactory.getLogger(OpsController.class).error("provider flag {} changed without audit and could not be restored: {}", key, e.toString());
        }
    }

    @GetMapping("/runs")
    public Map<String, Object> runs(@RequestParam(required = false) String job, @RequestParam(required = false) String status,
                                    @RequestParam(required = false) Long cursor, @RequestParam(defaultValue = "50") int limit) {
        int n = Math.max(1, Math.min(limit, 200));
        var rows = db.sql("""
                SELECT id, job, provider, started_at, finished_at, status, http_status, latency_ms, records_in, records_quarantined, raw_ref, error_text
                FROM ingest_run WHERE (:job::text IS NULL OR job = :job) AND (:status::text IS NULL OR status = :status) AND (:cursor::bigint IS NULL OR id < :cursor)
                ORDER BY id DESC LIMIT :n""").param("job", job).param("status", status).param("cursor", cursor).param("n", n + 1).query().listOfRows();
        Long next = rows.size() > n ? ((Number) rows.get(n - 1).get("id")).longValue() : null;
        var summary = db.sql("""
                SELECT job, provider, status, count(*) n, max(finished_at) last_at, avg(latency_ms)::int avg_latency_ms
                FROM ingest_run WHERE started_at > now() - interval '24 hours' GROUP BY job, provider, status ORDER BY job, provider, status""").query().listOfRows();
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("items", rows.size() > n ? rows.subList(0, n) : rows);
        m.put("next_cursor", next);
        m.put("summary_24h", summary);
        return m;
    }

    @GetMapping("/quality")
    public Map<String, Object> quality(@RequestParam(defaultValue = "7") int days) {
        int d = Math.max(1, Math.min(days, 90));
        var counts = db.sql("SELECT day, rule, count FROM quality_rule_count WHERE day >= CURRENT_DATE - :d ORDER BY day DESC, rule").param("d", d).query().listOfRows();
        var recent = db.sql("SELECT id, run_id, rule, hex, detail::text detail, created_at FROM quality_event ORDER BY id DESC LIMIT 50").query().listOfRows();
        return Map.of("rule_counts", counts, "recent", recent);
    }

    @GetMapping("/dlq")
    public Map<String, Object> dlq() {
        List<Map<String, Object>> items = new java.util.ArrayList<>();
        try {
            var recs = redis.opsForStream().reverseRange("wakeline:dlq", Range.unbounded(), Limit.limit().count(50));
            if (recs != null) for (var r : recs) { var m = new LinkedHashMap<>(castMap(r.getValue())); m.put("stream_id", r.getId().getValue()); items.add(m); }
        } catch (RuntimeException e) { return Map.of("items", items, "error", "redis unavailable"); }
        return Map.of("items", items);
    }

    @GetMapping("/settings")
    public Map<String, Object> settings() { return Map.of("items", settings.all()); }

    @PutMapping("/settings/{key}")
    public Map<String, Object> putSetting(@PathVariable String key, @RequestHeader(value = "If-Match", required = false) String ifMatch,
                                          @RequestBody JsonNode body, HttpServletRequest req, Authentication auth) {
        if (ifMatch == null) throw new Problem(org.springframework.http.HttpStatus.PRECONDITION_REQUIRED, "IF_MATCH_REQUIRED", "precondition required", "If-Match: <version> header required");
        int version;
        try { version = Integer.parseInt(ifMatch.replace("\"", "").trim()); } catch (NumberFormatException e) { throw Problem.badRequest("BAD_IF_MATCH", "If-Match must be the setting version"); }
        JsonNode value = body.has("value") ? body.get("value") : body;
        // UPDATE 와 감사 INSERT 가 한 트랜잭션(SettingsService.update) — Redis 미러는 커밋 뒤
        return settings.update(key, value, version, auth.getName(),
                (before, after) -> audit.record(req, userId(auth), "SETTING_UPDATE", key, before, after));
    }

    @GetMapping("/audit")
    public Map<String, Object> auditLog(@RequestParam(required = false) Long cursor, @RequestParam(defaultValue = "50") int limit) {
        int n = Math.max(1, Math.min(limit, 200));
        var rows = db.sql("""
                SELECT a.id, u.username, a.action, a.target, a.before::text before, a.after::text after, host(a.ip) ip, a.request_id, a.at
                FROM audit_log a LEFT JOIN ops_user u ON u.id = a.user_id WHERE (:cursor::bigint IS NULL OR a.id < :cursor) ORDER BY a.id DESC LIMIT :n""")
                .param("cursor", cursor).param("n", n + 1).query().listOfRows();
        Long next = rows.size() > n ? ((Number) rows.get(n - 1).get("id")).longValue() : null;
        return Map.of("items", rows.size() > n ? rows.subList(0, n) : rows, "next_cursor", next == null ? "" : next, "generated_at", Instant.now());
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> castMap(Map<?, ?> m) { return (Map<String, Object>) m; }

    private static Integer userId(Authentication auth) { return auth instanceof OpsAuthentication o ? o.user().id() : null; }
}
