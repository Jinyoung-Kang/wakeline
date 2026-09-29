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

/**
 * 운영 API(인증 필요, 비인가 404). 공급자·실행 이력·품질 게이트·설정·감사·DLQ.
 * 모든 변경은 감사 기록과 원자적이다(SEC-11): 변경의 원본은 DB 이고 감사 행과 한 트랜잭션으로 커밋된다 — 감사 없이 적용된 변경도,
 * 적용되지 않았는데 남은 감사 행도 없다. collector 가 읽는 Redis 값(설정·공급자 스위치)은 커밋 뒤 미러이고 60 s 마다 다시 맞춘다(StartupMirror).
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
    private final ProviderSwitchService switches;
    private final ResolutionService resolutions;

    public OpsController(StatusService status, JdbcClient db, StringRedisTemplate redis, SettingsService settings, AuditService audit,
                         dev.wakeline.persist.MaintenanceJobs jobs, TransactionTemplate tx, ProviderSwitchService switches,
                         ResolutionService resolutions) {
        this.status = status;
        this.db = db;
        this.redis = redis;
        this.settings = settings;
        this.audit = audit;
        this.jobs = jobs;
        this.tx = tx;
        this.switches = switches;
        this.resolutions = resolutions;
    }

    /**
     * 통계 재집계(멱등). 기본은 어제(UTC). 그 날의 재집계와 감사 기록이 한 트랜잭션 — 실패하면 둘 다 없다.
     * 끝난 날(오늘 UTC 이전)만 받는다(R-46) — 부분 집계가 완성된 통계처럼 남지 않게. 원본이 보존으로 사라진 계열은 다시 세지 않는다(MaintenanceJobs).
     */
    @PostMapping("/stats/aggregate")
    public ResponseEntity<Map<String, Object>> aggregate(@RequestParam(required = false) java.time.LocalDate day, HttpServletRequest req, Authentication auth) {
        java.time.LocalDate today = java.time.LocalDate.now(java.time.ZoneOffset.UTC);
        java.time.LocalDate d = day == null ? today.minusDays(1) : day;
        if (!d.isBefore(today)) throw Problem.badRequest("BAD_DAY", "day must be before today (UTC) — a day is aggregated once it has ended");
        tx.executeWithoutResult(st -> {
            jobs.aggregateDay(d);
            audit.record(req, userId(auth), "STATS_AGGREGATE", d.toString(), null, null);
        });
        return ResponseEntity.ok(Map.of("day", d.toString()));
    }

    /**
     * 공급자 상태(수집기 해시) · 자동 전환 · 예산 · 스위치. 공급자마다 해결 표시(계약 v5 §G13): last_error_resolution = 그 공급자의 유효한
     * provider_error 해결 {id, upto, resolved_by} | null(키는 늘 있다), last_error_resolved = 그 해결의 upto ≥ last_error_at(시각을 모르거나
     * 형식이 틀리면 false — 모르는 오류를 해결됨으로 보이지 않는다). 해시의 오류 값은 그대로 둔다(증거). resolution_state 는 해결 기록의 상태.
     */
    @GetMapping("/providers")
    public Map<String, Object> providers() {
        List<Map<String, Object>> list = status.providerStatuses();
        Resolutions res = resolutions.active();
        for (Map<String, Object> p : list) {
            Resolution r = res.provider(String.valueOf(p.get("name")));
            // 앱 JSON 규칙(NON_NULL)은 Map 의 null 값을 뺀다 — 계약은 명시적 null 이라 JSON null 노드로 싣는다
            p.put("last_error_resolution", r == null ? tools.jackson.databind.node.NullNode.getInstance() : r.ref());
            p.put("last_error_resolved", r != null && r.covers(OpsPipelineController.time(p.get("last_error_at"))));
        }
        List<Map<String, Object>> switchEvents = new java.util.ArrayList<>(); // collector 의 자동 전환(wakeline:events)
        try {
            List<MapRecord<String, Object, Object>> recs = redis.opsForStream().reverseRange("wakeline:events", Range.unbounded(), Limit.limit().count(20));
            if (recs != null) for (var r : recs) switchEvents.add(new LinkedHashMap<>(castMap(r.getValue())));
        } catch (RuntimeException ignored) { }
        var budgets = db.sql("SELECT provider, to_char(day, 'YYYY-MM-DD') AS day, calls, limit_value FROM provider_budget_day WHERE day >= CURRENT_DATE - 7 ORDER BY 2 DESC, provider").query().listOfRows();
        // provider_switch: 켜고 끄기의 원본(DB)과 collector 가 따르는 Redis 미러를 공급자마다 나란히(R-94) — providers 의 disabled 는 미러 값이다
        return Map.of("providers", list, "active", status.publicStatus().get("active_providers"), "collector", status.collectorHeartbeat(),
                "switches", switchEvents, "budget_days", budgets, "provider_switch", switches.states(), "resolution_state", res.state().label());
    }

    /**
     * 공급자 켜고 끄기(R-94, 계약 v5 §D1): 원본은 DB provider_switch — 감사 행과 한 트랜잭션으로 갱신하고, 커밋 뒤 collector 가 읽는
     * Redis wakeline:provider:{name}.disabled 로 미러한다. 미러가 실패해도 변경은 확정이고(mirrored=false) 주기 미러가 60 s 안에 맞춘다 —
     * 그동안 collector 는 이전 값을 따르므로 운영 화면은 mirrored=false 를 경고로 보이고, /ops/providers 의 provider_switch 로 원본과 미러를 나란히 보인다.
     * 이전에는 Redis 에만 있어서 Redis 볼륨을 잃으면 조용히 '켜짐'으로 돌아갔고, 같은 해시에 쓰는 collector 가 감사 없이 바꿀 수 있었다.
     * @return {provider, disabled, version, updated_at, mirrored}
     */
    @PostMapping("/providers/{name}/{action}")
    public Map<String, Object> toggleProvider(@PathVariable String name, @PathVariable String action, HttpServletRequest req, Authentication auth) {
        if (!StatusService.PROVIDERS.contains(name)) throw Problem.notFound("provider not found");
        boolean disable = switch (action) { case "disable" -> true; case "enable" -> false; default -> throw Problem.notFound("no such action"); };
        Integer uid = userId(auth);
        return switches.set(name, disable, uid,
                (before, after) -> audit.record(req, uid, disable ? "PROVIDER_DISABLE" : "PROVIDER_ENABLE", name, before, after));
    }

    /**
     * 수집 실행 기록(items — 증거라 가리지 않는다)과 24 h 요약(summary_24h — job · provider · status 마다 n · last_at · avg_latency_ms).
     * 요약은 resolved=hide(기본) | show(계약 v5 §G13): hide 면 활성 provider_error 해결이 있는 공급자의 status 'error' 실행 중 started_at ≤ upto
     * (그 공급자의 유효 해결 — upto 가 가장 늦은 것)를 셈 · 마지막 시각 · 평균에서 빼고 hidden_resolved_errors 로 센다(n 이 0 이 된 행은 없다).
     * 'error' 만 공급자 오류다 — collector 가 status.failure(last_error)를 쓰는 실행과 같다(throttled · budget_* 는 그대로). 해결은 DB 에서 같은 문장으로
     * 읽는다(캐시 없이 — 요약 자체가 DB 조회라 더 부를 것이 없다).
     */
    @GetMapping("/runs")
    public Map<String, Object> runs(@RequestParam(required = false) String job, @RequestParam(required = false) String status,
                                    @RequestParam(required = false) Long cursor, @RequestParam(defaultValue = "50") int limit,
                                    @RequestParam(required = false) String resolved) {
        boolean hide = Resolutions.hide(resolved);
        int n = Math.max(1, Math.min(limit, 200));
        var rows = db.sql("""
                SELECT id, job, provider, started_at, finished_at, status, http_status, latency_ms, records_in, records_quarantined, raw_ref, error_text
                FROM ingest_run WHERE (:job::text IS NULL OR job = :job) AND (:status::text IS NULL OR status = :status) AND (:cursor::bigint IS NULL OR id < :cursor)
                ORDER BY id DESC LIMIT :n""").param("job", job).param("status", status).param("cursor", cursor).param("n", n + 1).query().listOfRows();
        Long next = rows.size() > n ? ((Number) rows.get(n - 1).get("id")).longValue() : null;
        var grouped = db.sql("""
                WITH res AS (SELECT key AS provider, max(upto) AS upto FROM ops_resolution
                             WHERE kind = 'provider_error' AND revoked_at IS NULL GROUP BY key),
                     r AS (SELECT i.job, i.provider, i.status, i.finished_at, i.latency_ms,
                                  :hide AND coalesce(i.status = 'error' AND i.started_at <= res.upto, false) AS hidden
                           FROM ingest_run i LEFT JOIN res ON res.provider = i.provider
                           WHERE i.started_at > now() - interval '24 hours')
                SELECT job, provider, status, count(*) FILTER (WHERE NOT hidden) n, max(finished_at) FILTER (WHERE NOT hidden) last_at,
                       (avg(latency_ms) FILTER (WHERE NOT hidden))::int avg_latency_ms, count(*) FILTER (WHERE hidden) hidden_n
                FROM r GROUP BY job, provider, status ORDER BY job, provider, status""").param("hide", hide).query().listOfRows();
        List<Map<String, Object>> summary = new java.util.ArrayList<>(grouped.size());
        long hiddenErrors = 0;
        for (Map<String, Object> row : grouped) {
            hiddenErrors += ((Number) row.remove("hidden_n")).longValue();
            if (((Number) row.get("n")).longValue() > 0) summary.add(row); // 모두 해결된 행은 빠진다
        }
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("items", rows.size() > n ? rows.subList(0, n) : rows);
        m.put("next_cursor", next);
        m.put("summary_24h", summary);
        m.put("hidden_resolved_errors", hiddenErrors);
        return m;
    }

    @GetMapping("/quality")
    public Map<String, Object> quality(@RequestParam(defaultValue = "7") int days) {
        int d = Math.max(1, Math.min(days, 90));
        // day 는 UTC 날짜 "YYYY-MM-DD"(R-45 — JVM 시간대의 자정 시각이 아니다)
        var counts = db.sql("SELECT to_char(day, 'YYYY-MM-DD') AS day, rule, count FROM quality_rule_count WHERE day >= CURRENT_DATE - :d ORDER BY 1 DESC, rule").param("d", d).query().listOfRows();
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
        // 다음 쪽이 없으면 null — 키가 빠진다(R-74: /alerts/history · /ops/runs 와 같은 계약, 이전에는 빈 문자열)
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("items", rows.size() > n ? rows.subList(0, n) : rows);
        m.put("next_cursor", next);
        m.put("generated_at", Instant.now());
        return m;
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> castMap(Map<?, ?> m) { return (Map<String, Object>) m; }

    private static Integer userId(Authentication auth) { return auth instanceof OpsAuthentication o ? o.user().id() : null; }
}
