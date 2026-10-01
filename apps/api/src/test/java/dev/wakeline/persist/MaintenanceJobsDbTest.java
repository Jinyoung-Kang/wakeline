package dev.wakeline.persist;

import dev.wakeline.DbTestSupport;
import dev.wakeline.domain.SigmetRecord;
import dev.wakeline.geo.GeoJson;
import dev.wakeline.platform.config.AppProperties;
import dev.wakeline.platform.data.OrderedWriter;
import dev.wakeline.platform.data.Sql;
import dev.wakeline.settings.RegionSettings;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIf;
import org.locationtech.jts.geom.Coordinate;
import org.locationtech.jts.geom.MultiPolygon;
import org.locationtech.jts.geom.Polygon;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.jdbc.core.simple.JdbcClient;

import java.time.Instant;
import java.time.LocalDate;
import java.time.temporal.ChronoUnit;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 정기 작업(MaintenanceJobs · StatsRepository)을 실제 PostGIS + 운영과 같은 DML 계정(wakeline_api)으로 검증한다: 하루 통계 규칙,
 * 요약 · 통계 따라잡기, 수집기 표 보존. PersistDbTest 에서 시험 대상 클래스별로 나눴다.
 */
@EnabledIf("dev.wakeline.DbTestSupport#dockerAvailable")
class MaintenanceJobsDbTest {
    static final Instant T0 = Instant.now().truncatedTo(ChronoUnit.SECONDS);
    static final AppProperties PROPS = DbTestSupport.PROPS;

    JdbcClient api;
    JdbcClient admin;
    SimpleMeterRegistry meters;
    OrderedWriter writer;
    SigmetRepository sigmets;

    @BeforeEach
    void setUp() {
        DbTestSupport.reset();
        api = DbTestSupport.apiClient();
        admin = DbTestSupport.admin();
        meters = new SimpleMeterRegistry();
        writer = new OrderedWriter(meters, 10, 20);
        sigmets = new SigmetRepository(api, DbTestSupport.JSON, writer);
    }

    // ---------- 도우미 ----------

    static MultiPolygon box(double lomin, double lamin, double lomax, double lamax) {
        Polygon p = GeoJson.GF.createPolygon(new Coordinate[]{new Coordinate(lomin, lamin), new Coordinate(lomax, lamin),
                new Coordinate(lomax, lamax), new Coordinate(lomin, lamax), new Coordinate(lomin, lamin)});
        return GeoJson.GF.createMultiPolygon(new Polygon[]{p});
    }

    static SigmetRecord sig(String id, String provider, String raw, Instant from, Instant to) {
        return new SigmetRecord(id, "RKRR", "RKRR INCHEON", "RKSI", id, "ICE", "SEV", 0, null, from, to, box(126, 35, 128, 37),
                null, null, null, null, raw, provider, T0, SigmetRecord.BASE_ASSUMED_SURFACE, SigmetRecord.TOP_UNKNOWN);
    }

    void insertAlert(long id, String hex, String sig, String kind, Instant entered, Instant left) {
        admin.sql("""
                INSERT INTO alert_event (id, hex, sigmet_id, kind, entered_at, left_at, evidence) VALUES (:id, :hex, :sig, :kind, :e, :l, '{}'::jsonb)""")
                .param("id", id).param("hex", hex).param("sig", sig).param("kind", kind).param("e", Sql.ts(entered)).param("l", Sql.ts(left)).update();
    }

    RegionSettings region() { return new RegionSettings(new StringRedisTemplate(), api, DbTestSupport.JSON, PROPS); }

    void trackPoint(String hex, Instant ts, double lat, double lon) {
        admin.sql("""
                INSERT INTO track_point (hex, ts, geom, alt_ft, provider, fetched_at)
                VALUES (:h, :t, ST_SetSRID(ST_MakePoint(:lon, :lat), 4326), 30000, 'adsb_lol', :t)""")
                .param("h", hex).param("t", Sql.ts(ts)).param("lat", lat).param("lon", lon).update();
    }

