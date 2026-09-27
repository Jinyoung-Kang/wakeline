package dev.skywx.rest;

import dev.skywx.config.AppProperties;
import dev.skywx.ops.RegionSettings;
import org.springframework.beans.factory.annotation.Autowired;
import dev.skywx.engine.EngineService;
import dev.skywx.ingest.RadarStore;
import dev.skywx.ingest.SigmetStore;
import dev.skywx.ingest.Snapshot;
import dev.skywx.ingest.SnapshotStore;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.stereotype.Service;

import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.Supplier;

/** 공개 상태(비밀값·수치 예산 없음)와 운영 상태(공급자 해시 전체). collector 가 Redis 에 쓴 값을 읽는다. */
@Service
public class StatusService {
    public static final List<String> PROVIDERS = List.of("adsb_lol", "adsb_fi", "opensky", "awc", "rainviewer", "kma_radar", "fixture");
    private final SnapshotStore snapshots;
    private final SigmetStore sigmets;
    private final RadarStore radar;
    private final EngineService engine;
    private final StringRedisTemplate redis;
    /** 관심 지역(중심·반경) — collector 와 같은 런타임 설정(계약 §2, COR-12). */
    private final Supplier<RegionSettings.Region> region;

    @Autowired
    public StatusService(SnapshotStore snapshots, SigmetStore sigmets, RadarStore radar, EngineService engine, StringRedisTemplate redis, RegionSettings region) {
        this(snapshots, sigmets, radar, engine, redis, (Supplier<RegionSettings.Region>) region::current);
    }

    /** 고정 지역(.env 값) — 런타임 설정 없이 도는 테스트용. */
    public StatusService(SnapshotStore snapshots, SigmetStore sigmets, RadarStore radar, EngineService engine, StringRedisTemplate redis, AppProperties props) {
        this(snapshots, sigmets, radar, engine, redis, fixed(RegionSettings.defaults(props)));
    }

    StatusService(SnapshotStore snapshots, SigmetStore sigmets, RadarStore radar, EngineService engine, StringRedisTemplate redis, Supplier<RegionSettings.Region> region) {
        this.snapshots = snapshots;
        this.sigmets = sigmets;
        this.radar = radar;
        this.engine = engine;
        this.redis = redis;
        this.region = region;
    }

    private static Supplier<RegionSettings.Region> fixed(RegionSettings.Region r) { return () -> r; }

    public Map<String, Object> publicStatus() {
        Instant now = Instant.now();
        SnapshotStore.View view = snapshots.view(now);
        Snapshot r = view.region(), g = view.global();
        RegionSettings.Region reg = region.get();
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("server_time", now);
        m.put("snapshot_version", snapshots.version());
        // 배지는 api 설정이 아니라 collector 가 실제로 어떤 모드로 수집 중인지(heartbeat)를 따른다(VERIFICATION #15)
        Map<String, Object> hb = collectorHeartbeat();
        m.put("fixture_mode", "1".equals(String.valueOf(hb.get("fixture"))));
        m.put("collector_mode_known", hb.containsKey("fixture"));
        m.put("region", kv("center", reg.center(), "radius_nm", reg.radiusNm(),
                "provider", provider(r), "aircraft", r.states().size(), "lag_s", round(r.lagSeconds(now)), "stale", r.stale(now, 60), "fetched_at", fetched(r)));
        // 전세계: 자기 위치가 600 s 안인 기체만 센다(병합 뷰와 같은 기준) — 오래된 기체를 '현재' 수로 세지 않는다
        long cutoffMs = now.toEpochMilli() - SnapshotStore.GLOBAL_MAX_AGE_S * 1000;
        int globalCurrent = 0;
        for (var a : g.states().values()) if (a.seenAt().toEpochMilli() >= cutoffMs) globalCurrent++;
        m.put("global", kv("provider", provider(g), "aircraft", globalCurrent, "lag_s", round(g.lagSeconds(now)), "stale", g.stale(now, 300), "fetched_at", fetched(g)));
        var ss = sigmets.state();
        m.put("sigmet", kv("provider", ss.provider(), "count", ss.byId().size(), "active", sigmets.activeAt(now).size(), "fetched_at", ss.fetchedAt(),
                "lag_s", round(lag(ss.fetchedAt(), now)), "stale", lag(ss.fetchedAt(), now) > 900 || ss.fetchedAt().equals(Instant.EPOCH)));
        var rf = radar.frames();
        m.put("radar", kv("provider", rf.provider(), "frames", rf.past().size(), "fetched_at", rf.fetchedAt(), "stale", lag(rf.fetchedAt(), now) > 600));
        m.put("radar_kr", safeHash("skywx:radar_kr:meta"));
        m.put("engine", kv("index_polygons", engine.indexSize(), "last_cycle_ms", engine.lastCycleMs()));
        m.put("active_providers", safeHash("skywx:active"));
        return m;
    }

    public List<Map<String, Object>> providerStatuses() {
        List<Map<String, Object>> out = new java.util.ArrayList<>();
        for (String p : PROVIDERS) {
            Map<String, Object> h = new LinkedHashMap<>(safeHash("skywx:provider:" + p));
            if (h.isEmpty()) continue;
            h.put("name", p);
            out.add(h);
        }
        return out;
    }

    public Map<String, Object> collectorHeartbeat() { return safeHash("skywx:collector"); }

    @SuppressWarnings({"unchecked", "rawtypes"})
    private Map<String, Object> safeHash(String key) {
        try { return (Map) redis.opsForHash().entries(key); } catch (RuntimeException e) { return Map.of("error", "redis unavailable"); }
    }

    /** Map.of 는 null 값을 거부한다 — 값이 없는 필드는 null 로 그대로 내보낸다(추정하지 않는다). */
    private static Map<String, Object> kv(Object... kv) {
        Map<String, Object> m = new LinkedHashMap<>();
        for (int i = 0; i + 1 < kv.length; i += 2) m.put(String.valueOf(kv[i]), kv[i + 1]);
        return m;
    }

    /** 수집 이력이 없는 스냅샷의 자리표시("-", EPOCH)는 값이 아니다 — null 로 내보낸다. */
    private static String provider(Snapshot s) { return s.provider() == null || s.provider().isBlank() || "-".equals(s.provider()) ? null : s.provider(); }
    private static Instant fetched(Snapshot s) { return s.fetchedAt() == null || Instant.EPOCH.equals(s.fetchedAt()) ? null : s.fetchedAt(); }

    private static double lag(Instant t, Instant now) { return t.equals(Instant.EPOCH) ? -1 : (now.toEpochMilli() - t.toEpochMilli()) / 1000.0; }
    private static Object round(double v) { return v < 0 ? null : Math.round(v * 10) / 10.0; }
}
