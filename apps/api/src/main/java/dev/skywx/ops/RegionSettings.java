package dev.skywx.ops;

import dev.skywx.config.AppProperties;
import dev.skywx.domain.Bbox;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Component;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * 관심 지역(중심·반경) — collector 가 실제로 폴링하는 값과 같은 출처를 쓴다(COR-12, 계약 §2).
 * 읽는 순서: Redis 해시 skywx:settings(← app_setting 미러, collector 가 읽는 바로 그 값) → Redis 오류면 app_setting →
 * 둘 다 실패하면 마지막으로 읽은 값 유지 → 한 번도 못 읽었으면 .env 기본값(collector 도 해시가 없으면 같은 .env 값을 쓴다).
 * 값 해석 규칙도 collector(runtime_settings.py)와 같다: 중심 "lat,lon" 해석 실패 → 기본값, 반경은 정수·[50, 500] 로 자른다.
 * 조회(상태·통계·요약)는 캐시만 읽는다 — I/O 는 백그라운드 갱신(30 s)과 설정 변경 직후 refreshNow() 에서만 한다.
 */
@Component
public class RegionSettings {
    private static final Logger log = LoggerFactory.getLogger(RegionSettings.class);
    static final long TTL_MS = 30_000;
    static final String K_CENTER = "region_center";
    static final String K_RADIUS = "region_radius_nm";

    /** 관심 지역. center = [lat, lon]. */
    public record Region(double lat, double lon, int radiusNm) {
        public List<Double> center() { return List.of(lat, lon); }

        /** 관심 지역 원을 감싸는 bbox. 위도 1° = 60 NM, 경도는 cos(위도)로 보정(위도는 설정 검증에서 ±85° 로 제한). */
        public Bbox bbox() {
            double dlat = radiusNm / 60.0;
            double dlon = radiusNm / (60.0 * Math.cos(Math.toRadians(Math.max(-85, Math.min(85, lat)))));
            return new Bbox(Math.max(-180, lon - dlon), Math.max(-90, lat - dlat), Math.min(180, lon + dlon), Math.min(90, lat + dlat));
        }
    }

    private final StringRedisTemplate redis;
    private final JdbcClient db;
    private final ObjectMapper json;
    private final Region fallback;
    private volatile Region current;
    private volatile long loadedAtMs = Long.MIN_VALUE;
    private final AtomicBoolean refreshing = new AtomicBoolean();

    public RegionSettings(StringRedisTemplate redis, JdbcClient db, ObjectMapper json, AppProperties props) {
        this.redis = redis;
        this.db = db;
        this.json = json;
        this.fallback = defaults(props);
        this.current = fallback;
    }

    /** 현재 값(캐시). 30 s 가 지났으면 백그라운드에서 한 번 갱신을 건다 — 호출자는 기다리지 않는다. */
    public Region current() {
        if (System.currentTimeMillis() - loadedAtMs > TTL_MS && refreshing.compareAndSet(false, true)) {
            Thread.ofVirtual().name("region-settings").start(() -> {
                try { refreshNow(); } finally { refreshing.set(false); }
            });
        }
        return current;
    }

    /** 즉시 다시 읽는다(설정 변경·기동 미러 직후). 실패하면 마지막 값을 유지한다. */
    public Region refreshNow() {
        Map<String, String> raw = null;
        try {
            List<Object> v = redis.opsForHash().multiGet(SettingsService.REDIS_KEY, List.of(K_CENTER, K_RADIUS));
            raw = new HashMap<>();
            if (v != null && v.size() == 2) {
                if (v.get(0) != null) raw.put(K_CENTER, String.valueOf(v.get(0)));
                if (v.get(1) != null) raw.put(K_RADIUS, String.valueOf(v.get(1)));
            }
        } catch (RuntimeException e) {
            log.debug("region settings: redis unavailable ({}), trying app_setting", e.toString());
            try {
                raw = new HashMap<>();
                for (var r : db.sql("SELECT key, value::text value FROM app_setting WHERE key IN ('region_center', 'region_radius_nm')").query().listOfRows()) {
                    JsonNode n = json.readTree(String.valueOf(r.get("value")));
                    raw.put(String.valueOf(r.get("key")), n.isValueNode() ? n.asString() : n.toString());
                }
            } catch (RuntimeException e2) {
                log.warn("region settings unavailable (redis and db) — keeping {}: {}", current, e2.toString());
                raw = null;
            }
        }
        if (raw != null) {
            Region r = parse(raw.get(K_CENTER), raw.get(K_RADIUS), fallback);
            if (!r.equals(current)) log.info("region settings: {} (was {})", r, current);
            current = r;
        }
        loadedAtMs = System.currentTimeMillis();
        return current;
    }

    /** collector runtime_settings.region 과 같은 해석: 빈 값·해석 실패는 기본값, 반경은 [50, 500] 로 자른다. */
    static Region parse(String center, String radius, Region def) {
        double lat = def.lat(), lon = def.lon();
        if (center != null && !center.isBlank()) {
            String[] p = center.split(",");
            try {
                if (p.length != 2) throw new NumberFormatException("lat,lon");
                double la = Double.parseDouble(p[0].trim()), lo = Double.parseDouble(p[1].trim());
                if (!Double.isFinite(la) || !Double.isFinite(lo)) throw new NumberFormatException("non-finite");
                lat = la;
                lon = lo;
            } catch (NumberFormatException e) {
                lat = def.lat();
                lon = def.lon();
            }
        }
        int r = def.radiusNm();
        if (radius != null && !radius.isBlank()) {
            try { r = Integer.parseInt(radius.trim()); } catch (NumberFormatException e) { r = def.radiusNm(); }
        }
        return new Region(lat, lon, Math.max(50, Math.min(500, r)));
    }

    public static Region defaults(AppProperties props) {
        try {
            return new Region(props.regionLat(), props.regionLon(), Math.max(50, Math.min(500, props.regionRadiusNm())));
        } catch (RuntimeException e) {
            return new Region(36.5, 127.8, 250); // collector config.py 의 기본값과 같다
        }
    }
}