    // ---------- 통계 · 요약 ----------

    @Test
    void dailyStatsCountRegionTrafficIssueDaySigmetsAndHonestDwell() {
        LocalDate day = MaintenanceJobs.today().minusDays(1); // KST 날짜(계약 v5 §G20)
        Instant d0 = day.atStartOfDay(MaintenanceJobs.DAY_ZONE).toInstant();
        DbTestSupport.ensureTrackPartitions(d0, d0.plusSeconds(26 * 3600));
        sigmets.upsert(sig("X", "awc_isigmet", "X", d0.plusSeconds(20 * 3600), d0.plusSeconds(26 * 3600)));  // 그날 발표, 다음날까지
        sigmets.upsert(sig("Y", "awc_isigmet", "Y", d0.minusSeconds(2 * 3600), d0.plusSeconds(4 * 3600)));   // 전날 발표 → 그날 세지 않는다
        insertAlert(1, "b00001", "X", "OBSERVED", d0.plusSeconds(3600), d0.plusSeconds(3600 + 600));
        admin.sql("UPDATE alert_event SET close_reason = 'left' WHERE id = 1").update();
        insertAlert(2, "b00002", "X", "OBSERVED", d0.plusSeconds(3600), d0.plusSeconds(3600 + 60));
        admin.sql("UPDATE alert_event SET close_reason = 'signal_lost' WHERE id = 2").update();
        insertAlert(3, "b00003", "X", "OBSERVED", d0.plusSeconds(3600), d0.plusSeconds(3600 + 5));
        admin.sql("UPDATE alert_event SET close_reason = 'restart' WHERE id = 3").update();
        // DH-5·API-CONC-3: 사유 미기록(NULL)·경보 종료(sigmet_ended)·만료 뒤에 닫힌 옛 left 는 확인된 이탈이 아니다 — 평균에서 뺀다
        insertAlert(4, "b00004", "X", "OBSERVED", d0.plusSeconds(3600), d0.plusSeconds(3600 + 2000));
        insertAlert(5, "b00005", "X", "OBSERVED", d0.plusSeconds(3600), d0.plusSeconds(3600 + 3000));
        admin.sql("UPDATE alert_event SET close_reason = 'sigmet_ended' WHERE id = 5").update();
        insertAlert(6, "b00006", "X", "OBSERVED", d0.plusSeconds(3600), d0.plusSeconds(3600 + 4000));
        admin.sql("UPDATE alert_event SET close_reason = 'left', evidence = '{\"sigmet_expired\": true}'::jsonb WHERE id = 6").update();
        trackPoint("c00001", d0.plusSeconds(3600 + 30), 36.5, 127.8);   // 관심 지역 안
        trackPoint("c00002", d0.plusSeconds(3600 + 30), 0.5, 10.0);     // 전세계 표본 — 세지 않는다
        MaintenanceJobs jobs = new MaintenanceJobs(api, PROPS, region(), DbTestSupport.apiTx());

        jobs.aggregateDay(day);
        Map<String, Object> stats = new LinkedHashMap<>();
        for (var r : api.sql("SELECT metric || ':' || dim k, value FROM stats_daily WHERE day = :d").param("d", day).query().listOfRows())
            stats.put(String.valueOf(r.get("k")), ((Number) r.get("value")).doubleValue());
        assertThat(stats).containsEntry("sigmet_by_fir:RKRR", 1.0).containsEntry("traffic_by_hour:01", 1.0)
                .containsEntry("alert_dwell_avg_s:OBSERVED", 600.0).containsEntry("alerts_by_kind:OBSERVED", 6.0)
                .containsEntry("traffic_region:center_lat", 36.5).containsEntry("traffic_region:radius_nm", 250.0);
        var traffic = new StatsRepository(api).traffic(day);
        assertThat(traffic.region()).containsEntry("radius_nm", 250).containsEntry("center", List.of(36.5, 127.8));
        // DH-10: 집계가 실제로 센 사각형(같은 식으로 결정적으로 복원)
        var bb = new RegionSettings.Region(36.5, 127.8, 250).bbox();
        assertThat(traffic.region()).containsEntry("bbox", List.of(bb.lomin(), bb.lamin(), bb.lomax(), bb.lamax()));
        assertThat(new StatsRepository(api).traffic(day.minusDays(30)).region()).isNull(); // 지역 기록 없는 날 — 범위를 단정하지 않는다

        // 완료된(이탈) OBSERVED 가 없는 날: 체류 행을 만들지 않는다(0 을 지어내지 않는다)
        jobs.aggregateDay(day.minusDays(1));
        assertThat(api.sql("SELECT count(*) FROM stats_daily WHERE day = :d AND metric = 'alert_dwell_avg_s'").param("d", day.minusDays(1))
                .query(Long.class).single()).isZero();
        jobs.aggregateDay(day); // 멱등
        assertThat(api.sql("SELECT count(*) FROM stats_daily WHERE day = :d").param("d", day).query(Long.class).single())
                .isEqualTo((long) stats.size());
    }

