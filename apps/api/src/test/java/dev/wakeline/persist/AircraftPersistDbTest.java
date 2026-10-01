package dev.wakeline.persist;

import dev.wakeline.DbTestSupport;
import dev.wakeline.domain.AircraftState;
import dev.wakeline.geo.Bbox;
import dev.wakeline.ingest.IngestEvents;
import dev.wakeline.platform.data.Sql;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIf;
import org.springframework.jdbc.core.simple.JdbcClient;

import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 항공기 저장을 실제 PostGIS + 운영과 같은 DML 계정(wakeline_api)으로 검증한다: aircraft 한 문장 upsert, 항적 저장기(호출 스레드 밖 · 일시 장애 ·
 * 영구 오류 · 영수증 · 넘침), 재생 출처 · 레이더. PersistDbTest 에서 시험 대상 클래스(TrackWriter · AircraftRepository · TrackRepository)별로 나눴다.
 */
@EnabledIf("dev.wakeline.DbTestSupport#dockerAvailable")
class AircraftPersistDbTest {
    static final Instant T0 = Instant.now().truncatedTo(ChronoUnit.SECONDS);

    JdbcClient api;
    JdbcClient admin;
    SimpleMeterRegistry meters;

    @BeforeEach
    void setUp() {
        DbTestSupport.reset();
        api = DbTestSupport.apiClient();
        admin = DbTestSupport.admin();
        meters = new SimpleMeterRegistry();
    }

    // ---------- 도우미 ----------

    static AircraftState ac(String hex, double lat, double lon, Instant seen, String reg) {
        return new AircraftState(hex, "TST1", reg, null, null, lat, lon, 30000, 450.0, 90.0, 0.0, false, "1200", seen, "adsb_lol", seen, 0, false);
    }

    void trackPoint(String hex, Instant ts, double lat, double lon) {
        admin.sql("""
                INSERT INTO track_point (hex, ts, geom, alt_ft, provider, fetched_at)
                VALUES (:h, :t, ST_SetSRID(ST_MakePoint(:lon, :lat), 4326), 30000, 'adsb_lol', :t)""")
                .param("h", hex).param("t", Sql.ts(ts)).param("lat", lat).param("lon", lon).update();
    }

    // ---------- aircraft · 항적 ----------

    @Test
    void aircraftStaticUpsertWritesOnlyNewOrChangedRowsInBulk() {
        AircraftRepository repo = new AircraftRepository(api, DbTestSupport.JSON);
        List<AircraftState> many = new ArrayList<>();
        for (int i = 0; i < 6_000; i++) many.add(ac(String.format("%06x", i + 1), 36, 127, T0, null));
        assertThat(repo.touch(many)).isEqualTo(6_000);
        assertThat(admin.sql("SELECT count(*) FROM aircraft").query(Long.class).single()).isEqualTo(6_000L);
        assertThat(repo.touch(many)).isZero(); // 1분 안에 같은 내용 — 쓰지 않는다

        assertThat(repo.touch(List.of(ac("000001", 36, 127, T0.plusSeconds(5), "HL7777")))).isEqualTo(1); // 등록기호가 새로 알려짐
        assertThat(repo.touch(List.of(ac("000001", 36, 127, T0.plusSeconds(6), null)))).isZero();          // 모르는 값은 변화가 아니다
        Map<String, Object> row = repo.find("000001");
        assertThat(row).containsEntry("registration", "HL7777").containsEntry("last_seen", T0.plusSeconds(5));
    }

