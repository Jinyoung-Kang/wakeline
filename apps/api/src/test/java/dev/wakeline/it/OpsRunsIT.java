package dev.wakeline.it;

import dev.wakeline.DbTestSupport;
import dev.wakeline.ops.OpsUserService;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIf;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import tools.jackson.databind.JsonNode;

import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 운영 RUNS 가 오래된 오류 실행의 까닭을 보인다(운영 2026-09-30 — region adsb_fi error 13 중 마지막 하나의 글자만 보였다):
 * <ul>
 *   <li>summary_24h 행마다 last_error_text · last_http_status — 그 job · provider · status 의 가장 최근 실행(실패를 기록한 시각 finished_at 이 가장 늦은 것,
 *       모르면 뒤로)의 오류 글자(수집기가 가려 저장한 그대로)와 http. 해결 표시(resolved=hide)가 요약에서 뺀 실행은 고르지 않는다(n · last_at 과 같은 규칙).</li>
 *   <li>summary_since — 요약의 24 h 창이 시작한 순간(UTC ISO). 그 값을 since 로 돌려주면 같은 창의 실행만 나온다.</li>
 *   <li>GET /ops/runs 의 provider · since 필터(기본 없음 — 전과 같다). 목록(items)은 증거라 해결 표시와 상관없이 그대로 · 커서로 쪽을 넘긴다.</li>
 * </ul>
 */
@EnabledIf("dev.wakeline.DbTestSupport#dockerAvailable")
class OpsRunsIT extends IntegrationTest {
    static final String PW = "runs-horse-battery-staple";
    static final String JOB = "it_runs_drill";
    /** 다른 통합 시험이 해결 · 실행 기록을 쓰지 않는 운영 공급자 둘 */
    static final String P1 = "komsa_traffic";
    static final String P2 = "mof_grid4";

    @Autowired OpsUserService users;

    static String enc(String v) { return URLEncoder.encode(v, StandardCharsets.UTF_8); }

    /** summary_24h 에서 이 시험의 job 행만: "provider/status" → 행 */
    static Map<String, JsonNode> rows(JsonNode runs) {
        Map<String, JsonNode> out = new java.util.LinkedHashMap<>();
        for (JsonNode s : runs.path("summary_24h"))
            if (JOB.equals(s.path("job").asString())) out.put(s.path("provider").asString() + "/" + s.path("status").asString(), s);
        return out;
    }

    static List<String> texts(JsonNode page) {
        List<String> out = new ArrayList<>();
        for (JsonNode n : page.path("items")) out.add(n.path("error_text").isNull() ? null : n.path("error_text").asString());
        return out;
    }