    @Test
    void catchUpFillsOnlyMissingSummaryHoursAndStatsDays() {
        Instant now = Instant.now();
        Instant h2 = now.truncatedTo(ChronoUnit.HOURS).minus(2, ChronoUnit.HOURS);
        Instant h3 = h2.minus(1, ChronoUnit.HOURS);
        trackPoint("d00001", h2.plusSeconds(600), 36.5, 127.8);
        trackPoint("d00002", h3.plusSeconds(600), 36.5, 127.8);
        MaintenanceJobs jobs = new MaintenanceJobs(api, PROPS, region(), DbTestSupport.apiTx());
        jobs.summarizeHour(h3); // 이미 요약된 시간
        long before = admin.sql("SELECT count(*) FROM track_point_1m").query(Long.class).single();

        assertThat(jobs.catchUpSummaries(now)).containsExactly(h2);
        assertThat(admin.sql("SELECT count(*) FROM track_point_1m").query(Long.class).single()).isEqualTo(before + 1);
        assertThat(jobs.catchUpSummaries(now)).isEmpty(); // 멱등

        LocalDate today = MaintenanceJobs.today();
        // 이미 집계를 마친 날(R-46: 계열마다 완료 표식) — 따라잡기가 다시 세지 않는다
        admin.sql("INSERT INTO stats_daily (day, metric, dim, value) VALUES (:d, 'alerts_by_kind', 'OBSERVED', 1), "
                + "(:d, 'aggregated_at', 'sigmet', 1), (:d, 'aggregated_at', 'traffic', 1), (:d, 'aggregated_at', 'alerts', 1)").param("d", today.minusDays(2)).update();
        List<LocalDate> done = jobs.catchUpStats(today);
        assertThat(done).hasSize(MaintenanceJobs.CATCH_UP_DAYS - 1).doesNotContain(today.minusDays(2)).contains(today.minusDays(1), today.minusDays(7));
        assertThat(admin.sql("SELECT value FROM stats_daily WHERE day = :d AND metric = 'alerts_by_kind'").param("d", today.minusDays(2)).query(Long.class).single()).isEqualTo(1L);
    }

    @Test
    void retentionCanDeleteCollectorTables() {
        admin.sql("INSERT INTO radar_frame (frame_time, host, path, fetched_at) VALUES (now() - interval '8 days', 'h', '/p', now())").update();
        admin.sql("INSERT INTO ingest_run (job, provider, started_at, status) VALUES ('x', 'y', now() - interval '31 days', 'ok')").update();
        new MaintenanceJobs(api, PROPS, region(), DbTestSupport.apiTx()).dropOldPartitions();
        assertThat(admin.sql("SELECT count(*) FROM radar_frame").query(Long.class).single()).isZero();
        assertThat(admin.sql("SELECT count(*) FROM ingest_run").query(Long.class).single()).isZero();
    }
}
