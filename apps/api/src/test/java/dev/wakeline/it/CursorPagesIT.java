package dev.wakeline.it;

import dev.wakeline.DbTestSupport;
import dev.wakeline.ops.OpsUserService;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIf;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import tools.jackson.databind.JsonNode;

import java.util.ArrayList;
import java.util.List;
import java.util.function.Function;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * R-74: 커서 페이지(/alerts/history · /ops/runs · /ops/audit)는 같은 계약 — 다음이 있으면 next_cursor(숫자), 없으면 null(키 없음).
 * /ops/audit 은 빈 문자열을 냈다. 2쪽을 따라가면 중복·누락 없이 끝난다.
 */
@EnabledIf("dev.wakeline.DbTestSupport#dockerAvailable")
class CursorPagesIT extends IntegrationTest {
    @Autowired OpsUserService users;

    /** 첫 쪽부터 next_cursor 를 따라 끝까지 — 모은 id 들. 마지막 쪽에는 next_cursor 키가 없어야 한다(빈 문자열·null 금지). */
    static List<Long> follow(Function<String, JsonNode> page, String first) {
        List<Long> ids = new ArrayList<>();
        String path = first;
        for (int i = 0; i < 50; i++) {
            JsonNode body = page.apply(path);
            for (JsonNode it : body.path("items")) ids.add(it.path("id").asLong());
            if (!body.has("next_cursor")) return ids;
            JsonNode next = body.get("next_cursor");
            assertThat(next.isIntegralNumber()).as("next_cursor of " + path + " is " + next).isTrue();
            path = first + (first.contains("?") ? "&" : "?") + "cursor=" + next.asLong();
        }
        throw new AssertionError("no last page");
    }

    @Test
    void cursorPagesEndWithoutANextCursorAndCoverEveryRowOnce() {
        OpsBrowser b = OpsBrowser.login(this, users, "it-cursor", "cursor-horse-battery-staple");
        JdbcClient adm = admin();
        adm.sql("INSERT INTO audit_log (action, target) SELECT 'R74_TEST', 'row-' || g FROM generate_series(1, 7) g").update();
        JdbcClient col = JdbcClient.create(new DriverManagerDataSource(DbTestSupport.jdbcUrl(ItStack.DB), "wakeline_collector", DbTestSupport.COLLECTOR_PW));
        col.sql("INSERT INTO ingest_run (job, provider, started_at, status) SELECT 'r74_job', 'x', now(), 'ok' FROM generate_series(1, 7) g").update();

        long audits = count("SELECT count(*) FROM audit_log");
        List<Long> auditIds = follow(p -> b.get(p).json(), "/api/v1/ops/audit?limit=3");
        assertThat(auditIds).hasSize((int) audits).doesNotHaveDuplicates();

        List<Long> runIds = follow(p -> b.get(p).json(), "/api/v1/ops/runs?job=r74_job&limit=3");
        assertThat(runIds).hasSize(7).doesNotHaveDuplicates();

        adm.sql("""
                INSERT INTO sigmet (id, fir_id, series_id, hazard, valid_from, valid_to, raw_text, provider, fetched_at)
                VALUES ('R74-S', 'XXXX', 'R74', 'TS', now() - interval '1 hour', now() + interval '1 hour', 'r', 'awc', now()) ON CONFLICT DO NOTHING""").update();
        adm.sql("""
                INSERT INTO alert_event (hex, sigmet_id, kind, entered_at, evidence)
                SELECT 'a74' || lpad(g::text, 3, '0'), 'R74-S', 'OBSERVED', now() - g * interval '1 minute', '{"method":"observed_point_in_polygon"}'::jsonb FROM generate_series(1, 7) g""").update();
        List<Long> alertIds = follow(p -> get(p).json(), "/api/v1/alerts/history?hex=a74001&limit=3");
        assertThat(alertIds).hasSize(1);
        long inRange = count("SELECT count(*) FROM alert_event WHERE entered_at > now() - interval '24 hours'");
        List<Long> all = follow(p -> get(p).json(), "/api/v1/alerts/history?limit=4");
        assertThat(all).hasSize((int) inRange).doesNotHaveDuplicates();
        // 다른 통합 테스트(RestSamplesIT 의 기록)에 남지 않게
        adm.sql("DELETE FROM alert_event WHERE sigmet_id = 'R74-S'").update();
        adm.sql("DELETE FROM sigmet WHERE id = 'R74-S'").update();
        adm.sql("DELETE FROM audit_log WHERE action = 'R74_TEST'").update();
        adm.sql("DELETE FROM ingest_run WHERE job = 'r74_job'").update();
    }
}
