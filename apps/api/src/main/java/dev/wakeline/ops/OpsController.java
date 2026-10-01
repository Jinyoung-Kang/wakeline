package dev.wakeline.ops;

import dev.wakeline.platform.web.Problem;
import dev.wakeline.status.StatusService;
import dev.wakeline.settings.SettingsService;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.http.ResponseEntity;
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
 * DB · Redis 읽기는 {@link OpsQueries} · {@link IngestRunRepository} 가 한다(ADR-028 — 컨트롤러는 JDBC · Redis 를 쓰지 않는다).
 */
@org.springframework.context.annotation.Profile("!cli & !migrate")
@RestController
@RequestMapping("/api/v1/ops")
public class OpsController {
    private final StatusService status;
    private final OpsQueries queries;
    private final SettingsService settings;
    private final AuditService audit;
    private final dev.wakeline.history.MaintenanceJobs jobs;
    private final TransactionTemplate tx;
    private final ProviderSwitchService switches;
    private final ResolutionService resolutions;
    private final IngestRunRepository ingestRuns;

    public OpsController(StatusService status, OpsQueries queries, SettingsService settings, AuditService audit,
                         dev.wakeline.history.MaintenanceJobs jobs, TransactionTemplate tx, ProviderSwitchService switches,
                         ResolutionService resolutions, IngestRunRepository ingestRuns) {
        this.status = status;
        this.queries = queries;
        this.settings = settings;
        this.audit = audit;
        this.jobs = jobs;
        this.tx = tx;
        this.switches = switches;
        this.resolutions = resolutions;
        this.ingestRuns = ingestRuns;
    }

    /**
     * 통계 재집계(멱등). day = KST 날짜(계약 v5 §G20), 기본은 어제(KST). 그 날의 재집계와 감사 기록이 한 트랜잭션 — 실패하면 둘 다 없다.
     * 끝난 날(오늘 KST 이전)만 받는다(R-46) — 부분 집계가 완성된 통계처럼 남지 않게. 원본이 보존으로 사라진 계열은 다시 세지 않는다(MaintenanceJobs).
     */
    @PostMapping("/stats/aggregate")
    public ResponseEntity<Map<String, Object>> aggregate(@RequestParam(required = false) java.time.LocalDate day, HttpServletRequest req, Authentication auth) {
        java.time.LocalDate today = dev.wakeline.history.MaintenanceJobs.today();
        java.time.LocalDate d = day == null ? today.minusDays(1) : day;
        if (!d.isBefore(today)) throw Problem.badRequest("BAD_DAY", "day must be before today (KST, Asia/Seoul) — a day is aggregated once it has ended");
        tx.executeWithoutResult(st -> {
            jobs.aggregateDay(d);
            audit.record(req, userId(auth), "STATS_AGGREGATE", d.toString(), null, null);
        });
        return ResponseEntity.ok(Map.of("day", d.toString()));
    }

