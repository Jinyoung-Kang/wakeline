package dev.wakeline.rest;

import dev.wakeline.platform.config.AppProperties;
import dev.wakeline.platform.web.BboxParam;
import dev.wakeline.platform.web.Etags;
import dev.wakeline.platform.web.Meta;
import dev.wakeline.platform.web.Problem;
import dev.wakeline.platform.web.ProblemAdvice;
import dev.wakeline.domain.AircraftState;
import dev.wakeline.domain.Alert;
import dev.wakeline.geo.Bbox;
import dev.wakeline.engine.EngineService;
import dev.wakeline.ingest.SnapshotStore;
import dev.wakeline.persist.AircraftRepository;
import dev.wakeline.persist.TrackRepository;
import dev.wakeline.route.RouteReader;
import dev.wakeline.ws.WsHub;
import dev.wakeline.ws.WsMessages;
import org.springframework.dao.DataAccessException;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.http.CacheControl;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;

/** 항공기 REST v1. 스냅샷은 ETag(버전) + Cache-Control: public, max-age=5. 실시간 조회는 DB 에 의존하지 않는다. */
@org.springframework.context.annotation.Profile("!cli & !migrate")
@RestController
@RequestMapping("/api/v1/aircraft")
public class AircraftController {
    private final SnapshotStore snapshots;
    private final EngineService engine;
    private final AircraftRepository aircraft;
    private final TrackRepository tracks;
    private final AppProperties props;
    private final RouteReader routes;
    static final int SEARCH_LIMIT = 20;

    public AircraftController(SnapshotStore snapshots, EngineService engine, AircraftRepository aircraft, TrackRepository tracks, AppProperties props,
                              RouteReader routes) {
        this.snapshots = snapshots;
        this.engine = engine;
        this.aircraft = aircraft;
        this.tracks = tracks;
        this.props = props;
        this.routes = routes;
    }

    /**
     * bbox 안의 현재 항공기(병합 뷰: 관심 지역 · 핫 리전 · 집중 추적 · 전세계를 신선도 우선으로, 600 s 넘은 전세계 기체 제외).
     * ETag = 병합 뷰 버전(어느 스코프든 바뀌면 오른다) + 만료 구간(시간만 흘러 오래된 기체가 빠진 경우도 다른 표현이다).
     * meta.sources: 스코프별 provider·fetched_at·lag_s·stale(WS 스냅샷과 같은 모양, 계약 §1).
     */
    @GetMapping(produces = "application/geo+json")
    public ResponseEntity<Map<String, Object>> snapshot(@RequestParam String bbox, @RequestParam(defaultValue = "lite") String detail, HttpServletRequest req) {
        Bbox b = BboxParam.parse(bbox, props.maxBboxAreaSqdeg());
        Instant now = Instant.now();
        SnapshotStore.View view = snapshots.view(now);
        String etag = "\"v" + view.version() + "-" + Long.toString(view.recheckAtMs(), 36) + "\"";
        CacheControl cc = CacheControl.maxAge(5, TimeUnit.SECONDS).cachePublic();
        if (Etags.notModified(etag, req.getHeader("If-None-Match"))) return ResponseEntity.status(304).eTag(etag).cacheControl(cc).build();
        List<Map<String, Object>> features = new ArrayList<>();
        for (AircraftState a : view.states().values()) {
            if (!b.contains(a.lat(), a.lon())) continue;
            features.add(feature(a, "full".equals(detail) ? "full" : "lite"));
        }
        Map<String, Object> fc = new LinkedHashMap<>();
        fc.put("type", "FeatureCollection");
        fc.put("features", features);
        Map<String, Object> meta = Meta.of(req, view.region().provider(), view.region().fetchedAt(), 60);
        meta.put("sources", WsHub.sources(view, now));
        fc.put("meta", meta);
        return ResponseEntity.ok().eTag(etag).cacheControl(cc).body(fc);
    }

