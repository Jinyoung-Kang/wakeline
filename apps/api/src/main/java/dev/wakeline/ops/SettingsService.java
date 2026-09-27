package dev.wakeline.ops;

import dev.wakeline.config.Problem;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.node.JsonNodeFactory;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * 런타임 설정(FR-27): app_setting(낙관적 잠금 version) → Redis 해시 wakeline:settings 미러 → collector 가 다음 주기에 반영.
 * 변경과 감사 기록은 한 트랜잭션(SEC-11): UPDATE 와 audit_log INSERT 가 함께 커밋되거나 함께 취소된다. Redis 미러는 커밋 뒤에 하고,
 * 실패하면 응답에 mirrored=false 를 싣는다(주기 미러가 60 s 안에 맞춘다 — StartupMirror).
 */
@Service
public class SettingsService {
    private static final Logger log = LoggerFactory.getLogger(SettingsService.class);
    public static final String REDIS_KEY = "wakeline:settings";
    static final Set<String> KEYS = Set.of("region_poll_s", "global_poll_s", "sigmet_poll_s", "radar_poll_s", "metar_poll_s",
            "aircraft_providers", "region_center", "region_radius_nm", "global_enabled", "ais_bboxes");
    /** "lat,lon" — 숫자 형식만 여기서 보고, 범위는 숫자로 검사한다(정규식만으로는 lat 99 · lon 999 가 통과했다, COR-12). */
    private static final Pattern LAT_LON = Pattern.compile("^\\s*-?\\d{1,3}(\\.\\d{1,8})?\\s*,\\s*-?\\d{1,3}(\\.\\d{1,8})?\\s*$");
    /** AIS 구독 상자의 숫자 하나(ais/bbox.py 는 float() 로 더 넓게 받는다 — 여기서 더 엄격하면 api 를 통과한 값은 수집기도 받는다). */
    private static final Pattern BBOX_NUM = Pattern.compile("^-?\\d{1,3}(\\.\\d{1,6})?$");
    /** ais/bbox.py MAX_BOXES · MAX_TEXT 와 같다. */
    static final int MAX_AIS_BOXES = 16, MAX_AIS_TEXT = 1024;
    /** 관심 지역 위도 한계: 웹 메르카토르 표시 범위이자 bbox 경도 보정(cos 위도)이 발산하지 않는 범위. */
    static final double MAX_ABS_LAT = 85.0;
    /** 기동 시 .env 값으로 맞출 때 기록하는 updated_by. 운영자가 /ops 에서 바꾼 뒤에는(updated_by = 사용자명) 더 이상 덮어쓰지 않는다. */
    static final String ENV_SEEDER = "env";

    /** 변경 감사 기록 콜백(같은 트랜잭션 안에서 불린다). */
    @FunctionalInterface
    public interface AuditHook { void record(Object before, Object after); }

    private final JdbcClient db;
    private final StringRedisTemplate redis;
    private final ObjectMapper json;
    private final TransactionTemplate tx;
    private final RegionSettings region;

    public SettingsService(JdbcClient db, StringRedisTemplate redis, ObjectMapper json, TransactionTemplate tx, RegionSettings region) {
        this.db = db;
        this.redis = redis;
        this.json = json;
        this.tx = tx;
        this.region = region;
    }

    public List<Map<String, Object>> all() {
        return db.sql("SELECT key, value::text value, version, updated_by, updated_at FROM app_setting ORDER BY key").query().listOfRows()
                .stream().map(this::row).toList();
    }

    public Map<String, Object> get(String key) {
        return db.sql("SELECT key, value::text value, version, updated_by, updated_at FROM app_setting WHERE key = :k").param("k", key)
                .query().listOfRows().stream().findFirst().map(this::row)
                .orElseThrow(() -> Problem.notFound("setting not found"));
    }

    private Map<String, Object> row(Map<String, Object> r) {
        var m = new LinkedHashMap<>(r);
        m.put("value", json.readTree(String.valueOf(r.get("value"))));
        return m;
    }

