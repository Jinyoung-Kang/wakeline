package dev.wakeline.history;

import dev.wakeline.DbTestSupport;
import dev.wakeline.platform.data.Sql;
import dev.wakeline.settings.RegionSettings;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIf;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.jdbc.core.simple.JdbcClient;

import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneOffset;
import java.time.temporal.ChronoUnit;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * QA-601(출시 QA 2차 · 신뢰성 · 데이터 손실 조건부): 기동 뒤 따라잡기(catchUp)는 1분 요약 · 일 통계 · 옛 날짜 통계를 채운 뒤 지정 대상 보존 복사(70 h)를 한다
 * (MaintenanceJobs.catchUp — ADR-038 결정 3). 앞의 셋 중 하나가 예외를 던지면 같은 try 안의 보존 복사를 건너뛴다. 매시 복사는 3 h 창뿐이라, api 가 3 h 넘게
 * 멈췄다 뜬 뒤 통계 쪽 실패가 이어지면 그 사이 지정 대상의 원해상도 점은 72 h 에 파티션째 지워져 보존표에 오지 못한다. 매시 1분 요약은 일부러 실패를 따로
 * 가둔다(summarize1m). 기대: 통계 따라잡기가 실패해도 보존 복사는 한다.
 */
@EnabledIf("dev.wakeline.DbTestSupport#dockerAvailable")
class Qa601CatchUpRetainedCopyDbTest {
    @Test
    void aFailingStatsCatchUpDoesNotSkipTheRetainedCopy() {
        DbTestSupport.reset();
        JdbcClient admin = DbTestSupport.admin();
        JdbcClient api = DbTestSupport.apiClient();
        Instant now = Instant.now();
        MaintenanceJobs jobs = new MaintenanceJobs(api, DbTestSupport.PROPS, new RegionSettings(new StringRedisTemplate(), api, DbTestSupport.JSON, DbTestSupport.PROPS),
                DbTestSupport.apiTx(), 30, Clock.fixed(now, ZoneOffset.UTC)) {
            @Override
            List<LocalDate> catchUpStats(LocalDate today) { throw new IllegalStateException("stats catch-up failed (simulated)"); }
        };
        jobs.ensurePartitions();
        admin.sql("UPDATE app_setting SET value = to_jsonb('71be01'::text) WHERE key = 'retain_targets'").update();
        Instant tenHoursAgo = now.truncatedTo(ChronoUnit.HOURS).minus(10, ChronoUnit.HOURS).plusSeconds(5);  // 매시 3 h 창 밖 · 따라잡기 70 h 창 안
        admin.sql("""
                INSERT INTO track_point (hex, ts, geom, alt_ft, provider, fetched_at)
                VALUES ('71be01', :t, ST_SetSRID(ST_MakePoint(127, 37.5), 4326), 30000, 'adsb_lol', :t)""").param("t", Sql.ts(tenHoursAgo)).update();

        jobs.catchUp();

        assertThat(admin.sql("SELECT count(*) FROM retained_track WHERE target_id = '71be01'").query(Long.class).single())
                .as("the 70 h retained copy ran despite the stats failure").isEqualTo(1L);
    }
}
