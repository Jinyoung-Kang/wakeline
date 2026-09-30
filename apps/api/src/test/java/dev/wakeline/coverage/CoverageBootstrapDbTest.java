package dev.wakeline.coverage;

import dev.wakeline.DbTestSupport;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIf;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.jdbc.datasource.DriverManagerDataSource;

import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.SQLException;
import java.sql.Statement;
import java.sql.Timestamp;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * 관측 수신 격자의 부트스트랩(ADR-027)을 실제 PostGIS(운영과 같은 이미지 · 같은 마이그레이션 · api 계정 wakeline_api)로: 시 조각 문장이 칸 · MMSI 로 묶는지,
 * 격자에 옮긴 값이 넣은 행과 같은지, 셈 시작 뒤의 행은 읽지 않는지, 연결이 읽기 전용인지, 문장 상한(잠금 대기 포함)이 문장을 끝내고 그 시를 나중에 다시 읽는지,
 * 연결 실패의 종류.
 * 다른 DB 시험과 섞이지 않게 제 DB(wakeline_cov)를 쓴다.
 */
@EnabledIf("dev.wakeline.DbTestSupport#dockerAvailable")
class CoverageBootstrapDbTest {
    static final String DB = "wakeline_cov";
    static JdbcClient api;

    @BeforeAll
    static void db() {
        DbTestSupport.createMigratedDatabase(DB);
        api = JdbcClient.create(new DriverManagerDataSource(DbTestSupport.jdbcUrl(DB), "wakeline_api", DbTestSupport.API_PW));
    }

    @BeforeEach
    void clean() {
        DbTestSupport.exec(DB, "TRUNCATE ship_position");
    }

    static JdbcCoverageSource source() {
        return new JdbcCoverageSource(DbTestSupport.jdbcUrl(DB), "wakeline_api", DbTestSupport.API_PW);
    }

    static void insert(String mmsi, double lat, double lon, Instant ts) {
        api.sql("INSERT INTO ship_position (mmsi, ts, geom, position_source, provider) VALUES (:m, :t, ST_SetSRID(ST_MakePoint(:lon, :lat), 4326), 'epfs', 'fixture')")
                .param("m", mmsi).param("t", Timestamp.from(ts)).param("lon", lon).param("lat", lat).update();
    }

    @Test
    void oneStatementPerHourGroupsByHalfDegreeCellAndMmsi_withTheNewestTimestamp() throws SQLException {
        Instant h = Instant.now().truncatedTo(ChronoUnit.HOURS).minus(2, ChronoUnit.HOURS);
        insert("440000001", 37.46, 126.44, h.plusSeconds(60));
        insert("440000001", 37.47, 126.45, h.plusSeconds(120));
        insert("440000001", 37.47, 126.45, h.plusSeconds(3_600)); // 다음 시 — 이 조각이 아니다
        insert("440000002", 37.10, 126.01, h.plusSeconds(600));
        insert("440000003", -0.1, -0.25, h.plusSeconds(700));      // 적도 · 본초 자오선 바로 남서 — floor 는 −1 · −1
        insert("440000004", 37.5, 180.0, h.plusSeconds(800));      // 칸 경계의 값 — 37.5 는 위 칸, 180 은 색인 360(격자가 마지막 칸으로 붙인다)
        List<CoverageSource.Row> rows = new ArrayList<>();
        try (CoverageSource.Session s = source().open()) {
            s.read(h.toEpochMilli(), h.plusSeconds(3_600).toEpochMilli(), rows::add);
        }
        assertThat(rows).extracting(CoverageSource.Row::mmsi, CoverageSource.Row::lonIdx, CoverageSource.Row::latIdx, CoverageSource.Row::positions)
                .containsExactlyInAnyOrder(
                        org.assertj.core.groups.Tuple.tuple(440_000_001, 252, 74, 2),
                        org.assertj.core.groups.Tuple.tuple(440_000_002, 252, 74, 1),
                        org.assertj.core.groups.Tuple.tuple(440_000_003, -1, -1, 1),
                        org.assertj.core.groups.Tuple.tuple(440_000_004, 360, 75, 1));
        CoverageSource.Row first = rows.stream().filter(r -> r.mmsi() == 440_000_001).findFirst().orElseThrow();
        assertThat(first.lastMs()).isEqualTo(h.plusSeconds(120).toEpochMilli());
        // 같은 식: 격자의 색인과 DB 의 색인이 같다
        assertThat(CoverageGrid.lonIndex(126.44)).isEqualTo(252);
        assertThat(CoverageGrid.latIndex(37.5)).isEqualTo(75);
        assertThat(CoverageGrid.lonIndex(-0.25)).isEqualTo(-1);
    }

