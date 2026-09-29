package dev.wakeline.it;

import dev.wakeline.logs.LogEvents;
import dev.wakeline.logs.LogSink;
import dev.wakeline.ops.OpsUserService;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIf;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.data.redis.connection.stream.MapRecord;
import org.springframework.jdbc.core.simple.JdbcClient;
import tools.jackson.databind.JsonNode;

import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 해결 표시(계약 v5 §G13 · ADR-022) 끝에서 끝까지 — 실제 앱 · PostGIS(V13) · ACL Redis:
 * <ul>
 *   <li>POST · GET · DELETE /api/v1/ops/resolutions 는 운영 세션 전용(익명 404) · 쓰기는 CSRF(없으면 403) · 본문 오류는 400 BAD_RESOLUTION.</li>
 *   <li>로그 묶음을 해결하면 그 fp 의 지난 항목이 목록 · 묶음에서 빠지고(hidden_resolved), resolved=show 로 다시 보인다. upto 뒤의 새 발생은
 *       다시 보이고(재발), 되돌리면 모두 돌아온다. 스트림 항목은 그대로다. 감사 RESOLVE · UNRESOLVE 는 요청의 운영자 · request_id 와 함께.</li>
 *   <li>공급자 오류: /ops/providers 의 last_error_resolution · last_error_resolved(upto ≥ last_error_at).</li>
 *   <li>수집 실행 요약(/ops/runs summary_24h): 해결된 공급자의 error 실행 중 실패를 기록한 시각(finished_at — 공급자 해시의 last_error_at 과 같은 순간)이
 *       upto 이하인 것만 빠지고 hidden_resolved_errors 로 센다 — upto 전에 시작해 뒤에 실패한 실행 · 실패 시각을 모르는 실행은 보인다. ok 행 · 다른 공급자는 그대로.</li>
 * </ul>
 */
@EnabledIf("dev.wakeline.DbTestSupport#dockerAvailable")
class OpsResolutionsIT extends IntegrationTest {
    static final String PW = "resolve-horse-battery-staple";
    /** 다른 통합 시험이 상태 해시 · 실행 기록을 쓰지 않는 공급자. */
    static final String PROVIDER = "adsbdb";
    static final String JOB = "it_resolve";

    @Autowired OpsUserService users;

    OpsBrowser login(String user) { return OpsBrowser.login(this, users, user, PW); }

    static Map<String, String> csrf(OpsBrowser b) { return Map.of("X-CSRF-Token", String.valueOf(b.cookies.get("WAKELINE_CSRF"))); }

    static Res resolve(OpsBrowser b, String body) { return b.send("POST", "/api/v1/ops/resolutions", body, csrf(b)); }

    static Res revoke(OpsBrowser b, long id) { return b.send("DELETE", "/api/v1/ops/resolutions/" + id, null, csrf(b)); }

    /** 수집기 모양의 경고(스키마 v1)를 서버 로그 스트림에 싣는다 — ts 는 주어진 발생 시각. */
    static String xadd(String fp, Instant ts, String message) {
        var d = new LogEvents.Draft(ts, "collector", "collector-1:7", "WARN", "wakeline_collector.jobs.route", "MainThread", message, null, null,
                Map.of("job", "route"), false);
        String id = ItStack.admin().opsForStream().add(MapRecord.create(LogSink.STREAM, Map.of("e", LogEvents.serialize(d, fp, 0)))).getValue();
        LogsIT.nextRedisMillisecond();
        return id;
    }

    /** 그 행을 마지막으로 쓴 트랜잭션 id(PostgreSQL xmin). */
    String xmin(String table, String where) {
        return db.sql("SELECT xmin::text FROM " + table + " WHERE " + where).query(String.class).single();
    }

    static List<String> ids(JsonNode page) {
        List<String> out = new ArrayList<>();
        for (JsonNode n : page.path("items")) out.add(n.path("id").asString());
        return out;
    }

