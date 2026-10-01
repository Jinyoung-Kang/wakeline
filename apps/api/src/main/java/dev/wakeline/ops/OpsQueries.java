package dev.wakeline.ops;

import org.springframework.data.domain.Range;
import org.springframework.data.redis.connection.Limit;
import org.springframework.data.redis.connection.stream.MapRecord;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Component;

import java.time.LocalDate;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 운영 화면이 읽는 DB · Redis 값 — 예전에는 OpsController 가 직접 읽었다(리뷰 cto-2026-10 api §2.5 phase 3 · ADR-028: 컨트롤러는 JDBC · Redis 를
 * 쓰지 않는다). 문장 · 키 · 개수는 그대로 옮겼다. Redis 를 읽지 못하면 예외를 그대로 던진다 — 그것을 응답의 error 필드로 바꾸는 일(그리고 빈 목록과
 * 구별하는 일)은 응답 모양이라 컨트롤러가 한다.
 */
@org.springframework.context.annotation.Profile("!cli & !migrate")
@Component
public class OpsQueries {
    private final JdbcClient db;
    private final StringRedisTemplate redis;

    public OpsQueries(JdbcClient db, StringRedisTemplate redis) {
        this.db = db;
        this.redis = redis;
    }

    /** collector 의 자동 전환(wakeline:events) — 최근 20개, 새것부터. */
    public List<Map<String, Object>> switchEvents() {
        List<Map<String, Object>> out = new ArrayList<>();
        List<MapRecord<String, Object, Object>> recs = redis.opsForStream().reverseRange("wakeline:events", Range.unbounded(), Limit.limit().count(20));
        if (recs != null) for (var r : recs) out.add(new LinkedHashMap<>(castMap(r.getValue())));
        return out;
    }

    /** 공급자 하루 예산(수집기의 UTC 날) — 최근 8개 날, 날 역순 · 공급자 순. */
    public List<Map<String, Object>> budgetDays() {
        return db.sql("SELECT provider, to_char(day, 'YYYY-MM-DD') AS day, calls, limit_value FROM provider_budget_day WHERE day >= (now() AT TIME ZONE 'UTC')::date - 7 ORDER BY 2 DESC, provider").query().listOfRows();
    }

    /** quality_rule_count 를 KST 날짜 셈으로 바꾼 순간(kst_day_cutover, UTC ISO) — 없으면 null. */
    public String qualityCountedSince() {
        return db.sql("SELECT to_char(cut_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') FROM kst_day_cutover WHERE table_name = 'quality_rule_count'")
                .query(String.class).optional().orElse(null);
    }

    /** 품질 규칙 위반 수 — from(KST 날짜)부터, 바꾼 날(zone 의 날짜) 앞의 행은 빼고. 날 역순 · 규칙 순. */
    public List<Map<String, Object>> qualityRuleCounts(LocalDate from, String zone) {
        return db.sql("""
                SELECT to_char(day, 'YYYY-MM-DD') AS day, rule, count FROM quality_rule_count
                WHERE day >= :from
                  AND day >= coalesce((SELECT (cut_at AT TIME ZONE :zone)::date FROM kst_day_cutover WHERE table_name = 'quality_rule_count'), day)
                ORDER BY 1 DESC, rule""")
                .param("from", from).param("zone", zone).query().listOfRows();
    }

    /** 최근 품질 사건 50개, 새것부터. */
    public List<Map<String, Object>> qualityRecent() {
        return db.sql("SELECT id, run_id, rule, hex, detail::text detail, created_at FROM quality_event ORDER BY id DESC LIMIT 50").query().listOfRows();
    }

    /** DLQ(wakeline:dlq) — 최근 50개, 새것부터. 항목마다 stream_id 를 싣는다. */
    public List<Map<String, Object>> dlq() {
        List<Map<String, Object>> items = new ArrayList<>();
        var recs = redis.opsForStream().reverseRange("wakeline:dlq", Range.unbounded(), Limit.limit().count(50));
        if (recs != null) for (var r : recs) { var m = new LinkedHashMap<>(castMap(r.getValue())); m.put("stream_id", r.getId().getValue()); items.add(m); }
        return items;
    }

    /** 감사 기록 한 쪽: id 가 cursor 보다 작은(없으면 처음부터) 행을 새것부터 rows 개(사용자 이름 · ip 를 붙여서). */
    public List<Map<String, Object>> auditRows(Long cursor, int rows) {
        return db.sql("""
                SELECT a.id, u.username, a.action, a.target, a.before::text before, a.after::text after, host(a.ip) ip, a.request_id, a.at
                FROM audit_log a LEFT JOIN ops_user u ON u.id = a.user_id WHERE (:cursor::bigint IS NULL OR a.id < :cursor) ORDER BY a.id DESC LIMIT :n""")
                .param("cursor", cursor).param("n", rows).query().listOfRows();
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> castMap(Map<?, ?> m) { return (Map<String, Object>) m; }
}
