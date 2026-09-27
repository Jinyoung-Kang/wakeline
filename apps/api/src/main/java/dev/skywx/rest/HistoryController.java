package dev.skywx.rest;

import dev.skywx.config.AppProperties;
import dev.skywx.config.Problem;
import dev.skywx.domain.Bbox;
import dev.skywx.persist.SigmetRepository;
import dev.skywx.persist.StatsRepository;
import dev.skywx.persist.TrackRepository;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.http.CacheControl;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;

/** 재생 · 통계 · 공개 상태 REST v1. */
@org.springframework.context.annotation.Profile("!cli & !migrate")
@RestController
@RequestMapping("/api/v1")
public class HistoryController {
    private final TrackRepository tracks;
    private final SigmetRepository sigmetRepo;
    private final StatsRepository stats;
    private final StatusService status;
    private final AppProperties props;

    public HistoryController(TrackRepository tracks, SigmetRepository sigmetRepo, StatsRepository stats, StatusService status, AppProperties props) {
        this.tracks = tracks;
        this.sigmetRepo = sigmetRepo;
        this.stats = stats;
        this.status = status;
        this.props = props;
    }

    /** 시각 at 의 항공기 스냅샷(3분 창) + 그때 유효했던 SIGMET. */
    @GetMapping("/replay")
    public ResponseEntity<Map<String, Object>> replay(@RequestParam Instant at, @RequestParam String bbox, HttpServletRequest req) {
        Bbox b = Bbox.parse(bbox, props.maxBboxAreaSqdeg());
        if (at.isAfter(Instant.now().plusSeconds(60)) || Duration.between(at, Instant.now()).toDays() > 31) throw Problem.badRequest("BAD_AT", "at must be within the last 31 days");
        List<Map<String, Object>> aircraft = tracks.replay(at, b);
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("at", at);
        m.put("aircraft", aircraft);
        m.put("sigmets", sigmetRepo.validAt(at));
        m.put("source", Duration.between(at, Instant.now()).toHours() <= props.trackRetentionHours() ? "track_point" : "track_point_1m");
        m.put("meta", Meta.of(req, "db", at, Integer.MAX_VALUE));
        return ResponseEntity.ok().cacheControl(CacheControl.maxAge(3600, TimeUnit.SECONDS)).body(m);
    }

    @GetMapping("/stats/sigmet")
    public ResponseEntity<Map<String, Object>> statsSigmet(@RequestParam(required = false) LocalDate from, @RequestParam(required = false) LocalDate to,
                                                           @RequestParam(defaultValue = "fir") String group, HttpServletRequest req) {
        var range = range(from, to);
        String g = "hazard".equals(group) ? "hazard" : "fir";
        return ok(Map.of("group", g, "items", stats.sigmet(range[0], range[1], g)), req);
    }

    @GetMapping("/stats/traffic")
    public ResponseEntity<Map<String, Object>> statsTraffic(@RequestParam(required = false) LocalDate day, HttpServletRequest req) {
        LocalDate d = day == null ? LocalDate.now(java.time.ZoneOffset.UTC) : day;
        return ok(Map.of("day", d, "items", stats.traffic(d)), req);
    }

    @GetMapping("/stats/alerts")
    public ResponseEntity<Map<String, Object>> statsAlerts(@RequestParam(required = false) LocalDate from, @RequestParam(required = false) LocalDate to, HttpServletRequest req) {
        var range = range(from, to);
        return ok(Map.of("items", stats.alerts(range[0], range[1])), req);
    }

    @GetMapping("/status")
    public ResponseEntity<Map<String, Object>> status(HttpServletRequest req) {
        Map<String, Object> m = new LinkedHashMap<>(status.publicStatus());
        m.put("meta", Meta.of(req, "api", Instant.now(), 60));
        return ResponseEntity.ok().cacheControl(CacheControl.maxAge(5, TimeUnit.SECONDS)).body(m);
    }

    private static LocalDate[] range(LocalDate from, LocalDate to) {
        LocalDate t = to == null ? LocalDate.now(java.time.ZoneOffset.UTC) : to;
        LocalDate f = from == null ? t.minusDays(7) : from;
        if (f.isAfter(t) || f.plusDays(92).isBefore(t)) throw Problem.badRequest("BAD_RANGE", "range must be within 92 days");
        return new LocalDate[]{f, t};
    }

    private static ResponseEntity<Map<String, Object>> ok(Map<String, Object> body, HttpServletRequest req) {
        Map<String, Object> m = new LinkedHashMap<>(body);
        m.put("meta", Meta.of(req, "db", Instant.now(), Integer.MAX_VALUE));
        return ResponseEntity.ok().cacheControl(CacheControl.maxAge(600, TimeUnit.SECONDS)).body(m);
    }
}