    /**
     * 검색(계약 §2): 병합 뷰(관심 지역 + 전세계)에서 hex · 호출부호 · 등록기호 앞부분 일치, 최대 20건. 모자라면 DB(과거에 본 기체의
     * 정적 정보 — 현재 위치가 아니다, last_seen 포함)로 채운다. DB 가 없으면 실시간 결과만 주고 meta.db_unavailable = true(WARN 한 줄).
     */
    @GetMapping("/search")
    public ResponseEntity<Map<String, Object>> search(@RequestParam String q, HttpServletRequest req) {
        String needle = q.trim().toUpperCase(java.util.Locale.ROOT);
        if (needle.length() < 2 || needle.length() > 10) throw Problem.badRequest("BAD_QUERY", "q must be 2..10 chars");
        if (!needle.matches("^[A-Z0-9-]+$")) throw Problem.badRequest("BAD_QUERY", "q may contain letters, digits and '-' only");
        Instant now = Instant.now();
        SnapshotStore.View view = snapshots.view(now);
        List<Map<String, Object>> out = new ArrayList<>();
        java.util.Set<String> seen = new java.util.HashSet<>();
        for (AircraftState a : view.states().values()) {
            if (out.size() >= SEARCH_LIMIT) break;
            boolean m = a.hex().toUpperCase(java.util.Locale.ROOT).startsWith(needle)
                    || (a.callsign() != null && a.callsign().trim().toUpperCase(java.util.Locale.ROOT).startsWith(needle))
                    || (a.registration() != null && a.registration().toUpperCase(java.util.Locale.ROOT).startsWith(needle));
            if (m) {
                Map<String, Object> item = new LinkedHashMap<>(WsMessages.encode(a, "lite", false));
                item.put("live", true);
                out.add(item);
                seen.add(a.hex());
            }
        }
        boolean dbUnavailable = false;
        if (out.size() < SEARCH_LIMIT) {
            try {
                for (var r : aircraft.search(needle, SEARCH_LIMIT)) {
                    if (out.size() >= SEARCH_LIMIT) break;
                    if (seen.contains(String.valueOf(r.get("hex")).trim())) continue;
                    Map<String, Object> item = new LinkedHashMap<>(r);
                    item.put("live", false);
                    out.add(item);
                }
            } catch (DataAccessException e) {
                ProblemAdvice.answeredWithoutStore(e, req); // WARN 한 줄 — 결함(문법 · 권한)이면 그대로 던진다(500)
                dbUnavailable = true;
            }
        }
        Map<String, Object> meta = Meta.of(req, view.region().provider(), view.region().fetchedAt(), 60);
        if (dbUnavailable) meta.put("db_unavailable", true);
        return ResponseEntity.ok().cacheControl(CacheControl.maxAge(5, TimeUnit.SECONDS).cachePublic()).body(Map.of("items", out, "meta", meta));
    }

    /**
     * 상세: 실시간 상태는 메모리에서, 정적 정보는 DB 에서. DB 가 없어도 실시간 상태가 있으면 200 — static = null, meta.db_unavailable = true
     * (계약 §2: 실시간 경로는 DB 에 의존하지 않는다). 실시간 상태도 없고 DB 도 없으면 있는지 알 수 없으므로 503. 두 경우 모두 WARN 한 줄
     * (ProblemAdvice — 원인 · 경로 · 걸린 시간). DB 결함(문법 · 권한 — 저장소 장애가 아닌 DataAccessException)은 500.
     * route(계약 v4 §A): 실시간 상태의 콜사인으로 읽은 등록 노선(Redis 캐시 — 조회는 수집기가 선택된 항공기에 대해서만 한다).
     * 실시간 상태가 없으면 콜사인을 모르므로 키 없음.
     */
    @GetMapping("/{hex}")
    public ResponseEntity<Map<String, Object>> detail(@PathVariable String hex, HttpServletRequest req) {
        String h = normalizeHex(hex);
        AircraftState a = snapshots.find(h);
        Map<String, Object> stat = null;
        boolean dbUnavailable = false;
        try {
            stat = aircraft.find(h);
        } catch (DataAccessException e) {
            // 저장소를 못 쓰면 WARN 한 줄(원인 · 경로 · 걸린 시간) — 결함(문법 · 권한)은 삼키지 않는다(500 + ERROR)
            if (a == null) throw ProblemAdvice.storeUnavailable(e, req, "aircraft history store unavailable");
            ProblemAdvice.answeredWithoutStore(e, req);
            dbUnavailable = true;
        }
        if (a == null && stat == null) throw Problem.notFound("aircraft " + h + " not seen");
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("hex", h);
        m.put("state", a == null ? null : WsMessages.encode(a, "full", false));
        m.put("static", stat);
        m.put("route", routes.forAircraft(a));
        List<Alert> alerts = engine.activeAlerts(null).stream().filter(x -> x.hex().equals(h)).toList();
        m.put("active_alerts", alerts);
        m.put("inside_sigmets", engine.insideSigmets(h));
        m.put("emergency", a != null && a.emergency());
        Map<String, Object> meta = Meta.of(req, a == null ? "db" : a.provider(), a == null ? null : a.fetchedAt(), 60);
        if (dbUnavailable) meta.put("db_unavailable", true);
        m.put("meta", meta);
        return ResponseEntity.ok().cacheControl(CacheControl.maxAge(5, TimeUnit.SECONDS).cachePublic()).body(m);
    }