    /**
     * 공급자 상태(수집기 해시) · 자동 전환 · 예산 · 스위치. 공급자마다 해결 표시(계약 v5 §G14): last_error_resolution = 그 공급자의 유효한
     * provider_error 해결 {id, upto, resolved_by} | null(키는 늘 있다), last_error_resolved = 그 해결의 upto ≥ last_error_at(시각을 모르거나
     * 형식이 틀리면 false — 모르는 오류를 해결됨으로 보이지 않는다). 해시의 오류 값은 그대로 둔다(증거). resolution_state 는 해결 기록의 상태.
     * budget_days 는 수집기의 하루 예산 키(budget.py day_key)를 옮긴 것이라 그 day 는 UTC 날 — budget_day_zone "UTC" 로 밝힌다(계약 v5 §G20: 화면은
     * 그 날짜를 KST 날짜로 이름만 바꾸지 않고 창 "09:00 KST 부터 24 h" 로 적는다). 최근 8개 UTC 날. generated_at = 응답을 만든 서버 시각(UTC ISO) —
     * 운영 화면이 수집기 해시의 시각(기상청 '파일 없음' 연속의 마지막 확인)을 서버 기준 지금과 견준다(계약 v5 §G22 — 브라우저 시계가 틀려도 같은 판정).
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
        List<Map<String, Object>> switchEvents = List.of(); // collector 의 자동 전환(wakeline:events)
        String switchesError = null;
        try {
            switchEvents = queries.switchEvents();
        } catch (RuntimeException e) {
            // 읽지 못한 것을 '전환 없음' 과 구별한다 — /ops/dlq 와 같은 error 필드(리뷰 cto-2026-10 A4 — 예전에는 빈 목록뿐이었다)
            switchesError = "redis unavailable";
        }
        var budgets = queries.budgetDays();
        // provider_switch: 켜고 끄기의 원본(DB)과 collector 가 따르는 Redis 미러를 공급자마다 나란히(R-94) — providers 의 disabled 는 미러 값이다
        // generated_at: 이 응답을 만든 서버 시각 — 운영 화면이 수집기 시각(missing_checked_at 등)의 나이를 브라우저 시계가 아니라 서버 기준으로 잰다(계약 v5 §G22)
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("providers", list);
        m.put("active", status.publicStatus().get("active_providers"));
        m.put("collector", status.collectorHeartbeat());
        m.put("switches", switchEvents);
        if (switchesError != null) m.put("error", switchesError);
        m.put("budget_days", budgets);
        m.put("budget_day_zone", "UTC");
        m.put("provider_switch", switches.states());
        m.put("resolution_state", res.state().label());
        m.put("generated_at", Instant.now());
        return m;
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
     * 수집 실행 기록(items — 증거라 가리지 않는다)과 24 h 요약(summary_24h — job · provider · status 마다 n · last_at · avg_latency_ms ·
     * last_error_text · last_http_status).
     * 요약은 resolved=hide(기본) | show(계약 v5 §G14): hide 면 활성 provider_error 해결이 있는 공급자의 status 'error' 실행 중 finished_at ≤ upto
     * (그 공급자의 유효 해결 — upto 가 가장 늦은 것)를 셈 · 마지막 시각 · 평균 · 가장 최근 실행 고르기에서 빼고 hidden_resolved_errors 로 센다(n 이 0 이 된 행은 없다).
     * 기준은 실패를 기록한 시각(finished_at)이다 — collector 는 status.failure(last_error_at = 그때)를 쓴 바로 뒤 record_run(finished_at = 그때)을 적으므로
     * /ops/providers 의 last_error_resolved(upto ≥ last_error_at)와 같은 순간을 본다. started_at 으로 보면 해결 순간에 진행 중이던 실행(단계마다 읽기 8 s ·
     * 재시도)이 upto 뒤에 실패해도 가려져, 같은 실패가 공급자에서는 미해결 · 요약에서는 해결로 갈린다. finished_at 이 없으면(실패 시각을 모름) 가리지 않는다.
     * 'error' 만 공급자 오류다 — collector 가 status.failure(last_error)를 쓰는 실행과 같다(throttled · budget_* 는 그대로). 해결은 DB 에서 같은 문장으로
     * 읽는다(캐시 없이 — 요약 자체가 DB 조회라 더 부를 것이 없다).
     * <p>last_error_text · last_http_status(운영 2026-09-30 — region adsb_fi error 13 중 공급자 해시의 마지막 하나만 까닭이 보였다): ok 가 아닌 행은 그 행의
     * 가장 최근 실행(finished_at 이 가장 늦은 것, 모르면 뒤로 — last_at 과 같은 실행)의 오류 글자(수집기가 가려 저장한 그대로 — 원문 시각 'Z' 포함)와 http,
     * 없으면 null. ok 행은 둘 다 null(고르지 않는다 — 요약을 느리게 하지 않게, IngestRunRepository.summary). 키는 늘 있다.
     * summary_since = 요약 창의 시작(UTC ISO — DB 의 now() − 24 h, 요약 문장과 한 트랜잭션) — 창은 started_at &gt; summary_since. 그 값을 since 로 돌려주면 목록이 같은 창의 실행만 싣는다.
     * <p>목록 필터 job · provider · status · since(started_at &gt; since, ISO 순간 — 틀리면 400) · cursor — 모두 선택(없으면 그 조건 없음, 전과 같다).
     */
    @GetMapping("/runs")
    public Map<String, Object> runs(@RequestParam(required = false) String job, @RequestParam(required = false) String provider,
                                    @RequestParam(required = false) String status, @RequestParam(required = false) Instant since,
                                    @RequestParam(required = false) Long cursor, @RequestParam(defaultValue = "50") int limit,
                                    @RequestParam(required = false) String resolved) {
        boolean hide = Resolutions.hide(resolved);
        int n = Math.max(1, Math.min(limit, 200));
        var page = ingestRuns.runs(new IngestRunRepository.Filter(job, provider, status, since), cursor, n);
        // 한 트랜잭션: 창의 시작(summary_since)과 요약 문장이 같은 now() 를 본다
        var summary = tx.execute(st -> ingestRuns.summary(hide));
        for (Map<String, Object> row : summary.rows()) {
            // 앱 JSON 규칙(NON_NULL)은 Map 의 null 값을 뺀다 — 이 두 키는 늘 싣는다(null = 가장 최근 실행에 글자 · http 가 없음 또는 ok 행, 키 없음 = 옛 api)
            row.computeIfAbsent("last_error_text", k -> tools.jackson.databind.node.NullNode.getInstance());
            row.computeIfAbsent("last_http_status", k -> tools.jackson.databind.node.NullNode.getInstance());
        }
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("items", page.items());
        m.put("next_cursor", page.nextCursor());
        m.put("summary_24h", summary.rows());
        m.put("summary_since", summary.since());
        m.put("hidden_resolved_errors", summary.hiddenResolvedErrors());
        return m;
    }

