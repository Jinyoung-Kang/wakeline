package dev.wakeline.watch;

import dev.wakeline.aircraft.core.AircraftState;
import dev.wakeline.aircraft.core.SnapshotStore;
import dev.wakeline.platform.web.Meta;
import dev.wakeline.platform.web.Params;
import dev.wakeline.platform.web.Problem;
import dev.wakeline.platform.web.ProblemAdvice;
import dev.wakeline.ships.core.AisStatus;
import dev.wakeline.ships.core.AisGap;
import dev.wakeline.ships.core.ShipStore;
import dev.wakeline.weather.core.Alert;
import dev.wakeline.weather.core.EngineService;
import dev.wakeline.weather.data.AirportRepository;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.dao.DataAccessException;
import org.springframework.http.CacheControl;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.time.Instant;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.TimeUnit;
import java.util.function.UnaryOperator;
import java.util.regex.Pattern;

/**
 * 관심 대상 지금 상태(계약 v5 §G50 · ADR-037 · SPEC F4-4): 브라우저가 저장한 목록(서버는 저장하지 않는다)을 한 요청으로 묻는다 —
 * 항공기(병합 뷰의 마지막 관측 · 열린 알림 · 최근 15분 안에 닫힌 알림), 선박(마지막 위치 — 30분 넘게 못 받으면 저장소에 없다 · 마지막 AIS 수신 공백),
 * 공항(최신 METAR 의 비행 등급). 사건(진입 · 끊김 · 등급 변화)은 브라우저가 이전 답과 비교해 찾는다 — 서버는 상태만 준다.
 * <ul>
 *   <li>입력: aircraft=hex,… · ships=mmsi,… · airports=icao,… — 합쳐 {@link #MAX_TARGETS}개(중복은 한 번), 하나라도 틀리면 400(BAD_HEX · BAD_MMSI · BAD_ICAO ·
 *       TOO_MANY_TARGETS).</li>
 *   <li>항공기 · 선박은 메모리, 공항은 DB(최신 METAR 는 메모리에 없다 — 공항마다 색인 한 번). 외부 호출 없음(ADR-006). DB 를 못 쓰면 공항 줄 없이
 *       메모리 값만 200 + meta.db_unavailable(§G53 · QA-600 — 숨은 탭 알림이 이 응답 하나에 기댄다).</li>
 *   <li>요청 URL 에 목록이 실려 edge 접근 기록에 남는다 — 로컬 1인 운영이라 받아들였다(ADR-037). 캐시: private, max-age=5.</li>
 * </ul>
 */
@org.springframework.context.annotation.Profile("!cli & !migrate")
@RestController
@RequestMapping("/api/v1")
public class WatchController {
    public static final int MAX_TARGETS = 50;
    private static final Pattern MMSI = Pattern.compile("^[0-9]{9}$");
    private static final CacheControl CACHE = CacheControl.maxAge(5, TimeUnit.SECONDS).cachePrivate();
    private final SnapshotStore aircraft;
    private final EngineService engine;
    private final RecentClosedAlerts closed;
    private final ShipStore ships;
    private final AisStatus aisStatus;
    private final AirportRepository airports;

    public WatchController(SnapshotStore aircraft, EngineService engine, RecentClosedAlerts closed, ShipStore ships, AisStatus aisStatus,
                           AirportRepository airports) {
        this.aircraft = aircraft;
        this.engine = engine;
        this.closed = closed;
        this.ships = ships;
        this.aisStatus = aisStatus;
        this.airports = airports;
    }

    @GetMapping("/watch")
    public ResponseEntity<Map<String, Object>> watch(@RequestParam(required = false) String aircraft, @RequestParam(required = false) String ships,
                                                     @RequestParam(required = false) String airports, HttpServletRequest req) {
        List<String> hexes = list(aircraft, Params::hex);
        List<String> mmsis = list(ships, WatchController::mmsi);
        List<String> icaos = list(airports, Params::icao);
        if (hexes.size() + mmsis.size() + icaos.size() > MAX_TARGETS)
            throw Problem.badRequest("TOO_MANY_TARGETS", "at most " + MAX_TARGETS + " targets in total");
        Instant now = Instant.now();
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("aircraft", aircraftRows(hexes, now));
        m.put("ships", shipRows(mmsis, now));
        boolean dbUnavailable = false;
        try {
            m.put("airports", airportRows(icaos));
        } catch (DataAccessException e) {
            ProblemAdvice.answeredWithoutStore(e, req); // WARN 한 줄 — 결함(문법 · 권한)이면 그대로 던진다(500)
            m.put("airports", List.of());              // 모름 — '없음(found=false)'으로 지어 보이지 않는다
            dbUnavailable = true;
        }
        m.put("ais_last_gap", gap(aisStatus.openOrLastGap())); // 열린 공백 먼저(QA-701 — 전에는 끝난 공백만)
        m.put("closed_window_s", RecentClosedAlerts.WINDOW_S);
        m.put("closed_dropped", closed.dropped());
        Map<String, Object> meta = Meta.of(req, "memory", now, 60);
        if (dbUnavailable) meta.put("db_unavailable", true);
        m.put("meta", meta);
        return ResponseEntity.ok().cacheControl(CACHE).body(m);
    }

