package dev.wakeline.persist;

import dev.wakeline.DbTestSupport;
import dev.wakeline.settings.RegionSettings;
import dev.wakeline.platform.data.Sql;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIf;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.jdbc.core.simple.JdbcClient;

import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * R-46: 일 통계 '집계 완료' 는 행이 있는지가 아니라 완료 표식(stats_daily metric 'aggregated_at', dim = 계열)으로 판단한다.
 * 자료가 없는 날도 한 번 집계하면 끝나고(이전: 따라잡기마다 영원히 다시), 원본이 보존으로 사라진 계열은 다시 세지 않는다(이전: 0·빈 값으로 덮음).
 * 계약 v5 §G20: 하루 = KST 날짜(Asia/Seoul 00:00–24:00). '오늘' · '끝난 날' · 보존 경계도 KST 날짜로 센다.
 */
@EnabledIf("dev.wakeline.DbTestSupport#dockerAvailable")
class StatsAggregationDbTest {
    JdbcClient api;
    JdbcClient admin;

    @BeforeEach
    void setUp() {
        DbTestSupport.reset();
        api = DbTestSupport.apiClient();
        admin = DbTestSupport.admin();
    }

    MaintenanceJobs jobs() {
        return new MaintenanceJobs(api, PersistDbTest.PROPS, new RegionSettings(new StringRedisTemplate(), api, DbTestSupport.JSON, PersistDbTest.PROPS),
                DbTestSupport.apiTx());
    }

    /** 시계를 고정한 잡(보존 경계 · '오늘' 이 이 시계를 따른다) */
    MaintenanceJobs jobs(Clock clock) {
        return new MaintenanceJobs(api, PersistDbTest.PROPS, new RegionSettings(new StringRedisTemplate(), api, DbTestSupport.JSON, PersistDbTest.PROPS),
                DbTestSupport.apiTx(), MaintenanceJobs.DEFAULT_ALERT_RETENTION_DAYS, clock);
    }

    static Clock kstClock(LocalDate day, int hour) {
        return Clock.fixed(day.atTime(hour, 0).atZone(MaintenanceJobs.DAY_ZONE).toInstant(), ZoneOffset.UTC);
    }

    @Test
    void daysWithoutDataAreAggregatedOnceNotOnEveryCatchUp() {
        LocalDate today = LocalDate.now(MaintenanceJobs.DAY_ZONE);
        MaintenanceJobs jobs = jobs();
        assertThat(jobs.catchUpStats(today)).hasSize(MaintenanceJobs.CATCH_UP_DAYS); // 아무 자료도 없는 7일
        assertThat(jobs.catchUpStats(today)).as("already aggregated — even though they produced no rows").isEmpty();
    }

    @Test
    void trafficOfADayWhoseRawTrackDataIsGoneIsKeptOnReaggregation() {
        LocalDate old = LocalDate.now(MaintenanceJobs.DAY_ZONE).minusDays(5); // 원해상도 보존(72 h) 밖 — 파티션이 이미 지워졌다
        admin.sql("""
                INSERT INTO stats_daily (day, metric, dim, value) VALUES
                  (:d, 'traffic_by_hour', '10', 42), (:d, 'traffic_region', 'center_lat', 36.5), (:d, 'traffic_region', 'center_lon', 127.8),
                  (:d, 'traffic_region', 'radius_nm', 250)""").param("d", old).update();
        jobs().aggregateDay(old);
        assertThat(admin.sql("SELECT value::int FROM stats_daily WHERE day = :d AND metric = 'traffic_by_hour' AND dim = '10'").param("d", old)
                .query(Integer.class).optional()).contains(42);
        assertThat(admin.sql("SELECT count(*) FROM stats_daily WHERE day = :d AND metric = 'traffic_region'").param("d", old).query(Long.class).single())
                .isEqualTo(3L);
    }