    /**
     * 설정 변경 + 감사 기록(한 트랜잭션) → 커밋 후 Redis 미러.
     * @return 갱신된 설정 + mirrored(Redis 반영 여부)
     */
    public Map<String, Object> update(String key, JsonNode value, int expectedVersion, String by, AuditHook audit) {
        if (!KEYS.contains(key)) throw Problem.notFound("setting not found");
        validate(key, value);
        Map<String, Object> after = tx.execute(status -> {
            Map<String, Object> before = db.sql("SELECT key, value::text value, version, updated_by, updated_at FROM app_setting WHERE key = :k FOR UPDATE")
                    .param("k", key).query().listOfRows().stream().findFirst().map(this::row)
                    .orElseThrow(() -> Problem.notFound("setting not found"));
            int n = db.sql("UPDATE app_setting SET value = :v::jsonb, version = version + 1, updated_by = :by, updated_at = now() WHERE key = :k AND version = :ver")
                    .param("v", json.writeValueAsString(value)).param("by", by).param("k", key).param("ver", expectedVersion).update();
            if (n == 0) throw Problem.conflict("VERSION_MISMATCH", "setting changed by someone else; reload and retry");
            Map<String, Object> a = get(key);
            audit.record(before.get("value"), a.get("value"));
            return a;
        });
        Map<String, Object> out = new LinkedHashMap<>(after);
        out.put("mirrored", tryMirror());
        if (key.startsWith("region_")) region.refreshNow();
        return out;
    }

    private boolean tryMirror() {
        try {
            mirror();
            return true;
        } catch (RuntimeException e) {
            log.warn("settings mirror to redis failed (periodic mirror will retry): {}", e.toString());
            return false;
        }
    }

    /**
     * DB → Redis 미러(기동 시·변경 후·주기). 읽기와 쓰기를 한 락 안에서 해서, 오래된 값을 읽은 주기 미러가 방금 반영한 새 값을
     * 덮어쓰지 못하게 한다.
     */
    public synchronized void mirror() {
        Map<String, String> h = new LinkedHashMap<>();
        for (var r : all()) {
            JsonNode v = (JsonNode) r.get("value");
            h.put(String.valueOf(r.get("key")), v.isValueNode() ? v.asString() : v.toString());
        }
        redis.opsForHash().putAll(REDIS_KEY, h);
    }

