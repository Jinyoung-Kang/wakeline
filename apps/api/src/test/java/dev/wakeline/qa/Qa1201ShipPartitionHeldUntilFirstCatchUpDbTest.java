package dev.wakeline.qa;

import dev.wakeline.DbTestSupport;
import dev.wakeline.history.MaintenanceJobs;
import dev.wakeline.settings.RegionSettings;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIf;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.jdbc.core.simple.JdbcClient;

import java.time.LocalDate;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * QA-1201 남은 곳(독립 리뷰 2026-10-14): 따라잡기 창을 넓혀도(6c7daa54) 선박 위치 파티션은 기동 뒤 첫 따라잡기 전에 매시 :02 삭제가 지울 수 있었다
 * — 항적 파티션에만 삭제 보류(DROP_HOLD_MAX)가 있었다. 긴 정지(금 18:00 → 화 08:50 KST) 뒤 RDS 가 늦게 준비되면 따라잡기가 1 · 2 · 4 · 8분씩 물러나
 * 09:02 를 넘기고, 그 사이 정지 직전 시간의 지정 선박 점이 보존표로 옮겨지기 전에 원본과 함께 사라진다.
 * 기대: 선박 위치 파티션도 첫 따라잡기가 성공할 때까지(상한 DROP_HOLD_MAX) 지우지 않는다.
 */
@EnabledIf("dev.wakeline.DbTestSupport#dockerAvailable")
class Qa1201ShipPartitionHeldUntilFirstCatchUpDbTest {

    @Test
    void anExpiredShipPositionPartitionIsKeptUntilTheFirstCatchUpAfterStart() {
        DbTestSupport.reset();
        JdbcClient admin = DbTestSupport.admin();
        JdbcClient api = DbTestSupport.apiClient();
        LocalDate old = LocalDate.now(ZoneOffset.UTC).minusDays(6); // 보존(72 h)을 훨씬 넘은 날
        Qa1201RetainedCopyAfterLongStopDbTest.shipPartition(old);
        String part = "ship_position_" + old.format(DateTimeFormatter.BASIC_ISO_DATE);

        MaintenanceJobs started = new MaintenanceJobs(api, DbTestSupport.PROPS,
                new RegionSettings(new StringRedisTemplate(), api, DbTestSupport.JSON, DbTestSupport.PROPS), DbTestSupport.apiTx());
        started.dropExpiredPartitions(); // 기동 뒤 첫 따라잡기 전의 :02
        assertThat(exists(admin, part)).as("ship_position partition %s kept before the first catch-up after start", part).isTrue();

        started.catchUp();
        started.dropExpiredPartitions();
        assertThat(exists(admin, part)).as("dropped after the first catch-up").isFalse();
    }

    static boolean exists(JdbcClient admin, String relation) {
        return admin.sql("SELECT to_regclass(:p) IS NOT NULL").param("p", relation).query(Boolean.class).single();
    }
}