    @Test
    void completionMarkersArePerFamilyAndOnlyForFinishedDays() {
        LocalDate today = LocalDate.now(MaintenanceJobs.DAY_ZONE);
        MaintenanceJobs jobs = jobs();
        jobs.aggregateDay(today.minusDays(1));
        assertThat(markers(today.minusDays(1))).containsExactlyInAnyOrder("alerts", "sigmet", "traffic");
        jobs.aggregateDay(today); // 오늘은 아직 끝나지 않았다 — 부분 집계는 완료로 남지 않는다(다음 날 다시 센다)
        assertThat(markers(today)).isEmpty();
        jobs.aggregateDay(today.minusDays(5)); // 원해상도 보존 밖: traffic 은 다시 셀 수 없다 — 완료 표식도 남기지 않는다
        assertThat(markers(today.minusDays(5))).containsExactlyInAnyOrder("alerts", "sigmet");
        assertThat(jobs.catchUpStats(today)).as("the rest of the window").doesNotContain(today.minusDays(1), today.minusDays(5));
        assertThat(jobs.catchUpStats(today)).isEmpty();
    }

    /**
     * 계약 v5 §G20(사용자 결정 2026-09-30 "UTC 지우고 KST"): 하루는 KST 날짜 — 경계는 KST 자정(= UTC 15:00). 시간대별 교통량의 시(dim)는 KST 시.
     * 수정 전(UTC 날짜 집계)에는 KST 00:00–08:59 의 발표 · 진입 · 항적이 전날에, UTC 15:00 뒤(KST 다음 날)가 그날에 들어갔다 — 이 시험이 실패했다.
     */
    @Test
    void aDayIsTheKstDay_boundariesAreKstMidnightAndTrafficHoursAreKstHours() {
        LocalDate day = LocalDate.now(MaintenanceJobs.DAY_ZONE).minusDays(1);
        Instant k0 = day.atStartOfDay(MaintenanceJobs.DAY_ZONE).toInstant(); // KST 00:00 = 전날 15:00 UTC
        DbTestSupport.ensureTrackPartitions(k0.minusSeconds(3600), k0.plusSeconds(26 * 3600));
        // SIGMET 은 발표일(valid_from 의 KST 날짜)로 센다 — FIR 이름으로 어느 쪽에 들어갔는지 본다
        sigmet("S_PREV", "PREV", k0.minusSeconds(1));                   // 전날 23:59:59 KST
        sigmet("S_FIRST", "FRST", k0);                                  // 그날 00:00 KST(UTC 로는 전날 15:00)
        sigmet("S_LAST", "LAST", k0.plusSeconds(24 * 3600 - 1));        // 그날 23:59:59 KST
        sigmet("S_NEXT", "NEXT", k0.plusSeconds(24 * 3600));            // 다음 날 00:00 KST(UTC 로는 그날 15:00)
        alert(1, "S_FIRST", k0.plusSeconds(1));                         // 그날
        alert(2, "S_PREV", k0.minusSeconds(1));                         // 전날
        track("e00001", k0.plusSeconds(30 * 60));                       // 00:30 KST
        track("e00002", k0.plusSeconds(23 * 3600 + 30 * 60));           // 23:30 KST
        track("e00003", k0.plusSeconds(24 * 3600 + 30 * 60));           // 다음 날 00:30 KST
        jobs().aggregateDay(day);
        Map<String, Integer> st = new LinkedHashMap<>();
        for (var r : admin.sql("SELECT metric || ':' || dim k, value::int v FROM stats_daily WHERE day = :d AND metric <> 'aggregated_at' AND metric <> 'traffic_region'")
                .param("d", day).query().listOfRows()) st.put((String) r.get("k"), ((Number) r.get("v")).intValue());
        assertThat(st).containsExactlyInAnyOrderEntriesOf(Map.of(
                "sigmet_by_fir:FRST", 1, "sigmet_by_fir:LAST", 1, "sigmet_by_hazard:TS", 2,
                "traffic_by_hour:00", 1, "traffic_by_hour:23", 1,
                "alerts_by_kind:OBSERVED", 1, "alert_dwell_avg_s:OBSERVED", 60)); // 그날 진입해 이탈이 확인된 알림 하나(60 s)
        assertThat(markers(day)).containsExactlyInAnyOrder("alerts", "sigmet", "traffic"); // 끝난 KST 날
        jobs().aggregateDay(day.plusDays(1)); // 오늘(KST) — 끝나지 않아 표식 없음
        assertThat(markers(day.plusDays(1))).isEmpty();
    }

