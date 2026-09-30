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
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * R-45: 통계 응답의 day 는 날짜 문자열 "YYYY-MM-DD"(JVM 시간대와 무관 — 이전에는 java.sql.Date 를 그대로 직렬화해 "…T00:00:00.000Z" 였고
 * KST JVM 이면 하루 밀렸다). 집계하지 않은 날은 aggregated:false 로 밝힌다(이전: 빈 목록이라 '자료 없음' 과 구분할 수 없었다).
 * 계약 v5 §G20: 그 날짜는 KST 날짜 — 응답이 day_zone "Asia/Seoul" 로 밝히고, 기본 날짜 · 범위도 KST 로 센다. 운영 화면의 격리 수 날짜도 KST 날짜이고,
 * 공급자 예산 날은 수집기의 UTC 날 예산 키 그대로라 budget_day_zone "UTC" 로 밝힌다(화면이 그 창을 KST 로 적는다).
 */
@EnabledIf("dev.wakeline.DbTestSupport#dockerAvailable")
class StatsIT extends IntegrationTest {
    static final String DATE = "^\\d{4}-\\d{2}-\\d{2}$";

    @Autowired OpsUserService users;

    @Test
    void statsDaysAreKstDateStringsAndUnaggregatedDaysSaySo() {
        LocalDate today = LocalDate.now(ZoneId.of("Asia/Seoul")), y = today.minusDays(1), y2 = today.minusDays(2);
        JdbcClient adm = admin();
        adm.sql("DELETE FROM stats_daily WHERE day IN (:a, :b, :c)").param("a", today).param("b", y).param("c", y2).update();
        adm.sql("""
                INSERT INTO stats_daily (day, metric, dim, value) VALUES
                  (:y, 'sigmet_by_fir', 'RKRR', 3), (:y, 'alerts_by_kind', 'OBSERVED', 5), (:y, 'traffic_by_hour', '10', 7),
                  (:y, 'aggregated_at', 'sigmet', 1), (:y, 'aggregated_at', 'alerts', 1), (:y, 'aggregated_at', 'traffic', 1)""").param("y", y).update();

        JsonNode sig = get("/api/v1/stats/sigmet?from=" + y2 + "&to=" + y).json();
        assertThat(sig.path("day_zone").asString()).isEqualTo("Asia/Seoul");
        assertThat(sig.path("items")).isNotEmpty();
        for (JsonNode it : sig.path("items")) assertThat(it.path("day").asString()).matches(DATE);
        assertThat(sig.path("items").get(0).path("day").asString()).isEqualTo(y.toString());
        assertThat(days(sig)).containsExactly(y2 + "=false", y + "=true");

        JsonNode alerts = get("/api/v1/stats/alerts?from=" + y2 + "&to=" + y).json();
        assertThat(alerts.path("day_zone").asString()).isEqualTo("Asia/Seoul");
        for (JsonNode it : alerts.path("items")) assertThat(it.path("day").asString()).matches(DATE);
        assertThat(days(alerts)).containsExactly(y2 + "=false", y + "=true");

        JsonNode traffic = get("/api/v1/stats/traffic?day=" + y).json();
        assertThat(traffic.path("day_zone").asString()).isEqualTo("Asia/Seoul");
        assertThat(traffic.path("day").asString()).isEqualTo(y.toString());
        assertThat(traffic.path("aggregated").isBoolean() && traffic.path("aggregated").asBoolean()).isTrue();
        assertThat(traffic.path("items").get(0).path("day").asString()).isEqualTo(y.toString());
        // 오늘(KST — 아직 끝나지 않음 · 집계 전): 빈 목록이지만 '자료 없음' 이 아니라 '집계 전'. 기본 날짜 = KST 오늘
        JsonNode now = get("/api/v1/stats/traffic").json();
        assertThat(now.path("day").asString()).isEqualTo(today.toString());
        assertThat(now.path("aggregated").isBoolean()).isTrue();
        assertThat(now.path("aggregated").asBoolean()).isFalse();
        adm.sql("DELETE FROM stats_daily WHERE day IN (:a, :b, :c)").param("a", today).param("b", y).param("c", y2).update(); // 다른 테스트에 남기지 않는다
    }

