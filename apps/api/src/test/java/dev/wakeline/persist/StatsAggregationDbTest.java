package dev.wakeline.persist;

import dev.wakeline.DbTestSupport;
import dev.wakeline.ops.RegionSettings;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIf;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.jdbc.core.simple.JdbcClient;

import java.time.LocalDate;
import java.time.ZoneOffset;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * R-46: 일 통계 '집계 완료' 는 행이 있는지가 아니라 완료 표식(stats_daily metric 'aggregated_at', dim = 계열)으로 판단한다.
 * 자료가 없는 날도 한 번 집계하면 끝나고(이전: 따라잡기마다 영원히 다시), 원본이 보존으로 사라진 계열은 다시 세지 않는다(이전: 0·빈 값으로 덮음).
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
        LocalDate today = LocalDate.now(ZoneOffset.UTC);
        MaintenanceJobs jobs = jobs();
        assertThat(jobs.catchUpStats(today)).hasSize(MaintenanceJobs.CATCH_UP_DAYS); // 아무 자료도 없는 7일
        assertThat(jobs.catchUpStats(today)).as("already aggregated — even though they produced no rows").isEmpty();
    }

    @Test
    void trafficOfADayWhoseRawTrackDataIsGoneIsKeptOnReaggregation() {
        LocalDate old = LocalDate.now(ZoneOffset.UTC).minusDays(5); // 원해상도 보존(72 h) 밖 — 파티션이 이미 지워졌다
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
        LocalDate today = LocalDate.now(ZoneOffset.UTC);
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

    List<String> markers(LocalDate d) {
        return admin.sql("SELECT dim FROM stats_daily WHERE day = :d AND metric = 'aggregated_at'").param("d", d).query(String.class).list();
    }
}
