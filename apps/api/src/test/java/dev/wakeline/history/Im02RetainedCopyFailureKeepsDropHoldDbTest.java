package dev.wakeline.history;

import dev.wakeline.DbTestSupport;
import dev.wakeline.platform.data.Sql;
import dev.wakeline.settings.RegionSettings;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIf;
import org.springframework.dao.QueryTimeoutException;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.jdbc.core.simple.JdbcClient;

import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.Statement;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * IM-02(코드 리뷰 2026-10 · 데이터 손실 조건부): 기동 뒤 첫 따라잡기에서 요약 · 통계는 되고 지정 보존 복사만 실패해도(공유 RDS 풀 대기 · 57014 · 연결
 * 끊김) runCatchUp 이 성공을 돌려 catchUpOkAt 이 채워졌다. 항적 · 선박 위치 파티션 삭제 보류는 그것만 보았으므로 다음 :02 에 풀렸다. 다음 전체 창 복사는
 * 성공 3 h 뒤이고 매시 복사는 닫힌 3시간만 옮긴다. 그래서 4일 넘는 정지(금 18:00 → 화 08:50 KST) 뒤에는 정지 직전 시간(17–18시 KST — 그날 매시 복사가
 * 옮기지 못한 시간)의 지정 대상 점이 보존표에 오기 전에 원본과 함께 지워졌다(365일 보존 약속 위반, 영구).
 * 기대: 보존 복사가 성공할 때까지(상한 DROP_HOLD_MAX 그대로) 지우지 않는다. 복사만 따라잡기 물러남(1 · 2 · 4 … 분)으로 다시 하고, 요약 · 통계는 다시 돌리지 않는다.
 */
@EnabledIf("dev.wakeline.DbTestSupport#dockerAvailable")
class Im02RetainedCopyFailureKeepsDropHoldDbTest {
    JdbcClient admin;
    JdbcClient api;
    /** 정지한 날(UTC) — 파티션 끝 + 72 h 를 넘긴 날 */
    LocalDate stopDay;
    String trackPart;
    String shipPart;

    static final class MovingClock extends Clock {
        Instant now;
        MovingClock(Instant now) { this.now = now; }
        @Override public java.time.ZoneId getZone() { return ZoneOffset.UTC; }
        @Override public Clock withZone(java.time.ZoneId zone) { return this; }
        @Override public Instant instant() { return now; }
        void advance(Duration d) { now = now.plus(d); }
    }

    /** 지정 보존 복사의 앞 몇 번이 일시 오류로 실패하는 MaintenanceJobs — 요약 따라잡기 횟수를 센다 */
    final class Jobs extends MaintenanceJobs {
        final int failingCopies;
        int copies;
        int summaryCatchUps;

        Jobs(Clock clock, int failingCopies) {
            super(api, DbTestSupport.PROPS, new RegionSettings(new StringRedisTemplate(), api, DbTestSupport.JSON, DbTestSupport.PROPS),
                    DbTestSupport.apiTx(), DEFAULT_ALERT_RETENTION_DAYS, clock);
            this.failingCopies = failingCopies;
        }

        @Override
        int copyRetained(Instant from, Instant to) {
            if (copies++ < failingCopies) throw new QueryTimeoutException("canceling statement due to statement timeout (simulated)");
            return super.copyRetained(from, to);
        }

        @Override
        List<Instant> catchUpSummaries(Instant now) {
            summaryCatchUps++;
            return super.catchUpSummaries(now);
        }
    }

    @BeforeEach
    void setUp() {
        DbTestSupport.reset();
        admin = DbTestSupport.admin();
        api = DbTestSupport.apiClient();
        stopDay = LocalDate.now(ZoneOffset.UTC).minusDays(5);
        Instant t = stopDay.atTime(8, 40).toInstant(ZoneOffset.UTC); // 17:40 KST — 18:00 KST 정지 직전
        DbTestSupport.ensureTrackPartitions(t, t);
        shipPartition(stopDay);
        trackPart = "track_point_" + stopDay.format(DateTimeFormatter.BASIC_ISO_DATE);
        shipPart = "ship_position_" + stopDay.format(DateTimeFormatter.BASIC_ISO_DATE);
        admin.sql("UPDATE app_setting SET value = to_jsonb('71be01, 440000001'::text) WHERE key = 'retain_targets'").update();
        admin.sql("""
                INSERT INTO track_point (hex, ts, geom, alt_ft, provider, fetched_at)
                VALUES ('71be01', :t, ST_SetSRID(ST_MakePoint(127, 37.5), 4326), 30000, 'adsb_lol', :t)""").param("t", Sql.ts(t)).update();
        admin.sql("""
                INSERT INTO ship_position (mmsi, ts, geom, sog_kn, cog_deg, position_source, provider)
                VALUES ('440000001', :t, ST_SetSRID(ST_MakePoint(129.0, 35.0), 4326), 12.5, 180, 'epfs', 'aisstream')""").param("t", Sql.ts(t)).update();
    }

