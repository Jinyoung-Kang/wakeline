package dev.wakeline;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.zaxxer.hikari.HikariConfig;
import com.zaxxer.hikari.HikariDataSource;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import org.testcontainers.DockerClientFactory;
import org.testcontainers.postgresql.PostgreSQLContainer;
import org.testcontainers.utility.DockerImageName;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.PropertyNamingStrategies;
import tools.jackson.databind.json.JsonMapper;

import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.Statement;
import java.util.List;
import java.util.Map;

/**
 * 실제 PostGIS(운영과 같은 이미지)로 도는 DB 테스트 공통. Docker 가 없으면 이 지원을 쓰는 테스트는 건너뛴다(@EnabledIf dockerAvailable).
 * <ul>
 *   <li>클러스터 초기화는 compose 와 똑같이 <b>실제 infra/db/init 디렉터리</b>를 /docker-entrypoint-initdb.d 에 바인드한다
 *       (01-roles.sh 가 역할 3개 + wakeline DB + PostGIS 를 만든다 — 이미지의 10_postgis.sh 는 compose 처럼 가려진다).</li>
 *   <li>테스트용 DB(wakeline_stage·wakeline_it)는 같은 스크립트의 두 번째 블록(확장·스키마 권한·시간대)을 DB 이름만 바꿔 실행한다.</li>
 *   <li>스키마는 --migrate 경로(WakelineApplication.migrate — Flyway 만, wakeline_migrator)로 만든다.</li>
 * </ul>
 * 테스트는 운영과 같은 DML 전용 계정(wakeline_api)으로 접속한다.
 */
public final class DbTestSupport {
    public static final String IMAGE = "imresamu/postgis:18-3.6";
    public static final String MIGRATOR_PW = "migrator-test-pw";
    public static final String API_PW = "api-test-pw";
    public static final ObjectMapper JSON = JsonMapper.builder()
            .propertyNamingStrategy(PropertyNamingStrategies.SNAKE_CASE)
            .changeDefaultPropertyInclusion(i -> i.withValueInclusion(JsonInclude.Include.NON_NULL))
            .build();

    private static PostgreSQLContainer container;
    private static HikariDataSource api;
    private static HikariDataSource admin;

    private DbTestSupport() {}

    public static boolean dockerAvailable() {
        try { return DockerClientFactory.instance().isDockerAvailable(); } catch (Throwable t) { return false; }
    }

    /** 컨테이너 1개를 모든 DB 테스트가 같이 쓴다(JVM 종료 시 Ryuk 가 정리). 첫 호출에서 역할·DB 를 만들고 마이그레이션한다. */
    private static boolean ready;

    public static final String COLLECTOR_PW = "collector-test-pw";
    public static final String ROOT_PW = "root-test-pw";
    private static final java.util.Set<String> created = new java.util.HashSet<>();

    public static synchronized void start() {
        if (ready) return;
        if (container == null) {
            Path init = repoFile("infra/db/init/01-roles.sh").getParent();
            @SuppressWarnings("deprecation") // 바인드 마운트: compose 의 ./db/init:/docker-entrypoint-initdb.d:ro 와 같은 의미(이미지 기본 스크립트를 가린다)
            PostgreSQLContainer c = new PostgreSQLContainer(DockerImageName.parse(IMAGE).asCompatibleSubstituteFor("postgres"))
                    .withUsername("postgres").withPassword(ROOT_PW).withDatabaseName("postgres")
                    .withEnv("DB_MIGRATOR_PASSWORD", MIGRATOR_PW).withEnv("DB_API_PASSWORD", API_PW).withEnv("DB_COLLECTOR_PASSWORD", COLLECTOR_PW)
                    .withFileSystemBind(init.toString(), "/docker-entrypoint-initdb.d", org.testcontainers.containers.BindMode.READ_ONLY);
            container = c;
            container.start();
        }
        created.add("wakeline"); // 01-roles.sh 가 만들었다
        createDatabase("wakeline_stage");
        int rc = WakelineApplication.migrate(env("wakeline"));
        if (rc != 0) throw new IllegalStateException("migration failed rc=" + rc);
        api = pool("wakeline_api", API_PW, "wakeline");
        admin = pool("postgres", ROOT_PW, "wakeline");
        ready = true;
    }