    static JsonNode group(JsonNode groups, String fp) {
        for (JsonNode g : groups.path("groups")) if (fp.equals(g.path("fp").asString())) return g;
        return null;
    }

    @Test
    void resolutionEndpointsNeedAnOpsSessionAndCsrf_andBadBodiesAre400() {
        // 익명: 읽기는 404, 쓰기는 CSRF 검사가 인가보다 먼저라 403 — CSRF 쌍을 갖춰도 익명이면 404(SecurityIT 와 같은 규칙)
        String valid = "{\"kind\":\"provider_error\",\"key\":\"awc\"}";
        assertProblem(get("/api/v1/ops/resolutions"), 404, "NOT_FOUND", "/api/v1/ops/resolutions");
        OpsBrowser anon = new OpsBrowser(this);
        assertProblem(anon.send("POST", "/api/v1/ops/resolutions", valid, Map.of()), 403, "CSRF_INVALID", "/api/v1/ops/resolutions");
        assertProblem(anon.send("DELETE", "/api/v1/ops/resolutions/1", null, Map.of()), 403, "CSRF_INVALID", "/api/v1/ops/resolutions/1");
        assertThat(anon.cookies.get("WAKELINE_CSRF")).as("CSRF cookie issued").isNotBlank();
        assertProblem(resolve(anon, valid), 404, "NOT_FOUND", "/api/v1/ops/resolutions");
        assertProblem(revoke(anon, 1), 404, "NOT_FOUND", "/api/v1/ops/resolutions/1");
        OpsBrowser b = login("it-resolve-sec");
        assertProblem(b.send("POST", "/api/v1/ops/resolutions", valid, Map.of()), 403, "CSRF_INVALID",
                "/api/v1/ops/resolutions");
        assertProblem(b.send("DELETE", "/api/v1/ops/resolutions/1", null, Map.of()), 403, "CSRF_INVALID", "/api/v1/ops/resolutions/1");
        for (String body : new String[]{"not json", "{\"kind\":\"provider_error\",\"key\":\"awc\",\"kind\":\"log_group\"}", "{\"kind\":\"alert\",\"key\":\"x\"}",
                "{\"kind\":\"log_group\",\"key\":\"XYZ\"}", "{\"kind\":\"provider_error\",\"key\":\"awc\",\"upto\":\"" + Instant.now().plusSeconds(120) + "\"}",
                "{\"kind\":\"provider_error\",\"key\":\"awc\",\"extra\":1}", ""})
            assertThat(assertProblem(resolve(b, body), 400, "BAD_RESOLUTION", "/api/v1/ops/resolutions").path("detail").asString()).as(body).isNotBlank();
        assertThat(b.send("POST", "/api/v1/ops/resolutions", "kind=provider_error", merge(csrf(b), "Content-Type", "text/plain")).status())
                .as("JSON only").isEqualTo(415);
        assertProblem(revoke(b, 987654321), 404, "NOT_FOUND", "/api/v1/ops/resolutions/987654321");
        assertThat(count("SELECT count(*) FROM ops_resolution WHERE resolved_by = 'it-resolve-sec'")).as("nothing written").isZero();
    }

    static Map<String, String> merge(Map<String, String> m, String k, String v) {
        Map<String, String> out = new java.util.LinkedHashMap<>(m);
        out.put(k, v);
        return out;
    }

