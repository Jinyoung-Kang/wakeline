package dev.wakeline.it;

import dev.wakeline.DbTestSupport;
import dev.wakeline.ops.OpsUserService;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIf;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import tools.jackson.databind.JsonNode;

import java.time.LocalDate;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * R-45: 통계 응답의 day 는 UTC 날짜 문자열 "YYYY-MM-DD"(JVM 시간대와 무관 — 이전에는 java.sql.Date 를 그대로 직렬화해 "…T00:00:00.000Z" 였고
 * KST JVM 이면 하루 밀렸다). 집계하지 않은 날은 aggregated:false 로 밝힌다(이전: 빈 목록이라 '자료 없음' 과 구분할 수 없었다).
 */
@EnabledIf("dev.wakeline.DbTestSupport#dockerAvailable")
class StatsIT extends IntegrationTest {
    static final String DATE = "^\\d{4}-\\d{2}-\\d{2}$";

    @Autowired OpsUserService users;

    @Test
    void statsDaysAreUtcDateStringsAndUnaggregatedDaysSaySo() {
        LocalDate today = LocalDate.now(ZoneOffset.UTC), y = today.minusDays(1), y2 = today.minusDays(2);
        JdbcClient adm = admin();
        adm.sql("DELETE FROM stats_daily WHERE day IN (:a, :b, :c)").param("a", today).param("b", y).param("c", y2).update();
        adm.sql("""
                INSERT INTO stats_daily (day, metric, dim, value) VALUES
                  (:y, 'sigmet_by_fir', 'RKRR', 3), (:y, 'alerts_by_kind', 'OBSERVED', 5), (:y, 'traffic_by_hour', '10', 7),
                  (:y, 'aggregated_at', 'sigmet', 1), (:y, 'aggregated_at', 'alerts', 1), (:y, 'aggregated_at', 'traffic', 1)""").param("y", y).update();

        JsonNode sig = get("/api/v1/stats/sigmet?from=" + y2 + "&to=" + y).json();
        assertThat(sig.path("items")).isNotEmpty();
        for (JsonNode it : sig.path("items")) assertThat(it.path("day").asString()).matches(DATE);
        assertThat(sig.path("items").get(0).path("day").asString()).isEqualTo(y.toString());
        assertThat(days(sig)).containsExactly(y2 + "=false", y + "=true");

        JsonNode alerts = get("/api/v1/stats/alerts?from=" + y2 + "&to=" + y).json();
        for (JsonNode it : alerts.path("items")) assertThat(it.path("day").asString()).matches(DATE);
        assertThat(days(alerts)).containsExactly(y2 + "=false", y + "=true");

        JsonNode traffic = get("/api/v1/stats/traffic?day=" + y).json();
        assertThat(traffic.path("day").asString()).isEqualTo(y.toString());
        assertThat(traffic.path("aggregated").isBoolean() && traffic.path("aggregated").asBoolean()).isTrue();
        assertThat(traffic.path("items").get(0).path("day").asString()).isEqualTo(y.toString());
        // 오늘(아직 끝나지 않음 · 집계 전): 빈 목록이지만 '자료 없음' 이 아니라 '집계 전'
        JsonNode now = get("/api/v1/stats/traffic").json();
        assertThat(now.path("day").asString()).isEqualTo(today.toString());
        assertThat(now.path("aggregated").isBoolean()).isTrue();
        assertThat(now.path("aggregated").asBoolean()).isFalse();
        adm.sql("DELETE FROM stats_daily WHERE day IN (:a, :b, :c)").param("a", today).param("b", y).param("c", y2).update(); // 다른 테스트에 남기지 않는다
    }

    /** 운영 화면의 날짜 열(품질 규칙 일별 수 · 공급자 일별 호출)도 같은 형식. */
    @Test
    void opsDayColumnsAreUtcDateStrings() {
        JdbcClient col = JdbcClient.create(new DriverManagerDataSource(DbTestSupport.jdbcUrl(ItStack.DB), "wakeline_collector", DbTestSupport.COLLECTOR_PW));
        col.sql("INSERT INTO quality_rule_count (day, rule, count) VALUES (CURRENT_DATE, 'r45_rule', 1) ON CONFLICT DO NOTHING").update();
        col.sql("INSERT INTO provider_budget_day (provider, day, calls) VALUES ('r45_provider', CURRENT_DATE, 1) ON CONFLICT DO NOTHING").update();
        OpsBrowser b = OpsBrowser.login(this, users, "it-stats-days", "stats-days-horse-battery");
        JsonNode q = b.get("/api/v1/ops/quality?days=3").json();
        assertThat(q.path("rule_counts")).isNotEmpty();
        for (JsonNode r : q.path("rule_counts")) assertThat(r.path("day").asString()).matches(DATE);
        JsonNode p = b.get("/api/v1/ops/providers").json();
        assertThat(p.path("budget_days")).isNotEmpty();
        for (JsonNode r : p.path("budget_days")) assertThat(r.path("day").asString()).matches(DATE);
        admin().sql("DELETE FROM quality_rule_count WHERE rule = 'r45_rule'").update();
        admin().sql("DELETE FROM provider_budget_day WHERE provider = 'r45_provider'").update();
    }

    static List<String> days(JsonNode body) {
        List<String> out = new ArrayList<>();
        for (JsonNode d : body.path("days")) out.add(d.path("day").asString() + "=" + d.path("aggregated").asBoolean());
        return out;
    }
}
