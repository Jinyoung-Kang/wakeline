package dev.wakeline.status;

import dev.wakeline.platform.config.AppProperties;
import dev.wakeline.demand.DemandStats;
import dev.wakeline.settings.RegionSettings;
import dev.wakeline.platform.support.Times;
import dev.wakeline.weather.data.KrRadarFrames;
import dev.wakeline.weather.data.KrRadarMissing;
import org.springframework.beans.factory.annotation.Autowired;
import dev.wakeline.engine.EngineService;
import dev.wakeline.ingest.AisStatus;
import dev.wakeline.ingest.RadarStore;
import dev.wakeline.ingest.SigmetStore;
import dev.wakeline.ingest.Snapshot;
import dev.wakeline.ingest.SnapshotStore;
import io.micrometer.core.instrument.Counter;
import io.micrometer.core.instrument.MeterRegistry;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.stereotype.Service;

import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.Supplier;

/**
 * 공개 상태(비밀값·수치 예산 없음)와 운영 상태(공급자 해시 전체). collector 가 Redis 에 쓴 값을 읽는다.
 * 공개 상태는 {@link #STATUS_TTL_MS} 동안 한 벌을 나눠 쓴다(R-53) — WS status 메시지와 REST /api/v1/status 가 같은 캐시에서 읽는다
 * (예전에는 이 캐시가 WS 허브 안에 있어 REST 컨트롤러가 WS 허브를 읽었다 — api-review E6 · §2.5-5).
 */
@Service
public class StatusService {
    private static final Logger log = LoggerFactory.getLogger(StatusService.class);
    /** 공개 상태(Redis 조회 3회) 공유 캐시 수명 */
    static final long STATUS_TTL_MS = 3_000;
    /**
     * 운영 화면 공급자(상태 해시 wakeline:provider:{name} · 켜고 끄기는 감사 기록과 함께 — OpsController). adsbdb = 선택 항공기 노선 조회
     * (계약 v4 §G A-2 — 끄면 수집기가 묻지 않고 노선 상태는 disabled). 해시에는 호출 시각·지연·건수·오류·예산만 있고 노선 내용은 없다(ADR-016).
     * portmis = 한국 항만 입출항 색인(해양수산부 PORT-MIS, ADR-022 개정 — 끄면 수집기가 색인을 갱신하지 않고 선박 카드의 입출항은 disabled(operator)).
     * komsa_traffic · mof_grid4 = 연안 교통량(ADR-023 — 해양교통안전공단 실시간 해양교통정보 · 해양수산부 격자4단계 WFS). 끄면 그 부분만 멈춘다
     * (교통을 끄면 /traffic/grid 가 disabled · operator_off, 격자를 끄면 모르는 칸을 채우지 않는다). 셋 다 apis.data.go.kr 의 같은 키 · 호스트 한도를 쓴다.
     */
    public static final List<String> PROVIDERS = List.of("adsb_lol", "adsb_fi", "opensky", "awc", "rainviewer", "kma_radar", "adsbdb", "portmis",
            "komsa_traffic", "mof_grid4", "fixture");
    private final SnapshotStore snapshots;
    private final SigmetStore sigmets;
    private final RadarStore radar;
    private final EngineService engine;
    private final StringRedisTemplate redis;
    /** 관심 지역(중심·반경) — collector 와 같은 런타임 설정(계약 §2, COR-12). */
    private final Supplier<RegionSettings.Region> region;
    /** 수요 기반 추적 수(계약 v2 §A3) — DemandService 가 마지막 계산에서 남긴다. */
    private final DemandStats demand;
    /** AIS 수신 상태(계약 v2 §B3 status.sources.ais). 없으면(테스트) sources.ais = null. */
    private final AisStatus ais;
    /** collector heartbeat 가 이보다 오래되면 그 안의 adsb_fi_rps_1m 은 '현재' 값이 아니다(null). */
    static final long HEARTBEAT_MAX_AGE_S = 120;
    private record Cached(long atMs, Map<String, Object> status) {}
    private final Object statusLock = new Object();
    private volatile Cached statusCache;
    private final Counter statusHit;
    private final Counter statusMiss;

    @Autowired
    public StatusService(SnapshotStore snapshots, SigmetStore sigmets, RadarStore radar, EngineService engine, StringRedisTemplate redis, RegionSettings region,
                         DemandStats demand, AisStatus ais, MeterRegistry meters) {
        this(snapshots, sigmets, radar, engine, redis, (Supplier<RegionSettings.Region>) region::current, demand, ais, meters);
    }

