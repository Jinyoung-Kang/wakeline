package dev.wakeline.history;

import dev.wakeline.DbTestSupport;
import dev.wakeline.platform.data.Sql;
import dev.wakeline.settings.RegionSettings;
import dev.wakeline.ships.data.ShipRepository;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIf;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.jdbc.core.simple.JdbcClient;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.time.temporal.ChronoUnit;
import java.util.concurrent.Callable;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * AWS 공개 데모 QA(2026-10-14 · api-data) — 결함 후보를 확인했지만 지금 맞게 동작하는 경계(통과하는 확인 시험 — 결함 아님). 시험이 없던 경로를 고정한다:
 * 항적 파티션 삭제 보류 상한(6 h)의 ±1분, 지정 보존 선박 점의 실제 시각 창(QA-702 의 선박판), 지정 보존 복사 둘이 겹쳐 돌 때.
 */
@EnabledIf("dev.wakeline.DbTestSupport#dockerAvailable")
class QaAwsApiDataChecksDbTest {
    JdbcClient api;
    JdbcClient admin;

    @BeforeEach
    void setUp() {
        DbTestSupport.reset();
        api = DbTestSupport.apiClient();
        admin = DbTestSupport.admin();
        admin.sql("DELETE FROM retained_track").update();
    }

    MaintenanceJobs jobs(Clock clock) {
        return new MaintenanceJobs(api, DbTestSupport.PROPS, new RegionSettings(new StringRedisTemplate(), api, DbTestSupport.JSON, DbTestSupport.PROPS),
                DbTestSupport.apiTx(), MaintenanceJobs.DEFAULT_ALERT_RETENTION_DAYS, clock);
    }

    static final class MovingClock extends Clock {
        Instant now;
        MovingClock(Instant now) { this.now = now; }
        @Override public java.time.ZoneId getZone() { return ZoneOffset.UTC; }
        @Override public Clock withZone(java.time.ZoneId zone) { return this; }
        @Override public Instant instant() { return now; }
    }

    boolean exists(String relation) {
        return admin.sql("SELECT to_regclass(:p) IS NOT NULL").param("p", relation).query(Boolean.class).single();
    }

    /** 첫 따라잡기 없이: 기동 + 6 h − 1분에는 미루고, 6 h 정각부터 지운다(상한 DROP_HOLD_MAX — `isBefore`). */
    @Test
    void theTrackPartitionDropHoldEndsExactlyAtSixHoursAfterStart() {
        LocalDate old = LocalDate.now(ZoneOffset.UTC).minusDays(6);
        Instant d0 = old.atStartOfDay(ZoneOffset.UTC).toInstant();
        String part = "track_point_" + old.format(DateTimeFormatter.BASIC_ISO_DATE);
        MovingClock clock = new MovingClock(Instant.now());
        Instant t0 = clock.now;
        MaintenanceJobs jobs = jobs(clock);

        DbTestSupport.ensureTrackPartitions(d0, d0);
        clock.now = t0.plus(MaintenanceJobs.DROP_HOLD_MAX).minus(Duration.ofMinutes(1));
        jobs.dropExpiredPartitions();
        assertThat(exists(part)).as("6 h − 1 min after start: kept").isTrue();
        clock.now = t0.plus(MaintenanceJobs.DROP_HOLD_MAX);
        jobs.dropExpiredPartitions();
        assertThat(exists(part)).as("6 h after start: dropped").isFalse();
        DbTestSupport.ensureTrackPartitions(d0, d0);
        clock.now = t0.plus(MaintenanceJobs.DROP_HOLD_MAX).plus(Duration.ofMinutes(1));
        jobs.dropExpiredPartitions();
        assertThat(exists(part)).as("6 h + 1 min after start: dropped").isFalse();
    }

    /** QA-702 의 선박판: 지정 보존 선박 점도 실제 시각(ts)으로 [from, to] — 분 머리로 거르지 않는다. */
    @Test
    void retainedShipPointsAreFilteredByTheirActualTime() {
        Instant minute = Instant.parse("2026-01-10T10:05:00Z");
        admin.sql("""
                INSERT INTO retained_track (kind, target_id, ts_minute, ts, geom, sog_kn, cog_deg, provider)
                VALUES ('ship', '440000001', :m, :t, ST_SetSRID(ST_MakePoint(129, 35), 4326), 12.5, 180, 'aisstream')""")
                .param("m", Sql.ts(minute)).param("t", Sql.ts(minute.plusSeconds(40))).update();
        ShipRepository ships = new ShipRepository(null, api);
        assertThat(ships.retainedTrack("440000001", minute.minusSeconds(600), minute.plusSeconds(10), 100)).as("a point after `to`").isEmpty();
        assertThat(ships.retainedTrack("440000001", minute.plusSeconds(30), minute.plusSeconds(600), 100)).as("a point after `from` in the same minute").hasSize(1);
        assertThat(ships.retainedTrack("440000001", minute.plusSeconds(40), minute.plusSeconds(40), 100)).as("from = to = ts (closed range)").hasSize(1);
    }

    /** 매시 복사(:05)와 따라잡기 복사가 같은 분을 동시에 옮겨도 오류 없이 한 번만(ON CONFLICT DO NOTHING · 고유 키 대기). */
    @Test
    void twoRetainedCopiesAtOnceInsertEachMinuteOnce() throws Exception {
        Instant hour = Instant.now().truncatedTo(ChronoUnit.HOURS).minus(2, ChronoUnit.HOURS);
        DbTestSupport.ensureTrackPartitions(hour, hour.plus(1, ChronoUnit.HOURS));
        admin.sql("UPDATE app_setting SET value = to_jsonb('71be01'::text) WHERE key = 'retain_targets'").update();
        admin.sql("""
                INSERT INTO track_point (hex, ts, geom, alt_ft, provider, fetched_at)
                SELECT '71be01', :h::timestamptz + make_interval(secs => s * 10), ST_SetSRID(ST_MakePoint(127, 37.5), 4326), 30000, 'adsb_lol', now()
                FROM generate_series(0, 359) s""").param("h", Sql.ts(hour)).update(); // 1시간 · 10 s 간격 — 60분
        MaintenanceJobs a = jobs(Clock.systemUTC()), b = jobs(Clock.systemUTC());
        CountDownLatch go = new CountDownLatch(1);
        ExecutorService pool = Executors.newFixedThreadPool(2);
        try {
            Callable<Integer> ca = () -> { go.await(); return a.copyRetained(hour, hour.plus(1, ChronoUnit.HOURS)); };
            Callable<Integer> cb = () -> { go.await(); return b.copyRetained(hour, hour.plus(1, ChronoUnit.HOURS)); };
            Future<Integer> fa = pool.submit(ca), fb = pool.submit(cb);
            go.countDown();
            int n = fa.get() + fb.get();
            assertThat(n).as("rows inserted by both copies together").isEqualTo(60);
        } finally {
            pool.shutdownNow();
        }
        assertThat(admin.sql("SELECT count(*) FROM retained_track WHERE target_id = '71be01'").query(Long.class).single()).isEqualTo(60L);
        assertThat(admin.sql("SELECT count(*) FROM retained_track WHERE ts <> ts_minute").query(Long.class).single())
                .as("each minute keeps its first fix (ss = 00)").isZero();
    }
}
