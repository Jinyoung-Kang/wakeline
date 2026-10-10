package dev.wakeline.history;

import dev.wakeline.DbTestSupport;
import dev.wakeline.aircraft.data.TrackRepository;
import dev.wakeline.platform.data.Sql;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIf;
import org.springframework.jdbc.core.simple.JdbcClient;

import java.time.Instant;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * QA-702(출시 QA 2차 · 기능): 항적 조회는 [from, to] 안의 점(ts)을 준다(원해상도 track_point — ts BETWEEN). 지정 보존 점(V21 retained_track — 계약 v5 §G52)은
 * 분 머리(ts_minute)로 거르므로, 실제 시각(ts)이 to 뒤인 점이 섞이고(분 머리 ≤ to < ts) from 이 든 분의 점은 from 뒤여도 빠진다(분 머리 < from ≤ ts).
 * 기대: 보존 점도 실제 시각 ts 로 [from, to] — 원해상도와 같은 규칙.
 */
@EnabledIf("dev.wakeline.DbTestSupport#dockerAvailable")
class Qa702RetainedTrackMinuteBoundaryDbTest {
    @Test
    void retainedPointsAreFilteredByTheirActualTime() {
        DbTestSupport.reset();
        JdbcClient admin = DbTestSupport.admin();
        admin.sql("DELETE FROM retained_track").update();
        Instant minute = Instant.parse("2026-01-10T10:05:00Z");
        admin.sql("""
                INSERT INTO retained_track (kind, target_id, ts_minute, ts, geom, provider)
                VALUES ('aircraft', '71be01', :m, :t, ST_SetSRID(ST_MakePoint(127, 37.5), 4326), 'adsb_lol')""")
                .param("m", Sql.ts(minute)).param("t", Sql.ts(minute.plusSeconds(40))).update();  // 실제 시각 10:05:40
        TrackRepository tracks = new TrackRepository(DbTestSupport.apiClient());
        // to = 10:05:10 — 10:05:40 의 점은 창 밖
        List<Map<String, Object>> before = tracks.retained("71be01", minute.minusSeconds(600), minute.plusSeconds(10), 100);
        assertThat(before).as("a point after `to` is not returned").isEmpty();
        // from = 10:05:30 — 10:05:40 의 점은 창 안
        List<Map<String, Object>> after = tracks.retained("71be01", minute.plusSeconds(30), minute.plusSeconds(600), 100);
        assertThat(after).as("a point after `from` in the same minute is returned").hasSize(1);
    }
}
