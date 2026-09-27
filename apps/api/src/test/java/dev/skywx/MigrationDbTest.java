package dev.skywx;

import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIf;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.jdbc.datasource.DriverManagerDataSource;

import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.HashMap;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * --migrate 경로(Flyway 만, Spring 컨텍스트 없음)와 V3 마이그레이션: 적용·멱등, 기존 행 보정(추정 없이 결정적인 것만),
 * 그리고 api 계정이 DML 전용인지(감사 로그 변경·DDL 불가, 보존 삭제 가능 — SEC-3·REL-11).
 */
@EnabledIf("dev.skywx.DbTestSupport#dockerAvailable")
class MigrationDbTest {

    @Test
    void migrateIsIdempotentAndNeedsOnlyTheMigratorPassword() {
        DbTestSupport.start();
        assertThat(SkyWxApplication.migrate(DbTestSupport.env("skywx"))).isZero(); // 이미 적용됨 → 0건, 성공
        Map<String, String> noPw = new HashMap<>(DbTestSupport.env("skywx"));
        noPw.remove("DB_MIGRATOR_PASSWORD");
        assertThat(SkyWxApplication.migrate(noPw)).isEqualTo(2);
        assertThat(DbTestSupport.admin().sql("SELECT max(version::int) FROM flyway_schema_history WHERE success").query(Integer.class).single()).isEqualTo(3);
    }

    @Test
    void v3BackfillsOnlyDeterministicValues() {
        DbTestSupport.start();
        Map<String, String> env = DbTestSupport.env("skywx_stage");
        String url = DbTestSupport.jdbcUrl("skywx_stage");
        Flyway.configure().dataSource(url, "skywx_migrator", DbTestSupport.MIGRATOR_PW).locations("classpath:db/migration").target("2").load().migrate();
        JdbcClient stage = JdbcClient.create(new DriverManagerDataSource(url, "postgres", "root-test-pw"));
        stage.sql("""
                INSERT INTO sigmet (id, fir_id, series_id, hazard, base_ft, top_ft, valid_from, valid_to, raw_text, provider, fetched_at) VALUES
                  ('S0', 'X', '1', 'TS', 0, NULL, now(), now() + interval '1 hour', 'r', 'awc_isigmet', now()),
                  ('S1', 'X', '2', 'TS', 5000, 30000, now(), now() + interval '1 hour', 'r', 'awc_isigmet', now())""").update();
        stage.sql("INSERT INTO airport (icao, geom) VALUES ('RKSI', ST_SetSRID(ST_MakePoint(126, 37), 4326))").update();
        stage.sql("""
                INSERT INTO metar_obs (icao, obs_time, raw, vis_sm, ceiling_ft, flight_cat, flight_cat_source, provider, fetched_at) VALUES
                  ('RKSI', now() - interval '2 hours', 'a', 10, 1200, 'MVFR', 'awc', 'awc', now()),
                  ('RKSI', now() - interval '1 hours', 'b', NULL, NULL, 'VFR', 'computed', 'awc', now())""").update();
        stage.sql("""
                INSERT INTO alert_event (id, hex, sigmet_id, kind, entered_at, left_at, eta_s, evidence) VALUES
                  (1, 'abcdef', 'S1', 'OBSERVED', now() - interval '1 hour', now(), NULL, '{"method":"observed_point_in_polygon"}'::jsonb),
                  (2, 'abcde0', 'S1', 'OBSERVED', now() - interval '1 hour', NULL, 240, '{"method":"dead_reckoning_10min"}'::jsonb)""").update();

        assertThat(SkyWxApplication.migrate(env)).isZero();

        Map<String, Map<String, Object>> sig = new HashMap<>();
        for (var r : stage.sql("SELECT id, base_source, top_source, withdrawn_at FROM sigmet").query().listOfRows()) sig.put((String) r.get("id"), r);
        assertThat(sig.get("S0")).containsEntry("base_source", "unknown").containsEntry("top_source", "unknown");
        assertThat(sig.get("S1")).containsEntry("base_source", "json").containsEntry("top_source", "json");
        Map<String, Map<String, Object>> metar = new HashMap<>();
        for (var r : stage.sql("SELECT raw, ceiling_state, flight_cat, flight_cat_source FROM metar_obs").query().listOfRows()) metar.put((String) r.get("raw"), r);
        assertThat(metar.get("a")).containsEntry("ceiling_state", "measured").containsEntry("flight_cat", "MVFR").containsEntry("flight_cat_source", "awc");
        // 입력이 빠진 '계산' 카테고리(이전 경로는 모르는 값을 VFR 로 바꿨다)는 지운다. 실링 없음/모름은 구분할 수 없어 NULL.
        assertThat(metar.get("b").get("ceiling_state")).isNull();
        assertThat(metar.get("b").get("flight_cat")).isNull();
        assertThat(metar.get("b").get("flight_cat_source")).isNull();
        // 이미 닫힌 알림의 사유는 채우지 않는다
        assertThat(stage.sql("SELECT close_reason FROM alert_event WHERE id = 1").query(String.class).optional()).isEmpty();
        assertThat(stage.sql("SELECT evidence->>'integrity' FROM alert_event WHERE id = 1").query(String.class).optional()).isEmpty();
        // 예측 갱신에 덮어쓰인 관측 행: 근거는 남기되 표시하고, 관측에 없는 eta 는 비운다
        Map<String, Object> hit = stage.sql("SELECT eta_s, evidence->>'integrity' integrity, evidence->>'method' method FROM alert_event WHERE id = 2").query().singleRow();
        assertThat(hit.get("eta_s")).isNull();
        assertThat(hit).containsEntry("integrity", "evidence_overwritten_by_colliding_prediction_update").containsEntry("method", "dead_reckoning_10min");
    }

    @Test
    void apiRoleIsDmlOnlyButMayRunRetention() throws SQLException {
        DbTestSupport.start();
        try (Connection c = DriverManager.getConnection(DbTestSupport.jdbcUrl("skywx"), "skywx_api", DbTestSupport.API_PW)) {
            assertThat(sqlState(c, "DELETE FROM audit_log")).isEqualTo("42501");
            assertThat(sqlState(c, "UPDATE audit_log SET action = 'x'")).isEqualTo("42501");
            assertThat(sqlState(c, "CREATE TABLE evil (id int)")).isEqualTo("42501");
            assertThat(sqlState(c, "ALTER TABLE alert_event DISABLE TRIGGER ALL")).isEqualTo("42501");
            for (String t : new String[]{"metar_obs", "radar_frame", "ingest_run", "quality_event", "quality_rule_count"})
                assertThat(sqlState(c, "DELETE FROM " + t + " WHERE false")).as(t).isNull();
        }
        assertThatThrownBy(() -> DriverManager.getConnection(DbTestSupport.jdbcUrl("skywx"), "skywx_api", "wrong").close())
                .isInstanceOf(SQLException.class);
    }

    /** 문장을 실행하고 실패하면 SQLState, 성공하면 null. */
    private static String sqlState(Connection c, String sql) {
        try (Statement s = c.createStatement()) {
            s.execute(sql);
            return null;
        } catch (SQLException e) {
            return e.getSQLState();
        }
    }
}
