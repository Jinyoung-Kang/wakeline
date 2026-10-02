package dev.wakeline.weather.web;

import dev.wakeline.geo.Bbox;
import dev.wakeline.platform.config.AppProperties;
import dev.wakeline.platform.support.Times;
import dev.wakeline.platform.web.BboxParam;
import dev.wakeline.platform.web.Etags;
import dev.wakeline.platform.web.Meta;
import dev.wakeline.platform.web.Params;
import dev.wakeline.platform.web.Problem;
import dev.wakeline.weather.core.Alert;
import dev.wakeline.weather.core.EngineService;
import dev.wakeline.weather.core.RadarStore;
import dev.wakeline.weather.core.SigmetRecord;
import dev.wakeline.weather.core.SigmetStore;
import dev.wakeline.weather.data.AirportRepository;
import dev.wakeline.weather.data.AlertRepository;
import dev.wakeline.weather.data.KrRadarFrames;
import dev.wakeline.weather.data.KrRadarMissing;
import dev.wakeline.weather.data.KrRadarReader;
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

/** SIGMET · 알림 · 레이더 · 공항 REST v1. 기상청 레이더의 Redis 읽기는 {@link KrRadarReader}(ADR-028 — 컨트롤러는 Redis 를 쓰지 않는다). */
@org.springframework.context.annotation.Profile("!cli & !migrate")
@RestController
@RequestMapping("/api/v1")
public class WeatherController {
    private final SigmetStore sigmets;
    private final EngineService engine;
    private final RadarStore radar;
    private final AirportRepository airports;
    private final AlertRepository alertRepo;
    private final AppProperties props;
    private final KrRadarReader radarKr;
    private final tools.jackson.databind.ObjectMapper json;
    private final io.micrometer.core.instrument.MeterRegistry meters;

    public WeatherController(SigmetStore sigmets, EngineService engine, RadarStore radar, AirportRepository airports, AlertRepository alertRepo, AppProperties props,
                             KrRadarReader radarKr, tools.jackson.databind.ObjectMapper json,
                             io.micrometer.core.instrument.MeterRegistry meters) {
        this.radarKr = radarKr;
        this.json = json;
        this.meters = meters;
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
        if (bbox == null && hazard == null && Etags.notModified(etag, req.getHeader("If-None-Match")))
            return ResponseEntity.status(304).eTag(etag).cacheControl(CacheControl.maxAge(60, TimeUnit.SECONDS).cachePublic()).build();
        Bbox b = bbox == null ? null : BboxParam.parse(bbox, 0);
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
        return ResponseEntity.ok().cacheControl(CacheControl.maxAge(10, TimeUnit.SECONDS).cachePublic()).body(m);
    }

    @GetMapping("/alerts")
    public ResponseEntity<Map<String, Object>> alerts(@RequestParam(required = false) String kind, HttpServletRequest req) {
        List<Alert> list = engine.activeAlerts(Params.choice("kind", kind, null, "observed", "predicted")); // 없으면 둘 다(§G42)
        return ResponseEntity.ok().cacheControl(CacheControl.maxAge(5, TimeUnit.SECONDS).cachePublic()).body(Map.of("items", list, "meta", Meta.of(req, "engine", Instant.now(), 60)));
    }

    @GetMapping("/alerts/history")
    public ResponseEntity<Map<String, Object>> alertHistory(@RequestParam(required = false) Instant from, @RequestParam(required = false) Instant to,
                                                            @RequestParam(required = false) String hex, @RequestParam(required = false) Long cursor,
                                                            @RequestParam(defaultValue = "50") int limit, HttpServletRequest req) {
        Instant end = to == null ? Instant.now() : to;
        Instant start = from == null ? end.minusSeconds(86400) : from;
        if (!start.isBefore(end) || end.toEpochMilli() - start.toEpochMilli() > 30L * 86400_000) throw Problem.badRequest("BAD_RANGE", "range must be within 30 d");
        int lim = Math.max(1, Math.min(limit, 200));
        var page = alertRepo.history(start, end, hex == null ? null : Params.hex(hex), cursor, lim);
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("items", page.items());
        m.put("next_cursor", page.nextCursor());
        m.put("meta", Meta.of(req, "db", Instant.now(), 60));
        return ResponseEntity.ok().cacheControl(CacheControl.maxAge(60, TimeUnit.SECONDS).cachePublic()).body(m);
    }