    /**
     * 리뷰(2026-09-30, high): 원해상도 항적은 UTC 날 파티션에 있고 UTC 날 단위로 지워진다(V9 track_point_drop_old — 파티션 끝 ≤ now − 72 h).
     * KST 날짜 D 의 00:00–08:59 KST 는 UTC 날 D−1 파티션에 있어, 그 파티션은 D 의 끝(다음 날 00:00 KST)보다 15시간 먼저 지워진다.
     * 수정 전에는 재집계 가능 여부를 D 의 끝으로 판단해, 매일 09:00–24:00 KST 에 D = 오늘−3 을 다시 세면 00–08시가 빠진 교통량을 완료로 남겼다
     * (V16 배포 1분 뒤의 따라잡기가 바로 그날을 센다) — 이 시험이 실패했다. 이제 그날 첫 순간이 든 UTC 파티션이 보존 안일 때만 다시 센다.
     */
    @Test
    void trafficIsNotRecountedOnceTheUtcPartitionHoldingTheKstDaysFirstHoursIsGone() {
        LocalDate day = LocalDate.now(MaintenanceJobs.DAY_ZONE).minusDays(3);
        Instant k0 = day.atStartOfDay(MaintenanceJobs.DAY_ZONE).toInstant(); // D 00:00 KST = D−1 15:00 UTC
        DbTestSupport.ensureTrackPartitions(k0, k0.plusSeconds(24 * 3600 - 1));
        track("e00001", k0.plusSeconds(30 * 60));             // 00:30 KST — UTC 날 D−1 파티션
        track("e00002", k0.plusSeconds(10 * 3600 + 30 * 60)); // 10:30 KST — UTC 날 D 파티션
        admin.sql("INSERT INTO stats_daily (day, metric, dim, value) VALUES (:d, 'traffic_by_hour', '00', 1), (:d, 'traffic_by_hour', '10', 1)")
                .param("d", day).update(); // 두 파티션이 모두 있을 때 센 값
        // D+3 14:00 KST: 보존 경계 = D 05:00 UTC — UTC 날 D−1 파티션(끝 D 00:00 UTC)은 보존 삭제가 지웠다, D 파티션은 남았다
        dropTrackPartition(LocalDate.ofInstant(k0, ZoneOffset.UTC));
        MaintenanceJobs afternoon = jobs(kstClock(day.plusDays(3), 14));
        assertThat(afternoon.families(day)).doesNotContain(MaintenanceJobs.FAMILY_TRAFFIC);
        afternoon.aggregateDay(day);
        assertThat(trafficByHour(day)).as("a partial recount must not replace the full one").containsExactlyInAnyOrderEntriesOf(Map.of("00", 1, "10", 1));
        assertThat(markers(day)).containsExactlyInAnyOrder("sigmet", "alerts");
        // 경계 양쪽: D+3 08:59 KST(경계 D−1 23:59 UTC)에는 D−1 파티션이 아직 보존 안 — 다시 셀 수 있다. 09:00 KST 부터는 아니다.
        Clock before = Clock.fixed(day.plusDays(3).atTime(8, 59, 59).atZone(MaintenanceJobs.DAY_ZONE).toInstant(), ZoneOffset.UTC);
        assertThat(jobs(before).families(day)).contains(MaintenanceJobs.FAMILY_TRAFFIC);
        assertThat(jobs(kstClock(day.plusDays(3), 9)).families(day)).doesNotContain(MaintenanceJobs.FAMILY_TRAFFIC);
        assertThat(jobs(kstClock(day.plusDays(3), 23)).families(day)).doesNotContain(MaintenanceJobs.FAMILY_TRAFFIC);
    }