    /** 항적 한 번의 점 수 상한(R-52 — 선박 항적과 같다). 넘으면 앞에서부터(시간순) 이만큼만 싣고 properties.truncated = true. */
    static final int TRACK_MAX_POINTS = 5_000;
    /** 항적 범위 상한(선박 항적과 같다). */
    static final Duration TRACK_MAX_RANGE = Duration.ofHours(24);

    @GetMapping(value = "/{hex}/track", produces = "application/geo+json")
    public ResponseEntity<Map<String, Object>> track(@PathVariable String hex, @RequestParam(required = false) Instant from,
                                                     @RequestParam(required = false) Instant to, @RequestParam(defaultValue = "0") int stepS,
                                                     HttpServletRequest req) {
        String h = normalizeHex(hex);
        Instant end = to == null ? Instant.now() : to;
        Instant start = from == null ? end.minus(Duration.ofHours(2)) : from;
        // 정확히 비교한다(R-71 — toHours() 절삭은 24 h 59 m 을 통과시켰다)
        if (Duration.between(start, end).compareTo(TRACK_MAX_RANGE) > 0 || !start.isBefore(end)) throw Problem.badRequest("BAD_RANGE", "range must be within 24 h");
        List<Map<String, Object>> rows = tracks.track(h, start, end, Math.max(0, Math.min(stepS, 3600)), TRACK_MAX_POINTS + 1);
        boolean truncated = rows.size() > TRACK_MAX_POINTS;
        List<Map<String, Object>> pts = truncated ? rows.subList(0, TRACK_MAX_POINTS) : rows;
        List<double[]> coords = new ArrayList<>(pts.size());
        for (var p : pts) coords.add(new double[]{(double) p.get("lon"), (double) p.get("lat")});
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("type", "Feature");
        m.put("geometry", Map.of("type", "LineString", "coordinates", coords));
        m.put("properties", Map.of("hex", h, "from", start, "to", end, "points", pts.size(), "truncated", truncated));
        m.put("points", pts);
        m.put("meta", Meta.of(req, "db", pts.isEmpty() ? null : (Instant) pts.getLast().get("ts"), 120));
        return ResponseEntity.ok().cacheControl(CacheControl.maxAge(30, TimeUnit.SECONDS).cachePublic()).body(m);
    }

    static Map<String, Object> feature(AircraftState a, String detail) {
        Map<String, Object> f = new LinkedHashMap<>();
        f.put("type", "Feature");
        f.put("id", a.hex());
        f.put("geometry", Map.of("type", "Point", "coordinates", new double[]{a.lon(), a.lat()}));
        f.put("properties", WsMessages.encode(a, detail, false));
        return f;
    }

    static String normalizeHex(String hex) {
        String h = hex == null ? "" : hex.trim().toLowerCase();
        if (!h.matches("^[0-9a-f]{6}$")) throw Problem.badRequest("BAD_HEX", "hex must be 6 hex chars");
        return h;
    }
}