    /**
     * 01-roles.sh 와 같은 방법으로 DB 를 하나 더 만든다: CREATE DATABASE … OWNER wakeline_migrator + 스크립트 두 번째 블록
     * (확장·REVOKE/GRANT·시간대)을 그 DB 에서 실행. 블록은 실제 스크립트에서 읽는다 — 스크립트가 바뀌면 테스트 DB 도 따라 바뀐다.
     */
    public static synchronized void createDatabase(String db) {
        if (container == null) start();
        if (!created.add(db)) return;
        if (!db.matches("^wakeline_[a-z_]+$")) throw new IllegalArgumentException(db);
        exec("postgres", "CREATE DATABASE " + db + " OWNER wakeline_migrator");
        String block = rolesScriptBlocks().get(1);
        String marker = "ALTER DATABASE wakeline SET";
        if (!block.contains(marker)) throw new IllegalStateException("01-roles.sh changed shape: '" + marker + "' not found in the per-database block");
        for (String stmt : block.replace(marker, "ALTER DATABASE " + db + " SET").split(";")) {
            if (!stmt.isBlank()) exec(db, stmt.trim());
        }
    }

    /** 새 DB 를 만들고 --migrate 경로로 스키마를 올린다(이미 있으면 그대로). */
    public static synchronized void createMigratedDatabase(String db) {
        start();
        boolean fresh = !created.contains(db);
        createDatabase(db);
        if (fresh) {
            int rc = WakelineApplication.migrate(env(db));
            if (rc != 0) throw new IllegalStateException("migration of " + db + " failed rc=" + rc);
        }
    }

    /** 01-roles.sh 의 heredoc(<<-EOSQL … EOSQL) 본문들: [0] 역할·DB 생성, [1] DB 안의 확장·권한. */
    static List<String> rolesScriptBlocks() {
        try {
            String script = Files.readString(repoFile("infra/db/init/01-roles.sh"));
            List<String> blocks = new java.util.ArrayList<>();
            var m = java.util.regex.Pattern.compile("<<-?EOSQL\\n(.*?)\\nEOSQL", java.util.regex.Pattern.DOTALL).matcher(script);
            while (m.find()) blocks.add(m.group(1));
            if (blocks.size() != 2) throw new IllegalStateException("01-roles.sh: expected 2 SQL blocks, found " + blocks.size());
            return blocks;
        } catch (java.io.IOException e) {
            throw new IllegalStateException(e);
        }
    }

    /** 저장소 루트 기준 파일(테스트 작업 디렉터리 apps/api 에서 위로 찾는다). */
    public static Path repoFile(String relative) {
        for (Path p = Path.of(System.getProperty("user.dir")).toAbsolutePath(); p != null; p = p.getParent()) {
            Path f = p.resolve(relative);
            if (Files.isRegularFile(f)) return f;
        }
        throw new IllegalStateException(relative + " not found above " + System.getProperty("user.dir"));
    }

    public static String host() { start(); return container.getHost(); }
    public static int port() { start(); return container.getMappedPort(5432); }

    /** --migrate 가 읽는 환경변수(compose migrate 서비스와 같은 이름). */
    public static Map<String, String> env(String dbName) {
        return Map.of("DB_HOST", container.getHost(), "DB_PORT", String.valueOf(container.getMappedPort(5432)),
                "DB_NAME", dbName, "DB_MIGRATOR_PASSWORD", MIGRATOR_PW);
    }

