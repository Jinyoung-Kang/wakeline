package dev.wakeline.history;

import dev.wakeline.DbTestSupport;
import dev.wakeline.aircraft.data.TrackRepository;
import dev.wakeline.platform.data.Sql;
import dev.wakeline.settings.RegionSettings;
import dev.wakeline.ships.data.ShipRepository;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIf;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.jdbc.core.simple.JdbcClient;

import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.time.temporal.ChronoUnit;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 지정 대상 기록 보존(V21 · ADR-038 · 계약 v5 §G52 · SPEC F7 받아들일 조건): 지정한 항공기 · 선박의 원해상도 점이 1분에 첫 점 하나로 옮겨지고,
 * 원해상도가 지워진 뒤에도 항적 조회가 그 점을 읽는다 · 지정하지 않은 대상은 옮기지 않는다 · 다시 돌려도 같다 · 지정을 풀면 새로 옮기지 않지만 옮긴 점은
 * 남는다 · 365일이 지나면 지운다 · 틀린 설정은 '지정 없음'.
 */
@EnabledIf("dev.wakeline.DbTestSupport#dockerAvailable")
class RetainedTrackDbTest {
    final JdbcClient admin = DbTestSupport.admin();
    final JdbcClient api = DbTestSupport.apiClient();
    final Instant hour = Instant.now().truncatedTo(ChronoUnit.HOURS).minus(1, ChronoUnit.HOURS);
    MaintenanceJobs jobs;

    @BeforeEach
    void setUp() {
        DbTestSupport.reset();
        admin.sql("DELETE FROM retained_track").update();
        jobs = new MaintenanceJobs(api, DbTestSupport.PROPS, new RegionSettings(new StringRedisTemplate(), api, DbTestSupport.JSON, DbTestSupport.PROPS),
                DbTestSupport.apiTx(), 30, Clock.fixed(hour.plus(2, ChronoUnit.HOURS).plusSeconds(420), ZoneOffset.UTC));
        jobs.ensurePartitions();
    }

    void target(String v) { admin.sql("UPDATE app_setting SET value = to_jsonb(:v::text) WHERE key = 'retain_targets'").param("v", v).update(); }

    void ac(String hex, Instant ts, double lon) {
        admin.sql("""
                INSERT INTO track_point (hex, ts, geom, alt_ft, gs_kt, track_deg, provider, fetched_at)
                VALUES (:h, :t, ST_SetSRID(ST_MakePoint(:lon, 37.5), 4326), 30000, 450, 90, 'adsb_lol', :t)""")
                .param("h", hex).param("t", Sql.ts(ts)).param("lon", lon).update();
    }

    void ship(String mmsi, Instant ts) {
        admin.sql("""
                INSERT INTO ship_position (mmsi, ts, geom, sog_kn, cog_deg, position_source, provider)
                VALUES (:m, :t, ST_SetSRID(ST_MakePoint(129.0, 35.0), 4326), 12.5, 180, 'epfs', 'aisstream')""")
                .param("m", mmsi).param("t", Sql.ts(ts)).update();
    }

    @Test
    void copiesTheFirstFixPerMinuteOfTargetsOnly_andReadsThemAfterTheRawRowsAreGone() {
        target("71BE01, 440000001");
        ac("71be01", hour.plusSeconds(5), 127.0);
        ac("71be01", hour.plusSeconds(20), 127.1);
        ac("71be01", hour.plusSeconds(65), 127.2);
        ac("a00002", hour.plusSeconds(5), 127.0);   // 지정 안 됨
        ship("440000001", hour.plusSeconds(30));
        ship("440000001", hour.plusSeconds(50));
        ship("440000002", hour.plusSeconds(30));   // 지정 안 됨

        assertThat(jobs.copyRetained(hour, hour.plus(1, ChronoUnit.HOURS))).isEqualTo(3); // 항공기 2분 + 선박 1분
        assertThat(jobs.copyRetained(hour, hour.plus(1, ChronoUnit.HOURS))).isZero();     // 다시 돌려도 같다
        List<Map<String, Object>> rows = admin.sql("SELECT kind, target_id, ts, ST_X(geom) lon FROM retained_track ORDER BY kind, ts").query().listOfRows();
        assertThat(rows).extracting(r -> r.get("target_id")).containsExactly("71be01", "71be01", "440000001");
        assertThat(Sql.toInstant(rows.get(0).get("ts"))).isEqualTo(hour.plusSeconds(5));    // 그 분의 첫 점(평균 아님)
        assertThat((Double) rows.get(0).get("lon")).isEqualTo(127.0);
        assertThat(Sql.toInstant(rows.get(2).get("ts"))).isEqualTo(hour.plusSeconds(30));

        // 원해상도가 지워진 뒤(보존 삭제를 흉내 — 행을 지움): 항적 조회가 지정 보존 점을 읽는다
        admin.sql("DELETE FROM track_point").update();
        admin.sql("DELETE FROM ship_position").update();
        TrackRepository tracks = new TrackRepository(api);
        assertThat(tracks.track("71be01", hour, hour.plus(1, ChronoUnit.HOURS), 0, 100)).isEmpty();
        List<Map<String, Object>> kept = tracks.retained("71be01", hour, hour.plus(1, ChronoUnit.HOURS), 100);
        assertThat(kept).hasSize(2).first().satisfies(r -> assertThat(r).containsEntry("hex", "71be01").containsEntry("provider", "adsb_lol").containsKeys("lon", "lat", "alt_ft"));
        var ships = new ShipRepository(null, api).retainedTrack("440000001", hour, hour.plus(1, ChronoUnit.HOURS), 100);
        assertThat(ships).hasSize(1).first().satisfies(p -> {
            assertThat(p.sogKn()).isEqualTo(12.5);
            assertThat(p.positionSource()).isNull(); // 옮기지 않은 값은 모름
        });
        assertThat(tracks.retained("a00002", hour, hour.plus(1, ChronoUnit.HOURS), 100)).isEmpty();
    }

    @Test
    void unsettingStopsNewCopiesButKeepsOldOnes_andRetentionDeletesAfterAYear() {
        target("71be01");
        ac("71be01", hour.plusSeconds(5), 127.0);
        assertThat(jobs.copyRetained(hour, hour.plus(1, ChronoUnit.HOURS))).isEqualTo(1);
        target("");
        ac("71be01", hour.plusSeconds(125), 127.3);
        assertThat(jobs.copyRetained(hour, hour.plus(1, ChronoUnit.HOURS))).isZero();
        assertThat(admin.sql("SELECT count(*) FROM retained_track").query(Long.class).single()).isEqualTo(1L);

        target("bad-value"); // 틀린 값(설정 검사를 거치지 않은 행) — 지정 없음으로
        assertThat(jobs.retainTargets().isEmpty()).isTrue();

        Instant old = Instant.now().minus(MaintenanceJobs.RETAINED_DAYS + 1, ChronoUnit.DAYS).truncatedTo(ChronoUnit.MINUTES);
        admin.sql("""
                INSERT INTO retained_track (kind, target_id, ts_minute, ts, geom) VALUES ('ship', '440000009', :m, :m, ST_SetSRID(ST_MakePoint(129, 35), 4326))""")
                .param("m", Sql.ts(old)).update();
        assertThat(jobs.deleteOldRetained()).isEqualTo(1);
        assertThat(admin.sql("SELECT count(*) FROM retained_track").query(Long.class).single()).isEqualTo(1L);
    }
}
