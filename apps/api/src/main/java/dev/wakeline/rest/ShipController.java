package dev.wakeline.rest;

import dev.wakeline.config.AppProperties;
import dev.wakeline.config.Problem;
import dev.wakeline.domain.AisGap;
import dev.wakeline.domain.Bbox;
import dev.wakeline.domain.ShipCategory;
import dev.wakeline.domain.ShipStatic;
import dev.wakeline.ingest.AisStatus;
import dev.wakeline.ingest.ShipStore;
import dev.wakeline.persist.ShipRepository;
import dev.wakeline.ws.ShipFanout;
import dev.wakeline.ws.WsMessages;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.dao.DataAccessException;
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
import java.util.regex.Pattern;

/**
 * 선박 REST v1(계약 v2 §B3). 실시간 목록은 메모리(ShipStore)에서 — DB 에 의존하지 않는다. 항적·공백·과거 정적 정보는 DB.
 * 모든 값은 선박이 보낸 AIS 보고값이다(검증된 등록 정보가 아님). 값이 없으면 키를 뺀다(모름).
 */
@org.springframework.context.annotation.Profile("!cli & !migrate")
@RestController
@RequestMapping("/api/v1")
public class ShipController {
    static final Pattern MMSI = Pattern.compile("^[0-9]{9}$");
    /** /ships 한 응답의 선박 상한(WS 한 메시지와 같다). 넘으면 capped = true 와 bbox 안 전체 수를 함께 준다. */
    static final int MAX_FEATURES = ShipFanout.MAX_SHIPS_PER_MESSAGE;
    static final Duration TRACK_MAX_RANGE = Duration.ofHours(24);
    static final Duration TRACK_DEFAULT_RANGE = Duration.ofHours(6);
    /** 24 h × 60 s 창 = 1,440 점이 최대 — 여유 있는 상한. */
    static final int TRACK_MAX_POINTS = 5_000;
    /** 이보다 긴 시간 틈은 선을 끊는다(계약 v2 §B3). */
    static final Duration TRACK_BREAK = Duration.ofMinutes(15);
    /**
     * 선을 끊는 끝난 공백의 최소 길이(계약 v3 §D): 저장 간격이 60 s 창이라 더 짧은 수신 공백은 저장점을 없애지 못한다. 열린 공백은 길이와 무관하게 끊는다.
     */
    static final long GAP_BREAK_MIN_S = 60;
    /** 항적 응답의 gaps: 창과 겹치는 공백 중 최신 200개(열린 공백 포함). */
    static final int TRACK_GAPS_LIMIT = 200;
    /**
     * 선 끊기용 긴 공백 조회 상한(메모리 보호) — 60 s 이상 공백은 서로 겹치지 않으면 24 h 창에 1,442개를 넘을 수 없어 닿지 않는다.
     */
    static final int TRACK_BREAK_GAPS_MAX = 5_000;
    static final Duration GAPS_MAX_RANGE = Duration.ofDays(31);
    static final int GAPS_LIMIT = 500;
    /** 선박 목록 stale 기준: 수집기는 10 s 마다 발행한다. */
    static final int SHIPS_STALE_S = 60;

    private final ShipStore store;
    private final ShipRepository repo;
    private final AisStatus ais;
    private final AppProperties props;

    public ShipController(ShipStore store, ShipRepository repo, AisStatus ais, AppProperties props) {
        this.store = store;
        this.repo = repo;
        this.ais = ais;
        this.props = props;
    }

    /**
     * bbox(≤ 2,500 sq°) 안의 실시간 선박(ShipLite FeatureCollection). ETag = 선박 목록 버전 + 본문 meta 의 시간·수신 상태({@link #etag}).
     * 5,000 척을 넘으면 앞의 5,000 척만 싣고 meta.capped = true · meta.total_in_bbox 로 밝힌다(격자는 WS ships_grid).
     */
    @GetMapping(value = "/ships", produces = "application/geo+json")
    public ResponseEntity<Map<String, Object>> shipList(@RequestParam String bbox, HttpServletRequest req) {
        Bbox b = Bbox.parse(bbox, props.maxBboxAreaSqdeg());
        ShipStore.View v = store.view();
        Map<String, Object> meta = Meta.of(req, v.provider(), v.fetchedAt(), SHIPS_STALE_S);
        Map<String, Object> aisView = ais.publicView(System.currentTimeMillis());
        String etag = etag(v.version(), meta, aisView);
        CacheControl cc = CacheControl.maxAge(10, TimeUnit.SECONDS).cachePublic();
        if (etag.equals(req.getHeader("If-None-Match"))) return ResponseEntity.status(304).eTag(etag).cacheControl(cc).build();
        List<Map<String, Object>> features = new ArrayList<>();
        int[] total = {0};
        v.forEachIn(b, s -> {
            total[0]++;
            if (features.size() < MAX_FEATURES) features.add(feature(s));
        });
        Map<String, Object> fc = new LinkedHashMap<>();
        fc.put("type", "FeatureCollection");
        fc.put("features", features);
        meta.put("count", features.size());
        meta.put("total_in_bbox", total[0]);
        meta.put("capped", total[0] > features.size());
        meta.put("ais", aisView);
        fc.put("meta", meta);
        return ResponseEntity.ok().eTag(etag).cacheControl(cc).body(fc);
    }