    public StatusService(SnapshotStore snapshots, SigmetStore sigmets, RadarStore radar, EngineService engine, StringRedisTemplate redis, RegionSettings region,
                         DemandStats demand, AisStatus ais) {
        this(snapshots, sigmets, radar, engine, redis, (Supplier<RegionSettings.Region>) region::current, demand, ais);
    }

    /** 고정 지역(.env 값) — 런타임 설정 없이 도는 테스트용. */
    public StatusService(SnapshotStore snapshots, SigmetStore sigmets, RadarStore radar, EngineService engine, StringRedisTemplate redis, AppProperties props) {
        this(snapshots, sigmets, radar, engine, redis, fixed(RegionSettings.defaults(props)), new DemandStats());
    }

    StatusService(SnapshotStore snapshots, SigmetStore sigmets, RadarStore radar, EngineService engine, StringRedisTemplate redis, Supplier<RegionSettings.Region> region) {
        this(snapshots, sigmets, radar, engine, redis, region, new DemandStats());
    }

    StatusService(SnapshotStore snapshots, SigmetStore sigmets, RadarStore radar, EngineService engine, StringRedisTemplate redis, Supplier<RegionSettings.Region> region,
                  DemandStats demand) {
        this(snapshots, sigmets, radar, engine, redis, region, demand, null);
    }

    StatusService(SnapshotStore snapshots, SigmetStore sigmets, RadarStore radar, EngineService engine, StringRedisTemplate redis, Supplier<RegionSettings.Region> region,
                  DemandStats demand, AisStatus ais) {
        this(snapshots, sigmets, radar, engine, redis, region, demand, ais, new SimpleMeterRegistry());
    }

    StatusService(SnapshotStore snapshots, SigmetStore sigmets, RadarStore radar, EngineService engine, StringRedisTemplate redis, Supplier<RegionSettings.Region> region,
                  DemandStats demand, AisStatus ais, MeterRegistry meters) {
        // 캐시 적중률(R-53): 공유 status 페이로드(WS · REST /status)
        this.statusHit = Counter.builder("wakeline_cache_requests_total").tag("cache", "status").tag("result", "hit").register(meters);
        this.statusMiss = Counter.builder("wakeline_cache_requests_total").tag("cache", "status").tag("result", "miss").register(meters);
        this.ais = ais;
        this.snapshots = snapshots;
        this.sigmets = sigmets;
        this.radar = radar;
        this.engine = engine;
        this.redis = redis;
        this.region = region;
        this.demand = demand;
    }

    private static Supplier<RegionSettings.Region> fixed(RegionSettings.Region r) { return () -> r; }

    /**
     * 공개 상태(REST /api/v1/status 가 쓴다, R-53) — WS 와 같은 STATUS_TTL_MS 캐시. 요청마다 Redis 를 읽지 않는다. 조회 실패 시 이전 값,
     * 이전 값도 없으면 예외를 그대로 올린다(REST 가 503 으로).
     */
    public Map<String, Object> cachedPublicStatus() {
        Map<String, Object> c = cachedPublicStatusOrNull();
        return c != null ? c : publicStatus();
    }