    @Test
    void trackWriterRunsOffTheCallerThreadAndFlushesOnStop() throws Exception {
        AircraftRepository repo = new AircraftRepository(api, DbTestSupport.JSON);
        TrackWriter tw = new TrackWriter(DbTestSupport.apiJdbc(), repo, meters, 10, 20);
        tw.start();
        Instant seen = Instant.now().minusSeconds(30);
        var states = Map.of("aaa001", ac("aaa001", 36, 127, seen, "HL1"), "aaa002", ac("aaa002", 36.1, 127.1, seen, null));
        var snap = new dev.wakeline.ingest.Snapshot(1, "region", "adsb_lol", seen, seen, "-", states);
        tw.onSnapshot(new IngestEvents.SnapshotUpdated(dev.wakeline.ingest.Snapshot.empty("region"), snap));
        tw.onBacklog(new IngestEvents.AircraftBacklog("region", seen.minusSeconds(10),
                List.of(ac("aaa003", 36.2, 127.2, seen.minusSeconds(10), null))));
        long deadline = System.currentTimeMillis() + 10_000;
        while (System.currentTimeMillis() < deadline
                && admin.sql("SELECT count(*) FROM aircraft").query(Long.class).single() < 3) Thread.sleep(50);
        tw.stop();
        assertThat(admin.sql("SELECT count(*) FROM track_point WHERE hex IN ('aaa001','aaa002','aaa003')").query(Long.class).single()).isEqualTo(3L);
        assertThat(admin.sql("SELECT count(*) FROM aircraft").query(Long.class).single()).isEqualTo(3L);
        tw.write(List.of(states.get("aaa001"))); // 같은 (hex, ts) 재기록은 중복되지 않는다
        assertThat(admin.sql("SELECT count(*) FROM track_point WHERE hex = 'aaa001'").query(Long.class).single()).isEqualTo(1L);
        assertThat(meters.counter("wakeline_track_rows_total", "result", "dropped").count()).isZero();
    }

    @Test
    void trackBatchSurvivesATransientOutageWithoutLosingRows() throws Exception {
        java.util.concurrent.atomic.AtomicInteger outage = new java.util.concurrent.atomic.AtomicInteger(3);
        javax.sql.DataSource flaky = new org.springframework.jdbc.datasource.DelegatingDataSource(DbTestSupport.apiDataSource()) {
            @Override public java.sql.Connection getConnection() throws java.sql.SQLException {
                if (outage.getAndDecrement() > 0) throw new java.sql.SQLTransientConnectionException("pool timeout");
                return super.getConnection();
            }
        };
        TrackWriter tw = new TrackWriter(new org.springframework.jdbc.core.JdbcTemplate(flaky),
                new AircraftRepository(JdbcClient.create(flaky), DbTestSupport.JSON), meters, 10, 20);
        tw.start();
        Instant seen = Instant.now().minusSeconds(20);
        tw.enqueue(List.of(ac("f00001", 36, 127, seen, null), ac("f00002", 36, 127, seen, null)));
        long deadline = System.currentTimeMillis() + 10_000;
        while (System.currentTimeMillis() < deadline
                && admin.sql("SELECT count(*) FROM track_point WHERE hex LIKE 'f0000%'").query(Long.class).single() < 2) Thread.sleep(20);
        tw.stop();
        // 이전에는 실패한 배치를 버리고 dropped 도 세지 않았다(REL-10)
        assertThat(admin.sql("SELECT count(*) FROM track_point WHERE hex LIKE 'f0000%'").query(Long.class).single()).isEqualTo(2L);
        assertThat(meters.counter("wakeline_track_rows_total", "result", "written").count()).isEqualTo(2.0);
        assertThat(meters.counter("wakeline_track_rows_total", "result", "dropped").count()).isZero();
    }

    @Test
    void permanentlyRejectedTrackRowsAreCountedAsFailed() throws Exception {
        TrackWriter tw = new TrackWriter(DbTestSupport.apiJdbc(), new AircraftRepository(api, DbTestSupport.JSON), meters, 5, 10);
        tw.start();
        java.util.concurrent.atomic.AtomicInteger acked = new java.util.concurrent.atomic.AtomicInteger();
        dev.wakeline.platform.support.Receipt r = new dev.wakeline.platform.support.Receipt(acked::incrementAndGet);
        tw.enqueue(List.of(ac("f10001", 36, 127, Instant.parse("2001-01-01T00:00:00Z"), null)), r); // 파티션 없음(23514)
        r.release();
        long deadline = System.currentTimeMillis() + 10_000;
        while (System.currentTimeMillis() < deadline && meters.counter("wakeline_track_rows_total", "result", "failed").count() < 1) Thread.sleep(20);
        tw.stop();
        assertThat(meters.counter("wakeline_track_rows_total", "result", "failed").count()).isEqualTo(1.0);
        assertThat(meters.counter("wakeline_track_rows_total", "result", "written").count()).isZero();
        assertThat(acked.get()).as("re-processing cannot fix a permanent error — the message is acknowledged").isEqualTo(1);
    }

