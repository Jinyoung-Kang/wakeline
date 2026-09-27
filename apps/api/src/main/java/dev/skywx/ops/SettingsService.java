package dev.skywx.ops;

import dev.skywx.config.Problem;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/** 런타임 설정(FR-27): app_setting(낙관적 잠금 version) → Redis 해시 skywx:settings 미러 → collector 가 다음 주기에 반영. */
@Service
public class SettingsService {
    public static final String REDIS_KEY = "skywx:settings";
    static final Set<String> KEYS = Set.of("region_poll_s", "global_poll_s", "sigmet_poll_s", "radar_poll_s", "metar_poll_s",
            "aircraft_providers", "region_center", "region_radius_nm", "global_enabled");
    private final JdbcClient db;
    private final StringRedisTemplate redis;
    private final ObjectMapper json;

    public SettingsService(JdbcClient db, StringRedisTemplate redis, ObjectMapper json) {
        this.db = db;
        this.redis = redis;
        this.json = json;
    }

    public List<Map<String, Object>> all() {
        return db.sql("SELECT key, value::text value, version, updated_by, updated_at FROM app_setting ORDER BY key").query().listOfRows()
                .stream().map(r -> { var m = new LinkedHashMap<>(r); m.put("value", json.readTree(String.valueOf(r.get("value")))); return (Map<String, Object>) m; }).toList();
    }

    public Map<String, Object> get(String key) {
        return db.sql("SELECT key, value::text value, version, updated_by, updated_at FROM app_setting WHERE key = :k").param("k", key)
                .query().listOfRows().stream().findFirst().map(r -> { var m = new LinkedHashMap<>(r); m.put("value", json.readTree(String.valueOf(r.get("value")))); return (Map<String, Object>) m; })
                .orElseThrow(() -> Problem.notFound("setting not found"));
    }

    /** @return 갱신된 설정 */
    public Map<String, Object> update(String key, JsonNode value, int expectedVersion, String by) {
        if (!KEYS.contains(key)) throw Problem.notFound("setting not found");
        validate(key, value);
        int n = db.sql("UPDATE app_setting SET value = :v::jsonb, version = version + 1, updated_by = :by, updated_at = now() WHERE key = :k AND version = :ver")
                .param("v", json.writeValueAsString(value)).param("by", by).param("k", key).param("ver", expectedVersion).update();
        if (n == 0) throw Problem.conflict("VERSION_MISMATCH", "setting changed by someone else; reload and retry");
        mirror();
        return get(key);
    }

    /** 기동 시·변경 시 DB → Redis 미러. */
    public void mirror() {
        Map<String, String> h = new LinkedHashMap<>();
        for (var r : all()) {
            JsonNode v = (JsonNode) r.get("value");
            h.put(String.valueOf(r.get("key")), v.isValueNode() ? v.asString() : v.toString());
        }
        redis.opsForHash().putAll(REDIS_KEY, h);
    }

    static void validate(String key, JsonNode v) {
        switch (key) {
            case "region_poll_s" -> intRange(v, 5, 120);
            case "global_poll_s" -> intRange(v, 60, 3600);
            case "sigmet_poll_s" -> intRange(v, 60, 3600);
            case "radar_poll_s" -> intRange(v, 30, 3600);
            case "metar_poll_s" -> intRange(v, 300, 7200);
            case "region_radius_nm" -> intRange(v, 50, 500);
            case "global_enabled" -> { if (!v.isBoolean()) throw Problem.badRequest("BAD_VALUE", "boolean required"); }
            case "aircraft_providers" -> {
                if (!v.isString() || !v.asString().matches("^(adsb_lol|adsb_fi|opensky)(,(adsb_lol|adsb_fi|opensky))*$"))
                    throw Problem.badRequest("BAD_VALUE", "comma-separated list of adsb_lol|adsb_fi|opensky");
            }
            case "region_center" -> {
                if (!v.isString() || !v.asString().matches("^-?\\d{1,2}(\\.\\d+)?,-?\\d{1,3}(\\.\\d+)?$")) throw Problem.badRequest("BAD_VALUE", "lat,lon required");
            }
            default -> throw Problem.notFound("setting not found");
        }
    }

    private static void intRange(JsonNode v, int min, int max) {
        if (!v.isIntegralNumber() || v.asInt() < min || v.asInt() > max) throw Problem.badRequest("BAD_VALUE", "integer in [" + min + "," + max + "] required");
    }
}
