package dev.skywx.rest;

import dev.skywx.config.AppProperties;
import dev.skywx.config.Problem;
import dev.skywx.domain.Alert;
import dev.skywx.domain.Bbox;
import dev.skywx.domain.SigmetRecord;
import dev.skywx.engine.EngineService;
import dev.skywx.ingest.RadarStore;
import dev.skywx.ingest.SigmetStore;
import dev.skywx.persist.AirportRepository;
import dev.skywx.persist.AlertRepository;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.http.CacheControl;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;

/** SIGMET · 알림 · 레이더 · 공항 REST v1. */
@org.springframework.context.annotation.Profile("!cli")
@RestController
@RequestMapping("/api/v1")
public class WeatherController {
    private final SigmetStore sigmets;
    private final EngineService engine;
    private final RadarStore radar;
    private final AirportRepository airports;
    private final AlertRepository alertRepo;
    private final AppProperties props;
    private final org.springframework.data.redis.core.StringRedisTemplate redis;
    private final tools.jackson.databind.ObjectMapper json;

    public WeatherController(SigmetStore sigmets, EngineService engine, RadarStore radar, AirportRepository airports, AlertRepository alertRepo, AppProperties props, org.springframework.data.redis.core.StringRedisTemplate redis, tools.jackson.databind.ObjectMapper json) {
        this.redis = redis;
        this.json = json;
        this.sigmets = sigmets;
        this.engine = engine;
        this.radar = radar;
        this.airports = airports;
        this.alertRepo = alertRepo;
        this.props = props;
    }

    @GetMapping(value = "/sigmets", produces = "application/geo+json")
    public ResponseEntity<Map<String, Object>> sigmets(@RequestParam(defaultValue = "true") boolean active, @RequestParam(required = false) String bbox,
                                                       @RequestParam(required = false) String hazard, HttpServletRequest req) {
        Instant now = Instant.now();
        SigmetStore.State st = sigmets.state();
        String etag = "\"s" + st.version() + "-" + (active ? 1 : 0) + "\"";
        if (bbox == null && hazard == null && etag.equals(req.getHeader("If-None-Match"))) return ResponseEntity.status(304).eTag(etag).build();
        Bbox b = bbox == null ? null : Bbox.parse(bbox, 0);
        List<SigmetRecord> list = new ArrayList<>();
        for (SigmetRecord s : st.byId().values()) {
            if (hazard != null && !hazard.equalsIgnoreCase(s.hazard())) continue;
            if (b != null && s.geometry() != null) {
                var env = s.geometry().getEnvelopeInternal();
                if (env.getMaxX() < b.lomin() || env.getMinX() > b.lomax() || env.getMaxY() < b.lamin() || env.getMinY() > b.lamax()) continue;
            }
            list.add(s);
        }
        Map<String, Object> fc = SigmetGeoJson.collection(list, now, active);
        fc.put("meta", Meta.of(req, st.provider(), st.fetchedAt(), 900));
        return ResponseEntity.ok().eTag(etag).cacheControl(CacheControl.maxAge(60, TimeUnit.SECONDS).cachePublic()).body(fc);
    }

    @GetMapping("/sigmets/{id}")
    public ResponseEntity<Map<String, Object>> sigmet(@PathVariable String id, HttpServletRequest req) {
        SigmetRecord s = sigmets.get(id);
        if (s == null) throw Problem.notFound("sigmet not found");
        Map<String, Object> m = new LinkedHashMap<>(SigmetGeoJson.feature(s, Instant.now()));
        m.put("aircraft_inside", engine.aircraftInside(id));
        m.put("meta", Meta.of(req, s.provider(), s.fetchedAt(), 900));
        return ResponseEntity.ok().cacheControl(CacheControl.maxAge(10, TimeUnit.SECONDS)).body(m);
    }

