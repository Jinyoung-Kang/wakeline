package dev.wakeline.rest;

import dev.wakeline.config.AppProperties;
import dev.wakeline.config.Problem;
import dev.wakeline.domain.Bbox;
import dev.wakeline.persist.SigmetRepository;
import dev.wakeline.persist.StatsRepository;
import dev.wakeline.persist.TrackRepository;
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
    /** 재생 시각의 한도(지금 기준). */
    static final Duration REPLAY_MAX_AGE = Duration.ofDays(31);
    private final TrackRepository tracks;
    private final SigmetRepository sigmetRepo;
    private final StatsRepository stats;
    /** 공개 상태 — WS 와 같은 3 s 캐시(R-53: 요청마다 Redis 해시를 여러 번 읽지 않는다). */
    private final java.util.function.Supplier<Map<String, Object>> status;
    private final AppProperties props;

    public HistoryController(TrackRepository tracks, SigmetRepository sigmetRepo, StatsRepository stats, dev.wakeline.ws.WsHub hub, AppProperties props) {
        this.tracks = tracks;
        this.sigmetRepo = sigmetRepo;
        this.stats = stats;
        this.status = hub::status;
        this.props = props;
    }

    /**
     * 시각 at 의 항공기 스냅샷(3분 창) + 그때 유효했던(철회·만료 전) SIGMET 중 bbox 와 겹치는 것(도형 없는 경보 포함, R-26) + 그 시각의 레이더 프레임.
     * source: 행을 실제로 준 테이블(track_point | track_point_1m | none — COR-22). radar: 저장된 RainViewer 프레임(±10분)
     * {host, path, time(유닉스 초)} — at 이 최근 2시간 밖이면 null(RainViewer 가 타일을 2시간만 제공한다, GAP-19).
     */
    @GetMapping("/replay")
    public ResponseEntity<Map<String, Object>> replay(@RequestParam Instant at, @RequestParam String bbox, HttpServletRequest req) {
        Bbox b = Bbox.parse(bbox, props.maxBboxAreaSqdeg());
        Instant now = Instant.now();
        // 정확히 비교한다(R-71 — toDays() 절삭은 31일 23시간을 통과시켰다)
        if (at.isAfter(now.plusSeconds(60)) || Duration.between(at, now).compareTo(REPLAY_MAX_AGE) > 0) throw Problem.badRequest("BAD_AT", "at must be within the last 31 days");
        TrackRepository.Replay r = tracks.replay(at, b);
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("at", at);
        m.put("aircraft", r.aircraft());
        m.put("sigmets", sigmetRepo.validAt(at, b)); // 요청 bbox 와 겹치는 경보만(R-26)
        m.put("source", r.source());
        m.put("radar", tracks.radarFrameNear(at, now));
        m.put("meta", Meta.of(req, "db", at, Integer.MAX_VALUE));
        // 최근 시각은 행·프레임이 아직 들어오는 중이다 — 짧게만 캐시한다. 지난 시각도 1분(R-70): radar 는 '지금 기준 2시간' 에만 유효해
        // 오래 캐시하면 더는 제공되지 않는 타일을 가리킨다(이전 1시간).
        long maxAge = Duration.between(at, now).toMinutes() < 15 ? 30 : 60;
        return ResponseEntity.ok().cacheControl(CacheControl.maxAge(maxAge, TimeUnit.SECONDS).cachePublic()).body(m);
    }

    @GetMapping("/stats/sigmet")
    public ResponseEntity<Map<String, Object>> statsSigmet(@RequestParam(required = false) LocalDate from, @RequestParam(required = false) LocalDate to,
                                                           @RequestParam(defaultValue = "fir") String group, HttpServletRequest req) {
        var range = range(from, to);
        String g = "hazard".equals(group) ? "hazard" : "fir";
        return ok(Map.of("group", g, "items", stats.sigmet(range[0], range[1], g),
                "days", stats.days(range[0], range[1], dev.wakeline.persist.MaintenanceJobs.FAMILY_SIGMET)), req);
    }

    /**
     * 시간대별 트래픽(관심 지역 bbox 안의 서로 다른 항공기 수, 계약 §2). scope = "region", region = 그날 집계가 센 지역
     * {center, radius_nm, bbox — 집계가 실제로 쓴 사각형(DH-10)}.
     * 지역 기록이 없는 옛 집계(전세계 표본이 섞였을 수 있음)는 scope·region 이 null — 어느 범위인지 단정하지 않는다.
     * 자료가 없는 시간은 items 에 없다(0 이 아니다). aggregated = 그날 집계를 마쳤는가(R-45) — false 면 빈 items 는 '0 대' 가 아니라 '집계 전'
     * (오늘은 끝나지 않아 항상 false). day 는 UTC 날짜 "YYYY-MM-DD".
     */
    @GetMapping("/stats/traffic")
    public ResponseEntity<Map<String, Object>> statsTraffic(@RequestParam(required = false) LocalDate day, HttpServletRequest req) {
        LocalDate d = day == null ? LocalDate.now(java.time.ZoneOffset.UTC) : day;
        StatsRepository.Traffic t = stats.traffic(d);
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("day", d.toString());
        body.put("aggregated", t.aggregated());
        body.put("scope", t.region() == null ? null : "region");
        body.put("region", t.region());
        body.put("items", t.items());
        return ok(body, req);
    }

    @GetMapping("/stats/alerts")
    public ResponseEntity<Map<String, Object>> statsAlerts(@RequestParam(required = false) LocalDate from, @RequestParam(required = false) LocalDate to, HttpServletRequest req) {
        var range = range(from, to);
        return ok(Map.of("items", stats.alerts(range[0], range[1]), "days", stats.days(range[0], range[1], dev.wakeline.persist.MaintenanceJobs.FAMILY_ALERTS)), req);
    }

    @GetMapping("/status")
    public ResponseEntity<Map<String, Object>> status(HttpServletRequest req) {
        Map<String, Object> m = new LinkedHashMap<>(status.get());
        m.put("meta", Meta.of(req, "api", Instant.now(), 60));
        return ResponseEntity.ok().cacheControl(CacheControl.maxAge(5, TimeUnit.SECONDS).cachePublic()).body(m);
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
        return ResponseEntity.ok().cacheControl(CacheControl.maxAge(600, TimeUnit.SECONDS).cachePublic()).body(m);
    }
}