    /** RainViewer 프레임 목록. ETag = 목록 생성 시각(generated) + 수신 시각 — 새 목록이 올 때만 바뀐다. */
    @GetMapping("/radar/frames")
    public ResponseEntity<Map<String, Object>> radarFrames(HttpServletRequest req) {
        RadarStore.Frames f = radar.frames();
        String etag = "\"r" + f.generated() + "-" + Long.toString(f.fetchedAt().toEpochMilli(), 36) + "\"";
        CacheControl cc = CacheControl.maxAge(60, TimeUnit.SECONDS).cachePublic();
        if (Etags.notModified(etag, req.getHeader("If-None-Match"))) return ResponseEntity.status(304).eTag(etag).cacheControl(cc).build();
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("host", f.host());
        m.put("generated", f.generated());
        m.put("past", f.past());
        m.put("tile_template", "{host}{path}/512/{z}/{x}/{y}/2/1_0.png");
        m.put("max_zoom", 7);
        m.put("attribution", "Radar © RainViewer (personal/educational use)");
        m.put("meta", Meta.of(req, f.provider(), f.fetchedAt(), 600));
        return ResponseEntity.ok().eTag(etag).cacheControl(cc).body(m);
    }

    /**
     * 기상청 레이더 합성(FR-31): 최근 프레임 목록 + 웹 메르카토르 정합 좌표(문서 기반 LCC → EPSG:3857 재투영) + 범례.
     * 프레임마다 합성 지점 수 · 코드 · 기준 · 부분 합성 · 다시 받기 기록(ADR-021 — KrRadarFrames 가 검증), 최상위는 최신 프레임의 같은 값.
     * 목록은 PNG 키가 아직 남아 있는 프레임만 싣는다 — 목록 키가 프레임(TTL 3 h)보다 오래 남아도 없는 이미지를 '있다' 고 하지 않는다(REL-19).
     * available·georeferenced 는 수집기가 쓸 수 있다고 표시했고 실제 프레임이 하나 이상 있을 때만 true. ETag = 응답을 결정하는 값들의 해시.
     * missing = 기상청 내려받기 '파일 없음' 연속(KrRadarMissing — 목록에는 있는데 내려받기가 없다고 답한 첫 tm · 수 · 마지막 확인 · 파일 이름 · 목록 종류).
     * 연속이 없으면 키가 없다. 프레임이 그대로여도 연속이 갱신되면 ETag 가 바뀐다.
     */
    @GetMapping("/radar/kr")
    public ResponseEntity<Map<String, Object>> radarKr(HttpServletRequest req) {
        KrRadarReader.Listing listing = radarKr.listing(); // Redis 오류면 빈 해시 · 목록 없음(모름)
        Map<Object, Object> h = listing.meta();
        String framesJson = listing.framesJson();
        List<Map<String, Object>> frames = new ArrayList<>();
        tools.jackson.databind.JsonNode listedNode = framesJson == null ? null : parseJson("frames", framesJson);
        if (listedNode != null && listedNode.isArray()) {
            List<Map<String, Object>> listed = new ArrayList<>();
            for (var f : listedNode) {
                Map<String, Object> fr = KrRadarFrames.frame(f, this::radarParseError); // tm 이 틀리면 null · 부분 합성 필드는 검증한 값만(ADR-021)
                if (fr != null) listed.add(fr);
            }
            List<Boolean> exists = radarKr.framesExist(listed.stream().map(fr -> (String) fr.get("tm")).toList());
            for (int i = 0; i < listed.size(); i++) if (i < exists.size() && Boolean.TRUE.equals(exists.get(i))) frames.add(listed.get(i));
        }
        // 수집기가 쓴 값을 믿지 않는다(R-72): 형식이 틀린 필드는 null(모름)로 두고 센다 — 500 이 되지 않는다.
        // 좌표·이미지 크기를 모르면 지도에 놓을 수 없으므로 '쓸 수 없음'이다.
        tools.jackson.databind.JsonNode coordinates = h.get("coordinates") == null ? null : parseJson("coordinates", String.valueOf(h.get("coordinates")));
        int[] imageSize = imageSize(h.get("width"), h.get("height"));
        boolean available = "1".equals(h.get("available")) && !frames.isEmpty() && coordinates != null && imageSize != null;
        Map<String, Object> missing = KrRadarMissing.from(h, this::radarParseError);
        // 프레임은 tm 뿐 아니라 내용 전체(받은 시각 · 지점 수 · partial · URL 버전) — 같은 tm 을 다시 받아 바꿔도 304 로 옛 값을 붙잡지 않는다(ADR-021).
        // note(수집기가 적은 까닭 — 목록 멈춤 · 403 · 목록 실패 종류)도: 프레임이 만료된 '사용 불가' 동안 까닭만 바뀌어도 304 로 옛 까닭을 붙잡지 않는다(2026-10-01)
        String etag = "\"k" + Integer.toHexString(java.util.Objects.hash(h.get("fetched_at"), h.get("latest_tm"), h.get("available"), h.get("status"),
                h.get("note"), h.get("coordinates"), h.get("width"), h.get("height"), frames, missing)) + "\"";
        CacheControl cc = CacheControl.maxAge(30, TimeUnit.SECONDS).cachePublic();
        if (Etags.notModified(etag, req.getHeader("If-None-Match"))) return ResponseEntity.status(304).eTag(etag).cacheControl(cc).build();
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("available", available);
        m.put("status", h.get("status"));
        m.put("note", h.get("note"));
        m.put("product", h.get("product"));
        m.put("cmp", h.get("cmp"));
        m.put("latest_tm", h.get("latest_tm"));
        m.put("georeferenced", available);
        m.put("coordinates", coordinates);
        m.put("projection", h.get("projection"));
        m.put("grid", h.get("grid") == null ? null : parseJson("grid", String.valueOf(h.get("grid"))));
        m.put("legend", h.get("legend") == null ? null : parseJson("legend", String.valueOf(h.get("legend"))));
        m.put("min_dbz", h.get("min_dbz"));
        m.putAll(KrRadarFrames.latest(frames)); // 최신 프레임의 합성 지점 수 · 코드 · 기준 · partial(모르면 키 없음, ADR-021)
        m.put("image_size", imageSize);
        m.put("frames", frames);
        if (missing != null) m.put("missing", missing);
        m.put("time_zone", "KST(UTC+9) for tm; fetched_at is UTC");
        m.put("attribution", "기상청 API허브 레이더 합성자료(HSR) · 투영·격자 정의: 기상기후데이터위키");
        Instant fetched = h.get("fetched_at") == null ? null : Times.isoInstant(h.get("fetched_at"));
        if (h.get("fetched_at") != null && fetched == null) radarParseError("fetched_at");
        m.put("meta", Meta.of(req, "kma_apihub", fetched, 900));
        return ResponseEntity.ok().eTag(etag).cacheControl(cc).body(m);
    }