    /**
     * /ships ETag(리뷰 2026-09-28b #11): 선박 목록 버전만으로는 수신이 멈췄을 때(버전이 그대로) 304 가 예전 '신선·연결됨' meta 를 계속 보여 준다.
     * 그래서 본문 meta 중 시간·수신 상태로 바뀌는 값을 넣는다 — stale · ais connected · heartbeat_stale · gap_open_since · state · coverage.
     * lag_s·msgs_per_s 처럼 요청마다 달라지는 수치는 넣지 않는다(max-age 10 s 안의 차이).
     */
    static String etag(long version, Map<String, Object> meta, Map<String, Object> aisView) {
        StringBuilder b = new StringBuilder("\"s").append(version).append('-').append(flag(meta.get("stale")));
        if (aisView != null) {
            b.append('-').append(flag(aisView.get("connected"))).append(flag(aisView.get("heartbeat_stale")));
            b.append('-').append(aisView.get("gap_open_since") instanceof Instant g ? Long.toString(g.toEpochMilli(), 36) : "n");
            if (aisView.get("state") instanceof String st) b.append('-').append(st);
            if (aisView.get("coverage") instanceof List<?> cov) b.append('-').append(Integer.toHexString(cov.hashCode()));
        }
        return b.append('"').toString();
    }

    /** true → 1, false → 0, 모름(null) → u. */
    private static char flag(Object o) { return o == null ? 'u' : Boolean.TRUE.equals(o) ? '1' : '0'; }

    /**
     * 상세: 실시간 위치(state — 목록에 있을 때만) + 정적 정보(static — 메모리, 없으면 DB) + 선종 분류(category — 코드의 결정적 변환)
     * + first_recorded_at(이 서비스가 이 MMSI 를 처음 기록한 시각) · last_position_at(저장된 마지막 위치 시각, 보존 72 h 안 — 없으면 키 없음).
     * DB 가 없어도 실시간 위치가 있으면 200(static = 메모리 값 또는 null, meta.db_unavailable = true). 둘 다 없으면 404, 실시간도 없고
     * DB 도 없으면 있는지 알 수 없으므로 503.
     */
    @GetMapping("/ships/{mmsi}")
    public ResponseEntity<Map<String, Object>> shipDetail(@PathVariable String mmsi, HttpServletRequest req) {
        String m = normalizeMmsi(mmsi);
        ShipStore.View v = store.view();
        ShipStore.Ship live = v.get(m);
        ShipStatic stat = live != null && live.stat() != null ? live.stat() : store.staticOf(m);
        ShipRepository.StoredShip stored = null;
        Instant lastPosition = null;
        boolean dbUnavailable = false;
        try {
            stored = repo.find(m);
            if (stored != null) lastPosition = repo.lastPositionAt(m);
        } catch (DataAccessException e) {
            if (live == null && stat == null) throw Problem.unavailable("ship history store unavailable");
            dbUnavailable = true;
        }
        if (stat == null && stored != null) stat = stored.stat();
        if (live == null && stat == null && stored == null) throw Problem.notFound("ship " + m + " not seen");
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("mmsi", m);
        out.put("state", live == null ? null : WsMessages.encodeShipState(live.state()));
        out.put("static", stat == null ? null : WsMessages.encodeShipStatic(stat));
        out.put("category", ShipCategory.of(stat == null ? null : stat.shipType()).key());
        // ship.last_seen 은 쓰기 증폭을 줄이려 10분 단위로만 넓히므로 내보내지 않는다 — 정확한 마지막 위치 시각은 ship_position 에서
        if (stored != null) out.put("first_recorded_at", stored.firstSeen());
        if (lastPosition != null) out.put("last_position_at", lastPosition);
        Map<String, Object> meta = Meta.of(req, live == null ? "db" : live.state().provider(), live == null ? null : v.fetchedAt(), SHIPS_STALE_S);
        if (dbUnavailable) meta.put("db_unavailable", true);
        out.put("meta", meta);
        return ResponseEntity.ok().cacheControl(CacheControl.maxAge(5, TimeUnit.SECONDS).cachePublic()).body(out);
    }