    @GetMapping("/quality")
    public Map<String, Object> quality(@RequestParam(defaultValue = "7") int days) {
        int d = Math.max(1, Math.min(days, 90));
        // day 는 KST 날짜 "YYYY-MM-DD"(계약 v5 §G20 — 수집기가 실행이 시작된 KST 날짜로 센다 · R-45 — JVM 시간대의 자정 시각이 아니다). 최근 d 일(KST 오늘 포함 d+1 개 날)
        // counted_since = V16 이 이 표를 KST 날짜 셈으로 바꾼 순간(kst_day_cutover, UTC ISO) — 그 KST 날짜의 수는 그 뒤 실행만 든 부분 값이다(화면이 '부분' 으로 적는다).
        // 그보다 앞 KST 날짜의 행은 내지 않는다: 배포 중 아직 돌던 이전 수집기가 UTC 날짜로 쓴 행뿐이다(V16 앞의 수는 보관 표에 있다).
        String zone = dev.wakeline.history.MaintenanceJobs.DAY_ZONE_ID;
        String since = queries.qualityCountedSince();
        var counts = queries.qualityRuleCounts(dev.wakeline.history.MaintenanceJobs.today().minusDays(d), zone);
        var recent = queries.qualityRecent();
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("rule_counts", counts);
        m.put("recent", recent);
        m.put("day_zone", zone);
        m.put("counted_since", since);
        return m;
    }

    @GetMapping("/dlq")
    public Map<String, Object> dlq() {
        List<Map<String, Object>> items;
        try {
            items = queries.dlq();
        } catch (RuntimeException e) { return Map.of("items", List.of(), "error", "redis unavailable"); }
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
        var rows = queries.auditRows(cursor, n + 1);
        Long next = rows.size() > n ? ((Number) rows.get(n - 1).get("id")).longValue() : null;
        // 다음 쪽이 없으면 null — 키가 빠진다(R-74: /alerts/history · /ops/runs 와 같은 계약, 이전에는 빈 문자열)
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("items", rows.size() > n ? rows.subList(0, n) : rows);
        m.put("next_cursor", next);
        m.put("generated_at", Instant.now());
        return m;
    }

    private static Integer userId(Authentication auth) { return auth instanceof OpsAuthentication o ? o.user().id() : null; }
}
