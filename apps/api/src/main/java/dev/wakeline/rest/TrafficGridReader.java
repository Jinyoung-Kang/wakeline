package dev.wakeline.rest;

import io.micrometer.core.instrument.MeterRegistry;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.stereotype.Component;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Duration;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.function.LongSupplier;
import java.util.function.Supplier;
import java.util.regex.Pattern;

/**
 * 연안 교통량(ADR-023): 수집기가 쓴 스냅샷 wakeline:traffic_grid(문자열 JSON, TTL 20분)와 heartbeat(wakeline:collector 의 traffic_grid_state ·
 * traffic_grid_at)를 읽어 공개 /traffic/grid 의 상태를 정한다. api 는 외부를 부르지 않는다(ADR-006).
 * <ul>
 *   <li>수집기 값을 믿지 않는다(R-72): 형식이 틀린 스냅샷은 쓰지 않고(status invalid), 틀린 칸은 빼고 센다(invalid_cells · 지표) — 500 이 되지 않는다.
 *       칸은 0.025° 격자점(1e-6° 안)의 [grid_no, lat_min, lon_min, 척수, 밀집도 %] 만 받는다.</li>
 *   <li>상태: disabled(heartbeat 가 {@value #HEARTBEAT_MAX_AGE_S} s 안이고 수집기가 꺼졌다고 알림 — 키 없음 · fixture · 운영자 끔) · no_data(스냅샷 없음) ·
 *       invalid(형식 오류, 또는 regDt 가 지금보다 {@value #FUTURE_SKEW_S} s 넘게 미래 — 나이 0 으로 '신선'하게 보이지 않게) ·
 *       stale(자료 시각 regDt 가 {@value #STALE_AFTER_S} s 넘게 지남 — 칸을 싣지 않는다, 지난 자료를 지금처럼 보이지 않게) · ok.</li>
 *   <li>수: 해석 + 미해석 = 전체, 미해석 = 확인 중(pending) + 해양격자에 없음(not_found) + 격자 밖(off_grid) + 위치 조회 실패(failed — 거듭 실패해
 *       잠시 묻지 않는 칸). 하나라도 빠지거나 맞지 않으면 invalid.</li>
 *   <li>읽기는 {@value #MEMO_MS} ms 동안 같은 결과를 쓰고(요청마다 Redis 에서 250 KB 를 읽지 않게), 원문이 같으면 다시 해석하지 않는다.
 *       ETag 는 원문의 SHA-256 앞 8바이트 + 상태 — 내용이나 상태(오래됨 전환 포함)가 바뀔 때만 바뀐다.</li>
 * </ul>
 */
@Component
public class TrafficGridReader {
    public static final String KEY = "wakeline:traffic_grid";
    static final String HEARTBEAT = "wakeline:collector";
    public static final long STALE_AFTER_S = 900;
    /** 수집기 시계와 이만큼까지의 차이는 받는다(수집기도 같은 값으로 막는다 — PUBLISH_FUTURE_SKEW_S). */
    public static final long FUTURE_SKEW_S = 120;
    static final long HEARTBEAT_MAX_AGE_S = 120;
    static final long MEMO_MS = 5_000;
    public static final double CELL_DEG = 0.025;
    static final double SNAP_TOL_DEG = 1e-6;
    static final int MAX_CELLS = 20_000;
    static final Pattern GRID_NO = Pattern.compile("^[A-Za-z0-9_]{1,32}$");
    static final Set<String> DISABLED_STATES = Set.of("no_key", "fixture", "operator_off");
    public static final Map<String, String> SOURCE = source();

    private static Map<String, String> source() {
        Map<String, String> m = new LinkedHashMap<>(); // 순서 고정(응답 · 표본이 실행마다 같게)
        m.put("provider", "한국해양교통안전공단 MTIS 실시간 해양교통정보");
        m.put("grid", "해양수산부 해양격자 4단계");
        m.put("note", "5분 집계 — 격자별 선박 척수(개별 위치 아님)");
        return Collections.unmodifiableMap(m);
    }

    /** 해석한 스냅샷(원문이 같으면 다시 쓰는 불변 값). */
    record Parsed(String etag, Instant regDtUtc, String regDtKst, Instant fetchedAt, Map<String, Object> counts, List<List<Object>> cells, int invalidCells) {}

    /** 한 번 읽은 결과. */
    public record View(String status, String disabledReason, String etag, Parsed parsed, Instant heartbeatAt) {
        public boolean available() { return "ok".equals(status); }
    }