    /** 쉼표 목록 → 검사한 값(순서 유지 · 중복 한 번). 빈 칸은 건너뛴다. 너무 긴 입력은 개수 검사 전에 막는다. */
    static List<String> list(String raw, UnaryOperator<String> check) {
        if (raw == null || raw.isBlank()) return List.of();
        String[] parts = raw.split(",", MAX_TARGETS + 2);
        if (parts.length > MAX_TARGETS + 1) throw Problem.badRequest("TOO_MANY_TARGETS", "at most " + MAX_TARGETS + " targets in total");
        Set<String> out = new LinkedHashSet<>();
        for (String p : parts) if (!p.isBlank()) out.add(check.apply(p));
        return List.copyOf(out);
    }

    static String mmsi(String v) {
        String s = v == null ? "" : v.strip();
        if (!MMSI.matcher(s).matches()) throw Problem.badRequest("BAD_MMSI", "mmsi must be 9 digits");
        return s;
    }

    List<Map<String, Object>> aircraftRows(List<String> hexes, Instant now) {
        if (hexes.isEmpty()) return List.of();
        Map<String, AircraftState> merged = aircraft.merged(now);
        Map<String, List<Alert>> open = new HashMap<>();
        for (Alert a : engine.activeAlerts(null)) if (hexes.contains(a.hex())) open.computeIfAbsent(a.hex(), k -> new ArrayList<>()).add(a);
        Map<String, List<Alert>> recent = closed.forHexes(Set.copyOf(hexes), now);
        List<Map<String, Object>> rows = new ArrayList<>(hexes.size());
        for (String hex : hexes) {
            AircraftState s = merged.get(hex);
            Map<String, Object> r = new LinkedHashMap<>();
            r.put("hex", hex);
            r.put("found", s != null);
            r.put("callsign", s == null ? null : s.callsign());
            r.put("seen_at", s == null ? null : s.seenAt());
            r.put("fresh", s == null ? null : s.fresh(now));
            r.put("open_alerts", open.getOrDefault(hex, List.of()).stream().map(WatchController::alert).toList());
            r.put("closed_alerts", recent.getOrDefault(hex, List.of()).stream().map(WatchController::alert).toList());
            rows.add(r);
        }
        return rows;
    }

    List<Map<String, Object>> shipRows(List<String> mmsis, Instant now) {
        if (mmsis.isEmpty()) return List.of();
        ShipStore.View v = ships.view();
        List<Map<String, Object>> rows = new ArrayList<>(mmsis.size());
        for (String mmsi : mmsis) {
            ShipStore.Ship s = v.get(mmsi);
            Map<String, Object> r = new LinkedHashMap<>();
            r.put("mmsi", mmsi);
            r.put("found", s != null);
            r.put("name", s == null || s.stat() == null ? null : s.stat().name());
            r.put("seen_at", s == null ? null : s.state().seenAt());
            r.put("age_s", s == null ? null : Math.max(0, (now.toEpochMilli() - s.state().seenAt().toEpochMilli()) / 1000));
            rows.add(r);
        }
        return rows;
    }

    List<Map<String, Object>> airportRows(List<String> icaos) {
        if (icaos.isEmpty()) return List.of();
        Map<String, Map<String, Object>> byIcao = new HashMap<>();
        for (Map<String, Object> r : airports.latestFor(icaos)) byIcao.put(String.valueOf(r.get("icao")), r);
        List<Map<String, Object>> rows = new ArrayList<>(icaos.size());
        for (String icao : icaos) {
            Map<String, Object> a = byIcao.get(icao);
            Map<String, Object> r = new LinkedHashMap<>();
            r.put("icao", icao);
            r.put("found", a != null);
            r.put("name", a == null ? null : a.get("name"));
            r.put("flight_cat", a == null ? null : a.get("flight_cat"));
            r.put("obs_time", a == null ? null : a.get("obs_time"));
            r.put("obs_age_s", a == null ? null : a.get("obs_age_s"));
            r.put("stale", a == null ? null : a.get("stale"));
            rows.add(r);
        }
        return rows;
    }

    /** 알림 요약 — 근거 전체는 싣지 않는다(카드 · 근거 공유가 따로 읽는다). */
    static Map<String, Object> alert(Alert a) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("id", a.id());
        m.put("kind", a.kind());
        m.put("zone_type", a.zoneTypeOrSigmet());
        m.put("level", a.level());
        m.put("sigmet_id", a.sigmetId());
        m.put("hazard", a.hazard());
        m.put("zone_name", a.airspace() == null ? null : a.airspace().get("name"));
        m.put("entered_at", a.enteredAt());
        m.put("eta_at", a.etaAt());
        m.put("left_at", a.leftAt());
        m.put("close_reason", a.closeReason());
        return m;
    }

    static Map<String, Object> gap(AisGap g) {
        if (g == null) return null;
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("started_at", g.startedAt());
        m.put("ended_at", g.endedAt());
        m.put("reason", g.reason());
        return m;
    }
}