    @Test
    void theBootstrapMovesStoredPositionsIntoTheGrid_andLeavesRowsAfterTheLiveCutToTheLiveCount() {
        long now = System.currentTimeMillis();
        Instant cut = Instant.ofEpochMilli(Math.floorDiv(now, 60_000L) * 60_000L);
        insert("440000011", 35.1, 129.05, cut.minusSeconds(3 * 3_600));
        insert("440000011", 35.1, 129.06, cut.minusSeconds(3 * 3_600 - 60));
        insert("440000012", 35.2, 129.1, cut.minusSeconds(20 * 3_600));
        insert("440000013", 35.2, 129.1, cut.plusSeconds(1)); // 셈 시작 뒤 — 실시간 셈의 몫, 부트스트랩은 읽지 않는다
        AtomicLong clock = new AtomicLong(now);
        ShipCoverage c = new ShipCoverage(source(), clock::get, new SimpleMeterRegistry(), 0, ShipCoverage.MAX_CELLS, ShipCoverage.MAX_SHIP_CELLS, now);
        c.runBootstrap();
        ShipCoverage.Snapshot s = c.snapshotNow();
        assertThat(s.bootstrap().state()).isEqualTo("done");
        assertThat(s.bootstrap().error()).isNull();
        assertThat(s.bootstrap().rows()).isEqualTo(2);
        assertThat(s.covered()).isEqualTo("full");
        assertThat(s.cells()).hasSize(1);
        CoverageGrid.CellView cell = s.cells().getFirst();
        assertThat(cell.lon0()).isEqualTo(129.0);
        assertThat(cell.lat0()).isEqualTo(35.0);
        assertThat(cell.ships()).isEqualTo(2);
        assertThat(cell.positions()).isEqualTo(3);
        assertThat(cell.lastSeenMs()).isEqualTo(cut.minusSeconds(3 * 3_600 - 60).toEpochMilli());
    }

    @Test
    void theConnectionIsReadOnly_evenForTheApiRoleThatMayInsert() throws SQLException {
        JdbcCoverageSource src = source();
        try (Connection c = DriverManager.getConnection(DbTestSupport.jdbcUrl(DB), src.properties()); Statement st = c.createStatement()) {
            assertThatThrownBy(() -> st.execute("INSERT INTO ship_position (mmsi, ts, geom, position_source, provider) "
                    + "VALUES ('440000099', now(), ST_SetSRID(ST_MakePoint(1, 1), 4326), 'epfs', 'x')"))
                    .isInstanceOfSatisfying(SQLException.class, e -> assertThat(e.getSQLState()).isEqualTo("25006")); // read_only_sql_transaction
            var rs = st.executeQuery("SHOW statement_timeout");
            rs.next();
            assertThat(rs.getString(1)).isEqualTo(JdbcCoverageSource.STATEMENT_TIMEOUT_S + "s");
            rs = st.executeQuery("SELECT application_name FROM pg_stat_activity WHERE pid = pg_backend_pid()");
            rs.next();
            assertThat(rs.getString(1)).isEqualTo(JdbcCoverageSource.APPLICATION_NAME);
        }
    }

