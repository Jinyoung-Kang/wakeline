package dev.wakeline.persist;

import dev.wakeline.DbTestSupport;
import dev.wakeline.ops.RegionSettings;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIf;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.jdbc.core.simple.JdbcClient;

import java.time.Instant;
import java.time.LocalDate;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * R-46: 일 통계 '집계 완료' 는 행이 있는지가 아니라 완료 표식(stats_daily metric 'aggregated_at', dim = 계열)으로 판단한다.
 * 자료가 없는 날도 한 번 집계하면 끝나고(이전: 따라잡기마다 영원히 다시), 원본이 보존으로 사라진 계열은 다시 세지 않는다(이전: 0·빈 값으로 덮음).
 * 계약 v5 §G19: 하루 = KST 날짜(Asia/Seoul 00:00–24:00). '오늘' · '끝난 날' · 보존 경계도 KST 날짜로 센다.
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
     * 계약 v5 §G19(사용자 결정 2026-09-30 "UTC 지우고 KST"): 하루는 KST 날짜 — 경계는 KST 자정(= UTC 15:00). 시간대별 교통량의 시(dim)는 KST 시.
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
}