    /**
     * 공개 상태(WS status 메시지가 쓴다) — STATUS_TTL_MS 동안 모든 세션 · REST 가 같은 맵을 쓴다(같은 인스턴스 — WS 는 그 동안 직렬화도 한 번만).
     * 조회 실패 시 이전 값(없으면 null).
     */
    public Map<String, Object> cachedPublicStatusOrNull() {
        long now = System.currentTimeMillis();
        Cached c = statusCache;
        if (c != null && now - c.atMs() < STATUS_TTL_MS) {
            statusHit.increment();
            return c.status();
        }
        synchronized (statusLock) {
            c = statusCache;
            if (c != null && now - c.atMs() < STATUS_TTL_MS) {
                statusHit.increment();
                return c.status();
            }
            statusMiss.increment();
            try {
                Map<String, Object> st = publicStatus();
                statusCache = new Cached(System.currentTimeMillis(), st);
                return st;
            } catch (RuntimeException e) {
                log.debug("ws status unavailable: {}", e.toString());
                return c == null ? null : c.status();
            }
        }
    }

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
        m.put("radar", kv("provider", rf.provider(), "frames", rf.past().size(), "fetched_at", rf.fetchedAt(),
                "stale", lag(rf.fetchedAt(), now) > 600 || rf.fetchedAt().equals(Instant.EPOCH))); // 받은 적 없음 = 오래됨(SIGMET 과 같은 규칙)
        m.put("radar_kr", radarKr(safeHash("wakeline:radar_kr:meta")));
        m.put("engine", kv("index_polygons", engine.indexSize(), "last_cycle_ms", engine.lastCycleMs()));
        m.put("active_providers", activeProviders(safeHash("wakeline:active")));
        // 수요 기반 추적(계약 v2 §A3): 수만(hex·셀은 내보내지 않는다). adsb.fi 호출률은 수집기가 실제로 보낸 최근 60 s 호출 수 / 60.
        DemandStats.Counts dc = demand.counts();
        m.put("demand", kv("hot_active", dc.hotActive(), "focus_active", dc.focusActive(), "adsb_fi_rps_1m", adsbFiRps(hb, now)));
        // 선박(계약 v2 §B3): AIS 수신 상태 — 연결·지연·수신률·공백. AIS 를 본 적이 없으면 null(키 생략)
        m.put("sources", kv("ais", ais == null ? null : ais.publicView(now.toEpochMilli())));
        return m;
    }

    /**
     * collector heartbeat 의 adsb_fi_rps_1m(수집기 속도 상한이 센 실제 호출률). 값이 숫자가 아니거나, heartbeat 의 가장 최근 *_at 이
     * 120 s 보다 오래되었으면(수집기가 멈춤 — 마지막 값이 지금 값이 아니다) null.
     */
    static Double adsbFiRps(Map<String, Object> hb, Instant now) {
        Object raw = hb.get("adsb_fi_rps_1m");
        if (raw == null) return null;
        double v;
        try {
            v = Double.parseDouble(String.valueOf(raw).trim());
        } catch (NumberFormatException e) {
            return null;
        }
        if (!Double.isFinite(v) || v < 0 || v > 1000) return null;
        Instant newest = null;
        for (var e : hb.entrySet()) {
            if (!String.valueOf(e.getKey()).endsWith("_at")) continue;
            try {
                Instant t = Instant.parse(String.valueOf(e.getValue()));
                if (newest == null || t.isAfter(newest)) newest = t;
            } catch (java.time.format.DateTimeParseException ignored) {
                // 시각이 아닌 값은 건너뛴다
            }
        }
        if (newest == null || now.toEpochMilli() - newest.toEpochMilli() > HEARTBEAT_MAX_AGE_S * 1000) return null;
        return Math.round(v * 1000) / 1000.0;
    }

    /**
     * 공개 radar_kr(R-72 · ADR-017 §1): 수집기 해시 wakeline:radar_kr:meta 에서 검증한 필드만 — available(참·거짓, 수집기가 쓸 수 있다고 표시했는가),
     * status(세 자리 HTTP 상태), latest_tm(YYYYMMDDHHMM, KST), fetched_at·checked_at(시간대 있는 ISO 시각), 최신 프레임의 stations(합성 지점 수)·
     * stations_ref(기준)·partial(부분 합성 — ADR-021), missing(기상청 내려받기 '파일 없음' 연속 — KrRadarMissing, 2026-09-30). 틀리거나 없는 값은 키가 없다(모름).
     * 해시의 다른 필드(격자·범례·오류 문구 등)는 싣지 않는다 — 수집기가 필드를 더해도 공개 응답에 저절로 나가지 않는다.
     */
    static Map<String, Object> radarKr(Map<String, Object> h) {
        Map<String, Object> m = new LinkedHashMap<>();
        Object a = h.get("available");
        if ("1".equals(a)) m.put("available", true);
        else if ("0".equals(a)) m.put("available", false);
        String st = h.get("status") == null ? null : String.valueOf(h.get("status"));
        if (st != null && st.matches("^[1-5][0-9]{2}$")) m.put("status", st);
        String tm = h.get("latest_tm") == null ? null : String.valueOf(h.get("latest_tm"));
        if (tm != null && tm.matches("^[0-9]{12}$")) m.put("latest_tm", tm);
        for (String k : List.of("fetched_at", "checked_at")) {
            Instant t = Times.isoInstant(h.get(k));
            if (t != null) m.put(k, t);
        }
        // ADR-021: 최신 프레임의 합성 지점 수 · 기준 · 부분 합성. 기준은 자기 지점 수 이상, partial 은 두 수를 알고 stations < stations_ref 와 같을 때만
        Integer stations = siteCount(h.get("stations")), ref = siteCount(h.get("stations_ref"));
        if (stations != null) m.put("stations", stations);
        if (ref != null && (stations == null || ref >= stations)) m.put("stations_ref", ref);
        else ref = null;
        Object p = h.get("partial");
        if (stations != null && ref != null && ("1".equals(p) || "0".equals(p)) && "1".equals(p) == (stations < ref)) m.put("partial", "1".equals(p));
        Map<String, Object> missing = KrRadarMissing.from(h, field -> { }); // 틀린 값의 셈은 /radar/kr 가 한다(같은 해시 · 같은 규칙)
        if (missing != null) m.put("missing", missing);
        return m;
    }

    /** 수집기 해시의 지점 수(0–48 정수 문자열). 아니면 null — 옛 수집기의 코드 목록("KSN,GDK")도 모름이다. */
    static Integer siteCount(Object v) {
        if (v == null) return null;
        String s = String.valueOf(v).trim();
        if (!s.matches("^[0-9]{1,2}$")) return null;
        int n = Integer.parseInt(s);
        return n <= KrRadarFrames.MAX_STATIONS ? n : null;
    }

    public List<Map<String, Object>> providerStatuses() {
        List<Map<String, Object>> out = new java.util.ArrayList<>();
        for (String p : PROVIDERS) {
            Map<String, Object> h = new LinkedHashMap<>(safeHash("wakeline:provider:" + p));
            if (h.isEmpty()) continue;
            h.put("name", p);
            out.add(h);
        }
        return out;
    }

    public Map<String, Object> collectorHeartbeat() { return safeHash("wakeline:collector"); }

    /** Redis 를 읽지 못했다는 표시(api 가 붙인다 — 수집기 값이 아니다). */
    private static final Map<String, Object> REDIS_UNAVAILABLE = Map.of("error", "redis unavailable");

    @SuppressWarnings({"unchecked", "rawtypes"})
    private Map<String, Object> safeHash(String key) {
        try { return (Map) redis.opsForHash().entries(key); } catch (RuntimeException e) { return REDIS_UNAVAILABLE; }
    }

    /** 수집기가 wakeline:active 에 쓰는 작업(collector main.py — ProviderChain("region") · ProviderChain("global")). */
    static final List<String> ACTIVE_JOBS = List.of("region", "global");
    /** 작업마다 쓰는 필드의 꼬리(collector status.py set_active · set_none · NONE_FIELDS — "" 는 쓰는 공급자 이름). */
    static final List<String> ACTIVE_FIELD_SUFFIXES = List.of("", "_since", "_reason", "_none_since", "_none_reason", "_none_next", "_none_retry");
    private static final java.util.Set<String> ACTIVE_FIELDS = ACTIVE_JOBS.stream()
            .flatMap(j -> ACTIVE_FIELD_SUFFIXES.stream().map(x -> j + x)).collect(java.util.stream.Collectors.toUnmodifiableSet());

    /**
     * 공개 status(REST · WS)의 active_providers: 수집기 해시 wakeline:active 에서 허용 목록 필드만, 수집기가 쓴 순서대로(리뷰 cto-2026-10 S13 — 예전에는
     * 해시 전체를 실어 수집기가 새 필드를 쓰면 저절로 공개됐다). 화면(web lib/active-provider.ts)이 읽는 것이 이 필드들이다. 값은 수집기가 이미 가린 글이다.
     * 새 필드를 공개하려면 여기(와 웹 · 계약 문서)에 더한다. Redis 를 읽지 못했으면 그 표시를 그대로.
     */
    static Map<String, Object> activeProviders(Map<?, ?> hash) {
        if (hash == REDIS_UNAVAILABLE) return REDIS_UNAVAILABLE;
        Map<String, Object> out = new LinkedHashMap<>();
        for (var e : hash.entrySet()) if (ACTIVE_FIELDS.contains(String.valueOf(e.getKey()))) out.put(String.valueOf(e.getKey()), e.getValue());
        return out;
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