    /**
     * 판단(시계)과 읽기 사이에 보존 삭제가 끼지 않는다: 교통량을 다시 셀 때 트랜잭션 처음에 부모 track_point 를 ACCESS SHARE 로 잡는다 —
     * 파티션 DROP 은 부모의 ACCESS EXCLUSIVE 를 기다려야 하므로(PostgreSQL heap_drop_with_catalog) 집계가 끝날 때까지 지워지지 않는다.
     */
    @Test
    void aPartitionDropWaitsWhileATransactionHoldsTheParentTrackPointLock() {
        LocalDate utcDay = LocalDate.now(ZoneOffset.UTC).minusDays(1);
        DbTestSupport.ensureTrackPartitions(utcDay.atStartOfDay(ZoneOffset.UTC).toInstant(), utcDay.atStartOfDay(ZoneOffset.UTC).toInstant());
        String part = "track_point_" + utcDay.format(DateTimeFormatter.BASIC_ISO_DATE);
        DbTestSupport.apiTx().executeWithoutResult(status -> {
            MaintenanceJobs.lockTrackPoint(api);
            assertThatThrownBy(() -> admin.sql("DO $$ BEGIN SET LOCAL lock_timeout = '300ms'; EXECUTE 'DROP TABLE " + part + "'; END $$").update())
                    .hasMessageContaining("lock timeout");
        });
        assertThat(admin.sql("SELECT to_regclass(:p) IS NOT NULL").param("p", part).query(Boolean.class).single()).isTrue();
    }

    /**
     * 리뷰(2026-09-30, low): V16 이 KST 날짜 표를 비운 뒤 따라잡기는 최근 7일만 다시 셌다 — 원본이 남아 있는 더 오래된 SIGMET(영구) · 알림(30일) 날은
     * 다시 셀 수 있는데도 '집계되지 않음' 으로 남았다(/stats 는 92일 범위까지 받는다). 수정 전 이 시험이 실패했다. 이제 따라잡기가 그 날들을 채운다
     * (교통량은 72 h 보존이라 다시 셀 수 없다 — 표식 없음 그대로).
     */
    @Test
    void catchUpBackfillsOlderSigmetAndAlertDaysWhoseSourcesAreStillKept() {
        LocalDate today = LocalDate.now(MaintenanceJobs.DAY_ZONE);
        LocalDate twenty = today.minusDays(20), forty = today.minusDays(40);
        sigmet("S_20", "FT20", twenty.atTime(12, 0).atZone(MaintenanceJobs.DAY_ZONE).toInstant());
        sigmet("S_40", "FT40", forty.atTime(12, 0).atZone(MaintenanceJobs.DAY_ZONE).toInstant());
        alert(1, "S_20", twenty.atTime(12, 30).atZone(MaintenanceJobs.DAY_ZONE).toInstant());
        MaintenanceJobs jobs = jobs(Clock.systemUTC());
        jobs.catchUp();
        assertThat(count(twenty, "sigmet_by_fir")).isEqualTo(1);
        assertThat(count(twenty, "alerts_by_kind")).isEqualTo(1);
        assertThat(markers(twenty)).containsExactlyInAnyOrder("sigmet", "alerts"); // 교통량은 다시 셀 수 없다
        assertThat(count(forty, "sigmet_by_fir")).isEqualTo(1);
        assertThat(markers(forty)).containsExactly("sigmet"); // 알림 보존(30일) 밖
        assertThat(markers(forty.minusDays(1))).as("before the first source day").isEmpty();
        assertThat(jobs.backfillStats(today)).as("idempotent — every re-countable family is marked").isEmpty();
    }

    long count(LocalDate d, String metric) {
        return admin.sql("SELECT coalesce(sum(value), 0)::bigint FROM stats_daily WHERE day = :d AND metric = :m").param("d", d).param("m", metric).query(Long.class).single();
    }

    Map<String, Integer> trafficByHour(LocalDate d) {
        Map<String, Integer> m = new LinkedHashMap<>();
        for (var r : admin.sql("SELECT dim, value::int v FROM stats_daily WHERE day = :d AND metric = 'traffic_by_hour'").param("d", d).query().listOfRows())
            m.put((String) r.get("dim"), ((Number) r.get("v")).intValue());
        return m;
    }

    void dropTrackPartition(LocalDate utcDay) {
        admin.sql("DROP TABLE IF EXISTS track_point_" + utcDay.format(DateTimeFormatter.BASIC_ISO_DATE)).update();
    }

    void sigmet(String id, String fir, Instant validFrom) {
        admin.sql("""
                INSERT INTO sigmet (id, fir_id, series_id, hazard, valid_from, valid_to, raw_text, provider, fetched_at)
                VALUES (:id, :fir, '1', 'TS', :f, :f::timestamptz + interval '4 hours', 'r', 'awc', now())""")
                .param("id", id).param("fir", fir).param("f", Sql.ts(validFrom)).update();
    }

