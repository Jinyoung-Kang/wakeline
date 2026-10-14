package dev.wakeline.qa;

import dev.wakeline.DbTestSupport;
import dev.wakeline.history.MaintenanceJobs;
import dev.wakeline.platform.data.Sql;
import dev.wakeline.settings.RegionSettings;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIf;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.jdbc.core.simple.JdbcClient;

import java.time.Instant;
import java.time.temporal.ChronoUnit;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * QA-1202(AWS 공개 데모 QA · 데이터 손실 조건부): 매시 :05 의 1분 요약(summarize1m)은 지난 시간을 그때 있는 원해상도로만 요약한다. 그 뒤에 그 시간의 행이
 * 늦게 들어오면 — Redis 장애 동안 수집기가 쌓아 둔 XADD(Publisher 로컬 큐)를 장애가 끝난 뒤 보내 api 가 그 시간의 관측(ts = 관측 시각)을 :05 뒤에 쓰는
 * 경우, api 재시작 직후 스트림 백로그를 따라잡는 중에 :05 가 도는 경우 — 따라잡기(catchUpSummaries)는 '요약이 하나도 없는 시간'만 다시 요약하므로 그 분들은
 * 영영 요약되지 않는다. 72 h 뒤 원본이 지워지면 재생(1분 요약만 읽는다)에서 그 분들이 빈다(요약 행이 있는 다른 분들은 보인다).
 * 기대: 원해상도가 있는데 요약이 없는 분은 따라잡기가 채운다(summarizeHour 는 ON CONFLICT DO NOTHING 이라 다시 돌려도 같다).
 */
@EnabledIf("dev.wakeline.DbTestSupport#dockerAvailable")
class Qa1202LateRowsOfASummarizedHourDbTest {
    @Test
    void rowsWrittenAfterTheHourlySummaryAreSummarizedByTheCatchUp() throws InterruptedException {
        DbTestSupport.reset();
        JdbcClient admin = DbTestSupport.admin();
        JdbcClient api = DbTestSupport.apiClient();
        // summarize1m 은 벽시계로 '지난 시간'을 고른다 — 정시 직전이면 정시를 넘긴 뒤 시작한다(시험이 다른 시간을 보지 않게)
        Instant n0 = Instant.now();
        if (n0.truncatedTo(ChronoUnit.HOURS).plus(1, ChronoUnit.HOURS).toEpochMilli() - n0.toEpochMilli() < 15_000) Thread.sleep(16_000);
        Instant hour = Instant.now().truncatedTo(ChronoUnit.HOURS).minus(1, ChronoUnit.HOURS);
        DbTestSupport.ensureTrackPartitions(hour, hour);
        MaintenanceJobs jobs = new MaintenanceJobs(api, DbTestSupport.PROPS, new RegionSettings(new StringRedisTemplate(), api, DbTestSupport.JSON, DbTestSupport.PROPS),
                DbTestSupport.apiTx());
        insert(admin, "e12201", hour.plusSeconds(10 * 60));           // :05 전에 쓰인 관측(10분)

        jobs.summarize1m();                                            // 매시 :05 — 그 시간을 요약
        insert(admin, "e12202", hour.plusSeconds(55 * 60));           // 장애가 끝난 뒤 늦게 쓰인 같은 시간의 관측(55분)
        jobs.catchUp();                                                // 따라잡기(기동 1분 뒤 · 성공 뒤 3시간마다)

        assertThat(admin.sql("SELECT hex FROM track_point_1m WHERE ts_minute >= :a AND ts_minute < :b ORDER BY hex")
                .param("a", Sql.ts(hour)).param("b", Sql.ts(hour.plus(1, ChronoUnit.HOURS))).query(String.class).list())
                .as("1-minute summary rows of hour %s — the 55th minute was written after the :05 summary (raw row still kept)", hour)
                .containsExactly("e12201", "e12202");
    }

    static void insert(JdbcClient admin, String hex, Instant ts) {
        admin.sql("""
                INSERT INTO track_point (hex, ts, geom, alt_ft, provider, fetched_at)
                VALUES (:h, :t, ST_SetSRID(ST_MakePoint(127.8, 36.5), 4326), 30000, 'adsb_lol', now())""")
                .param("h", hex).param("t", Sql.ts(ts)).update();
    }
}
