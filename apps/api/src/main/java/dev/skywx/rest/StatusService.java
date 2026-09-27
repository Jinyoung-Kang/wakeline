package dev.skywx.rest;

import dev.skywx.config.AppProperties;
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

/** 공개 상태(비밀값·수치 예산 없음)와 운영 상태(공급자 해시 전체). collector 가 Redis 에 쓴 값을 읽는다. */
@Service
public class StatusService {
    public static final List<String> PROVIDERS = List.of("adsb_lol", "adsb_fi", "opensky", "awc", "rainviewer", "fixture");
    private final SnapshotStore snapshots;
    private final SigmetStore sigmets;
    private final RadarStore radar;
    private final EngineService engine;
    private final StringRedisTemplate redis;
    private final AppProperties props;

    public StatusService(SnapshotStore snapshots, SigmetStore sigmets, RadarStore radar, EngineService engine, StringRedisTemplate redis, AppProperties props) {
        this.snapshots = snapshots;
        this.sigmets = sigmets;
        this.radar = radar;
        this.engine = engine;
        this.redis = redis;
        this.props = props;
    }

    public Map<String, Object> publicStatus() {
        Instant now = Instant.now();
        Snapshot r = snapshots.region(), g = snapshots.global();
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("server_time", now);
        m.put("snapshot_version", snapshots.version());
        m.put("fixture_mode", props.fixture());
        m.put("region", kv("center", List.of(props.regionLat(), props.regionLon()), "radius_nm", props.regionRadiusNm(),
                "provider", r.provider(), "aircraft", r.states().size(), "lag_s", round(r.lagSeconds(now)), "stale", r.stale(now, 60), "fetched_at", r.fetchedAt()));
        m.put("global", kv("provider", g.provider(), "aircraft", g.states().size(), "lag_s", round(g.lagSeconds(now)), "stale", g.stale(now, 300), "fetched_at", g.fetchedAt()));
        var ss = sigmets.state();
        m.put("sigmet", kv("provider", ss.provider(), "count", ss.byId().size(), "active", sigmets.activeAt(now).size(), "fetched_at", ss.fetchedAt(),
                "lag_s", round(lag(ss.fetchedAt(), now)), "stale", lag(ss.fetchedAt(), now) > 900 || ss.fetchedAt().equals(Instant.EPOCH)));
        var rf = radar.frames();
        m.put("radar", kv("provider", rf.provider(), "frames", rf.past().size(), "fetched_at", rf.fetchedAt(), "stale", lag(rf.fetchedAt(), now) > 600));
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

    private static double lag(Instant t, Instant now) { return t.equals(Instant.EPOCH) ? -1 : (now.toEpochMilli() - t.toEpochMilli()) / 1000.0; }
    private static Object round(double v) { return v < 0 ? null : Math.round(v * 10) / 10.0; }
}