    @Test
    void aResolvedLogGroupIsHiddenUntilItRecurs_andRevokingBringsItBack() {
        OpsBrowser b = login("it-resolve-logs");
        String fp = LogsIT.randomFp();
        Instant t0 = Instant.now().truncatedTo(ChronoUnit.MILLIS);
        String old1 = xadd(fp, t0.minusSeconds(20), "route lookup failed 1");
        String old2 = xadd(fp, t0.minusSeconds(10), "route lookup failed 2");
        String q = "/api/v1/ops/logs?fp=" + fp;
        JsonNode before = b.get(q).json();
        assertThat(ids(before)).containsExactly(old2, old1);
        assertThat(before.path("hidden_resolved").asInt()).isZero();
        assertThat(before.path("resolution_state").asString()).isEqualTo("ok");
        assertThat(before.path("items").get(0).has("resolved")).isTrue();
        assertThat(before.path("items").get(0).get("resolved").isNull()).as("explicit null in the real JSON (NON_NULL app rule)").isTrue();

        Res created = resolve(b, "{\"kind\":\"log_group\",\"key\":\"" + fp + "\"}");
        assertThat(created.status()).isEqualTo(201);
        JsonNode r = created.json();
        long id = r.path("id").asLong();
        assertThat(id).isPositive();
        assertThat(r.path("kind").asString()).isEqualTo("log_group");
        assertThat(r.path("key").asString()).isEqualTo(fp);
        assertThat(r.path("resolved_by").asString()).isEqualTo("it-resolve-logs");
        assertThat(r.has("note") && r.get("note").isNull()).as("note: explicit null").isTrue();
        Instant upto = Instant.parse(r.path("upto").asString());
        assertThat(upto).isBetween(t0.minusSeconds(5), Instant.now());
        assertThat(Instant.parse(r.path("resolved_at").asString())).isCloseTo(Instant.now(), org.assertj.core.api.Assertions.within(60, ChronoUnit.SECONDS));
        // 감사: 같은 요청의 운영자 · request_id, 대상 kind:key, after = 행
        Map<String, Object> audit = admin().sql("""
                SELECT u.username, a.target, a.request_id, (a.after->>'id')::bigint id FROM audit_log a JOIN ops_user u ON u.id = a.user_id
                WHERE a.action = 'RESOLVE' AND a.target = :t""").param("t", "log_group:" + fp).query().singleRow();
        assertThat(audit).containsEntry("username", "it-resolve-logs").containsEntry("id", id).containsEntry("request_id", created.header("X-Request-Id"));
        // 같은 트랜잭션: 두 행을 만든 트랜잭션 id(xmin)가 같다
        assertThat(xmin("ops_resolution", "id = " + id)).isEqualTo(xmin("audit_log", "action = 'RESOLVE' AND target = 'log_group:" + fp + "'"));

        // 기본(hide): 지난 항목은 빠지고 센다 · show: 모두, 해결된 항목에 resolved
        JsonNode hidden = b.get(q).json();
        assertThat(ids(hidden)).isEmpty();
        assertThat(hidden.path("hidden_resolved").asInt()).isEqualTo(2);
        JsonNode shown = b.get(q + "&resolved=show").json();
        assertThat(ids(shown)).containsExactly(old2, old1);
        for (JsonNode n : shown.path("items")) {
            assertThat(n.path("resolved").path("id").asLong()).isEqualTo(id);
            assertThat(Instant.parse(n.path("resolved").path("upto").asString())).isEqualTo(upto);
            assertThat(n.path("resolved").path("resolved_by").asString()).isEqualTo("it-resolve-logs");
        }
        assertThat(b.get("/api/v1/ops/logs/" + old1).json().path("resolved").path("id").asLong()).as("detail: always returned, with resolved").isEqualTo(id);
        JsonNode groups = b.get("/api/v1/ops/logs/groups").json();
        assertThat(group(groups, fp)).as("a fully resolved group is left out").isNull();
        assertThat(groups.path("hidden_resolved").asInt()).isGreaterThanOrEqualTo(2);
        assertThat(group(b.get("/api/v1/ops/logs/groups?resolved=show").json(), fp).path("resolved").path("id").asLong()).isEqualTo(id);
        // 목록: 최신 순 활성 해결
        JsonNode list = b.get("/api/v1/ops/resolutions").json();
        assertThat(list.path("items").get(0).path("id").asLong()).isEqualTo(id);
        assertThat(list.path("resolution_state").asString()).isEqualTo("ok");

        // 재발: upto 뒤의 새 발생은 보인다(resolved null) — 지난 항목은 여전히 가려진다
        String again = xadd(fp, Instant.now(), "route lookup failed 3");
        JsonNode regression = b.get(q).json();
        assertThat(ids(regression)).containsExactly(again);
        assertThat(regression.path("items").get(0).get("resolved").isNull()).isTrue();
        assertThat(regression.path("hidden_resolved").asInt()).isEqualTo(2);
        JsonNode g = group(b.get("/api/v1/ops/logs/groups").json(), fp);
        assertThat(g.path("count").asLong()).isEqualTo(1);
        assertThat(g.get("resolved").isNull()).isTrue();

        // 되돌림: 204, 모두 다시 보인다. 행은 남는다(revoked_at · revoked_by). 두 번째는 404. 감사 UNRESOLVE
        Res del = revoke(b, id);
        assertThat(del.status()).isEqualTo(204);
        JsonNode back = b.get(q).json();
        assertThat(ids(back)).containsExactly(again, old2, old1);
        assertThat(back.path("hidden_resolved").asInt()).isZero();
        assertProblem(revoke(b, id), 404, "NOT_FOUND", "/api/v1/ops/resolutions/" + id);
        assertThat(db.sql("SELECT revoked_by FROM ops_resolution WHERE id = :id AND revoked_at IS NOT NULL").param("id", id).query(String.class).single())
                .isEqualTo("it-resolve-logs");
        assertThat(count("SELECT count(*) FROM audit_log WHERE action = 'UNRESOLVE' AND target = ?", "log_group:" + fp)).isEqualTo(1);
        assertThat(xmin("ops_resolution", "id = " + id)).as("revoke and its audit row: one transaction")
                .isEqualTo(xmin("audit_log", "action = 'UNRESOLVE' AND target = 'log_group:" + fp + "'"));
        for (JsonNode n : b.get("/api/v1/ops/resolutions").json().path("items")) assertThat(n.path("id").asLong()).isNotEqualTo(id);
        // 증거는 스트림에 그대로
        assertThat(ItStack.admin().opsForStream().range(LogSink.STREAM, org.springframework.data.domain.Range.closed(old1, old1))).hasSize(1);
    }

