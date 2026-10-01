package dev.wakeline.history;

import dev.wakeline.DbTestSupport;
import dev.wakeline.settings.RegionSettings;
import dev.wakeline.platform.data.Sql;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIf;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.jdbc.core.simple.JdbcClient;

import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.SQLException;
import java.sql.Statement;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.time.temporal.ChronoUnit;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 보존(R-06, ADR-017 §2): 항적·선박 위치 파티션은 파티션 전체가 보존 기간(72 h)보다 오래되는 순간 지운다(이전 규칙은 하루를 더 남겨 99–123 h),
 * 끝난 알림은 30일 보존(열린 알림은 남긴다), 보존 밖 날의 알림 통계는 재집계가 지우지 않는다(원본이 없으니 다시 셀 수 없다).
 */
@EnabledIf("dev.wakeline.DbTestSupport#dockerAvailable")
class RetentionDbTest {
    JdbcClient api;
    JdbcClient admin;

    @BeforeEach
    void setUp() {
        DbTestSupport.reset();
        api = DbTestSupport.apiClient();
        admin = DbTestSupport.admin();
    }

    static String partition(String table, LocalDate d) { return table + "_" + d.format(DateTimeFormatter.BASIC_ISO_DATE); }

    static void asMigrator(String sql) throws SQLException {
        try (Connection c = DriverManager.getConnection(DbTestSupport.jdbcUrl("wakeline"), "wakeline_migrator", DbTestSupport.MIGRATOR_PW);
             Statement s = c.createStatement()) {
            s.execute(sql);
        }
    }

    long exists(String relname) {
        return admin.sql("SELECT count(*) FROM pg_class WHERE relname = :n").param("n", relname).query(Long.class).single();
    }

    MaintenanceJobs jobs() {
        return new MaintenanceJobs(api, DbTestSupport.PROPS, new RegionSettings(new StringRedisTemplate(), api, DbTestSupport.JSON, DbTestSupport.PROPS),
                DbTestSupport.apiTx());
    }

    /**
     * 파티션 [d, d+1) 의 끝(d+1 00:00 UTC)이 now − 72 h 이전이면 그 파티션의 모든 행이 72 h 보다 오래됐다 → 지운다.
     * 오늘 − 4일 파티션: 끝 = 오늘 − 3일 00:00 → 나이 ≥ 72 h → 지운다(이전 규칙은 cutoff = (now − 72 h)::date − 1 = 오늘 − 4일 이라 남겼다).
     * 오늘 − 3일 파티션: 끝의 나이 48–72 h → 72 h 안의 행이 있으므로 남긴다.
     */
    @Test
    void partitionsAreDroppedAsSoonAsTheirWholeDayIsOlderThanTheRetention() throws SQLException {
        LocalDate today = LocalDate.now(ZoneOffset.UTC);
        for (String table : new String[]{"track_point", "ship_position"}) {
            for (int back : new int[]{4, 3}) {
                LocalDate d = today.minusDays(back);
                asMigrator("CREATE TABLE IF NOT EXISTS " + partition(table, d) + " PARTITION OF " + table
                        + " FOR VALUES FROM ('" + d + "') TO ('" + d.plusDays(1) + "')");
            }
        }
        assertThat(api.sql("SELECT track_point_drop_old(72)").query(Integer.class).single()).isGreaterThanOrEqualTo(1);
        assertThat(api.sql("SELECT ship_position_drop_old(72)").query(Integer.class).single()).isGreaterThanOrEqualTo(1);
        for (String table : new String[]{"track_point", "ship_position"}) {
            assertThat(exists(partition(table, today.minusDays(4)))).as(table + " day −4 (all rows ≥ 72 h old) dropped").isZero();
            assertThat(exists(partition(table, today.minusDays(3)))).as(table + " day −3 (has rows < 72 h old) kept").isEqualTo(1);
            assertThat(exists(partition(table, today))).as(table + " today kept").isEqualTo(1);
        }
    }