    @GetMapping("/alerts")
    public ResponseEntity<Map<String, Object>> alerts(@RequestParam(required = false) String kind, HttpServletRequest req) {
        List<Alert> list = engine.activeAlerts(kind);
        return ResponseEntity.ok().cacheControl(CacheControl.maxAge(5, TimeUnit.SECONDS)).body(Map.of("items", list, "meta", Meta.of(req, "engine", Instant.now(), 60)));
    }

    @GetMapping("/alerts/history")
    public ResponseEntity<Map<String, Object>> alertHistory(@RequestParam(required = false) Instant from, @RequestParam(required = false) Instant to,
                                                            @RequestParam(required = false) String hex, @RequestParam(required = false) Long cursor,
                                                            @RequestParam(defaultValue = "50") int limit, HttpServletRequest req) {
        Instant end = to == null ? Instant.now() : to;
        Instant start = from == null ? end.minusSeconds(86400) : from;
        if (!start.isBefore(end) || end.toEpochMilli() - start.toEpochMilli() > 30L * 86400_000) throw Problem.badRequest("BAD_RANGE", "range must be within 30 d");
        int lim = Math.max(1, Math.min(limit, 200));
        var page = alertRepo.history(start, end, hex == null ? null : AircraftController.normalizeHex(hex), cursor, lim);
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("items", page.items());
        m.put("next_cursor", page.nextCursor());
        m.put("meta", Meta.of(req, "db", Instant.now(), 60));
        return ResponseEntity.ok().cacheControl(CacheControl.maxAge(60, TimeUnit.SECONDS)).body(m);
    }

    @GetMapping("/radar/frames")
    public ResponseEntity<Map<String, Object>> radarFrames(HttpServletRequest req) {
        RadarStore.Frames f = radar.frames();
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("host", f.host());
        m.put("generated", f.generated());
        m.put("past", f.past());
        m.put("tile_template", "{host}{path}/512/{z}/{x}/{y}/2/1_0.png");
        m.put("max_zoom", 7);
        m.put("attribution", "Radar © RainViewer (personal/educational use)");
        m.put("meta", Meta.of(req, f.provider(), f.fetchedAt(), 600));
        return ResponseEntity.ok().cacheControl(CacheControl.maxAge(60, TimeUnit.SECONDS)).body(m);
    }

    /** 기상청 레이더 합성(FR-31): 최근 프레임 목록 + 웹 메르카토르 정합 좌표(문서 기반 LCC → EPSG:3857 재투영) + 범례. */
    @GetMapping("/radar/kr")
    public ResponseEntity<Map<String, Object>> radarKr(HttpServletRequest req) {
        Map<Object, Object> h;
        String framesJson;
        try { h = redis.opsForHash().entries("skywx:radar_kr:meta"); framesJson = redis.opsForValue().get("skywx:radar_kr:frames"); }
        catch (RuntimeException e) { h = Map.of(); framesJson = null; }
        Map<String, Object> m = new LinkedHashMap<>();
        boolean available = "1".equals(h.get("available"));
        m.put("available", available);
        m.put("status", h.get("status"));
        m.put("note", h.get("note"));
        m.put("product", h.get("product"));
        m.put("cmp", h.get("cmp"));
        m.put("latest_tm", h.get("latest_tm"));
        m.put("georeferenced", available);
        m.put("coordinates", h.get("coordinates") == null ? null : json.readTree(String.valueOf(h.get("coordinates"))));
        m.put("projection", h.get("projection"));
        m.put("grid", h.get("grid") == null ? null : json.readTree(String.valueOf(h.get("grid"))));
        m.put("legend", h.get("legend") == null ? null : json.readTree(String.valueOf(h.get("legend"))));
        m.put("min_dbz", h.get("min_dbz"));
        m.put("stations", h.get("stations"));
        m.put("image_size", h.get("width") == null ? null : new int[]{Integer.parseInt(String.valueOf(h.get("width"))), Integer.parseInt(String.valueOf(h.get("height")))});
        List<Map<String, Object>> frames = new ArrayList<>();
        if (framesJson != null) for (var f : json.readTree(framesJson)) {
            Map<String, Object> fr = new LinkedHashMap<>();
            fr.put("tm", f.path("tm").asString());
            fr.put("obs_tm", f.path("obs_tm").asString());
            fr.put("fetched_at", f.path("fetched_at").asString());
            fr.put("echo_cells", f.path("echo_cells").asInt());
            fr.put("url", "/api/v1/radar/kr/" + f.path("tm").asString() + ".png");
            frames.add(fr);
        }
        m.put("frames", frames);
        m.put("time_zone", "KST(UTC+9) for tm; fetched_at is UTC");
        m.put("attribution", "기상청 API허브 레이더 합성자료(HSR) · 투영·격자 정의: 기상기후데이터위키");
        Instant fetched = h.get("fetched_at") == null ? null : Instant.parse(String.valueOf(h.get("fetched_at")));
        m.put("meta", Meta.of(req, "kma_apihub", fetched, 900));
        return ResponseEntity.ok().cacheControl(CacheControl.maxAge(30, TimeUnit.SECONDS)).body(m);
    }

