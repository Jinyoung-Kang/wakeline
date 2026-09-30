package dev.wakeline.ops;

import dev.wakeline.persist.Sql;
import org.springframework.jdbc.core.simple.JdbcClient;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * 수집 실행 기록(ingest_run) 읽기 — 운영 RUNS(GET /api/v1/ops/runs). 운영 조회라 문장 상한은 연결 설정(statement_timeout 30 s)이다.
 * <p>목록 필터는 주어진 것만 문장에 둔다(R-15 — {@code (:x IS NULL OR col = :x)} 한 문장은 몇 번 실행된 뒤의 일반 계획에서 인덱스를 쓰지 못한다):
 * job 이 있으면 ingest_run_job(job, started_at DESC), since 만 있으면 ingest_run_started 로 범위를 좁힌다.
 */
public class IngestRunRepository {
    private final JdbcClient db;

    public IngestRunRepository(JdbcClient db) { this.db = db; }

    /** 목록 필터 — null 은 그 조건 없음. since = started_at 이 이 순간보다 뒤(요약의 창과 같은 비교). */
    public record Filter(String job, String provider, String status, Instant since) {}

    /** 한 쪽: items(id 역순) · nextCursor(다음 쪽이 있으면 이 쪽 마지막 id, 없으면 null). */
    public record Page(List<Map<String, Object>> items, Long nextCursor) {}

    /** 24 h 요약: 보이는 행(n &gt; 0) · 해결 표시로 뺀 error 실행 수 · 창의 시작(started_at &gt; since). */
    public record Summary(List<Map<String, Object>> rows, long hiddenResolvedErrors, Instant since) {}

    /**
     * 목록 한 쪽(id 역순). since 가 있으면 창 안의 행을 먼저 고른 뒤(MATERIALIZED — 계획의 울타리) id 순으로 자른다: 한 문장에 두면 일반 계획이
     * 'ORDER BY id DESC LIMIT' 를 기본 키 역순 훑기로 풀어, 드문 status(몇 건의 error)를 찾느라 30일 표 전체를 훑었다(IngestRunRepositoryDbTest).
     * since 가 없으면 전과 같은 한 문장(최근 것부터 훑다가 쪽이 차면 멈춘다 — 필터 없는 '최근 실행' 목록).
     */
    public Page runs(Filter f, Long cursor, int limit) {
        StringBuilder where = new StringBuilder();
        List<String> names = new ArrayList<>();
        List<Object> values = new ArrayList<>();
        cond(where, names, values, "job = :job", "job", f.job());
        cond(where, names, values, "provider = :provider", "provider", f.provider());
        cond(where, names, values, "status = :status", "status", f.status());
        cond(where, names, values, "started_at > :since", "since", Sql.ts(f.since()));
        cond(where, names, values, "id < :cursor", "cursor", cursor);
        String cols = "id, job, provider, started_at, finished_at, status, http_status, latency_ms, records_in, records_quarantined, raw_ref, error_text";
        String filtered = "SELECT " + cols + " FROM ingest_run" + (where.isEmpty() ? "" : " WHERE " + where);
        String sql = f.since() == null ? filtered + " ORDER BY id DESC LIMIT :n"
                : "WITH w AS MATERIALIZED (" + filtered + ") SELECT " + cols + " FROM w ORDER BY id DESC LIMIT :n";
        var q = db.sql(sql).param("n", limit + 1);
        for (int i = 0; i < names.size(); i++) q = q.param(names.get(i), values.get(i));
        List<Map<String, Object>> rows = q.query().listOfRows();
        Long next = rows.size() > limit ? ((Number) rows.get(limit - 1).get("id")).longValue() : null;
        return new Page(rows.size() > limit ? rows.subList(0, limit) : rows, next);
    }

    private static void cond(StringBuilder where, List<String> names, List<Object> values, String sql, String name, Object value) {
        if (value == null) return;
        if (!where.isEmpty()) where.append(" AND ");
        where.append(sql);
        names.add(name);
        values.add(value);
    }

