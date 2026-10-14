package dev.wakeline.qa;

import dev.wakeline.DbTestSupport;
import dev.wakeline.history.MaintenanceJobs;
import dev.wakeline.platform.data.Sql;
import dev.wakeline.settings.RegionSettings;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIf;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.jdbc.core.simple.JdbcClient;

import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.time.temporal.ChronoUnit;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * QA-1200(AWS 공개 데모 QA · 데이터 손실): 1분 요약 따라잡기 창이 '원해상도 보존 − 2 h'(= 70 h)로 고정이다(MaintenanceJobs.catchUpSummaries).
 * AWS 데모는 18:00 KST 에 EC2 를 멈춰 마지막 시간(17–18시 KST)의 정시 요약(:05)이 돌지 않는다 — 다음 기동의 따라잡기만 그 시간을 채울 수 있다.
 * 정지가 70 h 를 넘으면(연휴 · 일정 끔 · 기동 실패 — 금 18:00 → 화 09:00 KST 는 87 h) 그 시간은 창 밖이다. 원본은 기동 뒤 첫 따라잡기가 성공할 때까지
 * 파티션 삭제를 미루는 덕에(DROP_HOLD) 남아 있는데도 요약하지 않고, 첫 따라잡기가 성공하면 보류가 풀려 다음 :02 에 원본 파티션이 지워진다 —
 * 그 시간의 재생(72 h 뒤는 1분 요약만 읽는다)이 영구히 빈다. 기대: 원본이 남아 있는 시간은 창과 상관없이 요약한다.
 */
@EnabledIf("dev.wakeline.DbTestSupport#dockerAvailable")
class Qa1200SummaryCatchUpAfterLongStopDbTest {
    JdbcClient api;
    JdbcClient admin;

    @BeforeEach
    void setUp() {
        DbTestSupport.reset();
        api = DbTestSupport.apiClient();
        admin = DbTestSupport.admin();
    }

    MaintenanceJobs startedJobs() {
        return new MaintenanceJobs(api, DbTestSupport.PROPS, new RegionSettings(new StringRedisTemplate(), api, DbTestSupport.JSON, DbTestSupport.PROPS),
                DbTestSupport.apiTx());
    }

    void trackPoint(String hex, Instant ts) {
        admin.sql("""
                INSERT INTO track_point (hex, ts, geom, alt_ft, provider, fetched_at)
                VALUES (:h, :t, ST_SetSRID(ST_MakePoint(127.8, 36.5), 4326), 30000, 'adsb_lol', :t)""")  // 관심 지역 안
                .param("h", hex).param("t", Sql.ts(ts)).update();
    }

    long rawRows(Instant hour) {
        return admin.sql("SELECT count(*) FROM track_point WHERE ts >= :a AND ts < :b")
                .param("a", Sql.ts(hour)).param("b", Sql.ts(hour.plus(1, ChronoUnit.HOURS))).query(Long.class).single();
    }

    long summaryRows(Instant hour) {
        return admin.sql("SELECT count(*) FROM track_point_1m WHERE ts_minute >= :a AND ts_minute < :b")
                .param("a", Sql.ts(hour)).param("b", Sql.ts(hour.plus(1, ChronoUnit.HOURS))).query(Long.class).single();
    }

    boolean exists(String relation) {
        return admin.sql("SELECT to_regclass(:p) IS NOT NULL").param("p", relation).query(Boolean.class).single();
    }

    /**
     * 87–111 h 정지: 멈춘 날(UTC)의 파티션은 이미 보존 경계를 지났지만 기동 뒤 첫 따라잡기 전에는 남아 있다. 따라잡기가 성공하면 다음 :02 에 지워진다.
     */
    @Test
    void theLastHourBeforeAStopLongerThan70HoursIsSummarizedWhileItsRawRowsRemain() {
        Instant now = Instant.now();
        LocalDate stopDay = LocalDate.ofInstant(now.minus(72, ChronoUnit.HOURS), ZoneOffset.UTC).minusDays(1); // 파티션 끝(다음 UTC 자정) ≤ now − 72 h
        Instant lastHour = stopDay.atTime(8, 0).toInstant(ZoneOffset.UTC);                                    // 17–18시 KST — 18:00 KST 정지 직전
        DbTestSupport.ensureTrackPartitions(lastHour, lastHour);
        trackPoint("e12001", lastHour.plusSeconds(30 * 60));
        String partition = "track_point_" + stopDay.format(DateTimeFormatter.BASIC_ISO_DATE);

        MaintenanceJobs jobs = startedJobs();              // 기동
        jobs.dropExpiredPartitions();                      // 기동 뒤 첫 :02 — 첫 따라잡기 전이라 미룬다
        jobs.catchUp();                                    // 기동 1분 뒤 따라잡기 — 성공
        long rawAtCatchUp = rawRows(lastHour);
        jobs.dropExpiredPartitions();                      // 보류가 풀린 다음 :02
        boolean partitionGone = !exists(partition);

        assertThat(rawAtCatchUp).as("raw rows of the hour were still there when the first catch-up ran").isEqualTo(1L);
        assertThat(partitionGone).as("the next hourly retention dropped the raw partition (the only source of the summary)").isTrue();
        assertThat(summaryRows(lastHour))
                .as("1-minute summary of the last hour before a %d h stop (%s) — replay of that hour after the raw rows are gone",
                        ChronoUnit.HOURS.between(lastHour.plus(1, ChronoUnit.HOURS), now), lastHour)
                .isEqualTo(1L);
    }

    /** 경계: 70 h 까지는 채우고, 그 바로 앞 시간(71 h)은 원본이 남아 있어도 채우지 않는다. */
    @Test
    void anHourJustOutsideTheSeventyHourWindowIsSummarizedToo() {
        Instant current = Instant.now().truncatedTo(ChronoUnit.HOURS);
        Instant h70 = current.minus(70, ChronoUnit.HOURS), h71 = current.minus(71, ChronoUnit.HOURS);
        DbTestSupport.ensureTrackPartitions(h71, current);
        trackPoint("e12002", h70.plusSeconds(600));
        trackPoint("e12003", h71.plusSeconds(600));

        startedJobs().catchUp();

        assertThat(summaryRows(h70)).as("hour %s (70 h back — inside the window)", h70).isEqualTo(1L);
        assertThat(rawRows(h71)).as("raw rows of hour %s are still kept (retention 72 h)", h71).isEqualTo(1L);
        assertThat(summaryRows(h71)).as("1-minute summary of hour %s (71 h back, raw rows still kept)", h71).isEqualTo(1L);
    }
}