    /**
     * 문장 상한이 잠금을 기다리는 문장을 끝내고(종류 statement_timeout), 부트스트랩은 멈추지 않고 그 시를 나중에 다시 읽는다 — 잠금이 풀린 뒤 다시 읽어 다 센다
     * (2026-09-30 22:49 KST 배포 직후: 재시작 직후 경합에서 한 시가 상한을 넘자 부트스트랩이 멈췄다). 한 차례의 마감은 가짜 시계로 당겨 첫 시 뒤 나머지를 다음
     * 차례로 미룬다(시험이 시마다 1 s 를 기다리지 않게). 수정 전 실패(첫 시간 초과에서 멈췄다).
     */
    @Test
    void theStatementLimitEndsAStatementThatWaitsOnALock_andTheHourIsReadAgainOnceTheLockIsGone() throws Exception {
        long now = System.currentTimeMillis();
        Instant cut = Instant.ofEpochMilli(Math.floorDiv(now, 60_000L) * 60_000L);
        insert("440000021", 35.1, 129.05, cut.minusSeconds(2 * 3_600));
        try (Connection admin = DriverManager.getConnection(DbTestSupport.jdbcUrl(DB), "postgres", DbTestSupport.ROOT_PW)) {
            admin.setAutoCommit(false);
            try (Statement st = admin.createStatement()) {
                st.execute("LOCK TABLE ship_position IN ACCESS EXCLUSIVE MODE"); // 이 트랜잭션이 끝날 때까지 읽기도 기다린다
            }
            AtomicLong clock = new AtomicLong(now);
            AtomicBoolean locked = new AtomicBoolean(true);
            JdbcCoverageSource slow = new JdbcCoverageSource(DbTestSupport.jdbcUrl(DB), "wakeline_api", DbTestSupport.API_PW, 1);
            CoverageSource src = () -> {
                CoverageSource.Session in = slow.open();
                return new CoverageSource.Session() {
                    @Override
                    public void read(long fromMs, long toMs, java.util.function.Consumer<CoverageSource.Row> sink) throws SQLException {
                        try {
                            in.read(fromMs, toMs, sink);
                        } finally {
                            if (locked.get()) clock.addAndGet(ShipCoverage.BOOTSTRAP_DEADLINE_MS + 1); // 잠긴 동안은 한 시 뒤 차례 마감
                        }
                    }

                    @Override public void close() throws SQLException { in.close(); }
                };
            };
            ShipCoverage c = new ShipCoverage(src, clock::get, new SimpleMeterRegistry(), 0, 100, 1_000, now);
            List<ShipCoverage.Snapshot> waiting = new ArrayList<>();
            c.sleeper = ms -> {
                waiting.add(c.snapshotNow());
                if (locked.getAndSet(false)) {
                    try { admin.rollback(); } catch (SQLException e) { throw new IllegalStateException(e); }
                }
                clock.addAndGet(ms);
            };
            long t0 = System.nanoTime();
            c.runBootstrap();
            long ms = (System.nanoTime() - t0) / 1_000_000;
            assertThat(ms).as("ended by the 1 s statement limit, not by the lock").isLessThan(10_000);
            assertThat(waiting).hasSize(1);
            ShipCoverage.Snapshot w = waiting.getFirst();
            assertThat(w.bootstrap().state()).isEqualTo("running");
            assertThat(w.bootstrap().hoursLoaded()).isZero();
            assertThat(w.bootstrap().missing().getLast().error()).as("the newest hour hit the statement limit").isEqualTo("statement_timeout");
            assertThat(w.bootstrap().missing()).hasSize(w.bootstrap().hoursTotal());
            assertThat(w.bootstrap().missing().subList(0, w.bootstrap().hoursTotal() - 1)).allSatisfy(m -> assertThat(m.error()).isEqualTo("deadline"));
            assertThat(w.covered()).isEqualTo("since_api_start");
            ShipCoverage.Snapshot s = c.snapshotNow();
            assertThat(s.bootstrap().state()).isEqualTo("done");
            assertThat(s.bootstrap().missing()).isEmpty();
            assertThat(s.bootstrap().rows()).isEqualTo(1);
            assertThat(s.covered()).isEqualTo("full");
            assertThat(s.cells()).extracting(CoverageGrid.CellView::lon0, CoverageGrid.CellView::lat0).containsExactly(org.assertj.core.groups.Tuple.tuple(129.0, 35.0));
        }
    }

    @Test
    void theBackgroundReadHasItsOwnThirtySecondLimit_notThePublicThreeSecondOne() {
        assertThat(JdbcCoverageSource.STATEMENT_TIMEOUT_S).isEqualTo(30);
        assertThat(JdbcCoverageSource.SOCKET_TIMEOUT_S).isEqualTo(32);
        java.util.Properties p = source().properties();
        assertThat(p.getProperty("options")).contains("statement_timeout=30s").contains("default_transaction_read_only=on");
        assertThat(p.getProperty("socketTimeout")).isEqualTo("32");
    }

    @Test
    void anUnreachableDatabaseIsAConnectionFailure() {
        String url = "jdbc:postgresql://127.0.0.1:1/" + DB; // 닫힌 포트
        AtomicLong clock = new AtomicLong(System.currentTimeMillis());
        ShipCoverage c = new ShipCoverage(new JdbcCoverageSource(url, "wakeline_api", DbTestSupport.API_PW), clock::get,
                new SimpleMeterRegistry(), 0, 100, 1_000);
        c.sleeper = clock::addAndGet; // 다시 읽기 전 기다림(1 · 2 · 5 · 10분)은 가짜 시계로
        c.runBootstrap();
        assertThat(c.snapshotNow().bootstrap().state()).isEqualTo("failed");
        assertThat(c.snapshotNow().bootstrap().error()).isEqualTo("connection");
        assertThat(c.snapshotNow().bootstrap().missing()).isNotEmpty().allSatisfy(m -> assertThat(m.state()).isEqualTo("given_up"));
    }
}