    private final Supplier<String> raw;
    private final Supplier<Map<Object, Object>> heartbeat;
    private final ObjectMapper json;
    private final LongSupplier clock;
    private final MeterRegistry meters;
    private volatile String lastRaw;
    private volatile Parsed lastParsed;
    private volatile Map<Object, Object> lastHb = Map.of();
    private volatile boolean everRead;
    private volatile long readAtMs;
    private volatile Parsed futureCounted; // 미래 regDt 를 센 스냅샷(같은 원문을 읽을 때마다 다시 세지 않게)

    @Autowired
    public TrafficGridReader(StringRedisTemplate redis, ObjectMapper json, MeterRegistry meters) {
        this(() -> redis.opsForValue().get(KEY), () -> redis.opsForHash().entries(HEARTBEAT), json, System::currentTimeMillis, meters);
    }

    /** 시험용: Redis 읽기 두 개와 시계를 주입한다. */
    TrafficGridReader(Supplier<String> raw, Supplier<Map<Object, Object>> heartbeat, ObjectMapper json, LongSupplier clock, MeterRegistry meters) {
        this.raw = raw;
        this.heartbeat = heartbeat;
        this.json = json;
        this.clock = clock;
        this.meters = meters == null ? new SimpleMeterRegistry() : meters;
    }

    /** 지금 상태. Redis 오류는 no_data(모름)로 — 지난 값을 '지금'으로 쓰지 않는다. */
    public synchronized View read() {
        long now = clock.getAsLong();
        if (!everRead || now < readAtMs || now - readAtMs >= MEMO_MS) {
            String r;
            Map<Object, Object> hb;
            try {
                r = raw.get();
                hb = heartbeat.get();
            } catch (RuntimeException e) {
                r = null;
                hb = Map.of();
            }
            if (r == null) {
                lastParsed = null;
            } else if (!r.equals(lastRaw) || lastParsed == null) {
                lastParsed = parse(r);
            }
            lastRaw = r;
            lastHb = hb == null ? Map.of() : hb;
            readAtMs = now;
            everRead = true;
        }
        return decide(lastRaw, lastParsed, lastHb, Instant.ofEpochMilli(now));
    }

    private View decide(String r, Parsed p, Map<Object, Object> hb, Instant now) {
        Instant hbAt = StatusService.isoInstant(hb.get("traffic_grid_at"));
        Object state = hb.get("traffic_grid_state");
        boolean hbFresh = hbAt != null && Math.abs(Duration.between(hbAt, now).toSeconds()) <= HEARTBEAT_MAX_AGE_S;
        if (hbFresh && state instanceof String s && DISABLED_STATES.contains(s)) return new View("disabled", s, "\"td-" + s + "\"", null, hbAt);
        if (r == null) return new View("no_data", null, "\"tn\"", null, hbAt);
        if (p == null) return new View("invalid", null, "\"ti\"", null, hbAt);
        if (Duration.between(now, p.regDtUtc()).toSeconds() > FUTURE_SKEW_S) {
            if (futureCounted != p) {
                futureCounted = p;
                meters.counter("wakeline_traffic_grid_parse_errors_total", "field", "reg_dt_future").increment();
            }
            return new View("invalid", null, "\"ti\"", null, hbAt);
        }
        boolean stale = Duration.between(p.regDtUtc(), now).toSeconds() > STALE_AFTER_S;
        return new View(stale ? "stale" : "ok", null, "\"t" + p.etag() + (stale ? "-s" : "") + "\"", p, hbAt);
    }

