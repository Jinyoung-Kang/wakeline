package dev.skywx;

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
 * 역할 권한(6.4절 최소 권한) — 실제 infra/db/init/01-roles.sh 로 만든 클러스터(skywx DB) + V1~V3 마이그레이션 위에서:
 * <ul>
 *   <li>skywx_api: DML 전용 — DROP·ALTER·CREATE·TRUNCATE·권한 변경 불가, audit_log 는 INSERT·SELECT 만(UPDATE·DELETE 불가).</li>
 *   <li>skywx_collector: 수집 테이블만 — 도메인 테이블(항적·알림·SIGMET·설정·운영자·감사) 쓰기 불가, 운영자 해시·감사 로그 읽기 불가.</li>
 *   <li>파티션 함수: SECURITY DEFINER 라 skywx_api 가 불러도 파티션이 만들어지고/지워진다(VERIFICATION #16), 범위를 벗어난 인자는 거절,
 *       search_path 고정, PUBLIC·collector 는 실행 불가.</li>
 * </ul>
 */
@EnabledIf("dev.skywx.DbTestSupport#dockerAvailable")
class RolePrivilegesDbTest {
    static final String INSUFFICIENT_PRIVILEGE = "42501";
    static final String RAISED = "P0001";

    static Connection as(String user, String pw) throws SQLException {
        DbTestSupport.start();
        return DriverManager.getConnection(DbTestSupport.jdbcUrl("skywx"), user, pw);
    }

    static Connection api() throws SQLException { return as("skywx_api", DbTestSupport.API_PW); }
    static Connection collector() throws SQLException { return as("skywx_collector", DbTestSupport.COLLECTOR_PW); }
    static Connection migrator() throws SQLException { return as("skywx_migrator", DbTestSupport.MIGRATOR_PW); }

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
                    "INSERT INTO airport (icao, geom) VALUES ('ZZZZ', ST_SetSRID(ST_MakePoint(0, 0), 4326))", // 수집기 테이블은 읽기(+보존 삭제)만
            }) {
                assertThat(state(c, ddl)).as(ddl).isEqualTo(INSUFFICIENT_PRIVILEGE);
            }
            assertThat(state(c, "ALTER ROLE skywx_api CREATEDB")).as("ALTER ROLE").isEqualTo(INSUFFICIENT_PRIVILEGE);
            // GRANT 는 grant option 이 없으면 오류 대신 경고만 내고 아무것도 주지 않는다(PostgreSQL 규칙) — 결과로 확인한다
            state(c, "GRANT SELECT ON ops_user TO skywx_collector");
            state(c, "GRANT INSERT ON alert_event TO skywx_collector");
            assertThat(scalar(c, "SELECT has_table_privilege('skywx_collector', 'ops_user', 'SELECT')")).isEqualTo(false);
            assertThat(scalar(c, "SELECT has_table_privilege('skywx_collector', 'alert_event', 'INSERT')")).isEqualTo(false);
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
            assertThat(scalar(c, "SELECT pg_get_userbyid(relowner) FROM pg_class WHERE relname = '" + future + "'")).isEqualTo("skywx_migrator");
            // 새 파티션에도 api 의 DML 권한이 있다(기본 권한) — 항적 쓰기가 자정 이후에도 이어진다
            assertThat(state(c, "INSERT INTO track_point (hex, ts, geom, provider, fetched_at) VALUES ('abc123', now() + interval '3 days', "
                    + "ST_SetSRID(ST_MakePoint(127, 37), 4326), 'fixture', now()) ON CONFLICT DO NOTHING")).isNull();
            assertThat(state(c, "DELETE FROM " + future)).isNull();
            // 그래도 테이블 자체는 못 지운다(함수를 거쳐야 한다)
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
                assertThat(scalar(m, "SELECT has_function_privilege('skywx_collector', '" + fn + "(int)', 'EXECUTE')")).isEqualTo(false);
                assertThat(scalar(m, "SELECT has_function_privilege('skywx_api', '" + fn + "(int)', 'EXECUTE')")).isEqualTo(true);
            }
            // PUBLIC 은 스키마에 아무것도 만들 수 없다(01-roles.sh: REVOKE ALL ON SCHEMA public FROM PUBLIC)
            assertThat(scalar(m, "SELECT has_schema_privilege('skywx_api', 'public', 'CREATE')")).isEqualTo(false);
            assertThat(scalar(m, "SELECT has_schema_privilege('skywx_collector', 'public', 'CREATE')")).isEqualTo(false);
        }
    }

    @Test
    void testDatabasesAreInitialisedFromTheRealRolesScript() {
        // 두 번째 블록(확장·권한·시간대)을 스크립트에서 읽는다 — 형식이 바뀌면 여기서 먼저 깨진다
        var blocks = DbTestSupport.rolesScriptBlocks();
        assertThat(blocks.get(0)).contains("CREATE ROLE skywx_api").contains("CREATE DATABASE skywx OWNER skywx_migrator");
        assertThat(blocks.get(1)).contains("REVOKE ALL ON SCHEMA public FROM PUBLIC");
        for (String db : new String[]{"skywx", "skywx_stage"}) {
            String conf = DbTestSupport.admin().sql("""
                    SELECT array_to_string(s.setconfig, ',') FROM pg_db_role_setting s JOIN pg_database d ON d.oid = s.setdatabase
                    WHERE d.datname = :db AND s.setrole = 0""").param("db", db).query(String.class).single();
            assertThat(conf).as(db + " database settings").contains("TimeZone=UTC");
            assertThat(DbTestSupport.admin().sql("SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname = :db").param("db", db)
                    .query(String.class).single()).isEqualTo("skywx_migrator");
        }
    }
}
