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
    void migrateIsIdempotentAndNeedsOnlyTheMigratorPassword() {
        DbTestSupport.start();
        assertThat(WakelineApplication.migrate(DbTestSupport.env("wakeline"))).isZero(); // 이미 적용됨 → 0건, 성공
        Map<String, String> noPw = new HashMap<>(DbTestSupport.env("wakeline"));
        noPw.remove("DB_MIGRATOR_PASSWORD");
        assertThat(WakelineApplication.migrate(noPw)).isEqualTo(2);
        assertThat(DbTestSupport.admin().sql("SELECT max(version::int) FROM flyway_schema_history WHERE success").query(Integer.class).single()).isEqualTo(7);
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
        assertThat(stage.sql("SELECT value FROM stats_daily WHERE day = :d AND metric = 'alert_dwell_avg_s'").param("d", day)
                .query(java.math.BigDecimal.class).single().doubleValue()).isEqualTo(600.0);
        assertThat(stage.sql("SELECT count(*) FROM stats_daily WHERE day = :d").param("d", notAggregated).query(Long.class).single()).isZero();
        assertThat(stage.sql("SELECT value FROM stats_daily WHERE day = :d AND metric = 'alerts_by_kind'").param("d", day)
                .query(java.math.BigDecimal.class).single().intValue()).isEqualTo(4);
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
                      'ingest_gap', 'ingest_gap_pkey', 'ingest_gap_id_seq', 'ingest_gap_source_started') OR c.relname ~ '^ship_position_[0-9]{8}$')""")
                .query().listOfRows();
        assertThat(owners.size()).as("V5 objects incl. partitions").isGreaterThanOrEqualTo(9 + 5);
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