    /** 원문 → 해석한 스냅샷. 모양이 틀리면 null + 셈. */
    Parsed parse(String r) {
        JsonNode n;
        try {
            n = json.readTree(r);
        } catch (RuntimeException e) {
            return fail("json");
        }
        // canConvertToInt: int 밖의 정수면 intValue() 가 던진다(Jackson 3 — isIntegralNumber 는 범위를 보지 않는다, 리뷰 cto-2026-10 A2)
        if (n == null || !n.isObject() || !n.path("v").isIntegralNumber() || !n.path("v").canConvertToInt() || n.path("v").intValue() != 1) return fail("version");
        Instant regUtc = instant(n.get("reg_dt_utc"));
        String regKst = n.path("reg_dt_kst").isString() ? n.path("reg_dt_kst").asString() : null;
        if (regUtc == null || regKst == null || !kstOf(regKst, regUtc)) return fail("reg_dt");
        Instant fetched = instant(n.get("fetched_at"));
        if (fetched == null) return fail("fetched_at");
        JsonNode cd = n.get("cell_deg");
        if (cd == null || !cd.isNumber() || Math.abs(cd.doubleValue() - CELL_DEG) > 1e-12) return fail("cell_deg");
        Map<String, Object> counts = new LinkedHashMap<>();
        for (String k : List.of("total", "resolved", "unresolved", "pending", "not_found", "off_grid", "failed", "rejected")) {
            Integer v = count(n.get(k));
            if (v == null) return fail(k);
            counts.put(k, v);
        }
        int total = (int) counts.get("total"), resolved = (int) counts.get("resolved"), unresolved = (int) counts.get("unresolved");
        if (resolved + unresolved != total
                || (int) counts.get("pending") + (int) counts.get("not_found") + (int) counts.get("off_grid") + (int) counts.get("failed") != unresolved)
            return fail("counts");
        JsonNode tc = n.get("total_count");
        if (tc != null && !tc.isNull() && count(tc) == null) return fail("total_count");
        counts.put("total_count", tc == null || tc.isNull() ? null : count(tc));
        JsonNode partial = n.get("partial");
        if (partial == null || !partial.isBoolean()) return fail("partial");
        counts.put("partial", partial.booleanValue());
        JsonNode cells = n.get("cells");
        if (cells == null || !cells.isArray() || cells.size() > MAX_CELLS || cells.size() != resolved) return fail("cells");
        List<List<Object>> out = new ArrayList<>(cells.size());
        int invalid = 0;
        for (JsonNode c : cells) {
            List<Object> cell = cell(c);
            if (cell == null) invalid++;
            else out.add(cell);
        }
        if (invalid > 0) meters.counter("wakeline_traffic_grid_parse_errors_total", "field", "cell").increment(invalid);
        return new Parsed(sha(r), regUtc, regKst, fetched, Collections.unmodifiableMap(counts), Collections.unmodifiableList(out), invalid);
    }

    /** 칸 하나: [grid_no, lat_min, lon_min, 척수, 밀집도 %]. 틀리면 null. */
    static List<Object> cell(JsonNode c) {
        if (c == null || !c.isArray() || c.size() != 5) return null;
        JsonNode g = c.get(0), la = c.get(1), lo = c.get(2), v = c.get(3), d = c.get(4);
        if (!g.isString() || !GRID_NO.matcher(g.asString()).matches()) return null;
        if (!la.isNumber() || !lo.isNumber() || !onLattice(la.doubleValue()) || !onLattice(lo.doubleValue())) return null;
        double lat = la.doubleValue(), lon = lo.doubleValue();
        if (lat < -90 || lat + CELL_DEG > 90 + SNAP_TOL_DEG || lon < -180 || lon + CELL_DEG > 180 + SNAP_TOL_DEG) return null;
        Integer vm = count(v);
        if (vm == null || !d.isNumber() || !Double.isFinite(d.doubleValue()) || d.doubleValue() < 0 || d.doubleValue() > 100) return null;
        return List.of(g.asString(), lat, lon, vm, d.doubleValue());
    }

    static boolean onLattice(double v) {
        return Double.isFinite(v) && Math.abs(v - Math.round(v / CELL_DEG) * CELL_DEG) <= SNAP_TOL_DEG;
    }

    /** 0 이상 정수(int 범위). 아니면 null. */
    static Integer count(JsonNode v) {
        return v != null && v.isIntegralNumber() && v.canConvertToInt() && v.intValue() >= 0 ? v.intValue() : null;
    }

    static Instant instant(JsonNode v) {
        return v != null && v.isString() ? StatusService.isoInstant(v.asString()) : null;
    }

    /** reg_dt_kst 가 +09:00 이고 reg_dt_utc 와 같은 순간인가. */
    static boolean kstOf(String kst, Instant utc) {
        try {
            OffsetDateTime t = OffsetDateTime.parse(kst);
            return t.getOffset().equals(ZoneOffset.ofHours(9)) && t.toInstant().equals(utc);
        } catch (DateTimeParseException e) {
            return false;
        }
    }

    private Parsed fail(String field) {
        meters.counter("wakeline_traffic_grid_parse_errors_total", "field", field).increment();
        return null;
    }

    static String sha(String r) {
        try {
            byte[] h = MessageDigest.getInstance("SHA-256").digest(r.getBytes(StandardCharsets.UTF_8));
            return HexFormat.of().formatHex(h, 0, 8);
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e); // 모든 JVM 에 있다
        }
    }
}
