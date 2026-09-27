package dev.skywx.rest;

import dev.skywx.config.AppProperties;
import dev.skywx.config.Problem;
import dev.skywx.domain.AircraftState;
import dev.skywx.domain.Alert;
import dev.skywx.domain.Bbox;
import dev.skywx.engine.EngineService;
import dev.skywx.ingest.Snapshot;
import dev.skywx.ingest.SnapshotStore;
import dev.skywx.persist.AircraftRepository;
import dev.skywx.persist.TrackRepository;
import dev.skywx.ws.WsMessages;
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

/** 항공기 REST v1. 스냅샷은 ETag(버전) + max-age=5. */
@org.springframework.context.annotation.Profile("!cli & !migrate")
@RestController
@RequestMapping("/api/v1/aircraft")
public class AircraftController {
    private final SnapshotStore snapshots;
    private final EngineService engine;
    private final AircraftRepository aircraft;
    private final TrackRepository tracks;
    private final AppProperties props;

    public AircraftController(SnapshotStore snapshots, EngineService engine, AircraftRepository aircraft, TrackRepository tracks, AppProperties props) {
        this.snapshots = snapshots;
        this.engine = engine;
        this.aircraft = aircraft;
        this.tracks = tracks;
        this.props = props;
    }

    @GetMapping(produces = "application/geo+json")
    public ResponseEntity<Map<String, Object>> snapshot(@RequestParam String bbox, @RequestParam(defaultValue = "lite") String detail, HttpServletRequest req) {
        Bbox b = Bbox.parse(bbox, props.maxBboxAreaSqdeg());
        Snapshot s = snapshots.region();
        Snapshot g = snapshots.global();
        String etag = "\"v" + s.version() + "-" + g.version() + "\"";
        if (etag.equals(req.getHeader("If-None-Match"))) return ResponseEntity.status(304).eTag(etag).build();
        List<Map<String, Object>> features = new ArrayList<>();
        for (AircraftState a : snapshots.mergedValues()) {
            if (!b.contains(a.lat(), a.lon())) continue;
            features.add(feature(a, "full".equals(detail) ? "full" : "lite"));
        }
        Map<String, Object> fc = new LinkedHashMap<>();
        fc.put("type", "FeatureCollection");
        fc.put("features", features);
        fc.put("meta", Meta.of(req, s.provider(), s.fetchedAt(), 60));
        return ResponseEntity.ok().eTag(etag).cacheControl(CacheControl.maxAge(5, TimeUnit.SECONDS).cachePublic()).body(fc);
    }

    @GetMapping("/search")
    public ResponseEntity<Map<String, Object>> search(@RequestParam String q, HttpServletRequest req) {
        String needle = q.trim().toUpperCase();
        if (needle.length() < 2 || needle.length() > 10) throw Problem.badRequest("BAD_QUERY", "q must be 2..10 chars");
        List<Map<String, Object>> out = new ArrayList<>();
        for (AircraftState a : snapshots.region().states().values()) {
            if (out.size() >= 20) break;
            boolean m = a.hex().toUpperCase().startsWith(needle) || (a.callsign() != null && a.callsign().toUpperCase().startsWith(needle))
                    || (a.registration() != null && a.registration().toUpperCase().startsWith(needle));
            if (m) out.add(WsMessages.encode(a, "lite", false));
        }
        if (out.size() < 20) for (var r : aircraft.search(needle, 20 - out.size())) out.add(r);
        return ResponseEntity.ok().cacheControl(CacheControl.maxAge(5, TimeUnit.SECONDS)).body(Map.of("items", out, "meta", Meta.of(req, snapshots.region().provider(), snapshots.region().fetchedAt(), 60)));
    }

    @GetMapping("/{hex}")
    public ResponseEntity<Map<String, Object>> detail(@PathVariable String hex, HttpServletRequest req) {
        String h = normalizeHex(hex);
        AircraftState a = snapshots.find(h);
        Map<String, Object> stat = aircraft.find(h);
        if (a == null && stat == null) throw Problem.notFound("aircraft " + h + " not seen");
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("hex", h);
        m.put("state", a == null ? null : WsMessages.encode(a, "full", false));
        m.put("static", stat);
        List<Alert> alerts = engine.activeAlerts(null).stream().filter(x -> x.hex().equals(h)).toList();
        m.put("active_alerts", alerts);
        m.put("inside_sigmets", engine.insideSigmets(h));
        m.put("emergency", a != null && a.emergency());
        Snapshot s = snapshots.region();
        m.put("meta", Meta.of(req, a == null ? "db" : a.provider(), a == null ? null : a.fetchedAt(), 60));
        return ResponseEntity.ok().cacheControl(CacheControl.maxAge(5, TimeUnit.SECONDS)).body(m);
    }

    @GetMapping(value = "/{hex}/track", produces = "application/geo+json")
    public ResponseEntity<Map<String, Object>> track(@PathVariable String hex, @RequestParam(required = false) Instant from,
                                                     @RequestParam(required = false) Instant to, @RequestParam(defaultValue = "0") int stepS,
                                                     HttpServletRequest req) {
        String h = normalizeHex(hex);
        Instant end = to == null ? Instant.now() : to;
        Instant start = from == null ? end.minus(Duration.ofHours(2)) : from;
        if (Duration.between(start, end).toHours() > 24 || !start.isBefore(end)) throw Problem.badRequest("BAD_RANGE", "range must be within 24 h");
        List<Map<String, Object>> pts = tracks.track(h, start, end, Math.max(0, Math.min(stepS, 3600)));
        List<double[]> coords = new ArrayList<>(pts.size());
        for (var p : pts) coords.add(new double[]{(double) p.get("lon"), (double) p.get("lat")});
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("type", "Feature");
        m.put("geometry", Map.of("type", "LineString", "coordinates", coords));
        m.put("properties", Map.of("hex", h, "from", start, "to", end, "points", pts.size()));
        m.put("points", pts);
        m.put("meta", Meta.of(req, "db", pts.isEmpty() ? null : (Instant) pts.getLast().get("ts"), 120));
        return ResponseEntity.ok().cacheControl(CacheControl.maxAge(30, TimeUnit.SECONDS)).body(m);
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