    /**
     * .env 의 관심 지역을 런타임 설정에 맞춘다(COR-12: .env REGION_CENTER 가 collector 에서 조용히 무시되던 문제).
     * 운영자가 /ops 에서 바꾼 적이 없는 값(updated_by 가 NULL 또는 'env')만 바꾼다 — 운영자 변경이 .env 보다 우선한다.
     * 검증을 통과하지 못한 .env 값은 쓰지 않는다. 바꾼 경우 감사 기록(시스템)을 같은 트랜잭션에 남긴다.
     * @return 바꾼 키 목록
     */
    public List<String> seedFromEnv(String regionCenter, int regionRadiusNm, AuditService audit) {
        List<String> changed = new java.util.ArrayList<>();
        Map<String, JsonNode> wanted = new LinkedHashMap<>();
        wanted.put("region_center", JsonNodeFactory.instance.stringNode(regionCenter == null ? "" : regionCenter.trim()));
        wanted.put("region_radius_nm", JsonNodeFactory.instance.numberNode(regionRadiusNm));
        for (var e : wanted.entrySet()) {
            try {
                validate(e.getKey(), e.getValue());
            } catch (Problem p) {
                log.warn("env value for {} ignored (invalid): {}", e.getKey(), p.getMessage());
                continue;
            }
            Boolean did = tx.execute(status -> {
                var cur = db.sql("SELECT value::text value, updated_by FROM app_setting WHERE key = :k FOR UPDATE").param("k", e.getKey())
                        .query().listOfRows().stream().findFirst().orElse(null);
                if (cur == null) return false;
                Object by = cur.get("updated_by");
                if (by != null && !ENV_SEEDER.equals(by)) return false; // 운영자가 바꾼 값
                JsonNode before = json.readTree(String.valueOf(cur.get("value")));
                if (before.equals(e.getValue())) return false;
                db.sql("UPDATE app_setting SET value = :v::jsonb, version = version + 1, updated_by = :by, updated_at = now() WHERE key = :k")
                        .param("v", json.writeValueAsString(e.getValue())).param("by", ENV_SEEDER).param("k", e.getKey()).update();
                audit.recordSystem("SETTING_SEED_ENV", e.getKey(), before, e.getValue());
                return true;
            });
            if (Boolean.TRUE.equals(did)) changed.add(e.getKey());
        }
        return changed;
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
                if (!v.isString() || !LAT_LON.matcher(v.asString()).matches()) throw Problem.badRequest("BAD_VALUE", "\"lat,lon\" required");
                String[] p = v.asString().split(",");
                double lat = Double.parseDouble(p[0].trim()), lon = Double.parseDouble(p[1].trim());
                if (Math.abs(lat) > MAX_ABS_LAT || Math.abs(lon) > 180)
                    throw Problem.badRequest("BAD_VALUE", "lat must be within ±" + (int) MAX_ABS_LAT + ", lon within ±180");
            }
            case "ais_bboxes" -> aisBboxes(v);
            default -> throw Problem.notFound("setting not found");
        }
    }

    /**
     * AIS 구독 영역(ADR-014 §7): "lat1,lon1,lat2,lon2" 상자를 ';' 로 이어 쓴 문자열, 1~16 개, 1,024 자 이하, |lat| ≤ 90, |lon| ≤ 180,
     * 넓이 0 인 상자 금지 — ais/bbox.py parse_bboxes 와 같은 규칙. 빈 문자열은 ".env AIS_BBOXES 를 쓴다"는 뜻이라 허용한다.
     * 수집기도 다시 검사하고, 틀린 값이면 현재 구독을 유지한다(여기서 막는 것은 운영자에게 바로 알려 주기 위해서다).
     */
    static void aisBboxes(JsonNode v) {
        if (!v.isString()) throw Problem.badRequest("BAD_VALUE", "string \"lat1,lon1,lat2,lon2[;...]\" required (empty = .env AIS_BBOXES)");
        String s = v.asString();
        if (s.length() > MAX_AIS_TEXT) throw Problem.badRequest("BAD_VALUE", "at most " + MAX_AIS_TEXT + " characters");
        if (s.isBlank()) return;
        int boxes = 0;
        for (String raw : s.split(";", -1)) {
            String part = raw.strip();
            if (part.isEmpty()) continue;
            String[] p = part.split(",", -1);
            if (p.length != 4) throw Problem.badRequest("BAD_VALUE", "each box needs 4 numbers lat1,lon1,lat2,lon2");
            double[] d = new double[4];
            for (int i = 0; i < 4; i++) {
                String t = p[i].strip();
                if (!BBOX_NUM.matcher(t).matches()) throw Problem.badRequest("BAD_VALUE", "box values must be decimal numbers");
                d[i] = Double.parseDouble(t);
            }
            if (Math.abs(d[0]) > 90 || Math.abs(d[2]) > 90) throw Problem.badRequest("BAD_VALUE", "latitude must be within ±90");
            if (Math.abs(d[1]) > 180 || Math.abs(d[3]) > 180) throw Problem.badRequest("BAD_VALUE", "longitude must be within ±180");
            if (d[0] == d[2] || d[1] == d[3]) throw Problem.badRequest("BAD_VALUE", "box has zero area");
            if (++boxes > MAX_AIS_BOXES) throw Problem.badRequest("BAD_VALUE", "at most " + MAX_AIS_BOXES + " boxes");
        }
        if (boxes == 0) throw Problem.badRequest("BAD_VALUE", "no bounding box");
    }

    private static void intRange(JsonNode v, int min, int max) {
        if (!v.isIntegralNumber() || v.asInt() < min || v.asInt() > max) throw Problem.badRequest("BAD_VALUE", "integer in [" + min + "," + max + "] required");
    }
}