    /**
     * job · provider · status 마다 n · last_at · avg_latency_ms 와 last_error_text · last_http_status. 둘은 ok 가 아닌 행만 — 그 행의 가장 최근 실행
     * (finished_at 이 가장 늦은 것, 같으면 id 가 큰 것, finished_at 을 모르는 실행은 뒤로)의 error_text(수집기가 가려 저장한 그대로) · http_status, 없으면 null.
     * ok 행은 둘 다 null(고르지 않는다 — ok 실행은 오류가 아니고 화면도 비운다).
     * 창 = started_at &gt; now() − 24 h. hide 면 활성 provider_error 해결이 있는 공급자의 status 'error' 실행 중 finished_at ≤ upto 를 셈 · 마지막 시각 · 평균 ·
     * 가장 최근 실행 고르기에서 모두 빼고 따로 센다(n 이 0 이 된 행은 없다 — 계약 v5 §G14).
     * <p>가장 최근 실행은 한 번의 묶음(HashAggregate)에서 고른다: 행마다 [finished_at 의 epoch(모르면 −∞), id] 배열의 max 가 위 순서의 첫 실행이고
     * (numeric — 마이크로초까지 정확), 묶음 뒤 그 id 로 한 행씩 읽는다(기본 키). row_number() 창 함수로 고르면 창의 모든 행(ok 포함)을 글자 키로 정렬해
     * 요약이 약 5배 느렸다(리뷰 2026-10-01 — 15 s 마다 부른다 · IngestRunRepositoryDbTest 가 창의 행을 정렬하는 계획을 막는다). 배열은 ok 가 아닌 행에서만 만든다.
     * <p>한 트랜잭션 안에서 부른다(OpsController): now() 는 트랜잭션 시작 시각이라 돌려주는 since 가 요약 문장의 창 시작과 같은 값이다. 창은 문장에
     * now() 식으로 둔다 — 파라미터로 넘기면 여러 번 실행된 뒤의 일반 계획이 창의 크기를 몰라(기본 추정 1/3) 표 전체를 훑을 수 있다(15 s 마다 부른다).
     */
    public Summary summary(boolean hide) {
        Instant since = db.sql("SELECT now() - interval '24 hours'").query(java.time.OffsetDateTime.class).single().toInstant();
        var grouped = db.sql("""
                WITH res AS (SELECT key AS provider, max(upto) AS upto FROM ops_resolution
                             WHERE kind = 'provider_error' AND revoked_at IS NULL GROUP BY key),
                     r AS (SELECT i.id, i.job, i.provider, i.status, i.finished_at, i.latency_ms,
                                  :hide AND coalesce(i.status = 'error' AND i.finished_at <= res.upto, false) AS hidden
                           FROM ingest_run i LEFT JOIN res ON res.provider = i.provider
                           WHERE i.started_at > now() - interval '24 hours'),
                     g AS (SELECT job, provider, status, count(*) FILTER (WHERE NOT hidden) n, max(finished_at) FILTER (WHERE NOT hidden) last_at,
                                  (avg(latency_ms) FILTER (WHERE NOT hidden))::int avg_latency_ms, count(*) FILTER (WHERE hidden) hidden_n,
                                  max(ARRAY[coalesce(extract(epoch FROM finished_at), '-Infinity'::numeric), id::numeric])
                                      FILTER (WHERE NOT hidden AND status <> 'ok') newest
                           FROM r GROUP BY job, provider, status)
                SELECT g.job, g.provider, g.status, g.n, g.last_at, g.avg_latency_ms, g.hidden_n,
                       l.error_text AS last_error_text, l.http_status AS last_http_status
                FROM g LEFT JOIN ingest_run l ON l.id = (g.newest[2])::bigint
                ORDER BY g.job, g.provider, g.status""")
                .param("hide", hide).query().listOfRows();
        List<Map<String, Object>> rows = new ArrayList<>(grouped.size());
        long hidden = 0;
        for (Map<String, Object> row : grouped) {
            hidden += ((Number) row.remove("hidden_n")).longValue();
            if (((Number) row.get("n")).longValue() > 0) rows.add(row); // 모두 해결된 행은 빠진다
        }
        return new Summary(rows, hidden, since);
    }
}