    @Test
    void summaryRowsCarryTheNewestRunsErrorText_andRunsFilterByProviderAndSince() {
        OpsBrowser b = OpsBrowser.login(this, users, "it-runs-drill", PW);
        JdbcClient col = JdbcClient.create(new DriverManagerDataSource(DbTestSupport.jdbcUrl(ItStack.DB), "wakeline_collector", DbTestSupport.COLLECTOR_PW));
        List<Long> resolutions = new ArrayList<>();
        try {
            // VALUES 순서대로 id 가 커진다(목록은 id 역순)
            col.sql("""
                    INSERT INTO ingest_run (job, provider, started_at, finished_at, status, http_status, latency_ms, error_text) VALUES
                      (:job, :p1, now() - interval '30 hours', now() - interval '30 hours' + interval '1 second', 'error', NULL, 8000, 'ConnectError — 30 h ago'),
                      (:job, :p1, now() - interval '5 hours', now() - interval '5 hours' + interval '1 second', 'error', NULL, 8000,
                       'ReadTimeout — read 제한 8 s 초과 (opendata.adsb.fi)'),
                      (:job, :p1, now() - interval '3 hours', now() - interval '3 hours' + interval '1 second', 'error', 502, 300, 'HTTP 502 — Bad Gateway'),
                      (:job, :p1, now() - interval '1 hour', now() - interval '1 hour' + interval '1 second', 'ok', 200, 250, NULL),
                      (:job, :p1, now() - interval '10 minutes', NULL, 'error', NULL, NULL, 'finish unknown'),
                      (:job, :p2, now() - interval '2 hours', now() - interval '2 hours' + interval '1 second', 'error', 429, 100, 'HTTP 429 — Too Many Requests'),
                      (:job, :p2, now() - interval '20 minutes', now() - interval '20 minutes' + interval '1 second', 'budget_exhausted', NULL, NULL,
                       'MOF hourly window: grid share used (290 of 390 in UTC hour 2026093018, 100 left for port calls) — geometry fill resumes at 2026-09-30T19:00:00Z')""")
                    .param("job", JOB).param("p1", P1).param("p2", P2).update();
            List<Long> ids = col.sql("SELECT id FROM ingest_run WHERE job = :j ORDER BY id").param("j", JOB).query(Long.class).list();
            long old30h = ids.get(0), timeout5h = ids.get(1), gateway3h = ids.get(2), unknownFinish = ids.get(4);

            // ---- 요약: 행마다 가장 최근 실행의 글자 · http(show — 해결과 상관없이)
            JsonNode show = b.get("/api/v1/ops/runs?limit=1&resolved=show").json();
            Map<String, JsonNode> s = rows(show);
            assertThat(s.get(P1 + "/error").path("n").asLong()).as("the 30 h old run is outside the 24 h window").isEqualTo(3);
            assertThat(s.get(P1 + "/error").path("last_error_text").asString())
                    .as("the newest failure time wins; a run whose failure time is unknown is not 'the newest'").isEqualTo("HTTP 502 — Bad Gateway");
            assertThat(s.get(P1 + "/error").path("last_http_status").asInt()).isEqualTo(502);
            assertThat(s.get(P1 + "/ok").has("last_error_text")).as("the key is there, null for an ok run without text").isTrue();
            assertThat(s.get(P1 + "/ok").path("last_error_text").isNull()).isTrue();
            assertThat(s.get(P1 + "/ok").path("last_http_status").asInt()).isEqualTo(200);
            assertThat(s.get(P2 + "/error").path("last_error_text").asString()).isEqualTo("HTTP 429 — Too Many Requests");
            assertThat(s.get(P2 + "/error").path("last_http_status").asInt()).isEqualTo(429);
            assertThat(s.get(P2 + "/budget_exhausted").path("last_error_text").asString()).as("stored text as issued (raw — UTC 'Z' stays)")
                    .endsWith("geometry fill resumes at 2026-09-30T19:00:00Z");
            assertThat(s.get(P2 + "/budget_exhausted").has("last_http_status")).isTrue();
            assertThat(s.get(P2 + "/budget_exhausted").path("last_http_status").isNull()).isTrue();

            // summary_since: 요약 창의 시작(UTC ISO) — 지금 − 24 h
            Instant since = Instant.parse(show.path("summary_since").asString());
            assertThat(Duration.between(since, Instant.now().minus(Duration.ofHours(24))).abs()).isLessThan(Duration.ofMinutes(2));

            // ---- 해결 표시(hide): 해결이 가린 실행은 '가장 최근'으로 고르지 않는다 — 남은 실행 중 가장 최근(여기서는 실패 시각을 모르는 실행)
            Map<String, Object> body = Map.of("kind", "provider_error", "key", P1, "upto", Instant.now().minus(Duration.ofMinutes(150)).toString());
            Res r = b.send("POST", "/api/v1/ops/resolutions", Streams.JSON.writeValueAsString(body),
                    Map.of("X-CSRF-Token", String.valueOf(b.cookies.get("WAKELINE_CSRF"))));
            assertThat(r.status()).isEqualTo(201);
            resolutions.add(r.json().path("id").asLong());
            JsonNode hide = b.get("/api/v1/ops/runs?limit=1").json();
            Map<String, JsonNode> h = rows(hide);
            assertThat(h.get(P1 + "/error").path("n").asLong()).isEqualTo(1);
            assertThat(h.get(P1 + "/error").hasNonNull("last_at")).as("the only visible error has no failure time").isFalse();
            assertThat(h.get(P1 + "/error").path("last_error_text").asString()).isEqualTo("finish unknown");
            assertThat(h.get(P1 + "/error").path("last_http_status").isNull()).isTrue();
            assertThat(h.get(P2 + "/error").path("last_error_text").asString()).as("another provider is not hidden").isEqualTo("HTTP 429 — Too Many Requests");

            // ---- 목록 필터: job · provider · status · since(요약의 창) — 해결과 상관없이 모두(증거), 커서로 끝까지
            String base = "/api/v1/ops/runs?job=" + JOB + "&provider=" + P1 + "&status=error&since=" + enc(hide.path("summary_since").asString());
            JsonNode p1 = b.get(base + "&limit=2").json();
            assertThat(p1.path("items")).extracting(n -> n.path("id").asLong()).containsExactly(unknownFinish, gateway3h);
            assertThat(texts(p1)).containsExactly("finish unknown", "HTTP 502 — Bad Gateway");
            assertThat(p1.path("next_cursor").asLong()).isEqualTo(gateway3h);
            JsonNode p2 = b.get(base + "&limit=2&cursor=" + p1.path("next_cursor").asLong()).json();
            assertThat(p2.path("items")).extracting(n -> n.path("id").asLong()).containsExactly(timeout5h);
            assertThat(texts(p2)).containsExactly("ReadTimeout — read 제한 8 s 초과 (opendata.adsb.fi)");
            assertThat(p2.has("next_cursor")).as("no next page: the key is left out (R-74)").isFalse();

            // since 없이: 24 h 밖의 실행도(전과 같다) · provider 없이: 두 공급자 모두
            JsonNode noSince = b.get("/api/v1/ops/runs?job=" + JOB + "&provider=" + P1 + "&status=error&limit=50").json();
            assertThat(noSince.path("items")).extracting(n -> n.path("id").asLong()).containsExactly(unknownFinish, gateway3h, timeout5h, old30h);
            JsonNode noProvider = b.get("/api/v1/ops/runs?job=" + JOB + "&status=error&limit=50").json();
            assertThat(noProvider.path("items")).extracting(n -> n.path("provider").asString()).contains(P1, P2);
            assertThat(b.get("/api/v1/ops/runs?job=" + JOB + "&provider=" + P2 + "&limit=50").json().path("items"))
                    .extracting(n -> n.path("status").asString()).containsExactly("budget_exhausted", "error");

            // 틀린 since 는 400(전과 같은 규칙 — 틀린 cursor 와 같다)
            assertProblem(b.get("/api/v1/ops/runs?since=yesterday"), 400, "BAD_REQUEST", "/api/v1/ops/runs");
            // 요약 창 밖의 시각을 준 since 는 그 시각 뒤만
            JsonNode recent = b.get("/api/v1/ops/runs?job=" + JOB + "&since=" + enc(Instant.now().minus(30, ChronoUnit.MINUTES).toString()) + "&limit=50").json();
            assertThat(recent.path("items")).extracting(n -> n.path("id").asLong()).containsExactly(ids.get(6), unknownFinish);
        } finally {
            for (long id : resolutions)
                b.send("DELETE", "/api/v1/ops/resolutions/" + id, null, Map.of("X-CSRF-Token", String.valueOf(b.cookies.get("WAKELINE_CSRF"))));
            admin().sql("DELETE FROM ingest_run WHERE job = :j").param("j", JOB).update();
        }
    }
}