    void alert(int id, String sigmetId, Instant entered) {
        admin.sql("""
                INSERT INTO alert_event (id, hex, sigmet_id, kind, entered_at, left_at, close_reason, evidence)
                VALUES (:id, 'f0000' || :id, :s, 'OBSERVED', :e, :e::timestamptz + interval '60 seconds', 'left', '{}'::jsonb)""")
                .param("id", id).param("s", sigmetId).param("e", Sql.ts(entered)).update();
    }

    void track(String hex, Instant ts) {
        admin.sql("""
                INSERT INTO track_point (hex, ts, geom, alt_ft, provider, fetched_at)
                VALUES (:h, :t, ST_SetSRID(ST_MakePoint(127.8, 36.5), 4326), 30000, 'adsb_lol', :t)""")
                .param("h", hex).param("t", Sql.ts(ts)).update();
    }

    List<String> markers(LocalDate d) {
        return admin.sql("SELECT dim FROM stats_daily WHERE day = :d AND metric = 'aggregated_at'").param("d", d).query(String.class).list();
    }

    /**
     * 리뷰 cto-2026-10 D5(B8): 같은 날의 재집계 둘(03:30 정시 · 3시간 따라잡기 · 운영 POST — 스케줄러 16 스레드)이 겹친다. READ COMMITTED 에서 둘 다 그날의 행을
     * 지운 뒤(서로의 커밋 전 INSERT 는 보이지 않는다) 완료 표식을 넣으면 뒤의 것이 (day, metric, dim) 기본 키에서 23505 로 실패했다(운영 POST 는 500).
     * 겹침을 확실히 만든다: 시험이 stats_daily 를 EXCLUSIVE 로 잡아 두 트랜잭션을 기다리게 한 뒤(고치기 전: 둘 다 첫 DELETE 에서 · 고친 뒤: 하나는 DELETE,
     * 하나는 그날의 트랜잭션 잠금에서) 놓는다.
     */
    @Test
    void twoAggregationsOfTheSameDayAtOnceBothSucceed() throws Exception {
        LocalDate day = LocalDate.now(MaintenanceJobs.DAY_ZONE).minusDays(1);
        MaintenanceJobs a = jobs(), b = jobs();
        java.util.concurrent.ExecutorService pool = java.util.concurrent.Executors.newFixedThreadPool(2);
        try (java.sql.Connection lock = java.sql.DriverManager.getConnection(DbTestSupport.jdbcUrl("wakeline"), "postgres", DbTestSupport.ROOT_PW)) {
            lock.setAutoCommit(false);
            try (var st = lock.createStatement()) { st.execute("LOCK TABLE stats_daily IN EXCLUSIVE MODE"); }
            var fa = pool.submit(() -> a.aggregateDay(day));
            var fb = pool.submit(() -> b.aggregateDay(day));
            long until = System.currentTimeMillis() + 10_000;
            while (waitingAggregations() < 2 && System.currentTimeMillis() < until) Thread.sleep(10);
            assertThat(waitingAggregations()).as("both aggregations are waiting").isEqualTo(2);
            lock.commit(); // 둘을 함께 놓는다
            fa.get(30, java.util.concurrent.TimeUnit.SECONDS);
            fb.get(30, java.util.concurrent.TimeUnit.SECONDS);  // 수정 전: ExecutionException ← DuplicateKeyException(23505)
        } finally {
            pool.shutdownNow();
        }
        assertThat(markers(day)).containsExactlyInAnyOrder("alerts", "sigmet", "traffic");
    }

    /** 기다리는 잠금 수: stats_daily(시험이 잡은 표) 또는 권고 잠금(그날의 재집계 차례). */
    long waitingAggregations() {
        return admin.sql("SELECT count(*) FROM pg_locks l LEFT JOIN pg_class c ON c.oid = l.relation"
                + " WHERE NOT l.granted AND (c.relname = 'stats_daily' OR l.locktype = 'advisory')").query(Long.class).single();
    }
}