    public static String jdbcUrl(String db) {
        return "jdbc:postgresql://" + container.getHost() + ":" + container.getMappedPort(5432) + "/" + db;
    }

    private static HikariDataSource pool(String user, String pw, String db) {
        HikariConfig c = new HikariConfig();
        c.setJdbcUrl(jdbcUrl(db));
        c.setUsername(user);
        c.setPassword(pw);
        c.setMaximumPoolSize(12);
        c.setConnectionTimeout(5000);
        c.addDataSourceProperty("reWriteBatchedInserts", "true");
        return new HikariDataSource(c);
    }

    /** 운영 api 와 같은 권한(wakeline_api)의 DataSource. */
    public static HikariDataSource apiDataSource() { start(); return api; }

    /** 테스트 자료 준비용(수집기 테이블 쓰기·검증 쿼리). */
    public static JdbcClient admin() { start(); return JdbcClient.create(admin); }

    public static JdbcClient apiClient() { return JdbcClient.create(apiDataSource()); }
    public static JdbcTemplate apiJdbc() { return new JdbcTemplate(apiDataSource()); }
    public static TransactionTemplate apiTx() { return new TransactionTemplate(new DataSourceTransactionManager(apiDataSource())); }

    public static void exec(String db, String sql) {
        try (Connection c = DriverManager.getConnection(jdbcUrl(db), "postgres", ROOT_PW); Statement s = c.createStatement()) {
            s.execute(sql);
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    /**
     * [from, to] 가 걸친 UTC 날마다 track_point 일 파티션(운영과 같은 이름 · 같은 소유자 wakeline_migrator)을 만든다 — 마이그레이션은 어제(UTC)부터만 만든다.
     * KST 날짜 하루(전날 15:00 UTC 부터)의 자료를 넣는 시험이 쓴다(계약 v5 §G20).
     */
    public static void ensureTrackPartitions(java.time.Instant from, java.time.Instant to) {
        start();
        try (Connection c = DriverManager.getConnection(jdbcUrl("wakeline"), "wakeline_migrator", MIGRATOR_PW); Statement s = c.createStatement()) {
            for (java.time.LocalDate d = java.time.LocalDate.ofInstant(from, java.time.ZoneOffset.UTC); !d.isAfter(java.time.LocalDate.ofInstant(to, java.time.ZoneOffset.UTC)); d = d.plusDays(1))
                s.execute("CREATE TABLE IF NOT EXISTS track_point_" + d.format(java.time.format.DateTimeFormatter.BASIC_ISO_DATE)
                        + " PARTITION OF track_point FOR VALUES FROM ('" + d + "') TO ('" + d.plusDays(1) + "')");
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    /** 테스트 사이 초기화: 쓰기 대상 테이블 비우기 + 런타임 설정을 V1 시드로. */
    public static void reset() {
        start();
        exec("wakeline", """
                TRUNCATE alert_event, sigmet, aircraft, track_point, track_point_1m, stats_daily, metar_obs, radar_frame, airport,
                         audit_log, ops_user, ingest_run, quality_event, quality_rule_count, ship, ship_position, ingest_gap, provider_switch, ops_resolution,
                         port_call, port_call_coverage RESTART IDENTITY CASCADE;
                UPDATE app_setting SET version = 1, updated_by = NULL, value = CASE key
                  WHEN 'region_poll_s' THEN '10' WHEN 'global_poll_s' THEN '120' WHEN 'sigmet_poll_s' THEN '300' WHEN 'radar_poll_s' THEN '60'
                  WHEN 'metar_poll_s' THEN '600' WHEN 'aircraft_providers' THEN '"adsb_lol,adsb_fi,opensky"' WHEN 'region_center' THEN '"36.5,127.8"'
                  WHEN 'region_radius_nm' THEN '250' WHEN 'global_enabled' THEN 'true'
                  WHEN 'ais_bboxes' THEN '""' END::jsonb;""");
    }
}
