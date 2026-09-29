package dev.wakeline;

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
 * --migrate 경로(Flyway 만, Spring 컨텍스트 없음)와 V3·V4 마이그레이션: 적용·멱등, 기존 행 보정(추정 없이 결정적인 것만),
 * 그리고 api 계정이 DML 전용인지(감사 로그 변경·DDL 불가, 보존 삭제 가능 — SEC-3·REL-11).
 */
@EnabledIf("dev.wakeline.DbTestSupport#dockerAvailable")
class MigrationDbTest {

    @Test
    void migrateIsIdempotentAndNeedsOnlyTheMigratorPassword() throws Exception {
        DbTestSupport.start();
        assertThat(WakelineApplication.migrate(DbTestSupport.env("wakeline"))).isZero(); // 이미 적용됨 → 0건, 성공
        Map<String, String> noPw = new HashMap<>(DbTestSupport.env("wakeline"));
        noPw.remove("DB_MIGRATOR_PASSWORD");
        assertThat(WakelineApplication.migrate(noPw)).isEqualTo(2);
        assertThat(DbTestSupport.admin().sql("SELECT max(version::int) FROM flyway_schema_history WHERE success").query(Integer.class).single())
                .as("every migration on the classpath is applied").isEqualTo(latestMigrationVersion());
    }

    /** 클래스패스 db/migration 의 가장 높은 V 번호(새 마이그레이션이 늘어도 이 시험을 고치지 않게). */
    static int latestMigrationVersion() throws Exception {
        var dir = MigrationDbTest.class.getResource("/db/migration");
        assertThat(dir).as("db/migration on the classpath").isNotNull();
        try (var files = java.nio.file.Files.list(java.nio.file.Path.of(dir.toURI()))) {
            return files.map(f -> f.getFileName().toString()).filter(n -> n.matches("^V[0-9]+__.*\\.sql$"))
                    .mapToInt(n -> Integer.parseInt(n.substring(1, n.indexOf("__")))).max().orElseThrow();
        }
    }