    /**
     * 저장된 항적(≤ 24 h, 기본 최근 6 h): MMSI 별 60 s 창의 첫 보고. GeoJSON MultiLineString — 60 s 이상 끝난 AIS 수신 공백 또는 열린 공백을 사이에 둔
     * 두 점, 15분 넘게 떨어진 두 점에서 끊는다(계약 v3 §D, properties.gap_break_min_s — 2점 이상인 구간만 선이 된다, 모든 점은 points 에 있다).
     * 끊기용 긴 공백은 따로 조회한다(짧은 공백이 많아 gaps 목록이 잘려도 선 끊기는 영향이 없다). properties.segments[i] 는 geometry 의 i 번째 선.
     * gaps = 창과 겹치는 공백 중 최신 200개(오래된 것부터, 열린 공백은 ended_at 없음) — 더 있으면 properties.gaps_truncated = true.
     */
    @GetMapping(value = "/ships/{mmsi}/track", produces = "application/geo+json")
    public ResponseEntity<Map<String, Object>> shipTrack(@PathVariable String mmsi, @RequestParam(required = false) Instant from,
                                                     @RequestParam(required = false) Instant to, HttpServletRequest req) {
        String m = normalizeMmsi(mmsi);
        Instant end = to == null ? Instant.now() : to;
        Instant start = from == null ? end.minus(TRACK_DEFAULT_RANGE) : from;
        if (!start.isBefore(end) || Duration.between(start, end).compareTo(TRACK_MAX_RANGE) > 0)
            throw Problem.badRequest("BAD_RANGE", "range must be within 24 h and from < to");
        List<ShipRepository.TrackPoint> pts = repo.track(m, start, end, TRACK_MAX_POINTS);
        AisGap open = openGap(end);
        List<AisGap> breaks = new ArrayList<>(repo.gapsAtLeast(start, end, GAP_BREAK_MIN_S, TRACK_BREAK_GAPS_MAX));
        if (open != null) breaks.add(open);
        int room = TRACK_GAPS_LIMIT - (open == null ? 0 : 1);
        Newest listed = newest(repo.gaps(start, end, room + 1), room);
        List<AisGap> gaps = new ArrayList<>(listed.items());
        if (open != null) gaps.add(open);

        List<List<ShipRepository.TrackPoint>> segs = split(pts, breaks);
        List<List<double[]>> lines = new ArrayList<>();
        List<Map<String, Object>> segMeta = new ArrayList<>();
        for (List<ShipRepository.TrackPoint> seg : segs) {
            if (seg.size() < 2) continue; // GeoJSON LineString 은 2점 이상(RFC 7946) — 한 점은 points 에만
            List<double[]> line = new ArrayList<>(seg.size());
            for (ShipRepository.TrackPoint p : seg) line.add(new double[]{p.lon(), p.lat()});
            lines.add(line);
            segMeta.add(Map.of("start", seg.getFirst().ts(), "end", seg.getLast().ts(), "points", seg.size()));
        }
        List<Map<String, Object>> points = new ArrayList<>(pts.size());
        for (ShipRepository.TrackPoint p : pts) points.add(point(p));

        Map<String, Object> properties = new LinkedHashMap<>();
        properties.put("mmsi", m);
        properties.put("from", start);
        properties.put("to", end);
        properties.put("points", pts.size());
        properties.put("truncated", pts.size() >= TRACK_MAX_POINTS);
        properties.put("sampling", "first_fix_per_60s");
        properties.put("gap_break_min_s", GAP_BREAK_MIN_S);
        properties.put("gaps_truncated", listed.truncated());
        properties.put("segments", segMeta);
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("type", "Feature");
        out.put("geometry", Map.of("type", "MultiLineString", "coordinates", lines));
        out.put("properties", properties);
        out.put("points", points);
        out.put("gaps", gapsJson(gaps));
        out.put("meta", Meta.of(req, "db", pts.isEmpty() ? null : pts.getLast().ts(), 120));
        return ResponseEntity.ok().cacheControl(CacheControl.maxAge(30, TimeUnit.SECONDS).cachePublic()).body(out);
    }