    @GetMapping(value = "/radar/kr/{tm}.png")
    public ResponseEntity<byte[]> radarKrFrame(@PathVariable String tm) {
        if (!tm.matches("^\\d{12}$")) throw Problem.badRequest("BAD_TM", "tm must be YYYYMMDDHHMM");
        String b64;
        try { b64 = redis.opsForValue().get("skywx:radar_kr:frame:" + tm); } catch (RuntimeException e) { b64 = null; }
        if (b64 == null) throw Problem.notFound("no KMA radar frame " + tm);
        return ResponseEntity.ok().cacheControl(CacheControl.maxAge(3600, TimeUnit.SECONDS).cachePublic())
                .header("Content-Type", "image/png").body(java.util.Base64.getDecoder().decode(b64));
    }

    @GetMapping(value = "/airports", produces = "application/geo+json")
    public ResponseEntity<Map<String, Object>> airports(@RequestParam(required = false) String bbox, @RequestParam(defaultValue = "true") boolean watched, HttpServletRequest req) {
        Bbox b = bbox == null ? Bbox.world() : Bbox.parse(bbox, 0);
        List<Map<String, Object>> rows = airports.withLatestMetar(b, watched);
        List<Map<String, Object>> features = new ArrayList<>();
        Instant latest = null;
        for (var r : rows) {
            Map<String, Object> f = new LinkedHashMap<>();
            f.put("type", "Feature");
            f.put("id", r.get("icao"));
            f.put("geometry", Map.of("type", "Point", "coordinates", new double[]{(double) r.get("lon"), (double) r.get("lat")}));
            Map<String, Object> p = new LinkedHashMap<>(r);
            p.remove("lat"); p.remove("lon");
            f.put("properties", p);
            features.add(f);
            Object ft = r.get("fetched_at");
            if (ft instanceof Instant i && (latest == null || i.isAfter(latest))) latest = i;
        }
        Map<String, Object> fc = new LinkedHashMap<>();
        fc.put("type", "FeatureCollection");
        fc.put("features", features);
        fc.put("meta", Meta.of(req, "awc", latest, 1800));
        return ResponseEntity.ok().cacheControl(CacheControl.maxAge(60, TimeUnit.SECONDS)).body(fc);
    }

    @GetMapping("/airports/{icao}/wx")
    public ResponseEntity<Map<String, Object>> airportWx(@PathVariable String icao, HttpServletRequest req) {
        String code = icao.trim().toUpperCase();
        if (!code.matches("^[A-Z0-9]{4}$")) throw Problem.badRequest("BAD_ICAO", "icao must be 4 chars");
        Map<String, Object> wx = airports.wx(code);
        if (wx == null) throw Problem.notFound("airport not watched: " + code);
        Object ft = wx.get("fetched_at");
        wx.put("meta", Meta.of(req, String.valueOf(wx.getOrDefault("provider", "awc")), ft instanceof Instant i ? i : null, 1800));
        return ResponseEntity.ok().cacheControl(CacheControl.maxAge(300, TimeUnit.SECONDS)).body(wx);
    }
}
