package dev.wakeline;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIf;

import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.time.LocalDate;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 역할 권한(6.4절 최소 권한) — 실제 infra/db/init/01-roles.sh 로 만든 클러스터(wakeline DB) + V1~V3 마이그레이션 위에서:
 * <ul>
 *   <li>wakeline_api: DML 전용 — DROP·ALTER·CREATE·TRUNCATE·권한 변경 불가, audit_log 는 INSERT·SELECT 만(UPDATE·DELETE 불가).</li>
 *   <li>wakeline_collector: 수집 테이블만 — 도메인 테이블(항적·알림·SIGMET·설정·운영자·감사) 쓰기 불가, 운영자 해시·감사 로그 읽기 불가.</li>
 *   <li>파티션 함수: SECURITY DEFINER 라 wakeline_api 가 불러도 파티션이 만들어지고/지워진다(VERIFICATION #16), 범위를 벗어난 인자는 거절,
 *       search_path 고정, PUBLIC·collector 는 실행 불가.</li>
 * </ul>
 */
@EnabledIf("dev.wakeline.DbTestSupport#dockerAvailable")
class RolePrivilegesDbTest {
    static final String INSUFFICIENT_PRIVILEGE = "42501";
    static final String RAISED = "P0001";

    static Connection as(String user, String pw) throws SQLException {
        DbTestSupport.start();
        return DriverManager.getConnection(DbTestSupport.jdbcUrl("wakeline"), user, pw);
    }

    static Connection api() throws SQLException { return as("wakeline_api", DbTestSupport.API_PW); }
    static Connection collector() throws SQLException { return as("wakeline_collector", DbTestSupport.COLLECTOR_PW); }
    static Connection migrator() throws SQLException { return as("wakeline_migrator", DbTestSupport.MIGRATOR_PW); }

    /** 실행하고 실패하면 SQLState, 성공하면 null. 각 문장은 자기 트랜잭션(autocommit)이다. */
    static String state(Connection c, String sql) {
        try (Statement s = c.createStatement()) {
            s.execute(sql);
            return null;
        } catch (SQLException e) {
            return e.getSQLState();
        }
    }

    static Object scalar(Connection c, String sql) throws SQLException {
        try (Statement s = c.createStatement(); ResultSet rs = s.executeQuery(sql)) {
            rs.next();
            return rs.getObject(1);
        }
    }

    static String partition(int daysFromToday) {
        return "track_point_" + LocalDate.now(ZoneOffset.UTC).plusDays(daysFromToday).format(DateTimeFormatter.BASIC_ISO_DATE);
    }

    @Test
    void apiRoleCannotChangeSchemaOrRewriteTheAuditLog() throws SQLException {
        try (Connection c = api()) {
            for (String ddl : new String[]{
                    "DROP TABLE alert_event",
                    "DROP TABLE " + partition(0),
                    "ALTER TABLE alert_event ADD COLUMN evil int",
                    "ALTER TABLE audit_log DISABLE TRIGGER ALL",
                    "CREATE TABLE evil (id int)",
                    "CREATE SCHEMA evil",
                    "CREATE FUNCTION evil() RETURNS int LANGUAGE sql AS 'SELECT 1'",
                    "CREATE INDEX evil ON alert_event (hex)",
                    "TRUNCATE audit_log",
                    "TRUNCATE alert_event",
                    "ALTER FUNCTION track_point_drop_old(int) SECURITY INVOKER",
                    "UPDATE audit_log SET action = 'forged'",
                    "DELETE FROM audit_log",
                    "DELETE FROM ops_user",                       // 운영자 계정은 SELECT·INSERT·UPDATE 만
                    "DELETE FROM provider_switch",                // 공급자 스위치(V11)도 SELECT·INSERT·UPDATE 만
                    "DELETE FROM ops_resolution",                 // 해결 표시(V13)는 지우지 않는다 — 되돌림은 revoked_at 을 채운다
                    "UPDATE ops_resolution SET upto = now()",     // 이미 적은 해결 범위는 고치지 못한다(되돌림 두 열만)
                    "INSERT INTO airport (icao, geom) VALUES ('ZZZZ', ST_SetSRID(ST_MakePoint(0, 0), 4326))", // 수집기 테이블은 읽기(+보존 삭제)만
            }) {
                assertThat(state(c, ddl)).as(ddl).isEqualTo(INSUFFICIENT_PRIVILEGE);
            }
            assertThat(state(c, "ALTER ROLE wakeline_api CREATEDB")).as("ALTER ROLE").isEqualTo(INSUFFICIENT_PRIVILEGE);
            // GRANT 는 grant option 이 없으면 오류 대신 경고만 내고 아무것도 주지 않는다(PostgreSQL 규칙) — 결과로 확인한다
            state(c, "GRANT SELECT ON ops_user TO wakeline_collector");
            state(c, "GRANT INSERT ON alert_event TO wakeline_collector");
            assertThat(scalar(c, "SELECT has_table_privilege('wakeline_collector', 'ops_user', 'SELECT')")).isEqualTo(false);
            assertThat(scalar(c, "SELECT has_table_privilege('wakeline_collector', 'alert_event', 'INSERT')")).isEqualTo(false);
            // 대조군: 감사 기록 추가·조회, 도메인 DML, 보존 삭제는 된다
            assertThat(state(c, "INSERT INTO audit_log (action, target) VALUES ('ROLE_TEST', 'x')")).isNull();
            assertThat(state(c, "SELECT count(*) FROM audit_log")).isNull();
            assertThat(state(c, "UPDATE alert_event SET left_at = left_at WHERE false")).isNull();
            assertThat(state(c, "DELETE FROM metar_obs WHERE false")).isNull();
        }
    }

    @Test
    void collectorRoleCannotWriteDomainTablesOrReadSecrets() throws SQLException {
        try (Connection c = collector()) {
            for (String sql : new String[]{
                    "INSERT INTO alert_event (id, hex, sigmet_id, kind, entered_at, evidence) VALUES (1, 'abcdef', 'S', 'OBSERVED', now(), '{}')",
                    "UPDATE alert_event SET left_at = now()",
                    "DELETE FROM alert_event",
                    "INSERT INTO aircraft (hex, first_seen, last_seen) VALUES ('abcdef', now(), now())",
                    "INSERT INTO track_point (hex, ts, geom, provider, fetched_at) VALUES ('abcdef', now(), ST_SetSRID(ST_MakePoint(127, 37), 4326), 'x', now())",
                    "DELETE FROM track_point_1m",
                    "UPDATE sigmet SET hazard = 'X'",
                    "UPDATE app_setting SET value = '1'",
                    "SELECT * FROM provider_switch",              // 공급자 스위치의 원본(V11) — 수집기는 Redis 미러만 읽는다
                    "UPDATE provider_switch SET disabled = false",
                    "SELECT * FROM ops_resolution",               // 해결 표시(V13)는 api 만
                    "DELETE FROM stats_daily",
                    "INSERT INTO audit_log (action) VALUES ('forged')",
                    "SELECT password_hash FROM ops_user",
                    "SELECT * FROM audit_log",
                    "SELECT track_point_ensure_partitions(3)",
                    "SELECT track_point_drop_old(72)",
                    "DELETE FROM metar_obs",                      // 수집 테이블도 삭제는 없다(보존 정리는 api 의 일)
                    "CREATE TABLE evil (id int)",
            }) {
                assertThat(state(c, sql)).as(sql).isEqualTo(INSUFFICIENT_PRIVILEGE);
            }
            // 대조군: 수집 테이블 쓰기는 된다
            assertThat(state(c, "INSERT INTO ingest_run (job, provider, started_at, status) VALUES ('role_test', 'x', now(), 'ok')")).isNull();
            // V12(R-91): 실행 키로 한 번만 — ON CONFLICT (run_key) DO NOTHING 은 INSERT 권한만으로, run id 되찾기는 SELECT 로(새 열도 표 권한을 따른다)
            String key = java.util.UUID.randomUUID().toString();
            String once = "INSERT INTO ingest_run (run_key, job, provider, started_at, status) VALUES ('" + key + "', 'role_test', 'x', now(), 'ok') "
                    + "ON CONFLICT (run_key) DO NOTHING";
            assertThat(state(c, once)).isNull();
            assertThat(state(c, once)).as("retry of the same run").isNull();
            assertThat(scalar(c, "SELECT count(*) FROM ingest_run WHERE run_key = '" + key + "'")).isEqualTo(1L);
            assertThat(state(c, "UPDATE metar_obs SET raw = raw WHERE false")).isNull();
        }
    }

    @Test
    void partitionFunctionsRunAsOwnerForTheApiRoleAndRejectOutOfRangeArguments() throws SQLException {
        String future = partition(3);
        String old = partition(-10);
        try (Connection m = migrator()) {
            // 준비: 3일 뒤 파티션을 지워 두고(함수가 만들 것), 10일 전 파티션을 만든다(보존 72 h 밖 — 함수가 지울 것)
            assertThat(state(m, "DROP TABLE IF EXISTS " + future)).isNull();
            LocalDate d = LocalDate.now(ZoneOffset.UTC).minusDays(10);
            assertThat(state(m, "CREATE TABLE IF NOT EXISTS " + old + " PARTITION OF track_point FOR VALUES FROM ('" + d + "') TO ('" + d.plusDays(1) + "')")).isNull();
        }
        try (Connection c = api()) {
            assertThat(((Number) scalar(c, "SELECT track_point_ensure_partitions(3)")).intValue()).isGreaterThanOrEqualTo(1);
            assertThat(scalar(c, "SELECT pg_get_userbyid(relowner) FROM pg_class WHERE relname = '" + future + "'")).isEqualTo("wakeline_migrator");
            // 부모를 거친 쓰기는 된다 — 항적 쓰기가 자정 이후에도 이어진다(파티션 권한은 검사하지 않는다)
            assertThat(state(c, "INSERT INTO track_point (hex, ts, geom, provider, fetched_at) VALUES ('abc123', now() + interval '3 days', "
                    + "ST_SetSRID(ST_MakePoint(127, 37), 4326), 'fixture', now()) ON CONFLICT DO NOTHING")).isNull();
            // R-88: 새 파티션에 api 의 직접 권한은 없다(선박 파티션과 같다) — 파티션을 직접 고치거나 지우지 못한다
            for (String priv : new String[]{"SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"})
                assertThat(scalar(c, "SELECT has_table_privilege('wakeline_api', '" + future + "', '" + priv + "')")).as(future + " " + priv).isEqualTo(false);
            assertThat(state(c, "DELETE FROM " + future)).isEqualTo(INSUFFICIENT_PRIVILEGE);
            // 테이블 자체도 못 지운다(함수를 거쳐야 한다)
            assertThat(state(c, "DROP TABLE " + future)).isEqualTo(INSUFFICIENT_PRIVILEGE);

            assertThat(((Number) scalar(c, "SELECT track_point_drop_old(72)")).intValue()).isGreaterThanOrEqualTo(1);
            assertThat(scalar(c, "SELECT count(*) FROM pg_class WHERE relname = '" + old + "'")).isEqualTo(0L);
            assertThat(scalar(c, "SELECT count(*) FROM pg_class WHERE relname = '" + partition(0) + "'")).as("today's partition kept").isEqualTo(1L);

            // 인자 상한(DoS·이력 삭제 방지): 함수가 예외를 올린다
            for (String bad : new String[]{"SELECT track_point_ensure_partitions(0)", "SELECT track_point_ensure_partitions(15)",
                    "SELECT track_point_ensure_partitions(-1)", "SELECT track_point_drop_old(23)", "SELECT track_point_drop_old(0)",
                    "SELECT track_point_drop_old(721)"}) {
                assertThat(state(c, bad)).as(bad).isEqualTo(RAISED);
            }
        }
        try (Connection m = migrator()) {
            for (String fn : new String[]{"track_point_ensure_partitions", "track_point_drop_old"}) {
                assertThat(scalar(m, "SELECT prosecdef FROM pg_proc WHERE proname = '" + fn + "'")).as(fn + " SECURITY DEFINER").isEqualTo(true);
                assertThat(String.valueOf(scalar(m, "SELECT array_to_string(proconfig, ',') FROM pg_proc WHERE proname = '" + fn + "'")))
                        .as(fn + " search_path pinned").contains("search_path=public, pg_temp");
                assertThat(scalar(m, "SELECT has_function_privilege('wakeline_collector', '" + fn + "(int)', 'EXECUTE')")).isEqualTo(false);
                assertThat(scalar(m, "SELECT has_function_privilege('wakeline_api', '" + fn + "(int)', 'EXECUTE')")).isEqualTo(true);
            }
            // PUBLIC 은 스키마에 아무것도 만들 수 없다(01-roles.sh: REVOKE ALL ON SCHEMA public FROM PUBLIC)
            assertThat(scalar(m, "SELECT has_schema_privilege('wakeline_api', 'public', 'CREATE')")).isEqualTo(false);
            assertThat(scalar(m, "SELECT has_schema_privilege('wakeline_collector', 'public', 'CREATE')")).isEqualTo(false);
        }
    }

    /**
     * 선박 표(V5) 최소 권한: ship 은 upsert(INSERT·UPDATE)·조회만, ship_position 은 부모로 INSERT·SELECT 만(파티션 직접 접근·삭제 불가 —
     * 보존은 함수로만), ingest_gap 은 영구 이력(INSERT·SELECT 만). 수집기 역할(DB 를 쓰지 않는 ais 는 DB 계정 자체가 없다)은 아무것도 못 한다.
     */
    @Test
    void shipTablesAreLeastPrivilege() throws SQLException {
        String part = "ship_position_" + LocalDate.now(ZoneOffset.UTC).format(DateTimeFormatter.BASIC_ISO_DATE);
        try (Connection c = api()) {
            assertThat(state(c, "INSERT INTO ship_position (mmsi, ts, geom, position_source, provider) VALUES ('440000777', now(), "
                    + "ST_SetSRID(ST_MakePoint(129, 35), 4326), 'epfs', 'role_test') ON CONFLICT DO NOTHING")).isNull();
            assertThat(state(c, "SELECT count(*) FROM ship_position")).isNull();
            assertThat(state(c, "INSERT INTO ship (mmsi, first_seen, last_seen, provider) VALUES ('440000777', now(), now(), 'role_test') "
                    + "ON CONFLICT (mmsi) DO UPDATE SET last_seen = EXCLUDED.last_seen")).isNull();
            assertThat(state(c, "INSERT INTO ingest_gap (source, started_at, ended_at, reason, provider) VALUES ('role_test', now(), now() + interval '1 minute', 'r', 'x') "
                    + "ON CONFLICT DO NOTHING")).isNull();
            for (String sql : new String[]{
                    "DELETE FROM ship_position",
                    "UPDATE ship_position SET provider = 'x'",
                    "DELETE FROM " + part,
                    "SELECT count(*) FROM " + part,
                    "DROP TABLE " + part,
                    "DELETE FROM ship",
                    "UPDATE ingest_gap SET reason = 'forged'",
                    "DELETE FROM ingest_gap",
                    "TRUNCATE ingest_gap",
                    "ALTER FUNCTION ship_position_drop_old(int) SECURITY INVOKER",
            }) {
                assertThat(state(c, sql)).as(sql).isEqualTo(INSUFFICIENT_PRIVILEGE);
            }
            assertThat(((Number) scalar(c, "SELECT ship_position_ensure_partitions(3)")).intValue()).isGreaterThanOrEqualTo(0);
            assertThat(((Number) scalar(c, "SELECT ship_position_drop_old(72)")).intValue()).isGreaterThanOrEqualTo(0);
            for (String bad : new String[]{"SELECT ship_position_ensure_partitions(15)", "SELECT ship_position_drop_old(23)"})
                assertThat(state(c, bad)).as(bad).isEqualTo(RAISED);
        }
        try (Connection c = collector()) {
            for (String sql : new String[]{
                    "SELECT count(*) FROM ship", "INSERT INTO ship_position (mmsi, ts, geom, position_source, provider) VALUES ('440000778', now(), "
                    + "ST_SetSRID(ST_MakePoint(129, 35), 4326), 'epfs', 'x')", "SELECT count(*) FROM ingest_gap", "SELECT ship_position_ensure_partitions(3)"}) {
                assertThat(state(c, sql)).as(sql).isEqualTo(INSUFFICIENT_PRIVILEGE);
            }
        }
        try (Connection m = migrator()) {
            for (String fn : new String[]{"ship_position_ensure_partitions", "ship_position_drop_old"}) {
                assertThat(scalar(m, "SELECT prosecdef FROM pg_proc WHERE proname = '" + fn + "'")).as(fn).isEqualTo(true);
                assertThat(String.valueOf(scalar(m, "SELECT array_to_string(proconfig, ',') FROM pg_proc WHERE proname = '" + fn + "'")))
                        .contains("search_path=public, pg_temp");
            }
            state(m, "DELETE FROM ship WHERE provider = 'role_test'");
            state(m, "DELETE FROM ingest_gap WHERE source = 'role_test'");
            state(m, "DELETE FROM ship_position WHERE provider = 'role_test'");
        }
    }

    static String shipPartition(int daysFromToday) {
        return "ship_position_" + LocalDate.now(ZoneOffset.UTC).plusDays(daysFromToday).format(DateTimeFormatter.BASIC_ISO_DATE);
    }

    /**
     * 선박 파티션 함수(V5)를 api 역할로: 소유자(wakeline_migrator) 권한으로 만들고/지운다(SECURITY DEFINER). 함수가 만든 새 파티션에는 api 의
     * 직접 권한이 하나도 없다(기본 권한이 준 DML 을 함수가 회수) — 부모 표를 거친 INSERT 만 된다. 인자 상한 밖은 모두 예외(DoS·이력 삭제 방지).
     */
    @Test
    void shipPartitionFunctionsRunAsOwnerForTheApiRole_newPartitionsGrantTheApiNothing_andArgumentsAreBounded() throws SQLException {
        String future = shipPartition(3);
        String old = shipPartition(-10);
        try (Connection m = migrator()) {
            assertThat(state(m, "DROP TABLE IF EXISTS " + future)).isNull();
            LocalDate d = LocalDate.now(ZoneOffset.UTC).minusDays(10);
            assertThat(state(m, "CREATE TABLE IF NOT EXISTS " + old + " PARTITION OF ship_position FOR VALUES FROM ('" + d + "') TO ('" + d.plusDays(1) + "')")).isNull();
        }
        try (Connection c = api()) {
            assertThat(((Number) scalar(c, "SELECT ship_position_ensure_partitions(3)")).intValue()).isGreaterThanOrEqualTo(1);
            assertThat(scalar(c, "SELECT pg_get_userbyid(relowner) FROM pg_class WHERE relname = '" + future + "'")).isEqualTo("wakeline_migrator");
            for (String priv : new String[]{"SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"})
                assertThat(scalar(c, "SELECT has_table_privilege('wakeline_api', '" + future + "', '" + priv + "')")).as(future + " " + priv).isEqualTo(false);
            // 부모를 거친 쓰기는 된다(자정 뒤에도 위치 저장이 이어진다) — 파티션을 직접 고치거나 지우지는 못한다
            assertThat(state(c, "INSERT INTO ship_position (mmsi, ts, geom, position_source, provider) VALUES ('440000779', now() + interval '3 days', "
                    + "ST_SetSRID(ST_MakePoint(129, 35), 4326), 'epfs', 'role_test') ON CONFLICT DO NOTHING")).isNull();
            assertThat(state(c, "DELETE FROM " + future)).isEqualTo(INSUFFICIENT_PRIVILEGE);
            assertThat(state(c, "DROP TABLE " + future)).isEqualTo(INSUFFICIENT_PRIVILEGE);

            assertThat(((Number) scalar(c, "SELECT ship_position_drop_old(72)")).intValue()).isGreaterThanOrEqualTo(1);
            assertThat(scalar(c, "SELECT count(*) FROM pg_class WHERE relname = '" + old + "'")).isEqualTo(0L);
            assertThat(scalar(c, "SELECT count(*) FROM pg_class WHERE relname = '" + shipPartition(0) + "'")).as("today's partition kept").isEqualTo(1L);
            assertThat(scalar(c, "SELECT count(*) FROM pg_class WHERE relname = '" + shipPartition(-1) + "'")).as("yesterday's partition kept").isEqualTo(1L);

            for (String bad : new String[]{"SELECT ship_position_ensure_partitions(0)", "SELECT ship_position_ensure_partitions(-1)",
                    "SELECT ship_position_ensure_partitions(15)", "SELECT ship_position_drop_old(23)", "SELECT ship_position_drop_old(0)",
                    "SELECT ship_position_drop_old(-72)", "SELECT ship_position_drop_old(721)"}) {
                assertThat(state(c, bad)).as(bad).isEqualTo(RAISED);
            }
        }
        try (Connection m = migrator()) {
            for (String fn : new String[]{"ship_position_ensure_partitions", "ship_position_drop_old"})
                assertThat(scalar(m, "SELECT has_function_privilege('wakeline_collector', '" + fn + "(int)', 'EXECUTE')")).as(fn).isEqualTo(false);
            state(m, "DELETE FROM ship_position WHERE provider = 'role_test'");
        }
    }

    /** V5 표·시퀀스·함수는 api 가 구조를 바꿀 수 없다(DDL·소유권·시퀀스 조작·권한 전달 모두 불가). */
    @Test
    void apiRoleCannotChangeTheShipSchema() throws SQLException {
        try (Connection c = api()) {
            for (String ddl : new String[]{
                    "ALTER TABLE ship ADD COLUMN evil int",
                    "ALTER TABLE ship DISABLE TRIGGER ALL",
                    "ALTER TABLE ship OWNER TO wakeline_api",
                    "COMMENT ON TABLE ship IS 'x'",
                    "TRUNCATE ship",
                    "TRUNCATE ship_position",
                    "CREATE INDEX evil ON ship_position (provider)",
                    "ALTER TABLE ship_position DETACH PARTITION " + shipPartition(0),
                    "CREATE TABLE ship_position_29991231 PARTITION OF ship_position FOR VALUES FROM ('2999-12-31') TO ('3000-01-01')",
                    "ALTER TABLE ingest_gap DROP CONSTRAINT ingest_gap_order",
                    "DROP TABLE ingest_gap",
                    "ALTER SEQUENCE ingest_gap_id_seq RESTART",
                    "SELECT setval('ingest_gap_id_seq', 1)",
                    "CREATE OR REPLACE FUNCTION ship_position_drop_old(retention_hours int) RETURNS int LANGUAGE sql AS 'SELECT 0'",
                    "DROP FUNCTION ship_position_drop_old(int)",
                    "ALTER FUNCTION ship_position_ensure_partitions(int) OWNER TO wakeline_api",
            }) {
                assertThat(state(c, ddl)).as(ddl).isEqualTo(INSUFFICIENT_PRIVILEGE);
            }
            // GRANT 는 grant option 이 없으면 경고만 — 결과로 확인
            state(c, "GRANT SELECT ON ship TO wakeline_collector");
            state(c, "GRANT INSERT ON ingest_gap TO wakeline_collector");
            assertThat(scalar(c, "SELECT has_table_privilege('wakeline_collector', 'ship', 'SELECT')")).isEqualTo(false);
            assertThat(scalar(c, "SELECT has_table_privilege('wakeline_collector', 'ingest_gap', 'INSERT')")).isEqualTo(false);
            // 대조군: 공백 기록에 필요한 시퀀스 사용은 된다
            assertThat(state(c, "SELECT nextval('ingest_gap_id_seq')")).isNull();
        }
    }

    /**
     * R-88: 기본 권한(ALTER DEFAULT PRIVILEGES)이 migrator 가 만드는 새 표마다 api 에 DML 전체를 열었다(fail-open — 마이그레이션이 REVOKE 를
     * 잊으면 INSERT 전용이어야 할 표도 고치고 지울 수 있었다). 기본 권한은 없고, api 권한은 표마다 명시한 것뿐이다(아래 스냅샷 — 바꾸면 여기도).
     * 기존 track_point 파티션에도 직접 권한이 없다(부모를 거쳐서만 쓴다).
     */
    @Test
    void apiPrivilegesAreExplicitPerTableWithNoDefaultGrants() throws SQLException {
        try (Connection m = migrator()) {
            assertThat(scalar(m, """
                    SELECT count(*) FROM pg_default_acl d, aclexplode(d.defaclacl) a
                    WHERE a.grantee = 'wakeline_api'::regrole""")).as("no default privilege grants anything to the api role").isEqualTo(0L);
            // 모든 표(파티션 제외)의 api 권한 스냅샷
            java.util.Map<String, String> actual = new java.util.TreeMap<>();
            try (Statement s = m.createStatement(); ResultSet rs = s.executeQuery("""
                    SELECT c.relname,
                           concat_ws(',', CASE WHEN has_table_privilege('wakeline_api', c.oid, 'SELECT') THEN 'SELECT' END,
                                          CASE WHEN has_table_privilege('wakeline_api', c.oid, 'INSERT') THEN 'INSERT' END,
                                          CASE WHEN has_table_privilege('wakeline_api', c.oid, 'UPDATE') THEN 'UPDATE' END,
                                          CASE WHEN has_table_privilege('wakeline_api', c.oid, 'DELETE') THEN 'DELETE' END,
                                          CASE WHEN has_table_privilege('wakeline_api', c.oid, 'TRUNCATE') THEN 'TRUNCATE' END) privs
                    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relispartition
                      AND c.relname NOT IN ('spatial_ref_sys', 'flyway_schema_history')""")) {
                while (rs.next()) actual.put(rs.getString(1), rs.getString(2));
            }
            java.util.Map<String, String> expected = new java.util.TreeMap<>(java.util.Map.ofEntries(
                    java.util.Map.entry("aircraft", "SELECT,INSERT,UPDATE,DELETE"),
                    java.util.Map.entry("track_point", "SELECT,INSERT,UPDATE,DELETE"),
                    java.util.Map.entry("track_point_1m", "SELECT,INSERT,UPDATE,DELETE"),
                    java.util.Map.entry("sigmet", "SELECT,INSERT,UPDATE,DELETE"),
                    java.util.Map.entry("alert_event", "SELECT,INSERT,UPDATE,DELETE"),
                    java.util.Map.entry("app_setting", "SELECT,INSERT,UPDATE,DELETE"),
                    java.util.Map.entry("stats_daily", "SELECT,INSERT,UPDATE,DELETE"),
                    java.util.Map.entry("airport", "SELECT"),
                    java.util.Map.entry("metar_obs", "SELECT,DELETE"),
                    java.util.Map.entry("radar_frame", "SELECT,DELETE"),
                    java.util.Map.entry("ingest_run", "SELECT,DELETE"),
                    java.util.Map.entry("quality_event", "SELECT,DELETE"),
                    java.util.Map.entry("quality_rule_count", "SELECT,DELETE"),
                    java.util.Map.entry("provider_budget_day", "SELECT"),
                    java.util.Map.entry("ops_user", "SELECT,INSERT,UPDATE"),
                    java.util.Map.entry("audit_log", "SELECT,INSERT"),
                    java.util.Map.entry("ship", "SELECT,INSERT,UPDATE"),
                    java.util.Map.entry("ship_position", "SELECT,INSERT"),
                    java.util.Map.entry("ingest_gap", "SELECT,INSERT"),
                    java.util.Map.entry("provider_switch", "SELECT,INSERT,UPDATE"),
                    // V13: 해결 표시 — 표 단위 UPDATE 는 없고 되돌림 두 열만(아래), 지우지 않는다
                    java.util.Map.entry("ops_resolution", "SELECT,INSERT")));
            assertThat(actual).isEqualTo(expected);
            // 열 단위 UPDATE 스냅샷(표 단위 권한이 없는 표만): api 가 고칠 수 있는 열은 이것뿐이다
            java.util.Map<String, String> columns = new java.util.TreeMap<>();
            try (Statement s = m.createStatement(); ResultSet rs = s.executeQuery("""
                    SELECT a.table_name, string_agg(a.column_name, ',' ORDER BY a.column_name) FROM information_schema.column_privileges a
                    WHERE a.grantee = 'wakeline_api' AND a.privilege_type = 'UPDATE' AND a.table_schema = 'public'
                      AND NOT has_table_privilege('wakeline_api', (quote_ident(a.table_schema) || '.' || quote_ident(a.table_name))::regclass, 'UPDATE')
                    GROUP BY a.table_name""")) {
                while (rs.next()) columns.put(rs.getString(1), rs.getString(2));
            }
            assertThat(columns).isEqualTo(java.util.Map.of("ops_resolution", "revoked_at,revoked_by"));
            // 기존 track_point 파티션(V9 전 기본 권한으로 직접 권한을 받았던 것 포함)도 api 직접 권한 없음
            assertThat(scalar(m, """
                    SELECT count(*) FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid JOIN pg_class p ON p.oid = i.inhparent
                    WHERE p.relname IN ('track_point', 'ship_position')
                      AND (has_table_privilege('wakeline_api', c.oid, 'SELECT') OR has_table_privilege('wakeline_api', c.oid, 'INSERT')
                           OR has_table_privilege('wakeline_api', c.oid, 'UPDATE') OR has_table_privilege('wakeline_api', c.oid, 'DELETE'))""")).isEqualTo(0L);
        }
    }

    @Test
    void testDatabasesAreInitialisedFromTheRealRolesScript() {
        // 두 번째 블록(확장·권한·시간대)을 스크립트에서 읽는다 — 형식이 바뀌면 여기서 먼저 깨진다
        var blocks = DbTestSupport.rolesScriptBlocks();
        assertThat(blocks.get(0)).contains("CREATE ROLE wakeline_api").contains("CREATE DATABASE wakeline OWNER wakeline_migrator");
        assertThat(blocks.get(1)).contains("REVOKE ALL ON SCHEMA public FROM PUBLIC");
        for (String db : new String[]{"wakeline", "wakeline_stage"}) {
            String conf = DbTestSupport.admin().sql("""
                    SELECT array_to_string(s.setconfig, ',') FROM pg_db_role_setting s JOIN pg_database d ON d.oid = s.setdatabase
                    WHERE d.datname = :db AND s.setrole = 0""").param("db", db).query(String.class).single();
            assertThat(conf).as(db + " database settings").contains("TimeZone=UTC");
            assertThat(DbTestSupport.admin().sql("SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname = :db").param("db", db)
                    .query(String.class).single()).isEqualTo("wakeline_migrator");
        }
    }
}
