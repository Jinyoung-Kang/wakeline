package dev.wakeline.rest;

import dev.wakeline.domain.AircraftState;
import dev.wakeline.domain.GeoJson;
import dev.wakeline.domain.SigmetRecord;
import dev.wakeline.engine.EngineService;
import dev.wakeline.ingest.RadarStore;
import dev.wakeline.ingest.SigmetStore;
import dev.wakeline.ingest.Snapshot;
import dev.wakeline.ingest.SnapshotStore;
import dev.wakeline.ops.RegionSettings;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import org.junit.jupiter.api.Test;
import org.locationtech.jts.geom.Coordinate;
import org.locationtech.jts.geom.Polygon;
import org.springframework.data.redis.core.StringRedisTemplate;

import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicReference;

import static org.assertj.core.api.Assertions.assertThat;

/** /status 의 관심 지역은 런타임 설정(collector 와 같은 값)을 따르고, 전세계 기체 수는 '현재'(600 s 안) 기체만. SIGMET 출처 속성. */
class StatusServiceTest {

    static AircraftState ac(String hex, Instant seen) {
        return new AircraftState(hex, null, null, null, null, 10, 10, 30000, null, null, null, false, null, seen, "opensky", seen, 0, false);
    }

    @Test
    void regionComesFromRuntimeSettingsAndGlobalCountsOnlyCurrentAircraft() {
        SnapshotStore snapshots = new SnapshotStore();
        Instant now = Instant.now();
        snapshots.replaceIfNewer(new Snapshot(snapshots.nextVersion(), "global", "opensky", now, now, "-",
                Map.of("a00001", ac("a00001", now.minusSeconds(30)), "a00002", ac("a00002", now.minusSeconds(900)))));
        var region = new AtomicReference<>(new RegionSettings.Region(36.5, 127.8, 250));
        var status = new StatusService(snapshots, new SigmetStore(), new RadarStore(),
                new EngineService(snapshots, new SigmetStore(), e -> { }, new SimpleMeterRegistry()), new StringRedisTemplate(), region::get);

        Map<String, Object> s = status.publicStatus();
        assertThat(((Map<?, ?>) s.get("region")).get("center")).isEqualTo(List.of(36.5, 127.8));
        assertThat(((Map<?, ?>) s.get("region")).get("provider")).isNull();      // 수집 이력 없음 — "-" 를 값처럼 내보내지 않는다
        assertThat(((Map<?, ?>) s.get("global")).get("aircraft")).isEqualTo(1);  // 900 s 전 기체는 '현재' 가 아니다

        region.set(new RegionSettings.Region(35.5, 139.7, 300)); // 운영자가 /ops 에서 바꿈 → collector 와 같은 값
        Map<?, ?> r = (Map<?, ?>) status.publicStatus().get("region");
        assertThat(r.get("center")).isEqualTo(List.of(35.5, 139.7));
        assertThat(r.get("radius_nm")).isEqualTo(300);
    }

    /** 계약 v2 §A3: /status demand = {hot_active, focus_active, adsb_fi_rps_1m} — 수만, hex·셀 없음. */
    @Test
    void demandBlock_countsOnly_andRpsNullWithoutCollector() {
        SnapshotStore snapshots = new SnapshotStore();
        var stats = new dev.wakeline.demand.DemandStats();
        stats.update(new dev.wakeline.demand.DemandStats.Counts(2, 5, 3, 6, 4, 7));
        var status = new StatusService(snapshots, new SigmetStore(), new RadarStore(),
                new EngineService(snapshots, new SigmetStore(), e -> { }, new SimpleMeterRegistry()), new StringRedisTemplate(),
                () -> new RegionSettings.Region(36.5, 127.8, 250), stats);
        @SuppressWarnings("unchecked")
        Map<String, Object> d = (Map<String, Object>) status.publicStatus().get("demand");
        assertThat(d).containsOnlyKeys("hot_active", "focus_active", "adsb_fi_rps_1m");
        assertThat(d.get("hot_active")).isEqualTo(2);
        assertThat(d.get("focus_active")).isEqualTo(5);
        assertThat(d.get("adsb_fi_rps_1m")).isNull(); // Redis 없음 → 수집기 값 없음
    }

    @Test
    void adsbFiRps_fromFreshHeartbeatOnly() {
        Instant now = Instant.parse("2026-09-28T03:00:00Z");
        assertThat(StatusService.adsbFiRps(Map.of("adsb_fi_rps_1m", "0.2667", "region_at", now.minusSeconds(8).toString(), "focus_at", now.minusSeconds(200).toString()), now))
                .isEqualTo(0.267);
        assertThat(StatusService.adsbFiRps(Map.of("adsb_fi_rps_1m", "0.3", "region_at", now.minusSeconds(121).toString()), now)).isNull(); // 수집기 멈춤
        assertThat(StatusService.adsbFiRps(Map.of("adsb_fi_rps_1m", "0.3"), now)).isNull();                                            // 시각 없음
        assertThat(StatusService.adsbFiRps(Map.of("adsb_fi_rps_1m", "abc", "region_at", now.toString()), now)).isNull();
        assertThat(StatusService.adsbFiRps(Map.of("adsb_fi_rps_1m", "NaN", "region_at", now.toString()), now)).isNull();
        assertThat(StatusService.adsbFiRps(Map.of("adsb_fi_rps_1m", "-1", "region_at", now.toString()), now)).isNull();
        assertThat(StatusService.adsbFiRps(Map.of("region_at", now.toString()), now)).isNull();
        assertThat(StatusService.adsbFiRps(Map.of("adsb_fi_rps_1m", "0", "region_at", "garbage", "kma_at", now.toString()), now)).isEqualTo(0.0);
    }

    @Test
    void sigmetFeatureCarriesBandSourcesAndLegacyStaysUnknown() {
        Polygon p = GeoJson.GF.createPolygon(new Coordinate[]{new Coordinate(0, 0), new Coordinate(1, 0), new Coordinate(1, 1), new Coordinate(0, 0)});
        var mp = GeoJson.GF.createMultiPolygon(new Polygon[]{p});
        Instant now = Instant.now();
        var s = new SigmetRecord("A", "X", null, null, "1", "TS", null, 0, null, now, now.plusSeconds(60), mp, null, null, null, null, "r", "awc", now,
                SigmetRecord.BASE_ASSUMED_SURFACE, SigmetRecord.TOP_UNKNOWN);
        @SuppressWarnings("unchecked")
        Map<String, Object> props = (Map<String, Object>) SigmetGeoJson.feature(s, now).get("properties");
        assertThat(props).containsEntry("base_source", "assumed_surface").containsEntry("top_source", "unknown");
        var legacy = new SigmetRecord("B", "X", null, null, "1", "TS", null, 0, 20000, now, now.plusSeconds(60), mp, null, null, null, null, "r", "awc", now);
        @SuppressWarnings("unchecked")
        Map<String, Object> lp = (Map<String, Object>) SigmetGeoJson.feature(legacy, now).get("properties");
        assertThat(lp.get("base_source")).isNull(); // 출처를 모르는 이전 형식 — 추정해 채우지 않는다
        assertThat(lp.get("top_source")).isNull();
    }
}
