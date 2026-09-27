package dev.wakeline.persist;

import dev.wakeline.DbTestSupport;
import dev.wakeline.domain.AisGap;
import dev.wakeline.domain.ShipState;
import dev.wakeline.domain.ShipStatic;
import dev.wakeline.ingest.IngestEvents;
import dev.wakeline.ingest.Receipt;
import dev.wakeline.ops.RegionSettings;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIf;
import org.springframework.jdbc.core.simple.JdbcClient;

import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.time.temporal.ChronoUnit;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 선박 저장(V5 스키마 · 운영과 같은 DML 계정 wakeline_api): 60 s 창 가드(재시작 뒤에도 창마다 첫 보고 하나), 정적 정보 updated_at 단조,
 * last_seen 넓히기, 공백 중복 제거·겹침 조회, 항적 조회, 저장기 끝-끝(영수증), 파티션 보장·보존.
 */
@EnabledIf("dev.wakeline.DbTestSupport#dockerAvailable")
class ShipPersistDbTest {
    static final Instant W = Instant.now().truncatedTo(ChronoUnit.MINUTES).minusSeconds(3600); // 창 경계(:00)

    JdbcClient admin;
    ShipRepository repo;

    @BeforeEach
    void setUp() {
        DbTestSupport.reset();
        admin = DbTestSupport.admin();
        repo = new ShipRepository(DbTestSupport.apiJdbc(), DbTestSupport.apiClient());
    }

    static ShipState pos(String mmsi, Instant seen, double lat) {
        return new ShipState(mmsi, lat, 129.05, 11.2, 181.5, null, 5, null, "estimated", seen, "aisstream", "PositionReport", "A");
    }

    static ShipStatic stat(String mmsi, String name, Instant updated) {
        return new ShipStatic(mmsi, name, "D7AB", 9321483, 70, 150, 30, 14, 16, 9.8, "KR PUS", 9, 29, 6, 30, updated, "aisstream");
    }

    long rows(String mmsi) {
        return admin.sql("SELECT count(*) FROM ship_position WHERE mmsi = :m").param("m", mmsi).query(Long.class).single();
    }

    @Test void positions_oneRowPerSixtySecondWindow_evenAcrossSeparateBatches() {
        repo.writePositions(List.of(pos("440000001", W.plusSeconds(5), 35.1)));
        repo.writePositions(List.of(pos("440000001", W.plusSeconds(40), 35.2)));   // 같은 창(재시작 뒤 메모리 필터가 비었을 때) → 가드
        repo.writePositions(List.of(pos("440000001", W.plusSeconds(5), 35.1)));    // 같은 보고 재처리 → PK
        repo.writePositions(List.of(pos("440000001", W.plusSeconds(60), 35.3)));   // 다음 창
        assertThat(rows("440000001")).isEqualTo(2);
        var pts = repo.track("440000001", W, W.plusSeconds(120), 100);
        assertThat(pts).extracting(ShipRepository.TrackPoint::ts).containsExactly(W.plusSeconds(5), W.plusSeconds(60));
        ShipRepository.TrackPoint p = pts.getFirst();
        assertThat(p.lat()).isEqualTo(35.1);
        assertThat(p.sogKn()).as("real → short decimal, not 11.199999809").isEqualTo(11.2);
        assertThat(p.cogDeg()).isEqualTo(181.5);
        assertThat(p.headingDeg()).as("unknown stays null").isNull();
        assertThat(p.navStatus()).isEqualTo(5);
        assertThat(p.positionSource()).isEqualTo("estimated");
        assertThat(repo.track("440000001", W, W.plusSeconds(120), 1)).hasSize(1);
        assertThat(repo.lastPositionAt("440000001")).isEqualTo(W.plusSeconds(60));
        assertThat(repo.lastPositionAt("999999999")).isNull();
    }

    @Test void statics_newerWins_touchWidensSeenRange() {
        repo.touch(List.of(pos("440000002", W.plusSeconds(100), 35), pos("440000002", W.plusSeconds(50), 35)));
        ShipRepository.StoredShip s0 = repo.find("440000002");
        assertThat(s0.stat()).as("position only — no static info yet").isNull();
        assertThat(s0.firstSeen()).isEqualTo(W.plusSeconds(50));
        assertThat(s0.lastSeen()).isEqualTo(W.plusSeconds(100));

        repo.upsertStatics(List.of(new ShipRepository.StaticRow(stat("440000002", "HANJIN BUSAN", W.plusSeconds(10)), W.plusSeconds(200))));
        repo.upsertStatics(List.of(new ShipRepository.StaticRow(stat("440000002", "OLDER NAME", W), W.plusSeconds(300)))); // 오래된 내용 — 무시
        ShipRepository.StoredShip s1 = repo.find("440000002");
        assertThat(s1.stat().name()).isEqualTo("HANJIN BUSAN");
        assertThat(s1.stat().draughtM()).isEqualTo(9.8);
        assertThat(s1.stat().etaMinute()).isEqualTo(30);
        assertThat(s1.stat().imo()).isEqualTo(9321483);
        assertThat(s1.lastSeen()).isEqualTo(W.plusSeconds(200));
        assertThat(s1.firstSeen()).isEqualTo(W.plusSeconds(50));
        repo.touch(List.of(pos("440000002", W.plusSeconds(900), 35)));
        assertThat(repo.find("440000002").lastSeen()).isEqualTo(W.plusSeconds(900));
        assertThat(repo.find("999999999")).isNull();
    }

