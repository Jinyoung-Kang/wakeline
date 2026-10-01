package dev.wakeline.ships.web;

import dev.wakeline.geo.Bbox;
import dev.wakeline.platform.config.AppProperties;
import dev.wakeline.platform.web.BboxParam;
import dev.wakeline.platform.web.Etags;
import dev.wakeline.platform.web.Meta;
import dev.wakeline.platform.web.Problem;
import dev.wakeline.platform.web.ProblemAdvice;
import dev.wakeline.ships.core.AisGap;
import dev.wakeline.ships.core.AisStatus;
import dev.wakeline.ships.core.DestinationParser;
import dev.wakeline.ships.core.ShipCategory;
import dev.wakeline.ships.core.ShipQuery;
import dev.wakeline.ships.core.ShipState;
import dev.wakeline.ships.core.ShipStatic;
import dev.wakeline.ships.core.ShipStore;
import dev.wakeline.ships.data.ShipRepository;
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
    static final int MAX_FEATURES = ShipJson.MAX_SHIPS_PER_MESSAGE;
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
    /** 검색 결과 수(계약 v5 §B1: limit 1–20, 기본 10). */
    static final int SEARCH_MAX_LIMIT = 20;
    static final int SEARCH_DEFAULT_LIMIT = 10;
    /**
     * 검색 한 번의 DB 검색 문장 상한. 다시 묻는 것은 실시간 선박의 메모리 정적 정보와 저장 정적 정보가 어긋난 동안(개명 직후 저장 전 등)뿐이다 —
     * 그래도 모자라면 있는 만큼만 준다.
     */
    static final int SEARCH_DB_ATTEMPTS = 3;

    private final ShipStore store;
    private final ShipRepository repo;
    private final AisStatus ais;
    private final AppProperties props;
    /** 보고 목적지 풀이(계약 v4 §B) — 항구 표는 JVM 에서 한 번 읽는다(이 빈이 기동할 때). */
    private final DestinationParser destinations = DestinationParser.bundled();

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
        Bbox b = BboxParam.parse(bbox, props.maxBboxAreaSqdeg());
        ShipStore.View v = store.view();
        Map<String, Object> meta = Meta.of(req, v.provider(), v.fetchedAt(), SHIPS_STALE_S);
        Map<String, Object> aisView = ais.publicView(System.currentTimeMillis());
        String etag = etag(v.version(), meta, aisView);
        CacheControl cc = CacheControl.maxAge(10, TimeUnit.SECONDS).cachePublic();
        if (Etags.notModified(etag, req.getHeader("If-None-Match"))) return ResponseEntity.status(304).eTag(etag).cacheControl(cc).build();
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
     * 그래서 본문 meta 중 시간·수신 상태로 바뀌는 값을 넣는다 — stale · ais connected · heartbeat_stale · gap_open_since · state · coverage ·
     * shards(구역별 상태, 계약 v4 §D).
     * lag_s·msgs_per_s 처럼 요청마다 달라지는 수치는 넣지 않는다(max-age 10 s 안의 차이).
     */
    static String etag(long version, Map<String, Object> meta, Map<String, Object> aisView) {
        StringBuilder b = new StringBuilder("\"s").append(version).append('-').append(flag(meta.get("stale")));
        if (aisView != null) {
            b.append('-').append(flag(aisView.get("connected"))).append(flag(aisView.get("heartbeat_stale")));
            b.append('-').append(aisView.get("gap_open_since") instanceof Instant g ? Long.toString(g.toEpochMilli(), 36) : "n");
            if (aisView.get("state") instanceof String st) b.append('-').append(st);
            if (aisView.get("coverage") instanceof List<?> cov) b.append('-').append(Integer.toHexString(cov.hashCode()));
            if (aisView.get("shards") instanceof List<?> sh) b.append('-').append(Integer.toHexString(sh.hashCode()));
        }
        return b.append('"').toString();
    }

    /** true → 1, false → 0, 모름(null) → u. */
    private static char flag(Object o) { return o == null ? 'u' : Boolean.TRUE.equals(o) ? '1' : '0'; }

    /**
     * 선박 검색(계약 v5 §B1, 공개). 검색어 규칙은 {@link ShipQuery}(9자리 MMSI 정확 · 3–8자리 MMSI 앞부분 · IMO 접두/7자리 IMO 정확 · 그 밖 선명·호출부호 앞부분).
     * <ol>
     *   <li>실시간(ShipStore — 위치 + 메모리 정적 정보)에서 먼저: 정확 일치 → 최근 보고 → MMSI 순.</li>
     *   <li>모자라면 DB ship 표(정확 일치 → last_seen 최신 → MMSI 순)에서 실시간 결과에 없는 선박. 그 선박이 실시간 목록에 있는데 메모리에 정적 정보가 없으면
     *       (상세와 같은 DB 폴백) 실시간 위치와 함께 live=true. 메모리 정적 정보가 있는데 일치하지 않았다면 옛 보고로만 찾힌 것이라 싣지 않는다.</li>
     *   <li>last_position_at = DB 의 마지막 저장 위치 시각(ship_position — 보존 72 h 안, 그보다 오래된 선박은 null). 실시간이지만 메모리에 정적 정보가
     *       없는 선박은 DB 의 저장 정적 정보로 채운다.</li>
     *   <li>last_seen_at(계약 v5 §G4) = 저장만 된 선박(live=false)의 마지막 수신 기록 — ship.last_seen(위치 · 정적 정보 어떤 AIS 메시지든 받은 시각),
     *       저장된 마지막 위치가 더 늦으면 그 시각({@link #lastSeenAt}). 위치 보존(72 h)이 지나도 남는다. 실시간 선박은 null(seen_at 이 마지막 수신).</li>
     * </ol>
     * 항목은 계약의 13개 키를 늘 싣는다 — 모르는 값은 JSON null(실시간이 아니면 lat · lon · sog_kn · seen_at 이 null, 위치를 지어내지 않는다).
     * 분류(category)는 선종 코드의 결정적 변환(없으면 unknown). DB 가 없으면 실시간 결과만 주고 meta.db_unavailable = true(WARN 한 줄 —
     * ProblemAdvice.answeredWithoutStore. DB 결함은 500).
     */
    @GetMapping("/ships/search")
    public ResponseEntity<Map<String, Object>> shipSearch(@RequestParam(required = false) String q,
                                                      @RequestParam(defaultValue = "" + SEARCH_DEFAULT_LIMIT) int limit, HttpServletRequest req) {
        ShipQuery query;
        try {
            query = ShipQuery.parse(q);
        } catch (IllegalArgumentException e) {
            throw Problem.badRequest("BAD_QUERY", e.getMessage());
        }
        if (limit < 1 || limit > SEARCH_MAX_LIMIT) throw Problem.badRequest("BAD_LIMIT", "limit must be 1.." + SEARCH_MAX_LIMIT);
        ShipStore.View v = store.view();
        java.util.Comparator<ShipStore.Ship> order = java.util.Comparator.comparing((ShipStore.Ship s) -> !query.exact(s.mmsi(), s.stat()))
                .thenComparing((ShipStore.Ship s) -> s.state().seenAt(), java.util.Comparator.reverseOrder()).thenComparing(ShipStore.Ship::mmsi);
        // 상위 limit 척만 남기며 고른다(짧은 MMSI 앞부분은 실시간 목록 전체가 일치할 수 있다 — 전부 정렬하지 않는다)
        java.util.PriorityQueue<ShipStore.Ship> top = new java.util.PriorityQueue<>(limit + 1, order.reversed());
        if (query.kind() == ShipQuery.Kind.MMSI) {
            ShipStore.Ship s = v.get(query.text());
            if (s != null) top.add(s);
        } else {
            for (ShipStore.Ship s : v.ships().values()) {
                if (!query.matches(s.mmsi(), s.stat())) continue;
                if (top.size() == limit && order.compare(s, top.peek()) >= 0) continue; // 지금 남긴 것 중 가장 뒤보다 앞서지 않는다
                top.add(s);
                if (top.size() > limit) top.poll();
            }
        }
        List<ShipStore.Ship> live = new ArrayList<>(top);
        live.sort(order);
        List<Hit> hits = new ArrayList<>();
        java.util.Set<String> seen = new java.util.HashSet<>();
        for (ShipStore.Ship s : live) {
            hits.add(new Hit(s.mmsi(), s, s.stat(), null));
            seen.add(s.mmsi());
        }
        boolean dbUnavailable = false;
        // 9자리 MMSI 는 많아야 한 척 — 실시간에서 찾았으면 DB 검색은 같은 MMSI 만 돌려주므로 묻지 않는다(저장 정적 정보·마지막 저장 시각은 lookup)
        boolean complete = hits.size() >= limit || (query.kind() == ShipQuery.Kind.MMSI && !hits.isEmpty());
        if (!complete) {
            try {
                List<Hit> dbLive = new ArrayList<>(), dbOnly = new ArrayList<>();
                int want = limit - hits.size();
                int n = limit + hits.size(); // 실시간 결과와 겹칠 몫까지
                for (int attempt = 1; ; attempt++) {
                    dbLive.clear();
                    dbOnly.clear();
                    List<ShipRepository.SearchRow> rows = repo.search(query, n);
                    for (ShipRepository.SearchRow r : rows) {
                        if (seen.contains(r.mmsi())) continue; // ship 표의 MMSI 는 기본 키 — 한 번씩만 온다
                        ShipStore.Ship s = v.get(r.mmsi());
                        if (s == null) dbOnly.add(new Hit(r.mmsi(), null, r.stat(), r.lastSeen()));
                        else if (s.stat() == null) dbLive.add(new Hit(r.mmsi(), s, r.stat(), r.lastSeen()));
                        // 그 밖(메모리 정적 정보가 있는데 실시간 일치에 없음)은 옛 저장 정적 정보로만 찾힌 행 — 싣지 않는다
                    }
                    int got = dbLive.size() + dbOnly.size();
                    // 걸러진 행 때문에 모자라고 DB 에 더 있을 수 있으면(행이 n 개 꽉 참) 모자란 만큼 더 물어 처음부터 다시 — 같은 순서라 앞 행은 같다
                    if (got >= want || rows.size() < n || attempt == SEARCH_DB_ATTEMPTS) break;
                    n += want - got;
                }
                for (Hit h : dbLive) if (hits.size() < limit) hits.add(h); // 실시간 먼저
                for (Hit h : dbOnly) if (hits.size() < limit) hits.add(h);
            } catch (DataAccessException e) {
                ProblemAdvice.answeredWithoutStore(e, req); // WARN 한 줄 — 결함(문법 · 권한)이면 그대로 던진다(500)
                dbUnavailable = true;
            }
        }
        Map<String, ShipRepository.Known> known = Map.of();
        if (!dbUnavailable && !hits.isEmpty()) {
            try {
                known = repo.lookup(hits.stream().map(Hit::mmsi).toList());
            } catch (DataAccessException e) {
                ProblemAdvice.answeredWithoutStore(e, req);
                dbUnavailable = true;
            }
        }
        List<Map<String, Object>> items = new ArrayList<>(hits.size());
        for (Hit h : hits) items.add(searchItem(h, known.get(h.mmsi())));
        Map<String, Object> meta = Meta.of(req, v.provider(), v.fetchedAt(), SHIPS_STALE_S);
        meta.put("q", query.text());
        meta.put("count", items.size());
        if (dbUnavailable) meta.put("db_unavailable", true);
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("items", items);
        out.put("meta", meta);
        return ResponseEntity.ok().cacheControl(CacheControl.maxAge(5, TimeUnit.SECONDS).cachePublic()).body(out);
    }

    /** 검색 결과 하나: 실시간 선박(없으면 null)과 이 결과를 낸 정적 정보(메모리 또는 DB, 없으면 null), DB 행의 ship.last_seen(DB 에서 찾은 것만). */
    private record Hit(String mmsi, ShipStore.Ship live, ShipStatic stat, Instant storedLastSeen) {}

    /** 계약 v5 §B1 항목. 전역 non_null 설정이 Java null 을 빼 버리므로 모르는 값은 JSON null 노드로 넣는다(키를 남긴다 — SigmetGeoJson 과 같은 방법). */
    private static Map<String, Object> searchItem(Hit h, ShipRepository.Known known) {
        ShipStatic st = h.stat() != null ? h.stat() : known == null ? null : known.stat();
        ShipState s = h.live() == null ? null : h.live().state();
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("mmsi", h.mmsi());
        m.put("name", orNull(st == null ? null : st.name()));
        m.put("call_sign", orNull(st == null ? null : st.callSign()));
        m.put("imo", orNull(st == null ? null : st.imo()));
        m.put("ship_type", orNull(st == null ? null : st.shipType()));
        m.put("category", ShipCategory.of(st == null ? null : st.shipType()).key());
        m.put("live", s != null);
        m.put("lat", orNull(s == null ? null : s.lat()));
        m.put("lon", orNull(s == null ? null : s.lon()));
        m.put("sog_kn", orNull(s == null ? null : s.sogKn()));
        m.put("seen_at", orNull(s == null ? null : s.seenAt()));
        m.put("last_position_at", orNull(known == null ? null : known.lastPositionAt()));
        // §G4: 실시간이 아닐 때만 — 실시간이면 seen_at 이 마지막 수신이다(10분 단위 DB 값을 겹쳐 싣지 않는다)
        m.put("last_seen_at", orNull(s != null ? null : lastSeenAt(h.storedLastSeen(), known == null ? null : known.lastPositionAt())));
        return m;
    }

    /**
     * 마지막 수신 기록(계약 v5 §G4): ship.last_seen 과 저장된 마지막 위치 시각 중 늦은 것(둘 다 받은 AIS 보고의 시각 — 추정이 아니다).
     * ship.last_seen 은 위치로는 10분에 한 번만 넓히므로(ShipWriter — 쓰기 증폭 방지) 그 사이 60 s 창마다 저장된 위치가 더 늦을 수 있다.
     * 실제 마지막 수신은 이보다 늦을 수 있다(위치는 60 s 에 하나만 저장, 보존 72 h 가 지나면 ship.last_seen 의 10분 단위만 남는다). 둘 다 없으면 null.
     */
    static Instant lastSeenAt(Instant shipLastSeen, Instant lastPosition) {
        if (shipLastSeen == null) return lastPosition;
        if (lastPosition == null) return shipLastSeen;
        return lastPosition.isAfter(shipLastSeen) ? lastPosition : shipLastSeen;
    }

    private static Object orNull(Object v) { return v == null ? tools.jackson.databind.node.NullNode.getInstance() : v; }

    /**
     * 상세: 실시간 위치(state — 목록에 있을 때만) + 정적 정보(static — 메모리, 없으면 DB) + 그 출처(static_source — live · stored, 계약 v5 §G17 —
     * stored 이면 static_updated_at = 저장 행의 updated_at, WS ship_selected 와 같은 뜻) + 선종 분류(category — 코드의 결정적 변환)
     * + first_recorded_at(이 서비스가 이 MMSI 를 처음 기록한 시각) · last_position_at(저장된 마지막 위치 시각, 보존 72 h 안 — 없으면 키 없음)
     * + last_seen_at(실시간 목록에 없을 때만 — 마지막 수신 기록, {@link #lastSeenAt}, 계약 v5 §G4 — 검색과 같은 값. 실시간이면 state.seen_at)
     * + destination_info(static 의 보고 목적지를 결정적 규칙으로 푼 것, 계약 v4 §B — 목적지를 모르면 키 없음).
     * DB 가 없어도 실시간 위치가 있으면 200(static = 메모리 값 또는 null, meta.db_unavailable = true). 둘 다 없으면 404, 실시간도 없고
     * DB 도 없으면 있는지 알 수 없으므로 503. DB 없이 답하면 WARN 한 줄(ProblemAdvice — 원인 · 경로 · 걸린 시간), DB 결함(문법 · 권한)은 500.
     */
    @GetMapping("/ships/{mmsi}")
    public ResponseEntity<Map<String, Object>> shipDetail(@PathVariable String mmsi, HttpServletRequest req) {
        String m = normalizeMmsi(mmsi);
        ShipStore.View v = store.view();
        ShipStore.Ship live = v.get(m);
        ShipStatic stat = live != null && live.stat() != null ? live.stat() : store.staticOf(m);
        String source = stat == null ? null : ShipJson.STATIC_LIVE;
        ShipRepository.StoredShip stored = null;
        Instant lastPosition = null;
        boolean dbUnavailable = false;
        try {
            stored = repo.find(m);
            if (stored != null) lastPosition = repo.lastPositionAt(m);
        } catch (DataAccessException e) {
            // 저장소를 못 쓰면 WARN 한 줄(원인 · 경로 · 걸린 시간) — 결함(문법 · 권한)은 삼키지 않는다(500 + ERROR)
            if (live == null && stat == null) throw ProblemAdvice.storeUnavailable(e, req, "ship history store unavailable");
            ProblemAdvice.answeredWithoutStore(e, req);
            dbUnavailable = true;
        }
        if (stat == null && stored != null && stored.stat() != null) {
            stat = stored.stat();
            source = ShipJson.STATIC_STORED;
        }
        if (live == null && stat == null && stored == null) throw Problem.notFound("ship " + m + " not seen");
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("mmsi", m);
        out.put("state", live == null ? null : ShipJson.encodeShipState(live.state()));
        out.put("static", stat == null ? null : ShipJson.encodeShipStatic(stat));
        // 정적 정보가 있을 때만(없으면 키 없음 — 모름 · DB 불가는 meta.db_unavailable): 메모리(live) · DB 의 마지막 저장 정적 보고(stored)
        if (source != null) out.put("static_source", source);
        if (ShipJson.STATIC_STORED.equals(source)) out.put("static_updated_at", stat.updatedAt());
        out.put("destination_info", stat == null ? null : destinations.parse(stat.destination()));
        out.put("category", ShipCategory.of(stat == null ? null : stat.shipType()).key());
        // ship.last_seen 은 쓰기 증폭을 줄이려 10분 단위로만 넓히므로 그대로 내보내지 않는다 — 정확한 마지막 위치 시각은 ship_position 에서.
        // 실시간이 아닐 때의 '마지막 수신'(§G4)은 둘 중 늦은 것
        if (stored != null) out.put("first_recorded_at", stored.firstSeen());
        if (lastPosition != null) out.put("last_position_at", lastPosition);
        if (live == null && stored != null) out.put("last_seen_at", lastSeenAt(stored.lastSeen(), lastPosition));
        Map<String, Object> meta = Meta.of(req, live == null ? "db" : live.state().provider(), live == null ? null : v.fetchedAt(), SHIPS_STALE_S);
        if (dbUnavailable) meta.put("db_unavailable", true);
        out.put("meta", meta);
        return ResponseEntity.ok().cacheControl(CacheControl.maxAge(5, TimeUnit.SECONDS).cachePublic()).body(out);
    }

    /**
     * 저장된 항적(≤ 24 h, 기본 최근 6 h): MMSI 별 60 s 창의 첫 보고. GeoJSON MultiLineString — 60 s 이상 끝난 AIS 수신 공백 또는 열린 공백을 사이에 둔
     * 두 점, 15분 넘게 떨어진 두 점에서 끊는다(계약 v3 §D, properties.gap_break_min_s — 2점 이상인 구간만 선이 된다, 모든 점은 points 에 있다).
     * 구역(scope)이 있는 공백은 두 점 중 하나라도 그 구역 상자 안일 때만 끊는다(계약 v4 §D). 열린 공백은 구역 정보가 있으면 구역마다 하나.
     * 끊기용 긴 공백은 따로 조회한다(짧은 공백이 많아 gaps 목록이 잘려도 선 끊기는 영향이 없다). properties.segments[i] 는 geometry 의 i 번째 선.
     * gaps = 창과 겹치는 공백 중 최신 200개(오래된 것부터, 열린 공백은 ended_at 없음, 구역이 있으면 scope) — 더 있으면 properties.gaps_truncated = true.
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
        List<AisGap> open = openGaps(end);
        List<AisGap> breaks = new ArrayList<>(repo.gapsAtLeast(start, end, GAP_BREAK_MIN_S, TRACK_BREAK_GAPS_MAX));
        breaks.addAll(open);
        int room = TRACK_GAPS_LIMIT - open.size();
        Newest listed = newest(repo.gaps(start, end, room + 1), room);
        List<AisGap> gaps = new ArrayList<>(listed.items());
        gaps.addAll(open);
        gaps.sort(java.util.Comparator.comparing(AisGap::startedAt)); // 구역마다 열린 공백이 끝난 공백보다 이를 수 있다 — 오래된 것부터

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
     * AIS 수신 공백(≤ 31일, 기본 최근 24 h). items = 끝난 공백 중 최신 500개(오래된 것부터 정렬 — 더 있으면 truncated = true, 구역이 있으면 scope),
     * open = 지금 열린 공백 중 가장 이른 것(상태 해시의 합계 gap_open_since — 구역별 상태는 status.sources.ais.shards, 없으면 null).
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

    /** 창의 끝(end) 전에 시작한 지금 열린 공백들(구역 정보가 있으면 구역마다, 없으면 합계 하나 — {@link AisStatus.Feed#openGaps}). */
    private List<AisGap> openGaps(Instant end) {
        List<AisGap> out = new ArrayList<>();
        for (AisGap g : ais.current().openGaps()) if (g.startedAt().isBefore(end)) out.add(g);
        return out;
    }

    /** 최신 limit 건과 잘림 여부. */
    record Newest(List<AisGap> items, boolean truncated) {}

    /** 저장소가 준 최신 limit + 1 건(오래된 것부터)에서: 넘치면 가장 오래된 것을 빼고 truncated. */
    static Newest newest(List<AisGap> upToLimitPlusOne, int limit) {
        if (upToLimitPlusOne.size() <= limit) return new Newest(upToLimitPlusOne, false);
        return new Newest(upToLimitPlusOne.subList(upToLimitPlusOne.size() - limit, upToLimitPlusOne.size()), true);
    }

    /**
     * 시간순 점을 구간으로: 앞 점과 15분 넘게 떨어졌거나 그 사이에 선을 끊는 공백(breaks)이 걸쳐 있으면 새 구간. 구역이 있는 공백은 두 점 중
     * 하나라도 그 구역 상자 안일 때만 적용하고, 구역 없는 공백(옛 기록)은 모두에 적용한다(계약 v4 §D).
     */
    static List<List<ShipRepository.TrackPoint>> split(List<ShipRepository.TrackPoint> pts, List<AisGap> gaps) {
        List<List<ShipRepository.TrackPoint>> out = new ArrayList<>();
        List<ShipRepository.TrackPoint> cur = null;
        ShipRepository.TrackPoint last = null;
        for (ShipRepository.TrackPoint p : pts) {
            boolean brk = last == null || Duration.between(last.ts(), p.ts()).compareTo(TRACK_BREAK) > 0;
            if (!brk) for (AisGap g : gaps) if (g.between(last.ts(), p.ts()) && (g.appliesAt(last.lat(), last.lon()) || g.appliesAt(p.lat(), p.lon()))) {
                brk = true;
                break;
            }
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
            m.put("scope", g.scopeText()); // 구역 없음(옛 기록 — 모든 곳에 적용)은 키 없음
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
        f.put("properties", ShipJson.encodeShipLite(s.state(), s.stat()));
        return f;
    }

    static String normalizeMmsi(String mmsi) {
        String m = mmsi == null ? "" : mmsi.trim();
        if (!MMSI.matcher(m).matches()) throw Problem.badRequest("BAD_MMSI", "mmsi must be 9 digits");
        return m;
    }
}
