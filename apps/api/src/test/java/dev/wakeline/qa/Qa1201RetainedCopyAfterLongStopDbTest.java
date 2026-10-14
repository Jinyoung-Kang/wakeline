package dev.wakeline.qa;

import dev.wakeline.DbTestSupport;
import dev.wakeline.history.MaintenanceJobs;
import dev.wakeline.platform.data.Sql;
import dev.wakeline.settings.RegionSettings;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIf;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.jdbc.core.simple.JdbcClient;

import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.Statement;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.time.temporal.ChronoUnit;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * QA-1201(AWS 공개 데모 QA · 데이터 손실): 지정 대상 기록 보존(ADR-038 · 365일)의 기동 뒤 따라잡기 복사 창이 70 h 고정이다
 * (MaintenanceJobs.RETAIN_CATCH_UP_HOURS). 매시 복사(:05)는 닫힌 3시간만 옮기므로 18:00 KST 정지 직전 시간(17–18시 KST)은 다음 기동의 따라잡기만
 * 옮길 수 있다. 정지가 70 h 를 넘으면 그 시간은 창 밖이라, 원해상도가 아직 남아 있어도(항적 파티션은 첫 따라잡기까지 보류 · 선박 파티션은 그날 끝 + 72 h
 * 까지) 운영자가 지정한 항공기 · 선박의 그 시간 점이 보존표에 오지 않고 원본 삭제와 함께 영구히 사라진다. QA-1200 과 같은 꼴(고정 창)이다.
 * 기대: 원본이 남아 있는 시간은 창과 상관없이 옮긴다.
 */
@EnabledIf("dev.wakeline.DbTestSupport#dockerAvailable")
class Qa1201RetainedCopyAfterLongStopDbTest {

    static void shipPartition(LocalDate d) {
        try (Connection c = DriverManager.getConnection(DbTestSupport.jdbcUrl("wakeline"), "wakeline_migrator", DbTestSupport.MIGRATOR_PW);
             Statement s = c.createStatement()) {
            s.execute("CREATE TABLE IF NOT EXISTS ship_position_" + d.format(DateTimeFormatter.BASIC_ISO_DATE)
                    + " PARTITION OF ship_position FOR VALUES FROM ('" + d + "') TO ('" + d.plusDays(1) + "')");
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    @Test
    void targetPointsOfTheLastHourBeforeAStopLongerThan70HoursAreRetained() {
        DbTestSupport.reset();
        JdbcClient admin = DbTestSupport.admin();
        JdbcClient api = DbTestSupport.apiClient();
        Instant now = Instant.now();
        Instant lastHour = now.truncatedTo(ChronoUnit.HOURS).minus(71, ChronoUnit.HOURS);   // 71 h 전 — 원해상도 보존(72 h) 안
        LocalDate day = LocalDate.ofInstant(lastHour, ZoneOffset.UTC);
        DbTestSupport.ensureTrackPartitions(lastHour, lastHour);
        shipPartition(day);
        admin.sql("UPDATE app_setting SET value = to_jsonb('71be01, 440000001'::text) WHERE key = 'retain_targets'").update();
        Instant t = lastHour.plusSeconds(40 * 60);
        admin.sql("""
                INSERT INTO track_point (hex, ts, geom, alt_ft, provider, fetched_at)
                VALUES ('71be01', :t, ST_SetSRID(ST_MakePoint(127, 37.5), 4326), 30000, 'adsb_lol', :t)""").param("t", Sql.ts(t)).update();
        admin.sql("""
                INSERT INTO ship_position (mmsi, ts, geom, sog_kn, cog_deg, position_source, provider)
                VALUES ('440000001', :t, ST_SetSRID(ST_MakePoint(129.0, 35.0), 4326), 12.5, 180, 'epfs', 'aisstream')""").param("t", Sql.ts(t)).update();

        MaintenanceJobs jobs = new MaintenanceJobs(api, DbTestSupport.PROPS, new RegionSettings(new StringRedisTemplate(), api, DbTestSupport.JSON, DbTestSupport.PROPS),
                DbTestSupport.apiTx());
        jobs.catchUp(); // 기동 1분 뒤 따라잡기(성공)

        long rawAircraft = admin.sql("SELECT count(*) FROM track_point WHERE hex = '71be01'").query(Long.class).single();
        long rawShip = admin.sql("SELECT count(*) FROM ship_position WHERE mmsi = '440000001'").query(Long.class).single();
        assertThat(rawAircraft + rawShip).as("raw points of the targets are still kept when the catch-up runs").isEqualTo(2L);
        assertThat(admin.sql("SELECT kind || ':' || target_id FROM retained_track ORDER BY 1").query(String.class).list())
                .as("retained points of the designated targets in hour %s (71 h back, raw rows still kept)", lastHour)
                .containsExactly("aircraft:71be01", "ship:440000001");
    }
}