    @Test void gaps_dedupedAndQueriedByOverlap() {
        AisGap g = new AisGap(W, W.plusSeconds(120), "server closed (1006)", "aisstream");
        assertThat(repo.insertGap(g)).isTrue();
        assertThat(repo.insertGap(new AisGap(W, W.plusSeconds(130), "retry", "aisstream"))).as("same start = same gap").isFalse();
        repo.insertGap(new AisGap(W.plusSeconds(600), W.plusSeconds(700), "idle 120 s — no messages", "fixture"));
        assertThat(repo.gaps(W.plusSeconds(60), W.plusSeconds(650), 10)).extracting(AisGap::reason)
                .containsExactly("server closed (1006)", "idle 120 s — no messages");
        assertThat(repo.gaps(W.plusSeconds(200), W.plusSeconds(500), 10)).isEmpty();
        assertThat(repo.gaps(W.minusSeconds(10), W.plusSeconds(10_000), 1)).hasSize(1);
        AisGap back = repo.gaps(W.minusSeconds(10), W.plusSeconds(10), 10).getFirst();
        assertThat(back.startedAt()).isEqualTo(W);
        assertThat(back.endedAt()).isEqualTo(W.plusSeconds(120));
        assertThat(back.provider()).isEqualTo("aisstream");
    }

    @Test void writer_endToEnd_downsamplesAndAcksAfterCommit() throws Exception {
        ShipWriter w = new ShipWriter(repo, new OrderedWriter(new SimpleMeterRegistry(), 5, 10), new SimpleMeterRegistry(), 5, 20);
        w.start();
        try {
            AtomicInteger acked = new AtomicInteger();
            Receipt r = new Receipt(acked::incrementAndGet);
            w.onShips(new IngestEvents.ShipsUpdated(W.plusSeconds(10), "aisstream",
                    List.of(pos("440000003", W.plusSeconds(1), 35), pos("440000004", W.plusSeconds(2), 35)),
                    List.of(stat("440000003", "A", W)), Set.of(), Set.of(), r));
            r.release();
            Receipt r2 = new Receipt(acked::incrementAndGet);
            w.onShips(new IngestEvents.ShipsUpdated(W.plusSeconds(20), "aisstream",
                    List.of(pos("440000003", W.plusSeconds(11), 35.1)), List.of(), Set.of(), Set.of(), r2)); // 같은 창 → 저장할 것 없음 → 바로 ACK
            r2.release();
            long end = System.currentTimeMillis() + 10_000;
            while (acked.get() < 2 && System.currentTimeMillis() < end) Thread.sleep(10);
            assertThat(acked.get()).isEqualTo(2);
            assertThat(rows("440000003")).isEqualTo(1);
            assertThat(rows("440000004")).isEqualTo(1);
            assertThat(repo.find("440000003").stat().name()).isEqualTo("A");
            assertThat(repo.find("440000004").stat()).isNull();
        } finally {
            w.stop();
        }
    }

    @Test void partitionsAreEnsuredAndOldOnesDropped() {
        String old = "ship_position_" + LocalDate.now(ZoneOffset.UTC).minusDays(10).format(DateTimeFormatter.BASIC_ISO_DATE);
        LocalDate d = LocalDate.now(ZoneOffset.UTC).minusDays(10);
        DbTestSupport.exec("wakeline", "CREATE TABLE IF NOT EXISTS " + old + " PARTITION OF ship_position FOR VALUES FROM ('" + d + "') TO ('" + d.plusDays(1) + "')");
        MaintenanceJobs jobs = new MaintenanceJobs(DbTestSupport.apiClient(), PersistDbTest.PROPS,
                new RegionSettings(new org.springframework.data.redis.core.StringRedisTemplate(), DbTestSupport.apiClient(), DbTestSupport.JSON, PersistDbTest.PROPS),
                DbTestSupport.apiTx());
        jobs.ensurePartitions();
        String ahead = "ship_position_" + LocalDate.now(ZoneOffset.UTC).plusDays(3).format(DateTimeFormatter.BASIC_ISO_DATE);
        assertThat(admin.sql("SELECT count(*) FROM pg_class WHERE relname = :n").param("n", ahead).query(Long.class).single()).isEqualTo(1L);
        jobs.dropOldPartitions();
        assertThat(admin.sql("SELECT count(*) FROM pg_class WHERE relname = :n").param("n", old).query(Long.class).single()).isZero();
        Map<String, Object> fn = admin.sql("SELECT count(*) n FROM pg_proc WHERE proname LIKE 'ship_position_%' AND prosecdef").query().singleRow();
        assertThat(((Number) fn.get("n")).intValue()).isEqualTo(2);
    }
}