    @Test
    void theHourlyJobDropsExpiredPartitionsWithoutTheDailyRetention() throws SQLException {
        LocalDate old = LocalDate.now(ZoneOffset.UTC).minusDays(5);
        asMigrator("CREATE TABLE IF NOT EXISTS " + partition("track_point", old) + " PARTITION OF track_point FOR VALUES FROM ('" + old + "') TO ('" + old.plusDays(1) + "')");
        admin.sql("INSERT INTO radar_frame (frame_time, host, path, fetched_at) VALUES (now() - interval '8 days', 'h', '/p', now())").update();
        jobs().dropExpiredPartitions();
        assertThat(exists(partition("track_point", old))).isZero();
        assertThat(admin.sql("SELECT count(*) FROM radar_frame").query(Long.class).single()).as("daily retention is not part of the hourly job").isEqualTo(1L);
    }

    void sigmet(String id) {
        admin.sql("""
                INSERT INTO sigmet (id, fir_id, series_id, hazard, valid_from, valid_to, raw_text, provider, fetched_at)
                VALUES (:id, 'RKRR', '1', 'TS', now() - interval '60 days', now() - interval '59 days', 'r', 'awc', now()) ON CONFLICT DO NOTHING""")
                .param("id", id).update();
    }

    void alert(long id, Instant entered, Instant left) {
        admin.sql("INSERT INTO alert_event (id, hex, sigmet_id, kind, entered_at, left_at, evidence) VALUES (:id, :hex, 'S-RET', 'OBSERVED', :e, :l, '{}'::jsonb)")
                .param("id", id).param("hex", "abc12" + id).param("e", Sql.ts(entered)).param("l", Sql.ts(left)).update();
    }

    @Test
    void closedAlertsOlderThan30DaysAreDeletedButOpenAndRecentOnesStay() {
        sigmet("S-RET");
        Instant now = Instant.now().truncatedTo(ChronoUnit.SECONDS);
        alert(1, now.minus(40, ChronoUnit.DAYS), now.minus(40, ChronoUnit.DAYS).plusSeconds(600));   // 끝난 지 40일 → 지운다
        alert(2, now.minus(31, ChronoUnit.DAYS), now.minus(31, ChronoUnit.DAYS).plusSeconds(60));    // 31일 → 지운다
        alert(3, now.minus(40, ChronoUnit.DAYS), null);                                               // 열린 알림 → 남긴다
        alert(4, now.minus(31, ChronoUnit.DAYS), now.minus(29, ChronoUnit.DAYS));                    // 끝난 지 29일 → 남긴다
        alert(5, now.minus(1, ChronoUnit.DAYS), now.minus(1, ChronoUnit.DAYS).plusSeconds(60));      // 어제 → 남긴다

        jobs().dropOldPartitions();

        assertThat(admin.sql("SELECT id FROM alert_event ORDER BY id").query(Long.class).list()).containsExactly(3L, 4L, 5L);
    }

    @Test
    void reaggregatingADayOutsideTheAlertRetentionKeepsItsAlertStats() {
        LocalDate old = MaintenanceJobs.today().minusDays(40);
        admin.sql("""
                INSERT INTO stats_daily (day, metric, dim, value) VALUES
                  (:d, 'alerts_by_kind', 'OBSERVED', 120), (:d, 'alert_dwell_avg_s', 'OBSERVED', 640)""").param("d", old).update();
        jobs().aggregateDay(old); // 그날의 알림 행은 보존으로 이미 지워졌다 — 다시 세면 0 이 된다

        assertThat(admin.sql("SELECT metric || ':' || value::int FROM stats_daily WHERE day = :d AND metric <> 'aggregated_at' ORDER BY metric").param("d", old).query(String.class).list())
                .containsExactly("alert_dwell_avg_s:640", "alerts_by_kind:120");
    }
}