    /** 수집기 값 하나를 JSON 으로. 틀리면 null + 셈(R-72). */
    private tools.jackson.databind.JsonNode parseJson(String field, String text) {
        try {
            return json.readTree(text);
        } catch (RuntimeException e) {
            radarParseError(field);
            return null;
        }
    }

    /** 이미지 크기 [width, height] — 둘 다 양의 정수일 때만. 값이 있는데 틀리면 셈. */
    private int[] imageSize(Object width, Object height) {
        if (width == null && height == null) return null;
        try {
            int w = Integer.parseInt(String.valueOf(width).trim()), hgt = Integer.parseInt(String.valueOf(height).trim());
            if (w > 0 && hgt > 0) return new int[]{w, hgt};
        } catch (NumberFormatException e) {
            // 아래에서 센다
        }
        radarParseError("image_size");
        return null;
    }

    private void radarParseError(String field) {
        meters.counter("wakeline_radar_kr_parse_errors_total", "field", field).increment();
    }

    /**
     * 프레임 영상(ADR-012). 없으면 404. Redis 오류는 삼키지 않는다 — 일시 장애는 ProblemAdvice 가 503 + Retry-After(계약 §2 · 리뷰 cto-2026-10 A3 결정 6:
     * 예전에는 '없음' 404 로 답했다). 깨진 값(base64 아님)은 없는 것(404)으로 답하고 센다(R-72 — 예전에는 500).
     */
    @GetMapping(value = "/radar/kr/{tm}.png")
    public ResponseEntity<byte[]> radarKrFrame(@PathVariable String tm) {
        if (!tm.matches("^\\d{12}$")) throw Problem.badRequest("BAD_TM", "tm must be YYYYMMDDHHMM");
        String b64 = radarKr.frame(tm);
        if (b64 == null) throw Problem.notFound("no KMA radar frame " + tm);
        byte[] png;
        try {
            png = java.util.Base64.getDecoder().decode(b64);
        } catch (IllegalArgumentException e) {
            radarParseError("frame_png");
            throw Problem.notFound("no KMA radar frame " + tm);
        }
        return ResponseEntity.ok().cacheControl(CacheControl.maxAge(3600, TimeUnit.SECONDS).cachePublic())
                .header("Content-Type", "image/png").body(png);
    }

    @GetMapping(value = "/airports", produces = "application/geo+json")
    public ResponseEntity<Map<String, Object>> airports(@RequestParam(required = false) String bbox, @RequestParam(defaultValue = "true") boolean watched, HttpServletRequest req) {
        Bbox b = bbox == null ? Bbox.world() : BboxParam.parse(bbox, 0);
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
        return ResponseEntity.ok().cacheControl(CacheControl.maxAge(60, TimeUnit.SECONDS).cachePublic()).body(fc);
    }

    @GetMapping("/airports/{icao}/wx")
    public ResponseEntity<Map<String, Object>> airportWx(@PathVariable String icao, HttpServletRequest req) {
        String code = Params.icao(icao);
        Map<String, Object> wx = airports.wx(code);
        if (wx == null) throw Problem.notFound("airport not watched: " + code);
        Object ft = wx.get("fetched_at");
        Object provider = wx.get("provider");
        wx.put("meta", Meta.of(req, provider == null ? null : String.valueOf(provider), ft instanceof Instant i ? i : null, 1800));
        return ResponseEntity.ok().cacheControl(CacheControl.maxAge(300, TimeUnit.SECONDS).cachePublic()).body(wx);
    }
}