    @Test
    void aProviderErrorIsResolvedUntilANewErrorArrives() {
        OpsBrowser b = login("it-resolve-provider");
        String key = "wakeline:provider:" + PROVIDER;
        Map<Object, Object> saved = new java.util.LinkedHashMap<>(ItStack.admin().opsForHash().entries(key));
        List<Long> made = new ArrayList<>();
        try {
            // 수집기 status.py 와 같은 모양(μs · Z)
            Instant errAt = Instant.now().minusSeconds(60).truncatedTo(ChronoUnit.MICROS);
            ItStack.hset(ItStack.collector(), key, Map.of("name", PROVIDER, "last_error_at", errAt.toString(), "last_error", "HTTP 503", "consecutive_failures", "3"));
            JsonNode p = provider(b);
            assertThat(p.has("last_error_resolution") && p.get("last_error_resolution").isNull()).as("explicit null").isTrue();
            assertThat(p.path("last_error_resolved").isBoolean()).isTrue();
            assertThat(p.path("last_error_resolved").asBoolean()).isFalse();

            Res r = resolve(b, "{\"kind\":\"provider_error\",\"key\":\"" + PROVIDER + "\",\"note\":\"upstream recovered\"}");
            assertThat(r.status()).isEqualTo(201);
            long id = r.json().path("id").asLong();
            made.add(id);
            assertThat(r.json().path("note").asString()).isEqualTo("upstream recovered");
            p = provider(b);
            assertThat(p.path("last_error_resolution").path("id").asLong()).isEqualTo(id);
            assertThat(p.path("last_error_resolution").path("resolved_by").asString()).isEqualTo("it-resolve-provider");
            assertThat(p.path("last_error_resolved").asBoolean()).isTrue();
            assertThat(p.path("last_error").asString()).as("evidence stays").isEqualTo("HTTP 503");

            // 새 오류(upto 뒤): 해결 기록은 보이지만 지금 오류는 해결되지 않았다
            ItStack.hset(ItStack.collector(), key, Map.of("last_error_at", Instant.now().plusMillis(5).toString()));
            p = provider(b);
            assertThat(p.path("last_error_resolution").path("id").asLong()).isEqualTo(id);
            assertThat(p.path("last_error_resolved").asBoolean()).isFalse();
            // 형식이 틀린 시각은 해결됐다고 보이지 않는다(모름)
            ItStack.hset(ItStack.collector(), key, Map.of("last_error_at", "yesterday"));
            assertThat(provider(b).path("last_error_resolved").asBoolean()).isFalse();
        } finally {
            for (long id : made) revoke(b, id);
            ItStack.admin().delete(key);
            if (!saved.isEmpty()) ItStack.admin().opsForHash().putAll(key, saved);
        }
    }

