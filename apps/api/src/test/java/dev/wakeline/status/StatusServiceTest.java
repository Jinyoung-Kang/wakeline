package dev.wakeline.status;

import dev.wakeline.domain.AircraftState;
import dev.wakeline.geo.GeoJson;
import dev.wakeline.domain.SigmetRecord;
import dev.wakeline.engine.EngineService;
import dev.wakeline.ingest.RadarStore;
import dev.wakeline.ingest.SigmetStore;
import dev.wakeline.ingest.Snapshot;
import dev.wakeline.ingest.SnapshotStore;
import dev.wakeline.weather.web.SigmetGeoJson;
import dev.wakeline.settings.RegionSettings;
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

    /** 레이더를 한 번도 받지 않았으면(fetched_at 자리표시 EPOCH) "오래됨" — SIGMET 과 같은 규칙. 전에는 lag -1 이라 false 였다. */
    @Test
    void radarNeverFetchedIsStale() {
        SnapshotStore snapshots = new SnapshotStore();
        var status = new StatusService(snapshots, new SigmetStore(), new RadarStore(),
                new EngineService(snapshots, new SigmetStore(), e -> { }, new SimpleMeterRegistry()), new StringRedisTemplate(),
                () -> new RegionSettings.Region(36.5, 127.8, 250));
        Map<?, ?> radar = (Map<?, ?>) status.publicStatus().get("radar");
        assertThat(radar.get("frames")).isEqualTo(0);
        assertThat(radar.get("stale")).isEqualTo(true);
        Map<?, ?> sigmet = (Map<?, ?>) status.publicStatus().get("sigmet");
        assertThat(sigmet.get("stale")).isEqualTo(true); // 같은 규칙의 기준
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

    /** ADR-021: 공개 radar_kr 에 최신 프레임의 합성 지점 수 · 기준 · 부분 합성 — 검증한 값만(틀리거나 서로 맞지 않으면 키 없음). */
    @Test
    void radarKrCarriesTheLatestFramesSiteCountsOnlyWhenValid() {
        Map<String, Object> ok = StatusService.radarKr(Map.of("available", "1", "latest_tm", "202609291450", "stations", "7", "stations_ref", "15",
                "partial", "1", "station_ids", "KSN,GDK"));
        assertThat(ok).containsEntry("stations", 7).containsEntry("stations_ref", 15).containsEntry("partial", true)
                .doesNotContainKey("station_ids"); // 코드 목록은 /radar/kr 에만
        assertThat(StatusService.radarKr(Map.of("stations", "15", "stations_ref", "15", "partial", "0")))
                .containsEntry("stations", 15).containsEntry("stations_ref", 15).containsEntry("partial", false);
        // 옛 수집기(stations = 코드 목록) · 범위 밖 · 서로 맞지 않는 값 · 기준 없는 판정 → 모름
        assertThat(StatusService.radarKr(Map.of("stations", "KSN,GDK", "partial", "1"))).doesNotContainKeys("stations", "partial");
        assertThat(StatusService.radarKr(Map.of("stations", "49", "stations_ref", "-1"))).doesNotContainKeys("stations", "stations_ref");
        assertThat(StatusService.radarKr(Map.of("stations", "16", "stations_ref", "15", "partial", "0"))).doesNotContainKeys("stations_ref", "partial")
                .containsEntry("stations", 16);
        assertThat(StatusService.radarKr(Map.of("stations", "7", "stations_ref", "15", "partial", "0"))).doesNotContainKey("partial");
        assertThat(StatusService.radarKr(Map.of("stations", "7", "stations_ref", "15", "partial", "yes"))).doesNotContainKey("partial");
        assertThat(StatusService.radarKr(Map.of("stations", "", "stations_ref", "", "partial", ""))).isEmpty();
    }

    /** 기상청 내려받기 '파일 없음' 연속(2026-09-30): 공개 radar_kr 에도 검증한 missing — 없으면(빈 값) 키가 없다. */
    @Test
    void radarKrCarriesTheMissingFileStreakWhenValid() {
        Map<String, Object> on = StatusService.radarKr(Map.of("available", "1", "missing_since_tm", "202609300815", "missing_last_tm", "202609300950",
                "missing_tms", "20", "missing_checked_at", "2026-09-30T00:50:31Z", "missing_file", "RDR_CMP_HSR_PUB_202609300950.bin.gz", "missing_listed", "EXT"));
        assertThat(on.get("missing")).isEqualTo(Map.of("since_tm", "202609300815", "last_tm", "202609300950", "tms", 20,
                "checked_at", Instant.parse("2026-09-30T00:50:31Z"), "file", "RDR_CMP_HSR_PUB_202609300950.bin.gz", "listed", List.of("EXT")));
        assertThat(StatusService.radarKr(Map.of("available", "1", "missing_since_tm", ""))).doesNotContainKey("missing");
        assertThat(StatusService.radarKr(Map.of("missing_since_tm", "202609300815", "missing_tms", "20"))).doesNotContainKey("missing"); // 핵심 값이 없다
    }

    /**
     * 리뷰 cto-2026-10 S13(I-1): 공개 status 의 active_providers 는 수집기 해시 wakeline:active 의 허용 목록 필드만 — 작업(region · global)마다 수집기가 쓰는
     * {job} · _since · _reason · _none_since · _none_reason · _none_next · _none_retry(status.py set_active · set_none, 웹 lib/active-provider.ts 가 읽는 것).
     * 예전에는 해시 전체를 실어 수집기가 새 필드를 쓰면 저절로 공개됐다. 순서는 수집기가 쓴 순서 그대로. Redis 를 읽지 못하면 예전처럼 error 표시.
     */
    @Test
    @SuppressWarnings({"unchecked", "rawtypes"})
    void activeProvidersCarryOnlyTheAllowListedCollectorFields() {
        Map<String, Object> hash = new java.util.LinkedHashMap<>();
        hash.put("global", "opensky");
        hash.put("region", "adsb_lol");
        hash.put("region_since", "2026-09-30T03:16:32Z");
        hash.put("region_reason", "fallback — adsb_lol 429");
        hash.put("hot", "adsb_fi");                        // 수집기가 쓰지 않는 작업
        hash.put("region_debug", "x");                     // 모르는 꼬리
        hash.put("collector_token", "secret-like");        // 모르는 필드
        for (String k : List.of("none_since", "none_reason", "none_next", "none_retry")) hash.put("global_" + k, "v-" + k);
        org.springframework.data.redis.core.HashOperations<String, Object, Object> ops = org.mockito.Mockito.mock(org.springframework.data.redis.core.HashOperations.class);
        org.mockito.Mockito.when(ops.entries(org.mockito.ArgumentMatchers.anyString()))
                .thenAnswer(inv -> "wakeline:active".equals(inv.getArgument(0)) ? (Map) hash : Map.of());
        StringRedisTemplate redis = new StringRedisTemplate() {
            @Override public <HK, HV> org.springframework.data.redis.core.HashOperations<String, HK, HV> opsForHash() {
                return (org.springframework.data.redis.core.HashOperations) ops;
            }
        };
        SnapshotStore snapshots = new SnapshotStore();
        EngineService engine = new EngineService(snapshots, new SigmetStore(), e -> { }, new SimpleMeterRegistry());
        Map<String, Object> pub = (Map<String, Object>) new StatusService(snapshots, new SigmetStore(), new RadarStore(), engine, redis, () -> new RegionSettings.Region(36.5, 127.8, 250))
                .publicStatus().get("active_providers");
        assertThat(pub.keySet()).containsExactly("global", "region", "region_since", "region_reason", "global_none_since", "global_none_reason",
                "global_none_next", "global_none_retry");
        assertThat(pub.get("region_reason")).isEqualTo("fallback — adsb_lol 429");
        assertThat(pub.get("global_none_retry")).isEqualTo("v-none_retry");
        // Redis 를 읽지 못하면(연결 없음) 예전과 같은 표시
        assertThat(new StatusService(snapshots, new SigmetStore(), new RadarStore(), engine, new StringRedisTemplate(), () -> new RegionSettings.Region(36.5, 127.8, 250))
                .publicStatus().get("active_providers")).isEqualTo(Map.of("error", "redis unavailable"));
    }
}