    /**
     * 운영 화면의 날짜 열(품질 규칙 일별 수 — KST 날짜 · 공급자 예산 날 — UTC 날 예산 키)도 같은 형식이고, 어느 날짜인지 응답이 밝힌다.
     * 격리 수는 V16 이 KST 날짜로 세기 시작한 순간(counted_since — UTC ISO)을 함께 내고, 그 KST 날짜보다 앞 날짜의 행(배포 중 이전 수집기가 UTC 날짜로 쓴 것)은
     * 내지 않는다(리뷰 2026-09-30 — 바꾼 날의 부분 값을 하루치처럼 보이지 않게).
     */
    @Test
    void opsDayColumnsAreDateStringsWithTheirZone() {
        LocalDate today = LocalDate.now(ZoneId.of("Asia/Seoul"));
        JdbcClient adm = admin();
        String cut = adm.sql("SELECT cut_at::text FROM kst_day_cutover WHERE table_name = 'quality_rule_count'").query(String.class).single();
        try {
            // 바꾼 순간 = 오늘 00:05 KST(재현 가능한 값) — 오늘은 부분, 어제 날짜의 행은 이전 수집기의 것
            adm.sql("UPDATE kst_day_cutover SET cut_at = (:d::date + time '00:05') AT TIME ZONE 'Asia/Seoul' WHERE table_name = 'quality_rule_count'").param("d", today).update();
            JdbcClient col = JdbcClient.create(new DriverManagerDataSource(DbTestSupport.jdbcUrl(ItStack.DB), "wakeline_collector", DbTestSupport.COLLECTOR_PW));
            col.sql("INSERT INTO quality_rule_count (day, rule, count) VALUES (:t, 'r45_rule', 1), (:y, 'r45_rule_old_collector', 1) ON CONFLICT DO NOTHING")
                    .param("t", today).param("y", today.minusDays(1)).update();
            col.sql("INSERT INTO provider_budget_day (provider, day, calls) VALUES ('r45_provider', CURRENT_DATE, 1) ON CONFLICT DO NOTHING").update();
            OpsBrowser b = OpsBrowser.login(this, users, "it-stats-days", "stats-days-horse-battery");
            JsonNode q = b.get("/api/v1/ops/quality?days=3").json();
            assertThat(q.path("day_zone").asString()).isEqualTo("Asia/Seoul");
            assertThat(q.path("counted_since").asString()).isEqualTo(today.atTime(0, 5).atZone(ZoneId.of("Asia/Seoul")).toInstant().toString().replace("Z", ".000Z"));
            List<String> rows = new ArrayList<>();
            for (JsonNode r : q.path("rule_counts")) {
                assertThat(r.path("day").asString()).matches(DATE);
                rows.add(r.path("day").asString() + " " + r.path("rule").asString());
            }
            assertThat(rows).contains(today + " r45_rule").noneMatch(r -> r.contains("r45_rule_old_collector"));
            JsonNode p = b.get("/api/v1/ops/providers").json();
            assertThat(p.path("budget_day_zone").asString()).isEqualTo("UTC");
            // 서버 시각(운영 화면의 '확인 멈춤' 판정 기준 — 계약 v5 §G22): 시간대가 있는 ISO, 지금 근처
            java.time.Instant gen = java.time.Instant.parse(p.path("generated_at").asString());
            assertThat(java.time.Duration.between(gen, java.time.Instant.now()).abs()).isLessThan(java.time.Duration.ofMinutes(1));
            assertThat(p.path("budget_days")).isNotEmpty();
            for (JsonNode r : p.path("budget_days")) assertThat(r.path("day").asString()).matches(DATE);
        } finally {
            adm.sql("UPDATE kst_day_cutover SET cut_at = :c::timestamptz WHERE table_name = 'quality_rule_count'").param("c", cut).update();
            adm.sql("DELETE FROM quality_rule_count WHERE rule IN ('r45_rule', 'r45_rule_old_collector')").update();
            adm.sql("DELETE FROM provider_budget_day WHERE provider = 'r45_provider'").update();
        }
    }

    static List<String> days(JsonNode body) {
        List<String> out = new ArrayList<>();
        for (JsonNode d : body.path("days")) out.add(d.path("day").asString() + "=" + d.path("aggregated").asBoolean());
        return out;
    }
}