    /** API-CONC-8: 항적 메시지의 영수증은 그 행이 커밋된 뒤에만 풀린다 — DB 장애 중에는 ACK 되지 않고, 종료 때 못 쓴 메시지는 끝까지 ACK 되지 않는다. */
    @Test
    void trackReceiptsAreReleasedOnlyAfterTheirRowsAreDurable() throws Exception {
        java.util.concurrent.atomic.AtomicBoolean down = new java.util.concurrent.atomic.AtomicBoolean(true);
        javax.sql.DataSource flaky = new org.springframework.jdbc.datasource.DelegatingDataSource(DbTestSupport.apiDataSource()) {
            @Override public java.sql.Connection getConnection() throws java.sql.SQLException {
                if (down.get()) throw new java.sql.SQLTransientConnectionException("db down");
                return super.getConnection();
            }
        };
        TrackWriter tw = new TrackWriter(new org.springframework.jdbc.core.JdbcTemplate(flaky), new AircraftRepository(JdbcClient.create(flaky), DbTestSupport.JSON), meters, 10, 20);
        tw.start();
        Instant seen = Instant.now().minusSeconds(20);
        java.util.concurrent.atomic.AtomicInteger acked = new java.util.concurrent.atomic.AtomicInteger();
        dev.wakeline.platform.support.Receipt m1 = new dev.wakeline.platform.support.Receipt(acked::incrementAndGet);
        dev.wakeline.platform.support.Receipt m2 = new dev.wakeline.platform.support.Receipt(acked::incrementAndGet);
        dev.wakeline.platform.support.Receipt empty = new dev.wakeline.platform.support.Receipt(acked::incrementAndGet);
        tw.enqueue(List.of(ac("f20001", 36, 127, seen, null), ac("f20002", 36, 127, seen, null)), m1);
        tw.enqueue(List.of(ac("f20003", 36, 127, seen, null)), m2);
        tw.enqueue(List.of(), empty);
        m1.release(); m2.release(); empty.release(); // 소비자 자신의 보유
        assertThat(acked.get()).as("a message with no rows is acked at once").isEqualTo(1);
        Thread.sleep(200);                       // 배치가 재시도 중(DB 장애)
        assertThat(acked.get()).as("nothing acked while the rows are not durable").isEqualTo(1);
        assertThat(tw.pendingMarks()).isEqualTo(2);
        down.set(false);                         // DB 복구 → 커밋 → ACK
        long deadline = System.currentTimeMillis() + 10_000;
        while (System.currentTimeMillis() < deadline && acked.get() < 3) Thread.sleep(20);
        assertThat(acked.get()).isEqualTo(3);
        assertThat(admin.sql("SELECT count(*) FROM track_point WHERE hex LIKE 'f2000%'").query(Long.class).single()).isEqualTo(3L);

        // 종료 때 DB 가 다시 죽어 있으면: 못 쓴 행의 메시지는 ACK 하지 않는다(다음 기동에서 PEL 로 다시 온다)
        down.set(true);
        dev.wakeline.platform.support.Receipt m3 = new dev.wakeline.platform.support.Receipt(acked::incrementAndGet);
        tw.enqueue(List.of(ac("f20004", 36, 127, seen, null)), m3);
        m3.release();
        tw.stop();
        assertThat(acked.get()).isEqualTo(3);
        assertThat(meters.counter("wakeline_track_rows_total", "result", "dropped").count()).isEqualTo(1.0);
    }