    /**
     * AIS 수신 공백(≤ 31일, 기본 최근 24 h). items = 끝난 공백 중 최신 500개(오래된 것부터 정렬 — 더 있으면 truncated = true),
     * open = 지금 열린 공백(없으면 null).
     */
    @GetMapping("/ais/gaps")
    public ResponseEntity<Map<String, Object>> aisGaps(@RequestParam(required = false) Instant from, @RequestParam(required = false) Instant to,
                                                    HttpServletRequest req) {
        Instant end = to == null ? Instant.now() : to;
        Instant start = from == null ? end.minus(Duration.ofHours(24)) : from;
        if (!start.isBefore(end) || Duration.between(start, end).compareTo(GAPS_MAX_RANGE) > 0)
            throw Problem.badRequest("BAD_RANGE", "range must be within 31 days and from < to");
        Newest closed = newest(repo.gaps(start, end, GAPS_LIMIT + 1), GAPS_LIMIT);
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("from", start);
        out.put("to", end);
        out.put("items", gapsJson(closed.items()));
        out.put("truncated", closed.truncated());
        AisStatus.Feed f = ais.current();
        Map<String, Object> open = null;
        if (f.gapOpenSince() != null) {
            open = new LinkedHashMap<>();
            open.put("started_at", f.gapOpenSince());
            open.put("reason", f.gapReason());
        }
        out.put("open", open);
        // DB 목록은 요청 시각 기준 최신이다(알림 이력과 같은 규칙) — fetched_at 없이 stale=true 로 내면 화면이 항상 '오래됨' 을 띄운다
        out.put("meta", Meta.of(req, "db", Instant.now(), Integer.MAX_VALUE));
        return ResponseEntity.ok().cacheControl(CacheControl.maxAge(30, TimeUnit.SECONDS).cachePublic()).body(out);
    }

    // ---- 도우미 ----

    /** 창의 끝(end) 전에 시작한 지금 열린 공백(없으면 null). */
    private AisGap openGap(Instant end) {
        AisStatus.Feed f = ais.current();
        return f.gapOpenSince() != null && f.gapOpenSince().isBefore(end) ? new AisGap(f.gapOpenSince(), null, f.gapReason(), f.provider()) : null;
    }

    /** 최신 limit 건과 잘림 여부. */
    record Newest(List<AisGap> items, boolean truncated) {}

    /** 저장소가 준 최신 limit + 1 건(오래된 것부터)에서: 넘치면 가장 오래된 것을 빼고 truncated. */
    static Newest newest(List<AisGap> upToLimitPlusOne, int limit) {
        if (upToLimitPlusOne.size() <= limit) return new Newest(upToLimitPlusOne, false);
        return new Newest(upToLimitPlusOne.subList(upToLimitPlusOne.size() - limit, upToLimitPlusOne.size()), true);
    }

    /** 시간순 점을 구간으로: 앞 점과 15분 넘게 떨어졌거나 그 사이에 선을 끊는 공백(breaks)이 걸쳐 있으면 새 구간. */
    static List<List<ShipRepository.TrackPoint>> split(List<ShipRepository.TrackPoint> pts, List<AisGap> gaps) {
        List<List<ShipRepository.TrackPoint>> out = new ArrayList<>();
        List<ShipRepository.TrackPoint> cur = null;
        ShipRepository.TrackPoint last = null;
        for (ShipRepository.TrackPoint p : pts) {
            boolean brk = last == null || Duration.between(last.ts(), p.ts()).compareTo(TRACK_BREAK) > 0;
            if (!brk) for (AisGap g : gaps) if (g.between(last.ts(), p.ts())) { brk = true; break; }
            if (brk) {
                cur = new ArrayList<>();
                out.add(cur);
            }
            cur.add(p);
            last = p;
        }
        return out;
    }

    private static List<Map<String, Object>> gapsJson(List<AisGap> gaps) {
        List<Map<String, Object>> out = new ArrayList<>(gaps.size());
        for (AisGap g : gaps) {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("started_at", g.startedAt());
            m.put("ended_at", g.endedAt());
            m.put("reason", g.reason());
            m.put("provider", g.provider());
            out.add(m);
        }
        return out;
    }

    private static Map<String, Object> point(ShipRepository.TrackPoint p) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("ts", p.ts());
        m.put("lon", p.lon());
        m.put("lat", p.lat());
        if (p.sogKn() != null) m.put("sog_kn", p.sogKn());
        if (p.cogDeg() != null) m.put("cog_deg", p.cogDeg());
        if (p.headingDeg() != null) m.put("heading_deg", p.headingDeg());
        if (p.navStatus() != null) m.put("nav_status", p.navStatus());
        if (p.positionSource() != null) m.put("position_source", p.positionSource()); // 모름(V7 NULL)은 키 없음
        return m;
    }

    static Map<String, Object> feature(ShipStore.Ship s) {
        Map<String, Object> f = new LinkedHashMap<>();
        f.put("type", "Feature");
        f.put("id", s.mmsi());
        f.put("geometry", Map.of("type", "Point", "coordinates", new double[]{s.state().lon(), s.state().lat()}));
        f.put("properties", WsMessages.encodeShipLite(s.state(), s.stat()));
        return f;
    }

    static String normalizeMmsi(String mmsi) {
        String m = mmsi == null ? "" : mmsi.trim();
        if (!MMSI.matcher(m).matches()) throw Problem.badRequest("BAD_MMSI", "mmsi must be 9 digits");
        return m;
    }
}