    @Test
    void v3BackfillsOnlyDeterministicValues() {
        DbTestSupport.start();
        Map<String, String> env = DbTestSupport.env("wakeline_stage");
        String url = DbTestSupport.jdbcUrl("wakeline_stage");
        Flyway.configure().dataSource(url, "wakeline_migrator", DbTestSupport.MIGRATOR_PW).locations("classpath:db/migration").target("2").load().migrate();
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

        assertThat(WakelineApplication.migrate(env)).isZero();

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

    /**
     * V4(리뷰 수정): close_reason 'sigmet_ended'·top_source 'raw_text_lower_bound' 허용, 원문 "TOP ABV FLnnn" 과 같은 상한만 하한으로 재분류,
     * 예측 행의 진입 고도를 마지막 예측 근거와 맞춤, 이미 집계된 날의 체류 평균을 '확인된 이탈' 만으로 다시 계산.
     */
    @Test
    void v4ReclassifiesAbvTopsSyncsPredictionAltitudeAndRecomputesDwell() {
        DbTestSupport.start();
        String db = "wakeline_stage_four";
        DbTestSupport.createDatabase(db);
        String url = DbTestSupport.jdbcUrl(db);
        Flyway.configure().dataSource(url, "wakeline_migrator", DbTestSupport.MIGRATOR_PW).locations("classpath:db/migration").target("3").load().migrate();
        JdbcClient stage = JdbcClient.create(new DriverManagerDataSource(url, "postgres", DbTestSupport.ROOT_PW));
        stage.sql("""
                INSERT INTO sigmet (id, fir_id, series_id, hazard, base_ft, top_ft, top_source, valid_from, valid_to, raw_text, provider, fetched_at) VALUES
                  ('ABV_JSON', 'FIMM', 'A01', 'TS', 0, 39000, 'json', now(), now() + interval '1 hour', 'EMBD TS OBS WI AREA TOP ABV FL390 MOV E 05KT NC=', 'awc_isigmet', now()),
                  ('ABV_RAW', 'OEJD', '02', 'TS', 0, 38000, 'raw_text', now(), now() + interval '1 hour', 'FRQ TS FCST TOP ABV' || chr(10) || 'FL380 STNR=', 'awc_isigmet', now()),
                  ('TOP_EXACT', 'RKRR', '1', 'TS', 0, 38000, 'raw_text', now(), now() + interval '1 hour', 'EMBD TS TOP FL380 MOV NE=', 'awc_isigmet', now()),
                  ('ABV_OTHER', 'MMEX', 'F3', 'TS', 0, 45000, 'json', now(), now() + interval '1 hour', 'TS TOP ABV FL390=', 'awc_isigmet', now()),
                  ('TOPS', 'KZNY', '3', 'TS', 0, 45000, 'json', now(), now() + interval '1 hour', 'SEV TURB TOPS ABV FL450 CB=', 'awc_isigmet', now())""").update();
        java.time.LocalDate day = java.time.LocalDate.now(java.time.ZoneOffset.UTC).minusDays(3);
        java.time.LocalDate notAggregated = day.minusDays(1);
        java.time.Instant d0 = day.atStartOfDay(java.time.ZoneOffset.UTC).toInstant().plusSeconds(3600);
        java.time.Instant n0 = notAggregated.atStartOfDay(java.time.ZoneOffset.UTC).toInstant().plusSeconds(3600);
        stage.sql("""
                INSERT INTO alert_event (id, hex, sigmet_id, kind, entered_at, left_at, close_reason, alt_ft_at_entry, evidence) VALUES
                  (1, 'aaaaa1', 'TOP_EXACT', 'OBSERVED', :d::timestamptz, :d::timestamptz + interval '600 seconds', 'left', NULL, '{}'::jsonb),
                  (2, 'aaaaa2', 'TOP_EXACT', 'OBSERVED', :d::timestamptz, :d::timestamptz + interval '1000 seconds', NULL, NULL, '{}'::jsonb),
                  (3, 'aaaaa3', 'TOP_EXACT', 'OBSERVED', :d::timestamptz, :d::timestamptz + interval '5000 seconds', 'left', NULL, '{"sigmet_expired": true}'::jsonb),
                  (4, 'aaaaa4', 'TOP_EXACT', 'OBSERVED', :d::timestamptz, :d::timestamptz + interval '10 seconds', 'restart', NULL, '{}'::jsonb),
                  (5, 'aaaaa5', 'TOP_EXACT', 'OBSERVED', :n::timestamptz, :n::timestamptz + interval '300 seconds', 'left', NULL, '{}'::jsonb),
                  (6, 'aaaaa6', 'TOP_EXACT', 'PREDICTED', :d::timestamptz, NULL, NULL, 35000, '{"alt_ft_at_entry": 37000}'::jsonb),
                  (7, 'aaaaa7', 'TOP_EXACT', 'PREDICTED', :d::timestamptz, NULL, NULL, 35000, '{"method": "dead_reckoning_10min"}'::jsonb)""")
                .param("d", java.time.OffsetDateTime.ofInstant(d0, java.time.ZoneOffset.UTC)).param("n", java.time.OffsetDateTime.ofInstant(n0, java.time.ZoneOffset.UTC)).update();
        stage.sql("""
                INSERT INTO stats_daily (day, metric, dim, value) VALUES
                  (:day, 'alert_dwell_avg_s', 'OBSERVED', 1652.5), (:day, 'alerts_by_kind', 'OBSERVED', 4)""").param("day", day).update();

        assertThat(WakelineApplication.migrate(DbTestSupport.env(db))).isZero();

        Map<String, String> top = new HashMap<>();
        for (var r : stage.sql("SELECT id, top_source FROM sigmet").query().listOfRows()) top.put((String) r.get("id"), (String) r.get("top_source"));
        assertThat(top).containsEntry("ABV_JSON", "raw_text_lower_bound").containsEntry("ABV_RAW", "raw_text_lower_bound")
                .containsEntry("TOP_EXACT", "raw_text")      // "TOP FL380" 은 발표된 상한
                .containsEntry("ABV_OTHER", "json")          // ABV 값(39000)과 상한(45000)이 다르다 — 단정하지 않는다
                .containsEntry("TOPS", "json");              // "TOPS" 는 수집기 규칙(TOP\s)과 같게 일치하지 않는다
        assertThat(stage.sql("SELECT alt_ft_at_entry FROM alert_event WHERE id = 6").query(Integer.class).single()).isEqualTo(37000);
        assertThat(stage.sql("SELECT alt_ft_at_entry FROM alert_event WHERE id = 7").query(Integer.class).single()).isEqualTo(35000);
        // 체류: 확인된 이탈(id 1, 600 s)만 — NULL·만료 뒤 left·restart 는 빠진다. 집계된 적 없는 날은 새로 만들지 않는다.
        // (V4 가 고친 행은 UTC 날짜 집계 — 최신까지 올리면 V16 이 보관 표 stats_daily_utc_legacy 로 옮긴다. 계약 v5 §G19)
        assertThat(stage.sql("SELECT value FROM stats_daily_utc_legacy WHERE day = :d AND metric = 'alert_dwell_avg_s'").param("d", day)
                .query(java.math.BigDecimal.class).single().doubleValue()).isEqualTo(600.0);
        assertThat(stage.sql("SELECT count(*) FROM stats_daily_utc_legacy WHERE day = :d").param("d", notAggregated).query(Long.class).single()).isZero();
        assertThat(stage.sql("SELECT value FROM stats_daily_utc_legacy WHERE day = :d AND metric = 'alerts_by_kind'").param("d", day)
                .query(java.math.BigDecimal.class).single().intValue()).isEqualTo(4);
        assertThat(stage.sql("SELECT count(*) FROM stats_daily").query(Long.class).single()).as("V16: the KST-day table starts empty").isZero();
        // 새 값은 제약을 통과하고, 목록 밖 값은 여전히 거부된다
        stage.sql("UPDATE alert_event SET close_reason = 'sigmet_ended' WHERE id = 4").update();
        stage.sql("UPDATE sigmet SET top_source = 'raw_text_lower_bound' WHERE id = 'TOP_EXACT'").update();
        assertThatThrownBy(() -> stage.sql("UPDATE alert_event SET close_reason = 'bogus' WHERE id = 4").update()).hasMessageContaining("alert_event_close_reason_check");
        assertThatThrownBy(() -> stage.sql("UPDATE sigmet SET top_source = 'guess' WHERE id = 'TOPS'").update()).hasMessageContaining("sigmet_top_source_check");
    }

    /**
     * V5(선박): 표·제약(스트림 스키마와 같은 범위 — 모르는 값은 NULL 로만), 파티션 함수(SECURITY DEFINER·search_path 고정),
     * 새 파티션에 api 의 직접 권한 없음, V4 까지의 자료를 건드리지 않음.
     */
    @Test
    void v5CreatesShipTablesWithContractConstraints() {
        DbTestSupport.start();
        String db = "wakeline_stage_five";
        DbTestSupport.createDatabase(db);
        String url = DbTestSupport.jdbcUrl(db);
        Flyway.configure().dataSource(url, "wakeline_migrator", DbTestSupport.MIGRATOR_PW).locations("classpath:db/migration").target("4").load().migrate();
        JdbcClient stage = JdbcClient.create(new DriverManagerDataSource(url, "postgres", DbTestSupport.ROOT_PW));
        long alerts = stage.sql("SELECT count(*) FROM alert_event").query(Long.class).single();
        assertThat(WakelineApplication.migrate(DbTestSupport.env(db))).isZero();
        assertThat(stage.sql("SELECT count(*) FROM alert_event").query(Long.class).single()).isEqualTo(alerts);

        // 파티션: 어제~3일 뒤(5개), 부모로만 — 파티션에는 api 권한이 없다
        String today = "ship_position_" + java.time.LocalDate.now(java.time.ZoneOffset.UTC).format(java.time.format.DateTimeFormatter.BASIC_ISO_DATE);
        assertThat(stage.sql("SELECT count(*) FROM pg_inherits i JOIN pg_class p ON p.oid = i.inhparent WHERE p.relname = 'ship_position'")
                .query(Long.class).single()).isEqualTo(5L);
        assertThat(stage.sql("SELECT has_table_privilege('wakeline_api', :t, 'INSERT')").param("t", today).query(Boolean.class).single()).isFalse();
        assertThat(stage.sql("SELECT has_table_privilege('wakeline_api', 'ship_position', 'INSERT')").query(Boolean.class).single()).isTrue();

        stage.sql("""
                INSERT INTO ship_position (mmsi, ts, geom, sog_kn, cog_deg, heading_deg, nav_status, position_source, provider)
                VALUES ('440123456', now(), ST_SetSRID(ST_MakePoint(129, 35), 4326), NULL, NULL, NULL, NULL, 'epfs', 'aisstream')""").update();
        // 위치 출처 값은 V7 기준(epfs · manual · estimated · inoperative · NULL) — 아래 행은 각각 다른 제약 하나만 어긴다
        for (String bad : new String[]{
                "INSERT INTO ship_position (mmsi, ts, geom, position_source, provider) VALUES ('44012345', now(), ST_SetSRID(ST_MakePoint(129, 35), 4326), 'epfs', 'x')",
                "INSERT INTO ship_position (mmsi, ts, geom, position_source, provider) VALUES ('440123456', now() + interval '1 s', ST_SetSRID(ST_MakePoint(129, 35), 4326), 'dead_reckoning', 'x')",
                "INSERT INTO ship_position (mmsi, ts, geom, sog_kn, position_source, provider) VALUES ('440123456', now() + interval '2 s', ST_SetSRID(ST_MakePoint(129, 35), 4326), 102.3, 'epfs', 'x')",
                "INSERT INTO ship_position (mmsi, ts, geom, heading_deg, position_source, provider) VALUES ('440123456', now() + interval '3 s', ST_SetSRID(ST_MakePoint(129, 35), 4326), 511, 'epfs', 'x')",
                "INSERT INTO ship (mmsi, ship_type, first_seen, last_seen, provider) VALUES ('440123456', 0, now(), now(), 'x')",
                "INSERT INTO ship (mmsi, eta_hour, first_seen, last_seen, provider) VALUES ('440123456', 24, now(), now(), 'x')",
                "INSERT INTO ship (mmsi, first_seen, last_seen, provider) VALUES ('440123456', now(), now() - interval '1 s', 'x')",
                "INSERT INTO ingest_gap (source, started_at, ended_at, reason, provider) VALUES ('ais', now(), now(), 'r', 'x')",
                "INSERT INTO ingest_gap (source, started_at, ended_at, reason, provider) VALUES ('ais', now(), now() + interval '1 s', '', 'x')"}) {
            assertThatThrownBy(() -> stage.sql(bad).update()).as(bad).hasMessageContaining("violates");
        }
    }

    /**
     * V7(계약 v3 §B): position_source 는 NULL(모름) 허용 · 'epfs' 추가 · 예전 'gnss' 행은 NULL(0~60·누락이 섞여 있어 모른다 — 'epfs' 로
     * 추정하지 않는다), 다른 값은 그대로. 'gnss' 는 더 이상 받지 않는다 — 파티션 함수가 V7 뒤에 만든 파티션도 같은 제약을 물려받는다.
     */
    @Test
    void v7MakesPositionSourceNullableAndClearsLegacyGnss() {
        DbTestSupport.start();
        String db = "wakeline_stage_seven";
        DbTestSupport.createDatabase(db);
        String url = DbTestSupport.jdbcUrl(db);
        Flyway.configure().dataSource(url, "wakeline_migrator", DbTestSupport.MIGRATOR_PW).locations("classpath:db/migration").target("6").load().migrate();
        JdbcClient stage = JdbcClient.create(new DriverManagerDataSource(url, "postgres", DbTestSupport.ROOT_PW));
        stage.sql("""
                INSERT INTO ship_position (mmsi, ts, geom, position_source, provider) VALUES
                  ('440123456', now(), ST_SetSRID(ST_MakePoint(129, 35), 4326), 'gnss', 'aisstream'),
                  ('440123456', now() - interval '1 minute', ST_SetSRID(ST_MakePoint(129, 35), 4326), 'manual', 'aisstream'),
                  ('440123457', now() - interval '1 day', ST_SetSRID(ST_MakePoint(129, 35), 4326), 'gnss', 'aisstream'),
                  ('440123457', now() - interval '1 day' + interval '1 minute', ST_SetSRID(ST_MakePoint(129, 35), 4326), 'estimated', 'aisstream')""").update();
        assertThatThrownBy(() -> stage.sql("INSERT INTO ship_position (mmsi, ts, geom, position_source, provider) VALUES "
                + "('440123458', now(), ST_SetSRID(ST_MakePoint(129, 35), 4326), NULL, 'x')").update()).as("V6: NOT NULL").hasMessageContaining("violates");

        assertThat(WakelineApplication.migrate(DbTestSupport.env(db))).isZero();

        Map<String, Long> bySource = new HashMap<>();
        for (var r : stage.sql("SELECT coalesce(position_source, '<null>') src, count(*) n FROM ship_position GROUP BY 1").query().listOfRows())
            bySource.put((String) r.get("src"), ((Number) r.get("n")).longValue());
        assertThat(bySource).containsExactlyInAnyOrderEntriesOf(Map.of("<null>", 2L, "manual", 1L, "estimated", 1L));

        stage.sql("INSERT INTO ship_position (mmsi, ts, geom, position_source, provider) VALUES "
                + "('440123458', now(), ST_SetSRID(ST_MakePoint(129, 35), 4326), 'epfs', 'x'), "
                + "('440123458', now() + interval '1 minute', ST_SetSRID(ST_MakePoint(129, 35), 4326), NULL, 'x')").update();
        assertThatThrownBy(() -> stage.sql("INSERT INTO ship_position (mmsi, ts, geom, position_source, provider) VALUES "
                + "('440123459', now(), ST_SetSRID(ST_MakePoint(129, 35), 4326), 'gnss', 'x')").update()).hasMessageContaining("ship_position_source_check");
        // V7 뒤에 파티션 함수가 만든 파티션(오늘 + 5일)도 같은 CHECK
        assertThat(stage.sql("SELECT ship_position_ensure_partitions(5)").query(Integer.class).single()).isGreaterThanOrEqualTo(1);
        assertThatThrownBy(() -> stage.sql("INSERT INTO ship_position (mmsi, ts, geom, position_source, provider) VALUES "
                + "('440123459', now() + interval '5 days', ST_SetSRID(ST_MakePoint(129, 35), 4326), 'gnss', 'x')").update())
                .hasMessageContaining("ship_position_source_check");
        assertThat(stage.sql("SELECT installed_by FROM flyway_schema_history WHERE version = '7' AND success").query(String.class).single())
                .isEqualTo("wakeline_migrator");
    }

    /**
     * V8(계약 v4 §D): ingest_gap.scope(NULL = 구역 나누기 전) · 고유성 (source, coalesce(scope,''), started_at) 식 인덱스로 UNIQUE(source, started_at) 대체.
     * 기존 행은 그대로(scope NULL), 구역이 다르면 같은 시각 공백을 받고, 구역 없음끼리·같은 구역끼리는 막는다. api 권한은 그대로(INSERT·SELECT 만) —
     * 운영 저장소 문장(ON CONFLICT 식 추론)이 api 계정으로 동작한다. ADR-014 부록 B 의 되돌리기 SQL(계약 v4 §G D-4 — 원래 이름의 제약 ·
     * flyway_schema_history 의 V8 행 삭제)을 적용하면 스키마가 V7 과 같아지고, 그 뒤 --migrate 로 V8 을 다시 적용할 수 있다.
     */
    @Test
    void v8ScopesIngestGapsWithAnExpressionUniqueIndex() throws SQLException {
        DbTestSupport.start();
        String db = "wakeline_stage_eight";
        DbTestSupport.createDatabase(db);
        String url = DbTestSupport.jdbcUrl(db);
        Flyway.configure().dataSource(url, "wakeline_migrator", DbTestSupport.MIGRATOR_PW).locations("classpath:db/migration").target("7").load().migrate();
        JdbcClient stage = JdbcClient.create(new DriverManagerDataSource(url, "postgres", DbTestSupport.ROOT_PW));
        stage.sql("""
                INSERT INTO ingest_gap (source, started_at, ended_at, reason, provider) VALUES
                  ('ais', '2026-09-28T01:00:00Z', '2026-09-28T01:02:00Z', 'server closed (1006)', 'aisstream')""").update();

        // V8 까지만(V9 이후는 V8 되돌리기 시험의 대상이 아니다 — 같은 migrator · 같은 위치)
        Flyway.configure().dataSource(url, "wakeline_migrator", DbTestSupport.MIGRATOR_PW).locations("classpath:db/migration").target("8").load().migrate();

        assertThat(stage.sql("SELECT scope FROM ingest_gap").query(String.class).optional()).as("existing rows: no scope").isEmpty();
        assertThat(stage.sql("SELECT count(*) FROM pg_constraint WHERE conname = 'ingest_gap_source_started'").query(Long.class).single()).isZero();
        assertThat(stage.sql("SELECT indexdef FROM pg_indexes WHERE indexname = 'ingest_gap_source_scope_started_uq'").query(String.class).single())
                .contains("UNIQUE").contains("COALESCE(scope, ''::text)");
        assertThat(stage.sql("SELECT installed_by FROM flyway_schema_history WHERE version = '8' AND success").query(String.class).single())
                .isEqualTo("wakeline_migrator");
        for (String priv : new String[]{"UPDATE", "DELETE", "TRUNCATE"})
            assertThat(stage.sql("SELECT has_table_privilege('wakeline_api', 'ingest_gap', :p)").param("p", priv).query(Boolean.class).single()).as(priv).isFalse();
        for (String priv : new String[]{"SELECT", "INSERT"})
            assertThat(stage.sql("SELECT has_table_privilege('wakeline_api', 'ingest_gap', :p)").param("p", priv).query(Boolean.class).single()).as(priv).isTrue();

        // api 계정으로 운영과 같은 문장(ShipRepository.insertGap)
        JdbcClient api = JdbcClient.create(new DriverManagerDataSource(url, "wakeline_api", DbTestSupport.API_PW));
        dev.wakeline.persist.ShipRepository repo = new dev.wakeline.persist.ShipRepository(new org.springframework.jdbc.core.JdbcTemplate(
                new DriverManagerDataSource(url, "wakeline_api", DbTestSupport.API_PW)), api);
        java.time.Instant s = java.time.Instant.parse("2026-09-28T01:00:00Z");
        assertThat(repo.insertGap(new dev.wakeline.domain.AisGap(s, s.plusSeconds(60), "dup of the legacy row", "aisstream"))).isFalse();
        assertThat(repo.insertGap(new dev.wakeline.domain.AisGap(s, s.plusSeconds(60), "am", "aisstream",
                dev.wakeline.domain.AisScope.parse("-90,-180,90,0")))).isTrue();
        assertThat(repo.insertGap(new dev.wakeline.domain.AisGap(s, s.plusSeconds(90), "ap", "aisstream",
                dev.wakeline.domain.AisScope.parse("-90,45,90,180")))).isTrue();
        assertThat(repo.insertGap(new dev.wakeline.domain.AisGap(s, s.plusSeconds(99), "am again", "aisstream",
                dev.wakeline.domain.AisScope.parse("-90,-180,90,0")))).isFalse();
        assertThat(stage.sql("SELECT count(*) FROM ingest_gap").query(Long.class).single()).isEqualTo(3);
        try (Connection c = DriverManager.getConnection(url, "wakeline_api", DbTestSupport.API_PW)) {
            assertThat(sqlState(c, "UPDATE ingest_gap SET scope = 'x'")).isEqualTo("42501");
            assertThat(sqlState(c, "DELETE FROM ingest_gap")).isEqualTo("42501");
        }
        assertThatThrownBy(() -> stage.sql("INSERT INTO ingest_gap (source, started_at, ended_at, reason, provider, scope) "
                + "VALUES ('ais', now(), now() + interval '1 s', 'r', 'x', '')").update()).hasMessageContaining("ingest_gap_scope_len");

        // 되돌리기(ADR-014 부록 B · 계약 v4 §G D-4): 같은 시각의 구역 공백을 하나만 남긴 뒤 인덱스 삭제 · 제약을 원래 이름(V5)으로 복원 · 열 삭제 ·
        // V8 이력 행 삭제
        stage.sql("DELETE FROM ingest_gap WHERE scope IS NOT NULL").update();
        stage.sql("DROP INDEX ingest_gap_source_scope_started_uq").update();
        stage.sql("ALTER TABLE ingest_gap ADD CONSTRAINT ingest_gap_source_started UNIQUE (source, started_at)").update();
        stage.sql("ALTER TABLE ingest_gap DROP COLUMN scope").update();
        stage.sql("DELETE FROM flyway_schema_history WHERE version = '8'").update();
        assertThat(stage.sql("SELECT count(*) FROM ingest_gap").query(Long.class).single()).isEqualTo(1);
        assertThat(stage.sql("SELECT count(*) FROM pg_constraint WHERE conname = 'ingest_gap_source_started'").query(Long.class).single())
                .as("V7 schema again: the V5 constraint under its original name").isEqualTo(1);
        assertThat(stage.sql("SELECT max(version::int) FROM flyway_schema_history WHERE success").query(Integer.class).single()).isEqualTo(7);

        // 다시 앞으로: 같은 migrator · 같은 위치로 V8 이 다시 적용된다(제약 이름이 V8 이 지우는 이름과 같다)
        Flyway.configure().dataSource(url, "wakeline_migrator", DbTestSupport.MIGRATOR_PW).locations("classpath:db/migration").target("8").load().migrate();
        assertThat(stage.sql("SELECT installed_by FROM flyway_schema_history WHERE version = '8' AND success").query(String.class).single())
                .isEqualTo("wakeline_migrator");
        assertThat(stage.sql("SELECT count(*) FROM pg_constraint WHERE conname = 'ingest_gap_source_started'").query(Long.class).single()).isZero();
        assertThat(stage.sql("SELECT count(*) FROM pg_indexes WHERE indexname = 'ingest_gap_source_scope_started_uq'").query(Long.class).single()).isEqualTo(1);
        assertThat(repo.insertGap(new dev.wakeline.domain.AisGap(s, s.plusSeconds(60), "am after roll-forward", "aisstream",
                dev.wakeline.domain.AisScope.parse("-90,-180,90,0")))).isTrue();
        assertThat(repo.insertGap(new dev.wakeline.domain.AisGap(s, s.plusSeconds(60), "dup of the legacy row", "aisstream"))).isFalse();
    }

    /** V9 머리 주석의 되돌리기 SQL(주석 표시 '-- ' 를 뗀 본문). 블록 경계가 바뀌면 여기서 먼저 깨진다. */
    static String v9RollbackSql() throws java.io.IOException { return rollbackSql("V9__review_v1.sql"); }

    /** 마이그레이션 머리 주석의 되돌리기 SQL(주석 표시 '-- ' 를 뗀 본문 — V9 부터 같은 블록 형식). */
    static String rollbackSql(String file) throws java.io.IOException {
        String text;
        try (var in = MigrationDbTest.class.getResourceAsStream("/db/migration/" + file)) {
            assertThat(in).as(file + " on the classpath").isNotNull();
            text = new String(in.readAllBytes(), java.nio.charset.StandardCharsets.UTF_8);
        }
        String start = "-- ==== 되돌리기(rollback) SQL", end = "-- ==== 되돌리기 끝 ====";
        int s = text.indexOf(start), e = text.indexOf(end);
        assertThat(s).as("rollback block start").isNotNegative();
        assertThat(e).as("rollback block end").isGreaterThan(s);
        StringBuilder sql = new StringBuilder();
        for (String line : text.substring(text.indexOf('\n', s) + 1, e).split("\n")) {
            assertThat(line).as("every rollback line is a comment").startsWith("--");
            sql.append(line.startsWith("-- ") ? line.substring(3) : line.substring(2)).append('\n');
        }
        return sql.toString();
    }

    static void migrateTo(String url, String target) {
        Flyway.configure().dataSource(url, "wakeline_migrator", DbTestSupport.MIGRATOR_PW).locations("classpath:db/migration").target(target).load().migrate();
    }

    static void runAsMigrator(String url, String sql) throws SQLException {
        try (Connection c = DriverManager.getConnection(url, "wakeline_migrator", DbTestSupport.MIGRATOR_PW); Statement st = c.createStatement()) {
            st.execute(sql);
        }
    }

    /**
     * V9(리뷰 v1, ADR-017 §2): 머리 주석의 되돌리기 SQL 을 migrator 로 실행하면 V8 상태로 돌아가고(이력 행도 지워짐), 그 뒤 --migrate 로
     * V9 를 다시 적용할 수 있다. 되돌리기 SQL 이 실제로 동작하는지 여기서 고정한다.
     */
    @Test
    void v9RollbackSqlInTheHeaderRestoresV8AndV9ReappliesCleanly() throws Exception {
        DbTestSupport.start();
        String db = "wakeline_stage_nine";
        DbTestSupport.createDatabase(db);
        String url = DbTestSupport.jdbcUrl(db);
        // V9 까지만(V10 이후가 적용된 채로 V9 만 되돌릴 수는 없다 — 되돌리기는 최신부터 역순. 같은 migrator · 같은 위치)
        migrateTo(url, "9");
        JdbcClient stage = JdbcClient.create(new DriverManagerDataSource(url, "postgres", DbTestSupport.ROOT_PW));
        assertThat(stage.sql("SELECT max(version::int) FROM flyway_schema_history WHERE success").query(Integer.class).single()).isEqualTo(9);
        assertThat(stage.sql("SELECT prosrc FROM pg_proc WHERE proname = 'track_point_drop_old'").query(String.class).single()).contains("boundary");
        java.util.function.Function<String, Long> index = name -> stage.sql("SELECT count(*) FROM pg_indexes WHERE indexname = :n").param("n", name)
                .query(Long.class).single();
        for (String ix : new String[]{"alert_event_hex_id", "aircraft_hex_prefix", "aircraft_registration_prefix"})
            assertThat(index.apply(ix)).as("V9 index " + ix).isEqualTo(1);
        java.util.function.Supplier<Long> apiDefaultGrants = () -> stage.sql("""
                SELECT count(*) FROM pg_default_acl d, aclexplode(d.defaclacl) a WHERE a.grantee = 'wakeline_api'::regrole""").query(Long.class).single();
        java.util.function.Supplier<String> ensureBody = () -> stage.sql("SELECT prosrc FROM pg_proc WHERE proname = 'track_point_ensure_partitions'")
                .query(String.class).single();
        assertThat(apiDefaultGrants.get()).as("R-88: no default grants").isZero();
        assertThat(ensureBody.get()).contains("REVOKE ALL");

        try (Connection c = DriverManager.getConnection(url, "wakeline_migrator", DbTestSupport.MIGRATOR_PW); Statement st = c.createStatement()) {
            st.execute(v9RollbackSql());
        }
        assertThat(stage.sql("SELECT max(version::int) FROM flyway_schema_history WHERE success").query(Integer.class).single()).isEqualTo(8);
        for (String ix : new String[]{"alert_event_hex_id", "aircraft_hex_prefix", "aircraft_registration_prefix"})
            assertThat(index.apply(ix)).as("rolled back " + ix).isZero();
        assertThat(apiDefaultGrants.get()).as("V1 default grants restored (SELECT, INSERT, UPDATE, DELETE)").isEqualTo(4L);
        assertThat(ensureBody.get()).doesNotContain("REVOKE");
        for (String fn : new String[]{"track_point_drop_old", "ship_position_drop_old"}) {
            assertThat(stage.sql("SELECT prosrc FROM pg_proc WHERE proname = :f").param("f", fn).query(String.class).single()).as(fn).contains("::date - 1");
            assertThat(stage.sql("SELECT prosecdef FROM pg_proc WHERE proname = :f").param("f", fn).query(Boolean.class).single()).as(fn).isTrue();
            assertThat(stage.sql("SELECT has_function_privilege('wakeline_api', :f || '(int)', 'EXECUTE')").param("f", fn).query(Boolean.class).single()).isTrue();
        }

        migrateTo(url, "9");
        assertThat(stage.sql("SELECT installed_by FROM flyway_schema_history WHERE version = '9' AND success").query(String.class).single())
                .isEqualTo("wakeline_migrator");
        assertThat(stage.sql("SELECT prosrc FROM pg_proc WHERE proname = 'ship_position_drop_old'").query(String.class).single()).contains("boundary");
        for (String ix : new String[]{"alert_event_hex_id", "aircraft_hex_prefix", "aircraft_registration_prefix"})
            assertThat(index.apply(ix)).as("re-applied " + ix).isEqualTo(1);
        assertThat(apiDefaultGrants.get()).isZero();
        assertThat(ensureBody.get()).contains("REVOKE ALL");
    }

    /**
     * V10(계약 v5 §B1): 선박 검색 인덱스 셋(선명·호출부호 upper(...) text_pattern_ops · imo) — migrator 소유, 새 표·권한 없음(api 권한 스냅샷은
     * RolePrivilegesDbTest). 머리 주석의 되돌리기 SQL 을 migrator 로 실행하면 V9 상태(인덱스 없음 · 이력 행 없음)로 돌아가고, 다시 적용된다.
     */
    @Test
    void v10AddsShipSearchIndexes_andItsHeaderRollbackRestoresV9() throws Exception {
        DbTestSupport.start();
        String db = "wakeline_stage_ten";
        DbTestSupport.createDatabase(db);
        String url = DbTestSupport.jdbcUrl(db);
        java.util.function.Consumer<String> migrateTo = v -> Flyway.configure().dataSource(url, "wakeline_migrator", DbTestSupport.MIGRATOR_PW)
                .locations("classpath:db/migration").target(v).load().migrate();
        migrateTo.accept("9");
        JdbcClient stage = JdbcClient.create(new DriverManagerDataSource(url, "postgres", DbTestSupport.ROOT_PW));
        stage.sql("""
                INSERT INTO ship (mmsi, name, call_sign, imo, ship_type, first_seen, last_seen, updated_at, provider)
                VALUES ('440123456', 'HANJIN BUSAN', 'D7HB', 9321483, 70, now(), now(), now(), 'aisstream')""").update();
        java.util.function.Supplier<Map<String, String>> indexes = () -> {
            Map<String, String> m = new HashMap<>();
            for (var r : stage.sql("SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'ship' AND indexname IN "
                    + "('ship_name_prefix', 'ship_call_sign_prefix', 'ship_imo')").query().listOfRows())
                m.put((String) r.get("indexname"), (String) r.get("indexdef"));
            return m;
        };
        java.util.function.Supplier<Long> relations = () -> stage.sql("SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace "
                + "WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'S', 'v', 'm')").query(Long.class).single();
        assertThat(indexes.get()).isEmpty();
        long relationsAtV9 = relations.get();

        migrateTo.accept("10");
        Map<String, String> ix = indexes.get();
        assertThat(ix).containsOnlyKeys("ship_name_prefix", "ship_call_sign_prefix", "ship_imo");
        assertThat(ix.get("ship_name_prefix")).contains("upper(name)").contains("text_pattern_ops");
        assertThat(ix.get("ship_call_sign_prefix")).contains("upper(call_sign)").contains("text_pattern_ops");
        assertThat(ix.get("ship_imo")).contains("(imo)");
        assertThat(relations.get()).as("V10 creates no table, sequence or view — nothing that would need a GRANT").isEqualTo(relationsAtV9);
        for (String name : ix.keySet())
            assertThat(stage.sql("SELECT pg_get_userbyid(relowner) FROM pg_class WHERE relname = :n").param("n", name).query(String.class).single())
                    .as(name + " owner").isEqualTo("wakeline_migrator");
        assertThat(stage.sql("SELECT installed_by FROM flyway_schema_history WHERE version = '10' AND success").query(String.class).single())
                .isEqualTo("wakeline_migrator");
        assertThat(stage.sql("SELECT count(*) FROM ship").query(Long.class).single()).as("data untouched").isEqualTo(1L);

        try (Connection c = DriverManager.getConnection(url, "wakeline_migrator", DbTestSupport.MIGRATOR_PW); Statement st = c.createStatement()) {
            st.execute(rollbackSql("V10__ship_search_indexes.sql"));
        }
        assertThat(indexes.get()).as("rolled back").isEmpty();
        assertThat(stage.sql("SELECT max(version::int) FROM flyway_schema_history WHERE success").query(Integer.class).single()).isEqualTo(9);
        assertThat(stage.sql("SELECT count(*) FROM ship").query(Long.class).single()).isEqualTo(1L);

        migrateTo.accept("10");
        assertThat(indexes.get()).as("re-applied").hasSize(3);
        assertThat(stage.sql("SELECT installed_by FROM flyway_schema_history WHERE version = '10' AND success").query(String.class).single())
                .isEqualTo("wakeline_migrator");
    }

    /**
     * V11(계약 v5 §D1 · R-94 · ADR-019): provider_switch — 공급자 스위치의 원본(Redis wakeline:provider:{name}.disabled 는 미러).
     * 열·제약은 계약 그대로, api 는 SELECT · INSERT · UPDATE 만(V9 이후 기본 권한이 없으므로 명시 GRANT), collector 는 아무 권한 없음(스위치는 Redis 로만 본다).
     * updated_by 는 ops_user FK(NULL = 시스템 — Redis 값 이관). 머리 주석의 되돌리기 SQL 로 표와 이력 행이 사라지고, 다시 적용된다.
     */
    @Test
    void v11CreatesTheProviderSwitchTableWithExplicitApiGrantsOnly() throws Exception {
        DbTestSupport.start();
        String db = "wakeline_stage_eleven";
        DbTestSupport.createDatabase(db);
        String url = DbTestSupport.jdbcUrl(db);
        migrateTo(url, "11");
        JdbcClient stage = JdbcClient.create(new DriverManagerDataSource(url, "postgres", DbTestSupport.ROOT_PW));
        assertThat(stage.sql("SELECT installed_by FROM flyway_schema_history WHERE version = '11' AND success").query(String.class).single())
                .isEqualTo("wakeline_migrator");
        assertThat(stage.sql("SELECT pg_get_userbyid(relowner) FROM pg_class WHERE relname = 'provider_switch'").query(String.class).single())
                .isEqualTo("wakeline_migrator");
        Map<String, String> cols = new java.util.TreeMap<>();
        for (var r : stage.sql("SELECT column_name, data_type || ':' || is_nullable t FROM information_schema.columns WHERE table_name = 'provider_switch'")
                .query().listOfRows()) cols.put(String.valueOf(r.get("column_name")), String.valueOf(r.get("t")));
        assertThat(cols).isEqualTo(new java.util.TreeMap<>(Map.of("provider", "text:NO", "disabled", "boolean:NO", "version", "integer:NO",
                "updated_at", "timestamp with time zone:NO", "updated_by", "integer:YES")));
        assertThat(stage.sql("""
                SELECT string_agg(pg_get_constraintdef(oid), ' | ' ORDER BY contype) FROM pg_constraint WHERE conrelid = 'provider_switch'::regclass AND contype IN ('p', 'f', 'u', 'c')""")
                .query(String.class).single()).isEqualTo("FOREIGN KEY (updated_by) REFERENCES ops_user(id) | PRIMARY KEY (provider)");

        try (Connection c = DriverManager.getConnection(url, "wakeline_api", DbTestSupport.API_PW)) {
            assertThat(sqlState(c, "INSERT INTO provider_switch (provider, disabled, version, updated_at) VALUES ('adsbdb', true, 1, now())")).isNull();
            assertThat(sqlState(c, "UPDATE provider_switch SET disabled = false, version = version + 1 WHERE provider = 'adsbdb'")).isNull();
            assertThat(sqlState(c, "SELECT * FROM provider_switch")).isNull();
            assertThat(sqlState(c, "DELETE FROM provider_switch")).isEqualTo("42501");
            assertThat(sqlState(c, "TRUNCATE provider_switch")).isEqualTo("42501");
            assertThat(sqlState(c, "INSERT INTO provider_switch (provider, disabled, version, updated_at, updated_by) VALUES ('x', true, 1, now(), 999)"))
                    .as("updated_by must be an operator").isEqualTo("23503");
            assertThat(sqlState(c, "INSERT INTO provider_switch (provider, disabled, version, updated_at) VALUES ('y', NULL, 1, now())")).isEqualTo("23502");
        }
        try (Connection c = DriverManager.getConnection(url, "wakeline_collector", DbTestSupport.COLLECTOR_PW)) {
            for (String sql : new String[]{"SELECT * FROM provider_switch", "UPDATE provider_switch SET disabled = false",
                    "INSERT INTO provider_switch (provider, disabled, version, updated_at) VALUES ('opensky', false, 1, now())"})
                assertThat(sqlState(c, sql)).as(sql).isEqualTo("42501");
        }

        // 되돌리기(머리 주석): 표 삭제 + 이력 행 삭제 → Redis 값만 남아 이전 코드가 그대로 동작한다. 그 뒤 다시 앞으로
        runAsMigrator(url, rollbackSql("V11__provider_switch.sql"));
        assertThat(stage.sql("SELECT to_regclass('provider_switch') IS NULL").query(Boolean.class).single()).isTrue();
        assertThat(stage.sql("SELECT count(*) FROM flyway_schema_history WHERE version = '11'").query(Long.class).single()).isZero();
        migrateTo(url, "11");
        assertThat(stage.sql("SELECT has_table_privilege('wakeline_api', 'provider_switch', 'UPDATE')").query(Boolean.class).single()).isTrue();
        assertThat(stage.sql("SELECT has_table_privilege('wakeline_api', 'provider_switch', 'DELETE')").query(Boolean.class).single()).isFalse();
    }

    /**
     * V12(계약 v5 §D2 · R-91 · ADR-019): ingest_run.run_key uuid NULL UNIQUE. 옛 행은 NULL 로 남고(NULL 끼리는 겹치지 않는다), collector 계정으로
     * 운영과 같은 문장(INSERT … ON CONFLICT (run_key) DO NOTHING RETURNING id)을 두 번 보내도 한 행 — 두 번째는 행을 돌려주지 않고, run_key 로
     * run id 를 되찾을 수 있다. 새 열은 표 권한을 따른다(collector INSERT · api SELECT 만). 머리 주석의 되돌리기 SQL 로 V11 상태가 되고 다시 적용된다.
     */
    @Test
    void v12AddsAUniqueRunKeySoARetriedRunIsRecordedOnce() throws Exception {
        DbTestSupport.start();
        String db = "wakeline_stage_twelve";
        DbTestSupport.createDatabase(db);
        String url = DbTestSupport.jdbcUrl(db);
        migrateTo(url, "11");
        JdbcClient stage = JdbcClient.create(new DriverManagerDataSource(url, "postgres", DbTestSupport.ROOT_PW));
        stage.sql("INSERT INTO ingest_run (job, provider, started_at, status) VALUES ('legacy', 'x', now(), 'ok'), ('legacy', 'x', now(), 'ok')").update();

        migrateTo(url, "12");
        assertThat(stage.sql("SELECT installed_by FROM flyway_schema_history WHERE version = '12' AND success").query(String.class).single())
                .isEqualTo("wakeline_migrator");
        assertThat(stage.sql("SELECT count(*) FROM ingest_run WHERE run_key IS NULL").query(Long.class).single()).as("existing rows: no key").isEqualTo(2);
        assertThat(stage.sql("SELECT data_type || ':' || is_nullable FROM information_schema.columns WHERE table_name = 'ingest_run' AND column_name = 'run_key'")
                .query(String.class).single()).isEqualTo("uuid:YES");
        assertThat(stage.sql("SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'ingest_run_run_key_key'").query(String.class).single())
                .isEqualTo("UNIQUE (run_key)");

        String key = java.util.UUID.randomUUID().toString();
        String insert = """
                INSERT INTO ingest_run (run_key, job, provider, started_at, finished_at, status, http_status, latency_ms, records_in, records_quarantined, raw_ref, error_text)
                VALUES ('%s'::uuid, 'region', 'adsb_lol', now(), now(), 'ok', 200, 12, 7, 0, NULL, NULL)
                ON CONFLICT (run_key) DO NOTHING RETURNING id""".formatted(key);
        try (Connection c = DriverManager.getConnection(url, "wakeline_collector", DbTestSupport.COLLECTOR_PW); Statement st = c.createStatement()) {
            long first;
            try (var rs = st.executeQuery(insert)) { assertThat(rs.next()).isTrue(); first = rs.getLong(1); }
            try (var rs = st.executeQuery(insert)) { assertThat(rs.next()).as("retry of a committed run: no row").isFalse(); }
            try (var rs = st.executeQuery("SELECT id FROM ingest_run WHERE run_key = '" + key + "'::uuid")) {
                assertThat(rs.next()).isTrue();
                assertThat(rs.getLong(1)).as("run id recovered by run_key").isEqualTo(first);
            }
            assertThat(sqlState(c, "UPDATE ingest_run SET run_key = NULL WHERE false")).as("collector keeps its V1 table rights").isNull();
        }
        assertThat(stage.sql("SELECT count(*) FROM ingest_run WHERE job = 'region'").query(Long.class).single()).isEqualTo(1);
        try (Connection c = DriverManager.getConnection(url, "wakeline_api", DbTestSupport.API_PW)) {
            assertThat(sqlState(c, "SELECT run_key FROM ingest_run")).isNull();
            assertThat(sqlState(c, "INSERT INTO ingest_run (run_key, job, provider, started_at, status) VALUES (gen_random_uuid(), 'j', 'p', now(), 'ok')"))
                    .isEqualTo("42501");
            assertThat(sqlState(c, "UPDATE ingest_run SET run_key = NULL")).isEqualTo("42501");
        }

        // 되돌리기(머리 주석): 열(과 UNIQUE 제약·인덱스)을 지우고 이력 행 삭제 → V11 과 같은 스키마, 다시 앞으로
        runAsMigrator(url, rollbackSql("V12__ingest_run_run_key.sql"));
        assertThat(stage.sql("SELECT count(*) FROM information_schema.columns WHERE table_name = 'ingest_run' AND column_name = 'run_key'")
                .query(Long.class).single()).isZero();
        assertThat(stage.sql("SELECT count(*) FROM flyway_schema_history WHERE version = '12'").query(Long.class).single()).isZero();
        assertThat(stage.sql("SELECT count(*) FROM ingest_run").query(Long.class).single()).as("rows kept").isEqualTo(3);
        migrateTo(url, "12");
        assertThat(stage.sql("SELECT count(*) FROM pg_constraint WHERE conname = 'ingest_run_run_key_key'").query(Long.class).single()).isEqualTo(1);
    }

    /**
     * V13(계약 v5 §G14 · ADR-024): ops_resolution — 운영자의 '해결' 표시(로그 묶음 fp · 공급자 오류). 증거(로그 스트림 · ingest_run · 공급자 해시)는
     * 지우지 않고 upto 이하를 가린다. 열 · 제약은 계약 그대로(+ fp 모양 · 메모 200자 · 되돌림 쌍 CHECK), api 는 SELECT · INSERT 와 revoked_at ·
     * revoked_by 열의 UPDATE 만(행을 지우지 않는다 — 되돌림은 revoked_at 을 채운다 · 이미 적은 kind · key · upto · 메모는 고치지 못한다),
     * collector 는 권한 없음. 머리 주석의 되돌리기 SQL 로 표와 이력 행이 사라지고, 다시 적용된다.
     */
    @Test
    void v13CreatesTheResolutionTableWithInsertAndRevokeOnlyGrants() throws Exception {
        DbTestSupport.start();
        String db = "wakeline_stage_thirteen";
        DbTestSupport.createDatabase(db);
        String url = DbTestSupport.jdbcUrl(db);
        migrateTo(url, "13");
        JdbcClient stage = JdbcClient.create(new DriverManagerDataSource(url, "postgres", DbTestSupport.ROOT_PW));
        assertThat(stage.sql("SELECT installed_by FROM flyway_schema_history WHERE version = '13' AND success").query(String.class).single())
                .isEqualTo("wakeline_migrator");
        assertThat(stage.sql("SELECT pg_get_userbyid(relowner) FROM pg_class WHERE relname = 'ops_resolution'").query(String.class).single())
                .isEqualTo("wakeline_migrator");
        Map<String, String> cols = new java.util.TreeMap<>();
        for (var r : stage.sql("SELECT column_name, data_type || ':' || is_nullable t FROM information_schema.columns WHERE table_name = 'ops_resolution'")
                .query().listOfRows()) cols.put(String.valueOf(r.get("column_name")), String.valueOf(r.get("t")));
        assertThat(cols).isEqualTo(new java.util.TreeMap<>(Map.of("id", "bigint:NO", "kind", "text:NO", "key", "text:NO",
                "upto", "timestamp with time zone:NO", "resolved_at", "timestamp with time zone:NO", "resolved_by", "text:NO", "note", "text:YES",
                "revoked_at", "timestamp with time zone:YES", "revoked_by", "text:YES")));
        assertThat(stage.sql("SELECT column_default FROM information_schema.columns WHERE table_name = 'ops_resolution' AND column_name = 'resolved_at'")
                .query(String.class).single()).isEqualTo("now()");
        assertThat(stage.sql("SELECT indexdef FROM pg_indexes WHERE indexname = 'ops_resolution_active'").query(String.class).single())
                .contains("(kind, key)").contains("WHERE (revoked_at IS NULL)");

        String fp = "0123456789abcdef";
        try (Connection c = DriverManager.getConnection(url, "wakeline_api", DbTestSupport.API_PW)) {
            String ok = "INSERT INTO ops_resolution (kind, key, upto, resolved_by, note) VALUES ('log_group', '" + fp + "', now(), 'ops', 'fixed in 1.2')";
            assertThat(sqlState(c, ok)).isNull();
            assertThat(sqlState(c, "INSERT INTO ops_resolution (kind, key, upto, resolved_by) VALUES ('provider_error', 'adsb_lol', now(), 'ops')")).isNull();
            assertThat(sqlState(c, "SELECT * FROM ops_resolution")).isNull();
            // 되돌림(revoked_at · revoked_by)만 고칠 수 있다 — 이미 적은 해결 범위 · 누가 · 메모는 바꾸지 못한다
            assertThat(sqlState(c, "UPDATE ops_resolution SET revoked_at = now(), revoked_by = 'ops' WHERE kind = 'provider_error'")).isNull();
            for (String sql : new String[]{"UPDATE ops_resolution SET upto = now()", "UPDATE ops_resolution SET key = 'x'",
                    "UPDATE ops_resolution SET note = 'rewritten'", "UPDATE ops_resolution SET resolved_by = 'someone else'",
                    "DELETE FROM ops_resolution", "TRUNCATE ops_resolution"})
                assertThat(sqlState(c, sql)).as(sql).isEqualTo("42501");
            // 제약: kind 목록 · log_group 의 key 는 fp 모양(16자리 소문자 16진) · 메모 200자 이하 · 되돌림 시각과 사람은 함께
            for (String bad : new String[]{
                    "INSERT INTO ops_resolution (kind, key, upto, resolved_by) VALUES ('alert', 'x', now(), 'ops')",
                    "INSERT INTO ops_resolution (kind, key, upto, resolved_by) VALUES ('log_group', '0123456789ABCDEF', now(), 'ops')",
                    "INSERT INTO ops_resolution (kind, key, upto, resolved_by) VALUES ('log_group', 'abc', now(), 'ops')",
                    "INSERT INTO ops_resolution (kind, key, upto, resolved_by) VALUES ('provider_error', '', now(), 'ops')",
                    "INSERT INTO ops_resolution (kind, key, upto, resolved_by, note) VALUES ('provider_error', 'awc', now(), 'ops', repeat('가', 201))",
                    "INSERT INTO ops_resolution (kind, key, upto, resolved_by, revoked_at) VALUES ('provider_error', 'awc', now(), 'ops', now())",
                    "INSERT INTO ops_resolution (kind, key, upto, resolved_by) VALUES ('provider_error', 'awc', now(), '')"})
                assertThat(sqlState(c, bad)).as(bad).isEqualTo("23514");
            assertThat(sqlState(c, "INSERT INTO ops_resolution (kind, key, upto, resolved_by) VALUES ('provider_error', 'awc', NULL, 'ops')")).isEqualTo("23502");
            assertThat(sqlState(c, "INSERT INTO ops_resolution (kind, key, upto, resolved_by, note) VALUES ('provider_error', 'awc', now(), 'ops', repeat('가', 200))"))
                    .as("200 characters (not bytes) is the limit").isNull();
        }
        try (Connection c = DriverManager.getConnection(url, "wakeline_collector", DbTestSupport.COLLECTOR_PW)) {
            for (String sql : new String[]{"SELECT * FROM ops_resolution", "UPDATE ops_resolution SET revoked_at = now(), revoked_by = 'c'",
                    "INSERT INTO ops_resolution (kind, key, upto, resolved_by) VALUES ('provider_error', 'awc', now(), 'c')"})
                assertThat(sqlState(c, sql)).as(sql).isEqualTo("42501");
        }

        // 되돌리기(머리 주석): 표 삭제 + 이력 행 삭제 → V12 와 같은 스키마(가림이 없어 모든 증거가 다시 보인다). 그 뒤 다시 앞으로
        runAsMigrator(url, rollbackSql("V13__ops_resolution.sql"));
        assertThat(stage.sql("SELECT to_regclass('ops_resolution') IS NULL").query(Boolean.class).single()).isTrue();
        assertThat(stage.sql("SELECT count(*) FROM flyway_schema_history WHERE version = '13'").query(Long.class).single()).isZero();
        migrateTo(url, "13");
        assertThat(stage.sql("SELECT has_table_privilege('wakeline_api', 'ops_resolution', 'INSERT')").query(Boolean.class).single()).isTrue();
        assertThat(stage.sql("SELECT has_column_privilege('wakeline_api', 'ops_resolution', 'revoked_at', 'UPDATE')").query(Boolean.class).single()).isTrue();
        assertThat(stage.sql("SELECT has_table_privilege('wakeline_api', 'ops_resolution', 'DELETE')").query(Boolean.class).single()).isFalse();
    }

    /**
     * V14(계약 v5 §G15 · ADR-023): marine_grid4 — 해양격자 4단계 칸의 기하 캐시(연안 교통량). V13(해결 표시) 다음에 적용되고(합친 순서 — 레인은
     * 따로 만들었다), V15(입출항 색인) 앞이다. 열 · 한 칸 CHECK · grid_no 형식 CHECK, 권한은 collector SELECT · INSERT · UPDATE(upsert, 지우지 않음) ·
     * api SELECT. 머리 주석의 되돌리기 SQL 로 표와 이력 행이 사라지고, 다시 적용된다.
     */
    @Test
    void v14CreatesTheMarineGridCacheAfterV13WithCollectorUpsertAndApiReadGrants() throws Exception {
        DbTestSupport.start();
        assertThat(latestMigrationVersion()).as("latest migration on the classpath").isGreaterThanOrEqualTo(14);
        String db = "wakeline_stage_fourteen";
        DbTestSupport.createDatabase(db);
        String url = DbTestSupport.jdbcUrl(db);
        migrateTo(url, "14");
        JdbcClient stage = JdbcClient.create(new DriverManagerDataSource(url, "postgres", DbTestSupport.ROOT_PW));
        // V13 이 V14 보다 먼저(installed_rank) — 둘 다 migrator 가 적용
        assertThat(stage.sql("SELECT version FROM flyway_schema_history WHERE version IN ('13', '14') AND success ORDER BY installed_rank").query(String.class).list())
                .containsExactly("13", "14");
        assertThat(stage.sql("SELECT installed_by FROM flyway_schema_history WHERE version = '14' AND success").query(String.class).single())
                .isEqualTo("wakeline_migrator");
        assertThat(stage.sql("SELECT pg_get_userbyid(relowner) FROM pg_class WHERE relname = 'marine_grid4'").query(String.class).single())
                .isEqualTo("wakeline_migrator");
        Map<String, String> cols = new java.util.TreeMap<>();
        for (var r : stage.sql("SELECT column_name, data_type || ':' || is_nullable t FROM information_schema.columns WHERE table_name = 'marine_grid4'")
                .query().listOfRows()) cols.put(String.valueOf(r.get("column_name")), String.valueOf(r.get("t")));
        assertThat(cols).isEqualTo(new java.util.TreeMap<>(Map.of("grid_no", "text:NO", "lat_min", "double precision:NO", "lon_min", "double precision:NO",
                "lat_max", "double precision:NO", "lon_max", "double precision:NO", "gid", "integer:YES", "fetched_at", "timestamp with time zone:NO")));

        String ok = "INSERT INTO marine_grid4 (grid_no, lat_min, lon_min, lat_max, lon_max, gid, fetched_at) VALUES ('GR4_F2K41_C3', 37.45, 126.6, 37.475, 126.625, 7, now())";
        try (Connection c = DriverManager.getConnection(url, "wakeline_collector", DbTestSupport.COLLECTOR_PW)) {
            assertThat(sqlState(c, ok)).isNull();
            assertThat(sqlState(c, "UPDATE marine_grid4 SET gid = 8, fetched_at = now() WHERE grid_no = 'GR4_F2K41_C3'")).isNull();
            assertThat(sqlState(c, "SELECT * FROM marine_grid4")).isNull();
            for (String sql : new String[]{"DELETE FROM marine_grid4", "TRUNCATE marine_grid4"})
                assertThat(sqlState(c, sql)).as(sql).isEqualTo("42501");
            // 한 칸(0.025° 정사각형, 격자점에서 1e-6° 안) · grid_no 형식이 아니면 거절 — 수집기 검사의 둘째 방어선
            for (String bad : new String[]{
                    "INSERT INTO marine_grid4 (grid_no, lat_min, lon_min, lat_max, lon_max, fetched_at) VALUES ('GR4_OFF', 37.4512, 126.6, 37.4762, 126.625, now())",
                    "INSERT INTO marine_grid4 (grid_no, lat_min, lon_min, lat_max, lon_max, fetched_at) VALUES ('GR4_TWO', 37.45, 126.6, 37.5, 126.625, now())",
                    "INSERT INTO marine_grid4 (grid_no, lat_min, lon_min, lat_max, lon_max, fetched_at) VALUES ('GR4 bad', 37.45, 126.6, 37.475, 126.625, now())"})
                assertThat(sqlState(c, bad)).as(bad).isEqualTo("23514");
        }
        try (Connection c = DriverManager.getConnection(url, "wakeline_api", DbTestSupport.API_PW)) {
            assertThat(sqlState(c, "SELECT count(*) FROM marine_grid4")).isNull();
            for (String sql : new String[]{"UPDATE marine_grid4 SET gid = 1", "DELETE FROM marine_grid4",
                    "INSERT INTO marine_grid4 (grid_no, lat_min, lon_min, lat_max, lon_max, fetched_at) VALUES ('GR4_API', 37.45, 126.6, 37.475, 126.625, now())"})
                assertThat(sqlState(c, sql)).as(sql).isEqualTo("42501");
        }

        // 되돌리기(머리 주석): 표 삭제 + 이력 행 삭제 → V13 과 같은 스키마(파생 캐시 — 수집기가 다시 채운다). 그 뒤 다시 앞으로
        runAsMigrator(url, rollbackSql("V14__marine_grid4.sql"));
        assertThat(stage.sql("SELECT to_regclass('marine_grid4') IS NULL").query(Boolean.class).single()).isTrue();
        assertThat(stage.sql("SELECT count(*) FROM flyway_schema_history WHERE version = '14'").query(Long.class).single()).isZero();
        assertThat(stage.sql("SELECT to_regclass('ops_resolution') IS NOT NULL").query(Boolean.class).single()).as("V13 untouched").isTrue();
        migrateTo(url, "14");
        assertThat(stage.sql("SELECT has_table_privilege('wakeline_collector', 'marine_grid4', 'UPDATE')").query(Boolean.class).single()).isTrue();
        assertThat(stage.sql("SELECT has_table_privilege('wakeline_api', 'marine_grid4', 'SELECT')").query(Boolean.class).single()).isTrue();
        assertThat(stage.sql("SELECT has_table_privilege('wakeline_api', 'marine_grid4', 'INSERT')").query(Boolean.class).single()).isFalse();
    }

    /**
     * V15(계약 v5 §G16 · ADR-022 개정): 한국 항만 입출항 색인 — port_call(자연 키 항만청 · 호출부호 · 입항년도 · 입항횟수, 정규화한 호출부호 인덱스)과
     * port_call_coverage(항만청마다 색인한 KST 날짜 범위 · 꼬리 갱신 시각). V14 다음에 적용되고, 권한은 collector 가 port_call 을 upsert · 삭제(철회된 신고 ·
     * 보존 60일)하고 범위를 쓰며(지우지 않음) api 는 둘 다 읽기만. 형식 CHECK 가 collector 검사의 둘째 방어선이다. 머리 주석의 되돌리기 SQL 로 두 표와
     * 이력 행이 사라지고, 다시 적용된다.
     */
    @Test
    void v15CreatesThePortCallIndexAfterV14WithCollectorWriteAndApiReadGrants() throws Exception {
        DbTestSupport.start();
        assertThat(latestMigrationVersion()).as("latest migration on the classpath").isGreaterThanOrEqualTo(15);
        String db = "wakeline_stage_fifteen";
        DbTestSupport.createDatabase(db);
        String url = DbTestSupport.jdbcUrl(db);
        migrateTo(url, "15");
        JdbcClient stage = JdbcClient.create(new DriverManagerDataSource(url, "postgres", DbTestSupport.ROOT_PW));
        assertThat(stage.sql("SELECT version FROM flyway_schema_history WHERE version IN ('14', '15') AND success ORDER BY installed_rank").query(String.class).list())
                .containsExactly("14", "15");
        assertThat(stage.sql("SELECT installed_by FROM flyway_schema_history WHERE version = '15' AND success").query(String.class).single())
                .isEqualTo("wakeline_migrator");
        for (String t : new String[]{"port_call", "port_call_coverage"})
            assertThat(stage.sql("SELECT pg_get_userbyid(relowner) FROM pg_class WHERE relname = :t").param("t", t).query(String.class).single())
                    .as(t).isEqualTo("wakeline_migrator");
        Map<String, String> cols = new java.util.TreeMap<>();
        for (var r : stage.sql("SELECT column_name, data_type || ':' || is_nullable t FROM information_schema.columns WHERE table_name = 'port_call'")
                .query().listOfRows()) cols.put(String.valueOf(r.get("column_name")), String.valueOf(r.get("t")));
        Map<String, String> want = new java.util.TreeMap<>();
        for (String c : new String[]{"prt_ag_cd", "clsgn", "etrypt_year", "etrypt_co"}) want.put(c, "text:NO");
        for (String c : new String[]{"prt_ag_nm", "vssl_nm", "nationality_cd", "nationality_nm", "kind_cd", "kind_nm", "purpose_nm", "first_port_cd",
                "first_port_nm", "prev_port_cd", "prev_port_nm", "next_port_cd", "next_port_nm", "dest_port_cd", "dest_port_nm", "entry_revision",
                "exit_revision", "berth"}) want.put(c, "text:YES");
        want.put("listed_date", "date:NO");
        want.put("entry_at", "timestamp with time zone:YES");
        want.put("exit_at", "timestamp with time zone:YES");
        want.put("fetched_at", "timestamp with time zone:NO");
        want.put("updated_at", "timestamp with time zone:NO");
        assertThat(cols).isEqualTo(want);
        assertThat(stage.sql("SELECT indexdef FROM pg_indexes WHERE indexname = 'port_call_clsgn_idx'").query(String.class).single())
                .contains("(clsgn, listed_date DESC)");
        Map<String, String> cov = new java.util.TreeMap<>();
        for (var r : stage.sql("SELECT column_name, data_type || ':' || is_nullable t FROM information_schema.columns WHERE table_name = 'port_call_coverage'")
                .query().listOfRows()) cov.put(String.valueOf(r.get("column_name")), String.valueOf(r.get("t")));
        assertThat(cov).isEqualTo(new java.util.TreeMap<>(Map.of("prt_ag_cd", "text:NO", "covered_from", "date:NO", "covered_to", "date:NO",
                "refreshed_at", "timestamp with time zone:YES", "hole_days", "ARRAY:NO", "updated_at", "timestamp with time zone:NO")));
        assertThat(stage.sql("SELECT udt_name FROM information_schema.columns WHERE table_name = 'port_call_coverage' AND column_name = 'hole_days'")
                .query(String.class).single()).isEqualTo("_date");

        String row = "INSERT INTO port_call (prt_ag_cd, clsgn, etrypt_year, etrypt_co, listed_date, vssl_nm, entry_at, entry_revision, fetched_at, updated_at) "
                + "VALUES ('020', 'V7A3884', '2026', '005', '2026-09-24', 'AZAMARA PURSUIT', '2026-09-23T23:17:00Z', '최종', now(), now())";
        try (Connection c = DriverManager.getConnection(url, "wakeline_collector", DbTestSupport.COLLECTOR_PW)) {
            assertThat(sqlState(c, row)).isNull();
            assertThat(sqlState(c, row)).as("natural key").isEqualTo("23505");
            assertThat(sqlState(c, "UPDATE port_call SET exit_at = '2026-09-25T05:24:00Z', exit_revision = '최종' WHERE clsgn = 'V7A3884'")).isNull();
            assertThat(sqlState(c, "SELECT * FROM port_call WHERE clsgn = 'V7A3884'")).isNull();
            assertThat(sqlState(c, "DELETE FROM port_call WHERE listed_date < '2026-07-01'")).as("retention / withdrawn reports").isNull();
            assertThat(sqlState(c, "INSERT INTO port_call_coverage (prt_ag_cd, covered_from, covered_to, refreshed_at, updated_at) "
                    + "VALUES ('020', '2026-08-30', '2026-09-29', now(), now())")).isNull();
            assertThat(sqlState(c, "UPDATE port_call_coverage SET covered_from = '2026-08-31', updated_at = now() WHERE prt_ag_cd = '020'")).isNull();
            assertThat(stage.sql("SELECT cardinality(hole_days) FROM port_call_coverage WHERE prt_ag_cd = '020'").query(Integer.class).single())
                    .as("no hole unless the collector says so").isZero();
            assertThat(sqlState(c, "UPDATE port_call_coverage SET hole_days = ARRAY['2026-09-10'::date], updated_at = now() WHERE prt_ag_cd = '020'"))
                    .as("a day fetched but not completely indexed").isNull();
            for (String sql : new String[]{"DELETE FROM port_call_coverage", "TRUNCATE port_call_coverage", "TRUNCATE port_call"})
                assertThat(sqlState(c, sql)).as(sql).isEqualTo("42501");
            for (String bad : new String[]{
                    // 정규화하지 않은 호출부호 · 형식 밖 코드 · 모르는 판 · 시각 없는 판 · 뒤집힌 범위 · 80자 넘는 글
                    row.replace("'V7A3884'", "'v7a3884'"), row.replace("'V7A3884'", "'V7-3884'"), row.replace("'020'", "'20'"),
                    row.replace("'005'", "'0 5'").replace("'V7A3884'", "'V7A3885'"),
                    row.replace("'최종'", "'변경'").replace("'V7A3884'", "'V7A3886'"),
                    row.replace("'2026-09-23T23:17:00Z'", "NULL").replace("'V7A3884'", "'V7A3887'"),
                    row.replace("'AZAMARA PURSUIT'", "'" + "A".repeat(81) + "'").replace("'V7A3884'", "'V7A3888'"),
                    "INSERT INTO port_call_coverage (prt_ag_cd, covered_from, covered_to, updated_at) VALUES ('030', '2026-09-29', '2026-09-28', now())",
                    "INSERT INTO port_call_coverage (prt_ag_cd, covered_from, covered_to, updated_at) VALUES ('ABC', '2026-09-28', '2026-09-29', now())",
                    "INSERT INTO port_call_coverage (prt_ag_cd, covered_from, covered_to, hole_days, updated_at) "
                            + "VALUES ('040', '2026-09-28', '2026-09-29', ARRAY[NULL]::date[], now())"})
                assertThat(sqlState(c, bad)).as(bad).isEqualTo("23514");
        }
        try (Connection c = DriverManager.getConnection(url, "wakeline_api", DbTestSupport.API_PW)) {
            assertThat(sqlState(c, "SELECT count(*) FROM port_call WHERE clsgn = 'V7A3884'")).isNull();
            assertThat(sqlState(c, "SELECT * FROM port_call_coverage")).isNull();
            for (String sql : new String[]{row.replace("'V7A3884'", "'API1'"), "UPDATE port_call SET berth = 'x'", "DELETE FROM port_call",
                    "UPDATE port_call_coverage SET refreshed_at = now()", "DELETE FROM port_call_coverage",
                    "INSERT INTO port_call_coverage (prt_ag_cd, covered_from, covered_to, updated_at) VALUES ('200', '2026-09-28', '2026-09-29', now())"})
                assertThat(sqlState(c, sql)).as(sql).isEqualTo("42501");
        }

        // 되돌리기(머리 주석): 두 표 삭제 + 이력 행 삭제 → V14 와 같은 스키마(파생 색인 — 수집기가 다시 채운다). 그 뒤 다시 앞으로
        runAsMigrator(url, rollbackSql("V15__port_call_index.sql"));
        assertThat(stage.sql("SELECT to_regclass('port_call') IS NULL AND to_regclass('port_call_coverage') IS NULL").query(Boolean.class).single()).isTrue();
        assertThat(stage.sql("SELECT count(*) FROM flyway_schema_history WHERE version = '15'").query(Long.class).single()).isZero();
        assertThat(stage.sql("SELECT to_regclass('marine_grid4') IS NOT NULL").query(Boolean.class).single()).as("V14 untouched").isTrue();
        migrateTo(url, "15");
        assertThat(stage.sql("SELECT has_table_privilege('wakeline_collector', 'port_call', 'DELETE')").query(Boolean.class).single()).isTrue();
        assertThat(stage.sql("SELECT has_table_privilege('wakeline_collector', 'port_call_coverage', 'DELETE')").query(Boolean.class).single()).isFalse();
        assertThat(stage.sql("SELECT has_table_privilege('wakeline_api', 'port_call', 'SELECT')").query(Boolean.class).single()).isTrue();
        assertThat(stage.sql("SELECT has_table_privilege('wakeline_api', 'port_call_coverage', 'UPDATE')").query(Boolean.class).single()).isFalse();
    }

    /**
     * V16(계약 v5 §G19 — 사용자 결정 2026-09-30 "UTC 지우고 KST"): 우리 일 집계(stats_daily · quality_rule_count)의 날짜 = KST 날짜.
     * 이전 행은 UTC 날짜로 센 것이라 KST 날짜로 이름만 바꾸지 않는다 — 보관 표(*_utc_legacy)로 옮기고(서비스 역할은 아무 권한 없음 — 읽는 코드 없음),
     * 새 표는 비어 있다(api 따라잡기가 원본이 남은 계열을 KST 날짜로 다시 센다). 권한은 이전 표와 같다(api 통계 DML · collector 규칙별 수 upsert ·
     * api 규칙별 수 읽기 · 보존 삭제). 머리 주석의 되돌리기 SQL 로 옛 표가 돌아오고(행 그대로), 다시 적용된다.
     */
    @Test
    void v16MovesUtcDayAggregatesAsideAndStartsKstDayTablesWithTheSameGrants() throws Exception {
        DbTestSupport.start();
        assertThat(latestMigrationVersion()).as("latest migration on the classpath").isGreaterThanOrEqualTo(16);
        String db = "wakeline_stage_sixteen";
        DbTestSupport.createDatabase(db);
        String url = DbTestSupport.jdbcUrl(db);
        migrateTo(url, "15");
        JdbcClient stage = JdbcClient.create(new DriverManagerDataSource(url, "postgres", DbTestSupport.ROOT_PW));
        stage.sql("INSERT INTO stats_daily (day, metric, dim, value) VALUES ('2026-09-28', 'sigmet_by_fir', 'RKRR', 3), ('2026-09-28', 'aggregated_at', 'sigmet', 1)").update();
        stage.sql("INSERT INTO quality_rule_count (day, rule, count) VALUES ('2026-09-28', 'seen_in_future', 7)").update();

        migrateTo(url, "16");
        assertThat(stage.sql("SELECT installed_by FROM flyway_schema_history WHERE version = '16' AND success").query(String.class).single())
                .isEqualTo("wakeline_migrator");
        // 옛 행은 보관 표에 그대로(날짜 값을 바꾸지 않는다), 새 표는 비어 있다
        assertThat(stage.sql("SELECT day || ' ' || metric || ' ' || dim || ' ' || value FROM stats_daily_utc_legacy ORDER BY metric").query(String.class).list())
                .containsExactly("2026-09-28 aggregated_at sigmet 1", "2026-09-28 sigmet_by_fir RKRR 3");
        assertThat(stage.sql("SELECT day || ' ' || rule || ' ' || count FROM quality_rule_count_utc_legacy").query(String.class).list())
                .containsExactly("2026-09-28 seen_in_future 7");
        assertThat(stage.sql("SELECT count(*) FROM stats_daily").query(Long.class).single()).isZero();
        assertThat(stage.sql("SELECT count(*) FROM quality_rule_count").query(Long.class).single()).isZero();
        for (String t : new String[]{"stats_daily", "quality_rule_count", "stats_daily_utc_legacy", "quality_rule_count_utc_legacy"})
            assertThat(stage.sql("SELECT pg_get_userbyid(relowner) FROM pg_class WHERE relname = :t").param("t", t).query(String.class).single())
                    .as(t).isEqualTo("wakeline_migrator");
        assertThat(stage.sql("SELECT obj_description('stats_daily'::regclass)").query(String.class).single()).contains("KST");
        assertThat(stage.sql("SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = 'stats_daily'::regclass AND contype = 'p'").query(String.class).single())
                .isEqualTo("PRIMARY KEY (day, metric, dim)");
        assertThat(stage.sql("SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = 'quality_rule_count'::regclass AND contype = 'p'").query(String.class).single())
                .isEqualTo("PRIMARY KEY (day, rule)");

        try (Connection c = DriverManager.getConnection(url, "wakeline_api", DbTestSupport.API_PW)) {
            for (String sql : new String[]{"INSERT INTO stats_daily (day, metric, dim, value) VALUES ('2026-09-29', 'sigmet_by_fir', 'RKRR', 1)",
                    "UPDATE stats_daily SET value = 2", "SELECT * FROM stats_daily", "DELETE FROM stats_daily", "SELECT * FROM quality_rule_count",
                    "DELETE FROM quality_rule_count WHERE day < '2026-01-01'"})
                assertThat(sqlState(c, sql)).as(sql).isNull();
            for (String sql : new String[]{"INSERT INTO quality_rule_count (day, rule, count) VALUES ('2026-09-29', 'r', 1)",
                    "SELECT * FROM stats_daily_utc_legacy", "DELETE FROM stats_daily_utc_legacy", "SELECT * FROM quality_rule_count_utc_legacy"})
                assertThat(sqlState(c, sql)).as(sql).isEqualTo("42501");
        }
        try (Connection c = DriverManager.getConnection(url, "wakeline_collector", DbTestSupport.COLLECTOR_PW)) {
            assertThat(sqlState(c, """
                    INSERT INTO quality_rule_count (day, rule, count) VALUES ('2026-09-29', 'seen_in_future', 1)
                    ON CONFLICT (day, rule) DO UPDATE SET count = quality_rule_count.count + EXCLUDED.count""")).isNull();
            for (String sql : new String[]{"DELETE FROM quality_rule_count", "SELECT * FROM stats_daily", "SELECT * FROM quality_rule_count_utc_legacy",
                    "INSERT INTO quality_rule_count_utc_legacy (day, rule, count) VALUES ('2026-09-29', 'r', 1)"})
                assertThat(sqlState(c, sql)).as(sql).isEqualTo("42501");
        }

        // 되돌리기(머리 주석): 새 표(KST 날짜 행)를 지우고 보관 표를 원래 이름 · 권한으로 → V15 와 같은 스키마 · 옛 행 그대로. 그 뒤 다시 앞으로
        runAsMigrator(url, rollbackSql("V16__kst_day_aggregates.sql"));
        assertThat(stage.sql("SELECT count(*) FROM flyway_schema_history WHERE version = '16'").query(Long.class).single()).isZero();
        assertThat(stage.sql("SELECT to_regclass('stats_daily_utc_legacy') IS NULL AND to_regclass('quality_rule_count_utc_legacy') IS NULL").query(Boolean.class).single()).isTrue();
        assertThat(stage.sql("SELECT value::int FROM stats_daily WHERE metric = 'sigmet_by_fir'").query(Integer.class).single()).isEqualTo(3);
        assertThat(stage.sql("SELECT count FROM quality_rule_count WHERE rule = 'seen_in_future'").query(Long.class).single()).isEqualTo(7L);
        assertThat(stage.sql("SELECT has_table_privilege('wakeline_api', 'stats_daily', 'INSERT') AND has_table_privilege('wakeline_collector', 'quality_rule_count', 'UPDATE')")
                .query(Boolean.class).single()).isTrue();
        migrateTo(url, "16");
        assertThat(stage.sql("SELECT count(*) FROM stats_daily_utc_legacy").query(Long.class).single()).isEqualTo(2L);
        assertThat(stage.sql("SELECT has_table_privilege('wakeline_api', 'stats_daily_utc_legacy', 'SELECT')").query(Boolean.class).single()).isFalse();
    }

    /**
     * V4·V5 는 운영과 같은 --migrate 경로(wakeline_migrator — 슈퍼유저·역할/DB 생성 권한 없음)로 적용됐고, 스키마의 모든 객체는 migrator 소유다
     * (서비스 역할 소유 객체 없음). V5 파티션 함수는 SECURITY DEFINER 인데 PUBLIC 실행 권한이 없다.
     */
    @Test
    void v4AndV5AreAppliedByTheUnprivilegedMigratorWhichOwnsEveryObject() {
        DbTestSupport.start();
        JdbcClient admin = DbTestSupport.admin();
        var rows = admin.sql("SELECT version, installed_by, success FROM flyway_schema_history WHERE version IN ('4', '5') ORDER BY installed_rank")
                .query().listOfRows();
        assertThat(rows).hasSize(2);
        for (var r : rows) {
            assertThat(r.get("installed_by")).as("V" + r.get("version")).isEqualTo("wakeline_migrator");
            assertThat(r.get("success")).isEqualTo(true);
        }
        assertThat(admin.sql("SELECT rolsuper OR rolcreaterole OR rolcreatedb OR rolbypassrls OR rolreplication FROM pg_roles WHERE rolname = 'wakeline_migrator'")
                .query(Boolean.class).single()).as("migrator has no cluster-level privileges").isFalse();

        var owners = admin.sql("""
                SELECT c.relname, pg_get_userbyid(c.relowner) AS owner FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE n.nspname = 'public' AND (c.relname IN ('ship', 'ship_pkey', 'ship_position', 'ship_position_pkey', 'ship_position_ts_brin',
                      'ingest_gap', 'ingest_gap_pkey', 'ingest_gap_id_seq', 'ingest_gap_source_scope_started_uq') OR c.relname ~ '^ship_position_[0-9]{8}$')""")
                .query().listOfRows();
        assertThat(owners.size()).as("V5 objects (V8 unique index) incl. partitions").isGreaterThanOrEqualTo(9 + 5);
        for (var r : owners) assertThat(r.get("owner")).as(String.valueOf(r.get("relname"))).isEqualTo("wakeline_migrator");
        assertThat(admin.sql("""
                SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE n.nspname = 'public' AND pg_get_userbyid(c.relowner) IN ('wakeline_api', 'wakeline_collector')""").query(Long.class).single())
                .as("no relation owned by a service role").isZero();
        assertThat(admin.sql("""
                SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                WHERE n.nspname = 'public' AND pg_get_userbyid(p.proowner) IN ('wakeline_api', 'wakeline_collector')""").query(Long.class).single())
                .as("no function owned by a service role").isZero();
        for (String fn : new String[]{"ship_position_ensure_partitions", "ship_position_drop_old", "track_point_ensure_partitions", "track_point_drop_old"}) {
            assertThat(admin.sql("SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE proname = :f").param("f", fn).query(String.class).single())
                    .as(fn + " owner").isEqualTo("wakeline_migrator");
            // proacl 이 NULL 이면 기본값(PUBLIC 에 EXECUTE)이다 — 명시적 ACL 이 있어야 아래 검사가 의미 있다
            assertThat(admin.sql("SELECT proacl IS NOT NULL FROM pg_proc WHERE proname = :f").param("f", fn).query(Boolean.class).single())
                    .as(fn + " has an explicit ACL").isTrue();
            assertThat(admin.sql("SELECT count(*) FROM pg_proc p, aclexplode(p.proacl) a WHERE p.proname = :f AND a.grantee = 0 AND a.privilege_type = 'EXECUTE'")
                    .param("f", fn).query(Long.class).single()).as(fn + " not executable by PUBLIC").isZero();
        }
    }

    @Test
    void apiRoleIsDmlOnlyButMayRunRetention() throws SQLException {
        DbTestSupport.start();
        try (Connection c = DriverManager.getConnection(DbTestSupport.jdbcUrl("wakeline"), "wakeline_api", DbTestSupport.API_PW)) {
            assertThat(sqlState(c, "DELETE FROM audit_log")).isEqualTo("42501");
            assertThat(sqlState(c, "UPDATE audit_log SET action = 'x'")).isEqualTo("42501");
            assertThat(sqlState(c, "CREATE TABLE evil (id int)")).isEqualTo("42501");
            assertThat(sqlState(c, "ALTER TABLE alert_event DISABLE TRIGGER ALL")).isEqualTo("42501");
            for (String t : new String[]{"metar_obs", "radar_frame", "ingest_run", "quality_event", "quality_rule_count"})
                assertThat(sqlState(c, "DELETE FROM " + t + " WHERE false")).as(t).isNull();
        }
        assertThatThrownBy(() -> DriverManager.getConnection(DbTestSupport.jdbcUrl("wakeline"), "wakeline_api", "wrong").close())
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