    /** 큐가 넘쳐 버린 행의 메시지는(되살릴 수 없으므로) 센 뒤 ACK 된다 — PEL 이 끝없이 자라지 않게. 진행 중 배치보다 먼저 풀리지는 않는다. */
    @Test
    void overflowDroppedRowsReleaseTheirReceiptsAfterTheOutstandingBatch() throws Exception {
        java.util.concurrent.atomic.AtomicBoolean down = new java.util.concurrent.atomic.AtomicBoolean(true);
        javax.sql.DataSource flaky = new org.springframework.jdbc.datasource.DelegatingDataSource(DbTestSupport.apiDataSource()) {
            @Override public java.sql.Connection getConnection() throws java.sql.SQLException {
                if (down.get()) throw new java.sql.SQLTransientConnectionException("db down");
                return super.getConnection();
            }
        };
        TrackWriter tw = new TrackWriter(new org.springframework.jdbc.core.JdbcTemplate(flaky), new AircraftRepository(JdbcClient.create(flaky), DbTestSupport.JSON), meters, 10, 20);
        tw.start();
        Instant seen = Instant.now().minusSeconds(20);
        java.util.concurrent.atomic.AtomicInteger acked = new java.util.concurrent.atomic.AtomicInteger();
        List<AircraftState> first = new ArrayList<>();
        for (int i = 0; i < TrackWriter.BATCH; i++) first.add(ac(String.format("e3%04x", i), 36, 127, seen, null));
        dev.wakeline.platform.support.Receipt m1 = new dev.wakeline.platform.support.Receipt(acked::incrementAndGet);
        tw.enqueue(first, m1);
        m1.release();
        long deadline = System.currentTimeMillis() + 5_000;
        while (System.currentTimeMillis() < deadline && tw.queued() > 0) Thread.sleep(10); // 첫 배치가 워커 손에(재시도 중)
        List<AircraftState> flood = new ArrayList<>();
        for (int i = 0; i < TrackWriter.QUEUE_MAX + 10; i++) flood.add(ac(String.format("%06x", 0x900000 + i), 36, 127, seen, null));
        dev.wakeline.platform.support.Receipt m2 = new dev.wakeline.platform.support.Receipt(acked::incrementAndGet);
        tw.enqueue(flood, m2); // 자기 행 10개가 넘쳐 버려진다
        m2.release();
        assertThat(meters.counter("wakeline_track_rows_total", "result", "dropped").count()).isEqualTo(10.0);
        assertThat(acked.get()).as("the outstanding batch is not durable yet").isZero();
        tw.stop(); // DB 장애 그대로 — 어느 것도 ACK 하지 않는다
        assertThat(acked.get()).isZero();
    }

    // ---------- 재생 ----------

    @Test
    void replayReportsTheTableThatSuppliedRowsAndTheNearestRadarFrame() {
        TrackRepository tracks = new TrackRepository(api);
        Instant at = Instant.now().minusSeconds(1800).truncatedTo(ChronoUnit.SECONDS);
        Bbox b = new Bbox(120, 30, 135, 45);
        assertThat(tracks.replay(at, b).source()).isEqualTo("none");
        admin.sql("INSERT INTO track_point_1m (hex, ts_minute, geom, alt_ft, gs_kt, n) VALUES ('e00001', :t, ST_SetSRID(ST_MakePoint(127, 36), 4326), 30000, 400, 3)")
                .param("t", Sql.ts(at.minusSeconds(60).truncatedTo(ChronoUnit.MINUTES))).update();
        var fromSummary = tracks.replay(at, b);
        assertThat(fromSummary.source()).isEqualTo("track_point_1m");
        assertThat(fromSummary.aircraft().getFirst().get("on_ground")).isNull(); // 요약에는 지상 여부가 없다 — false 로 채우지 않는다
        assertThat(fromSummary.aircraft().getFirst().get("track_deg")).isNull();
        // DH-11: 1분 요약 행은 '평균 위치' 로 표시된다(기록된 한 점이 아니다) + 평균에 쓴 점 수
        assertThat(fromSummary.aircraft().getFirst()).containsEntry("averaged", true).containsEntry("samples", 3);
        trackPoint("e00002", at.minusSeconds(30), 36, 127);
        var raw = tracks.replay(at, b);
        assertThat(raw.source()).isEqualTo("track_point");
        assertThat(raw.aircraft().getFirst()).containsEntry("averaged", false).doesNotContainKey("samples");

        admin.sql("INSERT INTO radar_frame (frame_time, host, path, fetched_at) VALUES (:a, 'https://tilecache.rainviewer.com', '/v2/radar/a', now()), (:b, 'https://tilecache.rainviewer.com', '/v2/radar/b', now())")
                .param("a", Sql.ts(at.plusSeconds(240))).param("b", Sql.ts(at.minusSeconds(480))).update();
        Map<String, Object> radar = tracks.radarFrameNear(at, Instant.now());
        assertThat(radar).containsEntry("path", "/v2/radar/a").containsEntry("time", at.plusSeconds(240).getEpochSecond());
        assertThat(tracks.radarFrameNear(Instant.now().minusSeconds(3 * 3600), Instant.now())).isNull(); // RainViewer 는 2시간까지만
    }
}