    JsonNode provider(OpsBrowser b) {
        JsonNode body = b.get("/api/v1/ops/providers").json();
        assertThat(body.path("resolution_state").asString()).isEqualTo("ok");
        for (JsonNode p : body.path("providers")) if (PROVIDER.equals(p.path("name").asString())) return p;
        throw new AssertionError(PROVIDER + " missing from /ops/providers");
    }

    @Test
    void theRunSummaryLeavesOutResolvedErrorRunsOnly() {
        OpsBrowser b = login("it-resolve-runs");
        JdbcClient col = JdbcClient.create(new org.springframework.jdbc.datasource.DriverManagerDataSource(
                dev.wakeline.DbTestSupport.jdbcUrl(ItStack.DB), "wakeline_collector", dev.wakeline.DbTestSupport.COLLECTOR_PW));
        List<Long> made = new ArrayList<>();
        try {
            col.sql("""
                    INSERT INTO ingest_run (job, provider, started_at, finished_at, status, latency_ms, error_text) VALUES
                      (:job, :p, now() - interval '3 hours', now() - interval '3 hours' + interval '1 second', 'error', 1000, 'HTTP 503'),
                      (:job, :p, now() - interval '2 hours', now() - interval '2 hours' + interval '1 second', 'error', 3000, 'HTTP 503'),
                      (:job, :p, now() - interval '90 minutes', now() - interval '90 minutes' + interval '1 second', 'ok', 100, NULL),
                      (:job, :p, now() - interval '10 minutes', now() - interval '10 minutes' + interval '2 seconds', 'error', 2000, 'timeout'),
                      (:job, :p, now() - interval '2 hours', now() - interval '2 hours', 'throttled', NULL, '429'),
                      (:job, 'awc', now() - interval '2 hours', now() - interval '2 hours' + interval '1 second', 'error', 500, 'HTTP 500'),
                      -- upto(아래 지금 - 3600 s) 전에 시작해 그 뒤에 실패한 실행: 해결 순간에 진행 중이던 실행 — 실패는 upto 뒤라 보인다
                      (:job, :p, now() - interval '3630 seconds', now() - interval '3570 seconds', 'error', 60000, 'timeout in flight'),
                      -- 실패 시각(finished_at)을 모르는 실행: 해결됐다고 보이지 않는다(공급자의 last_error_at 이 없을 때와 같은 규칙)
                      (:job, :p, now() - interval '3 hours', NULL, 'error', NULL, 'unknown finish')""")
                    .param("job", JOB).param("p", PROVIDER).update();
            Instant lastError = db.sql("SELECT max(finished_at) FROM ingest_run WHERE job = :j AND provider = :p AND status = 'error'")
                    .param("j", JOB).param("p", PROVIDER).query(java.time.OffsetDateTime.class).single().toInstant();
            Res r = resolve(b, "{\"kind\":\"provider_error\",\"key\":\"" + PROVIDER + "\",\"upto\":\"" + Instant.now().minusSeconds(3600) + "\"}");
            assertThat(r.status()).isEqualTo(201);
            made.add(r.json().path("id").asLong());

            JsonNode hide = b.get("/api/v1/ops/runs?limit=1").json();
            assertThat(hide.path("hidden_resolved_errors").asLong()).as("only the two runs that failed at or before upto").isEqualTo(2);
            Map<String, JsonNode> rows = rows(hide);
            assertThat(rows.get(PROVIDER + "/error").path("n").asLong())
                    .as("the error after upto, the run in flight at upto that failed after it, the run with an unknown failure time").isEqualTo(3);
            assertThat(rows.get(PROVIDER + "/error").path("avg_latency_ms").asInt()).as("avg of 2000 and 60000 (the unknown one has no latency)")
                    .isEqualTo(31000);
            // last_at 은 이 요약의 기존 표기(ms — java.sql.Timestamp 직렬화) 그대로
            assertThat(Instant.parse(rows.get(PROVIDER + "/error").path("last_at").asString())).as("the visible error's finish time")
                    .isEqualTo(lastError.truncatedTo(ChronoUnit.MILLIS));
            assertThat(rows.get(PROVIDER + "/ok").path("n").asLong()).as("ok rows unchanged").isEqualTo(1);
            assertThat(rows.get(PROVIDER + "/throttled").path("n").asLong()).as("only status error is a provider error").isEqualTo(1);
            assertThat(rows.get("awc/error").path("n").asLong()).as("another provider").isEqualTo(1);
            assertThat(b.get("/api/v1/ops/runs?job=" + JOB + "&limit=50").json().path("items").size()).as("the run list (evidence) is not filtered")
                    .isEqualTo(8);

            JsonNode show = b.get("/api/v1/ops/runs?limit=1&resolved=show").json();
            assertThat(show.path("hidden_resolved_errors").asLong()).isZero();
            assertThat(rows(show).get(PROVIDER + "/error").path("n").asLong()).isEqualTo(5);
            assertThat(rows(show).get(PROVIDER + "/error").path("avg_latency_ms").asInt()).isEqualTo(16500);

            // 지금까지 해결: 실패 시각을 아는 error 실행은 모두 빠지고, 모르는 실행 하나만 남는다
            Res all = resolve(b, "{\"kind\":\"provider_error\",\"key\":\"" + PROVIDER + "\"}");
            made.add(all.json().path("id").asLong());
            JsonNode unknown = b.get("/api/v1/ops/runs?limit=1").json();
            assertThat(rows(unknown).get(PROVIDER + "/error").path("n").asLong()).as("unknown failure time: never shown as resolved").isEqualTo(1);
            assertThat(unknown.path("hidden_resolved_errors").asLong()).isEqualTo(4);
            // 모든 error 실행을 덮으면 그 행은 사라진다
            admin().sql("DELETE FROM ingest_run WHERE job = :j AND finished_at IS NULL").param("j", JOB).update();
            JsonNode none = b.get("/api/v1/ops/runs?limit=1").json();
            assertThat(rows(none)).doesNotContainKey(PROVIDER + "/error").containsKey(PROVIDER + "/ok");
            assertThat(none.path("hidden_resolved_errors").asLong()).isEqualTo(4);
            assertProblem(b.get("/api/v1/ops/runs?resolved=everything"), 400, "BAD_RESOLVED", "/api/v1/ops/runs");
        } finally {
            for (long id : made) revoke(b, id);
            admin().sql("DELETE FROM ingest_run WHERE job = :j").param("j", JOB).update();
        }
    }

    /** summary_24h 에서 이 시험의 job 행만: "provider/status" → 행. */
    static Map<String, JsonNode> rows(JsonNode runs) {
        Map<String, JsonNode> out = new java.util.LinkedHashMap<>();
        for (JsonNode s : runs.path("summary_24h"))
            if (JOB.equals(s.path("job").asString())) out.put(s.path("provider").asString() + "/" + s.path("status").asString(), s);
        return out;
    }
}