    static void shipPartition(LocalDate d) {
        try (Connection c = DriverManager.getConnection(DbTestSupport.jdbcUrl("wakeline"), "wakeline_migrator", DbTestSupport.MIGRATOR_PW);
             Statement s = c.createStatement()) {
            s.execute("CREATE TABLE IF NOT EXISTS ship_position_" + d.format(DateTimeFormatter.BASIC_ISO_DATE)
                    + " PARTITION OF ship_position FOR VALUES FROM ('" + d + "') TO ('" + d.plusDays(1) + "')");
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    boolean exists(String relation) {
        return admin.sql("SELECT to_regclass(:p) IS NOT NULL").param("p", relation).query(Boolean.class).single();
    }

    List<String> retained() {
        return admin.sql("SELECT kind || ':' || target_id FROM retained_track ORDER BY 1").query(String.class).list();
    }

    @Test
    void aRetainedCopyFailingInTheFirstCatchUpKeepsTheExpiredPartitionsUntilTheCopyIsRetriedAlone() {
        MovingClock clock = new MovingClock(Instant.now());
        Jobs jobs = new Jobs(clock, 1);
        clock.advance(Duration.ofMinutes(1));
        jobs.catchUpTick();                       // 기동 1분 뒤 따라잡기 — 요약 · 통계는 되고 보존 복사만 일시 오류
        assertThat(retained()).as("the simulated copy failure left nothing copied").isEmpty();

        jobs.dropExpiredPartitions();             // 다음 :02
        assertThat(exists(trackPart)).as("track_point partition %s kept while the first retained copy has not succeeded", trackPart).isTrue();
        assertThat(exists(shipPart)).as("ship_position partition %s kept while the first retained copy has not succeeded", shipPart).isTrue();

        jobs.copyRetained();                      // 매시 복사(닫힌 3시간 창)가 성공해도 정지 직전 시간은 옮기지 않으므로 보류를 풀지 않는다
        jobs.dropExpiredPartitions();
        assertThat(exists(trackPart) && exists(shipPart)).as("an hourly 3 h copy does not release the hold").isTrue();

        clock.advance(Duration.ofMinutes(1));
        jobs.catchUpTick();                       // 1분 뒤 — 보존 복사만 다시(3 h 를 기다리지 않는다)
        assertThat(retained()).as("points of the designated targets in the last hour before the stop (%s 08:40 UTC)", stopDay)
                .containsExactly("aircraft:71be01", "ship:440000001");
        assertThat(jobs.summaryCatchUps).as("summaries · stats are not run again for the copy retry").isEqualTo(1);

        jobs.dropExpiredPartitions();
        assertThat(exists(trackPart)).as("track_point partition dropped after the retained copy").isFalse();
        assertThat(exists(shipPart)).as("ship_position partition dropped after the retained copy").isFalse();
    }

    /** 시험 · 수동 따라잡기(catchUp)도 같다 — catchUpOkAt 을 채우는 두 경로 모두 */
    @Test
    void theManualCatchUpKeepsTheHoldWhenOnlyTheRetainedCopyFails() {
        Jobs jobs = new Jobs(Clock.systemUTC(), 1);
        jobs.catchUp();
        jobs.dropExpiredPartitions();
        assertThat(exists(trackPart) && exists(shipPart)).as("partitions kept after a catch-up whose retained copy failed").isTrue();

        jobs.catchUp();
        assertThat(retained()).containsExactly("aircraft:71be01", "ship:440000001");
        jobs.dropExpiredPartitions();
        assertThat(exists(trackPart) || exists(shipPart)).as("dropped once the retained copy succeeded").isFalse();
    }

    /** 복사가 계속 실패해도 삭제 보류의 상한(기동 + DROP_HOLD_MAX)은 그대로다 — 저장이 늘기만 하지 않는다(수용한 상한) */
    @Test
    void aRetainedCopyThatKeepsFailingHoldsTheDropAtMostUntilTheHoldLimit() {
        MovingClock clock = new MovingClock(Instant.now());
        Instant t0 = clock.now;
        Jobs jobs = new Jobs(clock, Integer.MAX_VALUE);
        for (int minute = 1; minute < MaintenanceJobs.DROP_HOLD_MAX.toMinutes(); minute++) {
            clock.now = t0.plus(Duration.ofMinutes(minute));
            jobs.catchUpTick();
        }
        assertThat(jobs.summaryCatchUps).as("one summary catch-up at start and one 3 h later").isEqualTo(2);
        // 복사: 1분(따라잡기) · 2 · 4 · 8 · 16 · 32 · 62 · 92 · 122 · 152분(물러남 1 · 2 · 4 · 8 · 16 · 30분 상한) · 181분(3 h 뒤 따라잡기) · 211 · 241 · 271 · 301 · 331분
        assertThat(jobs.copies).as("retained copy retried alone with the catch-up back-off, not every minute").isEqualTo(16);

        clock.now = t0.plus(MaintenanceJobs.DROP_HOLD_MAX).minus(Duration.ofMinutes(1));
        jobs.dropExpiredPartitions();
        assertThat(exists(trackPart) && exists(shipPart)).as("6 h − 1 min after start: kept").isTrue();
        clock.now = t0.plus(MaintenanceJobs.DROP_HOLD_MAX);
        jobs.dropExpiredPartitions();
        assertThat(exists(trackPart) || exists(shipPart)).as("6 h after start: dropped even though the retained copy never succeeded").isFalse();
    }
}
