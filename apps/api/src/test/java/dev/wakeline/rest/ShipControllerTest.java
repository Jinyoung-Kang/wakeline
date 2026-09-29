package dev.wakeline.rest;

import dev.wakeline.config.ProblemAdvice;
import dev.wakeline.domain.AisGap;
import dev.wakeline.domain.ShipState;
import dev.wakeline.domain.ShipStatic;
import dev.wakeline.ingest.AisStatus;
import dev.wakeline.ingest.ShipStore;
import dev.wakeline.persist.ShipRepository;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.jdbc.CannotGetJdbcConnectionException;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.hamcrest.Matchers.containsString;
import static org.hamcrest.Matchers.nullValue;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * 선박 REST(계약 v2 §B3): 입력 검증(MMSI·bbox·기간), 실시간 목록(ETag·상한·meta), 상세(메모리 → DB 폴백, DB 장애 시 실시간은 200),
 * 항적 끊기(AIS 공백·15분), 공백 목록.
 */
class ShipControllerTest {
    static final Instant T = Instant.now().truncatedTo(java.time.temporal.ChronoUnit.SECONDS);

    /** 메모리에 든 가짜 저장소(없으면 DB 장애). */
    static final class FakeRepo extends ShipRepository {
        volatile boolean down;
        /** lookup 만 실패(검색 문장은 성공한 뒤 DB 가 끊긴 경우). */
        volatile boolean lookupDown;
        StoredShip stored;
        /** stored 가 위치로만 만든 행(stat null)일 때 그 행의 MMSI. */
        String storedMmsi;
        final List<TrackPoint> points = new ArrayList<>();
        final List<AisGap> gaps = new ArrayList<>();

        FakeRepo() { super(null, null); }

        @Override public StoredShip find(String mmsi) {
            if (down) throw new CannotGetJdbcConnectionException("down");
            if (stored == null) return null;
            return mmsi.equals(stored.stat() != null ? stored.stat().mmsi() : storedMmsi) ? stored : null;
        }

        @Override public Instant lastPositionAt(String mmsi) {
            if (down) throw new CannotGetJdbcConnectionException("down");
            return points.isEmpty() ? null : points.getLast().ts();
        }

        @Override public List<TrackPoint> track(String mmsi, Instant from, Instant to, int limit) {
            if (down) throw new CannotGetJdbcConnectionException("down");
            return points.stream().filter(p -> !p.ts().isBefore(from) && !p.ts().isAfter(to)).limit(limit).toList();
        }

        /** 실제 저장소와 같은 규칙: 겹치는 것 중 최신 limit 건, 오래된 것부터. */
        @Override public List<AisGap> gaps(Instant from, Instant to, int limit) {
            if (down) throw new CannotGetJdbcConnectionException("down");
            List<AisGap> all = gaps.stream().filter(g -> g.startedAt().isBefore(to) && g.endedAt().isAfter(from))
                    .sorted(java.util.Comparator.comparing(AisGap::startedAt)).toList();
            return all.subList(Math.max(0, all.size() - limit), all.size());
        }

        /** ship 표 행(검색 대상). 실제 저장소와 같은 규칙(ShipQuery.matches)으로 거르고, 정확 일치 → last_seen 최신 → MMSI 순. */
        final List<SearchRow> rows = new ArrayList<>();
        final java.util.Map<String, Instant> lastPositions = new java.util.HashMap<>();
        int searchCalls, lookupCalls, lastSearchLimit;

        @Override public List<SearchRow> search(dev.wakeline.domain.ShipQuery q, int limit) {
            searchCalls++;
            lastSearchLimit = limit;
            if (down) throw new CannotGetJdbcConnectionException("down");
            return rows.stream().filter(r -> q.matches(r.mmsi(), r.stat()))
                    .sorted(java.util.Comparator.comparing((SearchRow r) -> !q.exact(r.mmsi(), r.stat()))
                            .thenComparing(SearchRow::lastSeen, java.util.Comparator.reverseOrder()).thenComparing(SearchRow::mmsi))
                    .limit(limit).toList();
        }

        @Override public java.util.Map<String, Known> lookup(java.util.Collection<String> mmsis) {
            lookupCalls++;
            if (down || lookupDown) throw new CannotGetJdbcConnectionException("down");
            java.util.Map<String, Known> out = new java.util.HashMap<>();
            for (String m : mmsis) {
                ShipStatic st = rows.stream().filter(r -> r.mmsi().equals(m)).map(SearchRow::stat).filter(java.util.Objects::nonNull).findFirst().orElse(null);
                if (st != null || lastPositions.containsKey(m)) out.put(m, new Known(st, lastPositions.get(m)));
            }
            return out;
        }

        @Override public List<AisGap> gapsAtLeast(Instant from, Instant to, long minS, int limit) {
            if (down) throw new CannotGetJdbcConnectionException("down");
            return gaps.stream().filter(g -> g.startedAt().isBefore(to) && g.endedAt().isAfter(from))
                    .filter(g -> java.time.Duration.between(g.startedAt(), g.endedAt()).getSeconds() >= minS)
                    .sorted(java.util.Comparator.comparing(AisGap::startedAt)).limit(limit).toList();
        }
    }

    static ShipState pos(String mmsi, double lat, double lon, Instant seen) {
        return new ShipState(mmsi, lat, lon, 12.0, 45.0, null, 0, null, "estimated", seen, "aisstream", "PositionReport", "A");
    }

    static ShipStatic stat(String mmsi, String name, Integer type) {
        return new ShipStatic(mmsi, name, null, null, type, null, null, null, null, null, "KR PUS", null, null, null, null, T.minusSeconds(60), "aisstream");
    }

    static ShipRepository.TrackPoint tp(Instant ts, double lon) {
        return new ShipRepository.TrackPoint(ts, lon, 35.0, 10.0, null, null, null, "epfs", "aisstream");
    }

    /** AIS 수집기 상태 해시를 넣는다(update 는 패키지 전용 — 반사로). */
    void aisHash(java.util.Map<Object, Object> h) throws Exception {
        java.lang.reflect.Method update = AisStatus.class.getDeclaredMethod("update", java.util.Map.class);
        update.setAccessible(true);
        update.invoke(ais, h);
    }

    static java.util.Map<Object, Object> aisHealthy(Instant updatedAt) {
        java.util.Map<Object, Object> h = new java.util.HashMap<>();
        h.put("provider", "aisstream");
        h.put("state", "receiving");
        h.put("connected", "1");
        h.put("updated_at", updatedAt.toString());
        h.put("bbox", "18,105,46,150");
        return h;
    }

    final ShipStore store = new ShipStore();
    final FakeRepo repo = new FakeRepo();
    final AisStatus ais = new AisStatus(new StringRedisTemplate(), store);
    MockMvc mvc;

    @BeforeEach
    void setUp() {
        store.apply(List.of(pos("440000001", 35.1, 129.1, T.minusSeconds(5)), pos("440000002", 35.2, 129.2, T.minusSeconds(5))),
                List.of(stat("440000001", "HANJIN BUSAN", 70)), T, "aisstream", System.currentTimeMillis());
        mvc = MockMvcBuilders.standaloneSetup(new ShipController(store, repo, ais, dev.wakeline.rest.AircraftControllerTest.PROPS))
                .setControllerAdvice(new ProblemAdvice()).build();
    }

    @Test void list_geoJsonWithEtagAndMeta() throws Exception {
        MvcResult r = mvc.perform(get("/api/v1/ships").param("bbox", "128,34,130,36")).andExpect(status().isOk())
                .andExpect(header().string("Cache-Control", containsString("public")))
                .andExpect(jsonPath("$.type").value("FeatureCollection"))
                .andExpect(jsonPath("$.features.length()").value(2))
                .andExpect(jsonPath("$.meta.count").value(2))
                .andExpect(jsonPath("$.meta.total_in_bbox").value(2))
                .andExpect(jsonPath("$.meta.capped").value(false))
                .andExpect(jsonPath("$.meta.provider").value("aisstream"))
                .andReturn();
        assertThat(r.getResponse().getContentAsString()).contains("\"position_source\":\"estimated\"").contains("\"name\":\"HANJIN BUSAN\"");
        String etag = r.getResponse().getHeader("ETag");
        mvc.perform(get("/api/v1/ships").param("bbox", "128,34,130,36").header("If-None-Match", etag)).andExpect(status().isNotModified());
        mvc.perform(get("/api/v1/ships").param("bbox", "0,0,60,60")).andExpect(status().isUnprocessableContent()); // 3,600 sq° > 2,500
        mvc.perform(get("/api/v1/ships").param("bbox", "1,2,3")).andExpect(status().isBadRequest());
    }

    @Test void list_isCappedAt5000_andSaysSo() throws Exception {
        List<ShipState> many = new ArrayList<>();
        for (int i = 0; i < ShipController.MAX_FEATURES + 7; i++) many.add(pos(String.format("%09d", 300_000_000 + i), 10 + (i % 100) * 0.01, 10 + (i / 100) * 0.01, T));
        store.apply(many, List.of(), T, "aisstream", System.currentTimeMillis());
        mvc.perform(get("/api/v1/ships").param("bbox", "9,9,12,12")).andExpect(status().isOk())
                .andExpect(jsonPath("$.features.length()").value(ShipController.MAX_FEATURES))
                .andExpect(jsonPath("$.meta.total_in_bbox").value(ShipController.MAX_FEATURES + 7))
                .andExpect(jsonPath("$.meta.capped").value(true));
    }

    @Test void detail_liveFromMemory_dbFallbackForStatic_dbOutage() throws Exception {
        mvc.perform(get("/api/v1/ships/440000001")).andExpect(status().isOk())
                .andExpect(jsonPath("$.state.position_source").value("estimated"))
                .andExpect(jsonPath("$.static.name").value("HANJIN BUSAN"))
                .andExpect(jsonPath("$.static_source").value("live")) // 계약 v5 §G17 — 메모리(선박 스트림)
                .andExpect(jsonPath("$.static_updated_at").doesNotExist())
                .andExpect(jsonPath("$.category").value("cargo"));
        // 실시간인데 정적 정보가 메모리에 없으면 DB 에서 — 저장값이라고 밝힌다(stored + 저장 행의 updated_at)
        ShipStatic fromDb = stat("440000002", "FROM DB", 80);
        repo.stored = new ShipRepository.StoredShip(fromDb, T.minusSeconds(86_400), T.minusSeconds(600));
        mvc.perform(get("/api/v1/ships/440000002")).andExpect(status().isOk())
                .andExpect(jsonPath("$.static.name").value("FROM DB"))
                .andExpect(jsonPath("$.static_source").value("stored"))
                .andExpect(jsonPath("$.static_updated_at").value(fromDb.updatedAt().toString()))
                .andExpect(jsonPath("$.category").value("tanker"))
                .andExpect(jsonPath("$.first_recorded_at").exists())
                .andExpect(jsonPath("$.last_seen").doesNotExist())
                .andExpect(jsonPath("$.last_seen_at").doesNotExist()); // 실시간 — 마지막 수신은 state.seen_at
        // 지금은 없고 DB 에만 있는 선박
        repo.stored = new ShipRepository.StoredShip(stat("440000099", "HISTORY", 30), T.minusSeconds(86_400), T.minusSeconds(86_000));
        repo.points.add(tp(T.minusSeconds(86_000), 129));
        mvc.perform(get("/api/v1/ships/440000099")).andExpect(status().isOk())
                .andExpect(jsonPath("$.last_position_at").exists())
                // §G4: 실시간이 아니면 마지막 수신(ship.last_seen — 저장 위치가 더 늦으면 그 시각)
                .andExpect(jsonPath("$.last_seen_at").value(T.minusSeconds(86_000).toString()))
                .andExpect(jsonPath("$.state").value(nullValue()))
                .andExpect(jsonPath("$.static.name").value("HISTORY"))
                .andExpect(jsonPath("$.static_source").value("stored"))
                .andExpect(jsonPath("$.meta.provider").value("db"));
        // 위치로만 만든 행(정적 보고를 받은 적 없음) — 정적 정보도 출처도 없다
        repo.stored = new ShipRepository.StoredShip(null, T.minusSeconds(86_400), T.minusSeconds(86_000));
        repo.storedMmsi = "440000097";
        mvc.perform(get("/api/v1/ships/440000097")).andExpect(status().isOk())
                .andExpect(jsonPath("$.static").doesNotExist())
                .andExpect(jsonPath("$.static_source").doesNotExist())
                .andExpect(jsonPath("$.static_updated_at").doesNotExist());
        mvc.perform(get("/api/v1/ships/440000098")).andExpect(status().isNotFound());
        mvc.perform(get("/api/v1/ships/44000009")).andExpect(status().isBadRequest()).andExpect(jsonPath("$.code").value("BAD_MMSI"));
        // DB 장애: 실시간 선박은 200(db_unavailable), 모르는 선박은 503(없다고 단정하지 않는다)
        repo.down = true;
        mvc.perform(get("/api/v1/ships/440000002")).andExpect(status().isOk())
                .andExpect(jsonPath("$.static").value(nullValue()))
                .andExpect(jsonPath("$.static_source").doesNotExist())
                .andExpect(jsonPath("$.category").value("unknown"))
                .andExpect(jsonPath("$.meta.db_unavailable").value(true));
        mvc.perform(get("/api/v1/ships/440000098")).andExpect(status().isServiceUnavailable()).andExpect(header().string("Retry-After", "10"));
    }

    /** 계약 v4 §B: 보고 목적지의 결정적 풀이(실린 UN/LOCODE 항구 표). 목적지를 모르면 키 없음. */
    @Test void detail_destinationInfo() throws Exception {
        mvc.perform(get("/api/v1/ships/440000001")).andExpect(status().isOk())
                .andExpect(jsonPath("$.destination_info.raw").value("KR PUS"))
                .andExpect(jsonPath("$.destination_info.kind").value("text"))
                .andExpect(jsonPath("$.destination_info.to.locode").value("KRPUS"))
                .andExpect(jsonPath("$.destination_info.to.name").value("Busan"))
                .andExpect(jsonPath("$.destination_info.to.country").value("KR"))
                .andExpect(jsonPath("$.destination_info.to.ambiguous").value(false))
                .andExpect(jsonPath("$.destination_info.from").doesNotExist())
                .andExpect(jsonPath("$.destination_info.places.length()").value(1));
        ShipStatic route = new ShipStatic("440000003", "ROUTE", null, null, 70, null, null, null, null, null, "KRPUS>CAVAN", null, null, null, null,
                T.minusSeconds(60), "aisstream");
        ShipStatic none = new ShipStatic("440000004", "NO DEST", null, null, 70, null, null, null, null, null, null, null, null, null, null,
                T.minusSeconds(60), "aisstream");
        store.apply(List.of(pos("440000003", 35.3, 129.3, T), pos("440000004", 35.4, 129.4, T)), List.of(route, none), T, "aisstream",
                System.currentTimeMillis());
        mvc.perform(get("/api/v1/ships/440000003")).andExpect(status().isOk())
                .andExpect(jsonPath("$.destination_info.kind").value("from_to"))
                .andExpect(jsonPath("$.destination_info.from.name").value("Busan"))
                .andExpect(jsonPath("$.destination_info.to.locode").value("CAVAN"))
                .andExpect(jsonPath("$.destination_info.to.ambiguous").value(true));
        mvc.perform(get("/api/v1/ships/440000004")).andExpect(status().isOk())
                .andExpect(jsonPath("$.destination_info").value(nullValue()));
        mvc.perform(get("/api/v1/ships/440000002")).andExpect(status().isOk()) // 정적 정보 없음
                .andExpect(jsonPath("$.destination_info").value(nullValue()));
    }

    @Test void track_splitsAtAisGapsAndAtFifteenMinuteJumps() throws Exception {
        Instant t0 = T.minusSeconds(3 * 3600);
        repo.points.add(tp(t0, 129.00));
        repo.points.add(tp(t0.plusSeconds(60), 129.01));
        repo.points.add(tp(t0.plusSeconds(120), 129.02));
        repo.points.add(tp(t0.plusSeconds(300), 129.03));      // 그 사이 AIS 공백(t0+150 ~ t0+250) → 끊음
        repo.points.add(tp(t0.plusSeconds(360), 129.04));
        repo.points.add(tp(t0.plusSeconds(360 + 16 * 60), 129.10)); // 16분 뒤 → 끊음(한 점 구간 — 선에는 없고 points 에만)
        repo.points.add(tp(t0.plusSeconds(360 + 40 * 60), 129.20)); // 또 24분 뒤 → 끊음
        repo.points.add(tp(t0.plusSeconds(360 + 41 * 60), 129.21));
        repo.gaps.add(new AisGap(t0.plusSeconds(150), t0.plusSeconds(250), "server closed (1006)", "aisstream"));
        mvc.perform(get("/api/v1/ships/440000001/track").param("from", t0.minusSeconds(1).toString()).param("to", T.toString()))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.type").value("Feature"))
                .andExpect(jsonPath("$.geometry.type").value("MultiLineString"))
                .andExpect(jsonPath("$.geometry.coordinates.length()").value(3))
                .andExpect(jsonPath("$.geometry.coordinates[0].length()").value(3))
                .andExpect(jsonPath("$.properties.segments.length()").value(3))
                .andExpect(jsonPath("$.properties.segments[1].points").value(2))
                .andExpect(jsonPath("$.properties.points").value(8))
                .andExpect(jsonPath("$.properties.sampling").value("first_fix_per_60s"))
                .andExpect(jsonPath("$.points.length()").value(8))
                .andExpect(jsonPath("$.points[0].position_source").value("epfs"))
                .andExpect(jsonPath("$.properties.gap_break_min_s").value(60))
                .andExpect(jsonPath("$.properties.gaps_truncated").value(false))
                .andExpect(jsonPath("$.gaps.length()").value(1))
                .andExpect(jsonPath("$.gaps[0].reason").value("server closed (1006)"));
        // 기간 검증
        mvc.perform(get("/api/v1/ships/440000001/track").param("from", T.minusSeconds(25 * 3600).toString()).param("to", T.toString()))
                .andExpect(status().isBadRequest()).andExpect(jsonPath("$.code").value("BAD_RANGE"));
        mvc.perform(get("/api/v1/ships/440000001/track").param("from", T.toString()).param("to", T.minusSeconds(1).toString()))
                .andExpect(status().isBadRequest());
        mvc.perform(get("/api/v1/ships/440000001/track")).andExpect(status().isOk()); // 기본: 최근 6 h
        repo.down = true;
        mvc.perform(get("/api/v1/ships/440000001/track")).andExpect(status().isServiceUnavailable());
    }

    @Test void split_onePointSegmentsAndOpenGaps() {
        Instant t0 = T.minusSeconds(600);
        List<ShipRepository.TrackPoint> pts = List.of(tp(t0, 1), tp(t0.plusSeconds(60), 2), tp(t0.plusSeconds(120), 3));
        assertThat(ShipController.split(pts, List.of())).hasSize(1);
        // 열린 공백(끝 없음)이 두 번째 점 뒤에 시작 → 세 번째 점 앞에서 끊는다
        assertThat(ShipController.split(pts, List.of(new AisGap(t0.plusSeconds(90), null, "open", "aisstream")))).hasSize(2);
        assertThat(ShipController.split(List.of(), List.of())).isEmpty();
    }

    @Test void gaps_listWithOpenGap_andRangeValidation() throws Exception {
        repo.gaps.add(new AisGap(T.minusSeconds(7200), T.minusSeconds(7000), "idle 120 s — no messages", "aisstream"));
        java.util.Map<Object, Object> h = new java.util.HashMap<>();
        h.put("provider", "aisstream");
        h.put("connected", "0");
        h.put("updated_at", T.toString());
        h.put("gap_open_since", T.minusSeconds(30).toString());
        h.put("gap_reason", "server closed (1006)");
        aisHash(h);
        mvc.perform(get("/api/v1/ais/gaps")).andExpect(status().isOk())
                .andExpect(jsonPath("$.items.length()").value(1))
                .andExpect(jsonPath("$.items[0].reason").value("idle 120 s — no messages"))
                .andExpect(jsonPath("$.open.reason").value("server closed (1006)"))
                .andExpect(jsonPath("$.truncated").value(false))
                // DB 목록 — 요청 시각 기준 최신(항상 stale 로 보이지 않는다)
                .andExpect(jsonPath("$.meta.stale").value(false))
                .andExpect(jsonPath("$.meta.fetched_at").exists());
        mvc.perform(get("/api/v1/ais/gaps").param("from", T.minusSeconds(40L * 86_400).toString())).andExpect(status().isBadRequest());
        // 항적의 gaps 에도 열린 공백(끝 없음)이 들어간다
        mvc.perform(get("/api/v1/ships/440000001/track")).andExpect(jsonPath("$.gaps.length()").value(2))
                .andExpect(jsonPath("$.gaps[1].ended_at").doesNotExist());
    }

    /** 계약 v3 §D: 60 s 보다 짧은 끝난 공백은 선을 끊지 않는다(저장 간격이 60 s 창이라 저장점을 없애지 못한다) — 60 s 이상·열린 공백만. */
    @Test void track_shortClosedGapsDoNotBreakTheLine() throws Exception {
        Instant t0 = T.minusSeconds(3600);
        for (long s : new long[]{0, 60, 120, 180, 300, 360}) repo.points.add(tp(t0.plusSeconds(s), 129 + s / 10_000.0));
        repo.gaps.add(new AisGap(t0.plusSeconds(70), t0.plusSeconds(110), "short 40 s", "aisstream"));  // 60–120 사이 → 끊지 않음
        repo.gaps.add(new AisGap(t0.plusSeconds(190), t0.plusSeconds(250), "exactly 60 s", "aisstream")); // 180–300 사이 → 끊음
        java.util.Map<Object, Object> h = aisHealthy(Instant.now());
        h.put("gap_open_since", t0.plusSeconds(400).toString()); // 마지막 점 뒤의 열린 공백 — 선에는 영향 없음, 목록 끝
        aisHash(h);
        mvc.perform(get("/api/v1/ships/440000001/track").param("from", t0.minusSeconds(1).toString()).param("to", T.toString()))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.geometry.coordinates.length()").value(2))
                .andExpect(jsonPath("$.properties.segments[0].points").value(4))
                .andExpect(jsonPath("$.properties.segments[1].points").value(2))
                .andExpect(jsonPath("$.properties.gap_break_min_s").value(60))
                .andExpect(jsonPath("$.gaps.length()").value(3))
                .andExpect(jsonPath("$.gaps[0].reason").value("short 40 s"))  // 목록에는 짧은 공백도 있다
                .andExpect(jsonPath("$.gaps[2].ended_at").doesNotExist());
    }

    /**
     * 계약 v3 §D(리뷰 #12): 응답 gaps 는 창과 겹치는 공백 중 최신 200개(오래된 것부터, 열린 공백 포함) + gaps_truncated. 선 끊기용 긴 공백은
     * 따로 물으므로 목록에서 잘린 오래된 긴 공백에서도 선이 끊긴다.
     */
    @Test void track_gapsAreTheNewest200_truncationDoesNotAffectLineBreaks() throws Exception {
        Instant t0 = T.minusSeconds(20 * 3600);
        repo.points.add(tp(t0, 129.00));
        repo.points.add(tp(t0.plusSeconds(60), 129.01));
        repo.gaps.add(new AisGap(t0.plusSeconds(70), t0.plusSeconds(160), "oldest long", "aisstream"));
        repo.points.add(tp(t0.plusSeconds(180), 129.02));
        repo.points.add(tp(t0.plusSeconds(240), 129.03));
        for (int i = 0; i < 250; i++) {
            Instant s = t0.plusSeconds(1_000 + 120L * i);
            repo.gaps.add(new AisGap(s, s.plusSeconds(10), "short " + i, "aisstream"));
        }
        String path = "/api/v1/ships/440000001/track";
        mvc.perform(get(path).param("from", t0.minusSeconds(1).toString()).param("to", T.toString()))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.gaps.length()").value(ShipController.TRACK_GAPS_LIMIT))
                .andExpect(jsonPath("$.gaps[0].reason").value("short 50"))
                .andExpect(jsonPath("$.gaps[199].reason").value("short 249"))
                .andExpect(jsonPath("$.properties.gaps_truncated").value(true))
                .andExpect(jsonPath("$.geometry.coordinates.length()").value(2));
        // 열린 공백도 200개 안에 든다(가장 최신)
        java.util.Map<Object, Object> h = aisHealthy(Instant.now());
        h.put("gap_open_since", T.minusSeconds(10).toString());
        aisHash(h);
        mvc.perform(get(path).param("from", t0.minusSeconds(1).toString()).param("to", T.toString()))
                .andExpect(jsonPath("$.gaps.length()").value(ShipController.TRACK_GAPS_LIMIT))
                .andExpect(jsonPath("$.gaps[0].reason").value("short 51"))
                .andExpect(jsonPath("$.gaps[198].reason").value("short 249"))
                .andExpect(jsonPath("$.gaps[199].ended_at").doesNotExist())
                .andExpect(jsonPath("$.properties.gaps_truncated").value(true));
        // 잘리지 않으면 false
        mvc.perform(get(path).param("from", t0.plusSeconds(20_000).toString()).param("to", T.toString()))
                .andExpect(jsonPath("$.properties.gaps_truncated").value(false));
    }

    /** 계약 v3 §D: /ais/gaps 는 최신 500개(오래된 것부터) — 정확히 500개면 잘리지 않았다. */
    @Test void aisGaps_areTheNewest500_truncatedOnlyWhenMore() throws Exception {
        Instant t0 = T.minusSeconds(20 * 3600);
        for (int i = 0; i < ShipController.GAPS_LIMIT; i++) {
            Instant s = t0.plusSeconds(100L * i);
            repo.gaps.add(new AisGap(s, s.plusSeconds(30), "g" + i, "aisstream"));
        }
        mvc.perform(get("/api/v1/ais/gaps")).andExpect(status().isOk())
                .andExpect(jsonPath("$.items.length()").value(ShipController.GAPS_LIMIT))
                .andExpect(jsonPath("$.items[0].reason").value("g0"))
                .andExpect(jsonPath("$.truncated").value(false));
        Instant s = t0.plusSeconds(100L * ShipController.GAPS_LIMIT);
        repo.gaps.add(new AisGap(s, s.plusSeconds(30), "newest", "aisstream"));
        mvc.perform(get("/api/v1/ais/gaps")).andExpect(status().isOk())
                .andExpect(jsonPath("$.items.length()").value(ShipController.GAPS_LIMIT))
                .andExpect(jsonPath("$.items[0].reason").value("g1"))
                .andExpect(jsonPath("$.items[499].reason").value("newest"))
                .andExpect(jsonPath("$.truncated").value(true));
    }

    /** 리뷰 #11: 선박 목록 버전이 그대로여도(수신 멈춤) AIS 수신 상태가 바뀌면 ETag 가 바뀐다 — 304 로 예전 '연결됨' 을 계속 보여 주지 않는다. */
    @Test void list_etagChangesWithAisStatusWhileTheShipListIsFrozen() throws Exception {
        aisHash(aisHealthy(Instant.now()));
        MvcResult r = mvc.perform(get("/api/v1/ships").param("bbox", "128,34,130,36")).andExpect(status().isOk())
                .andExpect(jsonPath("$.meta.ais.connected").value(true))
                .andExpect(jsonPath("$.meta.ais.state").value("receiving"))
                .andExpect(jsonPath("$.meta.ais.coverage[0][1]").value(105.0))
                .andReturn();
        String healthy = r.getResponse().getHeader("ETag");
        mvc.perform(get("/api/v1/ships").param("bbox", "128,34,130,36").header("If-None-Match", healthy)).andExpect(status().isNotModified());

        java.util.Map<Object, Object> down = aisHealthy(Instant.now());
        down.put("connected", "0");
        down.put("state", "backoff");
        down.put("gap_open_since", Instant.now().minusSeconds(5).toString());
        aisHash(down); // ships 메시지는 오지 않는다 — 목록 버전 그대로
        MvcResult r2 = mvc.perform(get("/api/v1/ships").param("bbox", "128,34,130,36").header("If-None-Match", healthy))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.meta.ais.connected").value(false))
                .andExpect(jsonPath("$.meta.ais.gap_open_since").exists())
                .andReturn();
        assertThat(r2.getResponse().getHeader("ETag")).isNotEqualTo(healthy);

        aisHash(aisHealthy(Instant.now().minusSeconds(120))); // 수집기 heartbeat 가 오래됨(죽음)
        mvc.perform(get("/api/v1/ships").param("bbox", "128,34,130,36").header("If-None-Match", healthy))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.meta.ais.heartbeat_stale").value(true))
                .andExpect(jsonPath("$.meta.ais.state").doesNotExist());
    }

    @Test void etag_encodesEveryTimeOrStatusDependentMetaValue() {
        java.util.Map<String, Object> fresh = java.util.Map.of("stale", false), stale = java.util.Map.of("stale", true);
        java.util.function.Function<java.util.Map<String, Object>, java.util.Map<String, Object>> ais = over -> {
            java.util.Map<String, Object> m = new java.util.HashMap<>();
            m.put("connected", true);
            m.put("heartbeat_stale", false);
            m.put("state", "receiving");
            m.put("coverage", List.of(List.of(18.0, 105.0, 46.0, 150.0)));
            m.putAll(over);
            return m;
        };
        java.util.Map<String, Object> noConn = new java.util.HashMap<>(ais.apply(java.util.Map.of()));
        noConn.put("connected", null);
        List<String> tags = List.of(
                ShipController.etag(7, fresh, ais.apply(java.util.Map.of())),
                ShipController.etag(8, fresh, ais.apply(java.util.Map.of())),
                ShipController.etag(7, stale, ais.apply(java.util.Map.of())),
                ShipController.etag(7, fresh, ais.apply(java.util.Map.of("connected", false))),
                ShipController.etag(7, fresh, noConn),
                ShipController.etag(7, fresh, ais.apply(java.util.Map.of("heartbeat_stale", true))),
                ShipController.etag(7, fresh, ais.apply(java.util.Map.of("gap_open_since", T))),
                ShipController.etag(7, fresh, ais.apply(java.util.Map.of("state", "backoff"))),
                ShipController.etag(7, fresh, ais.apply(java.util.Map.of("coverage", List.of(List.of(-90.0, -180.0, 90.0, 0.0))))),
                ShipController.etag(7, fresh, ais.apply(java.util.Map.of("shards", List.of(java.util.Map.of("connected", true))))),
                ShipController.etag(7, fresh, ais.apply(java.util.Map.of("shards", List.of(java.util.Map.of("connected", false))))),
                ShipController.etag(7, fresh, null));
        assertThat(new java.util.HashSet<>(tags)).hasSize(tags.size());
        assertThat(tags.getFirst()).startsWith("\"s7-0-").endsWith("\"");
        assertThat(ShipController.etag(7, fresh, ais.apply(java.util.Map.of()))).isEqualTo(tags.getFirst()); // 같은 상태 → 같은 ETag
    }

    static final String AMERICAS = "-90,-180,90,0", ASIA_PACIFIC = "-90,45,90,180";

    static String shardJson(String scope, boolean connected, Instant gapOpenSince, String reason) {
        return "{\"scope\":\"" + scope + "\",\"state\":\"" + (connected ? "receiving" : "backoff") + "\",\"connected\":" + connected
                + ",\"gap_open_since\":" + (gapOpenSince == null ? "null" : "\"" + gapOpenSince + "\"") + ",\"gap_reason\":" + (reason == null ? "null" : "\"" + reason + "\"") + "}";
    }

    static ShipRepository.TrackPoint at(Instant ts, double lat, double lon) {
        return new ShipRepository.TrackPoint(ts, lon, lat, 10.0, null, null, null, "epfs", "aisstream");
    }

    /** 계약 v4 §D: 구역이 있는 공백은 두 점 중 하나라도 그 구역 상자 안일 때만 선을 끊는다. 구역 없는 공백(옛 기록)은 모두에 적용. */
    @Test void split_scopedGapsApplyOnlyWhenAnEndpointIsInsideTheScope() {
        Instant t0 = T.minusSeconds(3600);
        dev.wakeline.domain.AisScope americas = dev.wakeline.domain.AisScope.parse(AMERICAS);
        AisGap scoped = new AisGap(t0.plusSeconds(90), t0.plusSeconds(200), "server closed (1006)", "aisstream", americas);
        List<ShipRepository.TrackPoint> busan = List.of(at(t0, 35, 129), at(t0.plusSeconds(60), 35, 129.01), at(t0.plusSeconds(240), 35, 129.02));
        assertThat(ShipController.split(busan, List.of(scoped))).as("Busan is not in the Americas shard").hasSize(1);
        assertThat(ShipController.split(busan, List.of(new AisGap(t0.plusSeconds(90), t0.plusSeconds(200), "legacy", "aisstream")))).hasSize(2);
        List<ShipRepository.TrackPoint> ny = List.of(at(t0, 40, -70), at(t0.plusSeconds(60), 40, -70.01), at(t0.plusSeconds(240), 40, -70.02));
        assertThat(ShipController.split(ny, List.of(scoped))).hasSize(2);
        // 구역 경계를 넘는 두 점: 한 점만 안이어도 끊는다
        List<ShipRepository.TrackPoint> crossing = List.of(at(t0, 0, 1), at(t0.plusSeconds(60), 0, 0.5), at(t0.plusSeconds(240), 0, -0.5));
        assertThat(ShipController.split(crossing, List.of(scoped))).hasSize(2);
        List<ShipRepository.TrackPoint> leaving = List.of(at(t0, 0, -1), at(t0.plusSeconds(60), 0, -0.5), at(t0.plusSeconds(240), 0, 0.5));
        assertThat(ShipController.split(leaving, List.of(scoped))).hasSize(2);
    }

    /**
     * 계약 v4 §D: 항적의 열린 공백은 구역마다 하나(scope 포함)이고 그 구역 안 점에서만 선을 끊는다. 끝난 공백도 scope 를 싣는다(구역 없는 옛 기록은 키 없음).
     * gaps 는 오래된 것부터(구역의 열린 공백이 끝난 공백보다 이를 수 있다).
     */
    @Test void track_openGapsPerShard_scopeInTheGapList() throws Exception {
        Instant t0 = T.minusSeconds(3600);
        for (long sec : new long[]{0, 60, 120, 180}) repo.points.add(tp(t0.plusSeconds(sec), 129 + sec / 10_000.0)); // 35N 129E — 아시아·태평양
        repo.gaps.add(new AisGap(t0.plusSeconds(1000), t0.plusSeconds(1100), "idle 120 s", "aisstream", dev.wakeline.domain.AisScope.parse(ASIA_PACIFIC)));
        repo.gaps.add(new AisGap(t0.plusSeconds(1200), t0.plusSeconds(1300), "legacy", "aisstream"));
        java.util.Map<Object, Object> h = aisHealthy(Instant.now());
        h.put("bbox", AMERICAS + "|" + ASIA_PACIFIC);
        h.put("connected", "0");
        h.put("gap_open_since", t0.plusSeconds(90).toString());
        // 아메리카 구역은 60~120 s 사이(90 s)에 열렸다 — 부산 항적은 끊지 않는다(구역 없이 적용했다면 [0,60] [120] [180]).
        // 아시아·태평양은 120~180 s 사이(150 s)에 열렸다 — 끊는다 → [0,60,120] 선 하나 + [180] 한 점
        h.put("shards", "[" + shardJson(AMERICAS, false, t0.plusSeconds(90), "server closed (1006)") + ","
                + shardJson(ASIA_PACIFIC, false, t0.plusSeconds(150), "idle 120 s — no messages") + "]");
        aisHash(h);
        mvc.perform(get("/api/v1/ships/440000001/track").param("from", t0.minusSeconds(1).toString()).param("to", T.toString()))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.geometry.coordinates.length()").value(1))
                .andExpect(jsonPath("$.properties.segments[0].points").value(3))
                .andExpect(jsonPath("$.points.length()").value(4))
                .andExpect(jsonPath("$.gaps.length()").value(4))
                .andExpect(jsonPath("$.gaps[0].scope").value(AMERICAS))
                .andExpect(jsonPath("$.gaps[0].ended_at").doesNotExist())
                .andExpect(jsonPath("$.gaps[1].scope").value(ASIA_PACIFIC))
                .andExpect(jsonPath("$.gaps[1].ended_at").doesNotExist())
                .andExpect(jsonPath("$.gaps[2].scope").value(ASIA_PACIFIC))
                .andExpect(jsonPath("$.gaps[2].reason").value("idle 120 s"))
                .andExpect(jsonPath("$.gaps[3].scope").doesNotExist());
        // /ais/gaps: 끝난 공백의 scope, open 은 합계(가장 이른 열린 공백)
        mvc.perform(get("/api/v1/ais/gaps").param("from", t0.toString()).param("to", T.toString())).andExpect(status().isOk())
                .andExpect(jsonPath("$.items.length()").value(2))
                .andExpect(jsonPath("$.items[0].scope").value(ASIA_PACIFIC))
                .andExpect(jsonPath("$.items[1].scope").doesNotExist())
                .andExpect(jsonPath("$.open.started_at").exists());
        // 목록 상태의 구역별 상태(계약 v4 §D) — meta.ais.shards
        mvc.perform(get("/api/v1/ships").param("bbox", "128,34,130,36")).andExpect(status().isOk())
                .andExpect(jsonPath("$.meta.ais.shards.length()").value(2))
                .andExpect(jsonPath("$.meta.ais.shards[1].coverage[0][1]").value(45.0))
                .andExpect(jsonPath("$.meta.ais.shards[1].connected").value(false))
                .andExpect(jsonPath("$.meta.ais.coverage.length()").value(2));
    }

    // ---- 선박 검색(계약 v5 §B1) ----

    static ShipStatic full(String mmsi, String name, String callSign, Integer imo, Integer type) {
        return new ShipStatic(mmsi, name, callSign, imo, type, null, null, null, null, null, null, null, null, null, null, T.minusSeconds(60), "aisstream");
    }

    static final java.util.Set<String> ITEM_KEYS = java.util.Set.of("mmsi", "name", "call_sign", "imo", "ship_type", "category", "live", "lat", "lon",
            "sog_kn", "seen_at", "last_position_at", "last_seen_at");

    tools.jackson.databind.JsonNode search(String q, String limit) throws Exception {
        var b = get("/api/v1/ships/search");
        if (q != null) b = b.param("q", q);
        if (limit != null) b = b.param("limit", limit);
        MvcResult r = mvc.perform(b).andExpect(status().isOk()).andExpect(header().string("Cache-Control", containsString("public"))).andReturn();
        tools.jackson.databind.JsonNode body = tools.jackson.databind.json.JsonMapper.builder().build().readTree(r.getResponse().getContentAsString());
        // 계약의 항목 모양: 13개 키(§B1 12개 + §G4 last_seen_at)가 늘 있다(모르는 값은 null — 키를 빼지 않는다)
        for (tools.jackson.databind.JsonNode it : body.path("items")) {
            java.util.Set<String> keys = new java.util.HashSet<>();
            it.propertyNames().forEach(keys::add);
            assertThat(keys).isEqualTo(ITEM_KEYS);
        }
        assertThat(body.path("meta").path("count").asInt()).isEqualTo(body.path("items").size());
        return body;
    }

    @Test void search_validatesQueryAndLimit() throws Exception {
        for (String bad : new String[]{"a", " b ", "HAN%", "HAN_JIN", "선박", "A".repeat(41)})
            mvc.perform(get("/api/v1/ships/search").param("q", bad)).andExpect(status().isBadRequest())
                    .andExpect(header().string("Content-Type", containsString("application/problem+json")))
                    .andExpect(jsonPath("$.code").value("BAD_QUERY"));
        mvc.perform(get("/api/v1/ships/search")).andExpect(status().isBadRequest()).andExpect(jsonPath("$.code").value("BAD_QUERY"));
        for (String bad : new String[]{"0", "21", "-1"})
            mvc.perform(get("/api/v1/ships/search").param("q", "HANJIN").param("limit", bad)).andExpect(status().isBadRequest())
                    .andExpect(jsonPath("$.code").value("BAD_LIMIT"));
        mvc.perform(get("/api/v1/ships/search").param("q", "HANJIN").param("limit", "x")).andExpect(status().isBadRequest());
        assertThat(repo.searchCalls).isZero();
    }

    /** 실시간(메모리) 결과: 위치·속력·보고 시각은 메모리 값, last_position_at 은 DB 의 마지막 저장 시각, 분류는 선종 코드의 결정적 변환. */
    @Test void search_liveByNamePrefix() throws Exception {
        repo.lastPositions.put("440000001", T.minusSeconds(40));
        var body = search("  hanjin ", null);
        assertThat(body.path("meta").path("q").asString()).isEqualTo("HANJIN");
        assertThat(body.path("meta").path("provider").asString()).isEqualTo("aisstream");
        assertThat(body.path("items").size()).isEqualTo(1);
        var it = body.path("items").get(0);
        assertThat(it.path("mmsi").asString()).isEqualTo("440000001");
        assertThat(it.path("name").asString()).isEqualTo("HANJIN BUSAN");
        assertThat(it.path("call_sign").isNull()).isTrue();
        assertThat(it.path("imo").isNull()).isTrue();
        assertThat(it.path("ship_type").asInt()).isEqualTo(70);
        assertThat(it.path("category").asString()).isEqualTo("cargo");
        assertThat(it.path("live").asBoolean()).isTrue();
        assertThat(it.path("lat").asDouble()).isEqualTo(35.1);
        assertThat(it.path("lon").asDouble()).isEqualTo(129.1);
        assertThat(it.path("sog_kn").asDouble()).isEqualTo(12.0);
        assertThat(Instant.parse(it.path("seen_at").asString())).isEqualTo(T.minusSeconds(5));
        assertThat(Instant.parse(it.path("last_position_at").asString())).isEqualTo(T.minusSeconds(40));
        assertThat(it.path("last_seen_at").isNull()).as("§G4: live — seen_at is the last reception").isTrue();
        assertThat(body.path("meta").has("db_unavailable")).isFalse();
    }

    /**
     * 계약 v5 §G4: 저장만 된 선박(실시간 아님)은 last_seen_at = 이 선박의 AIS 메시지를 마지막으로 받은 기록 시각 — ship.last_seen, 저장된 마지막 위치가
     * 더 늦으면 그 시각(ship.last_seen 은 위치로는 10분에 한 번만 넓히므로 그 사이 저장된 위치가 더 늦을 수 있다 — 둘 다 받은 보고의 시각).
     * 보존(72 h)이 지나 위치가 없어도 last_seen_at 은 있다. 실시간 선박은 null(seen_at 이 마지막 수신).
     */
    @Test void search_storedOnlyCarriesLastSeenAt() throws Exception {
        repo.rows.add(new ShipRepository.SearchRow("440000071", full("440000071", "HANJIN A", null, null, 70), T.minusSeconds(3_600)));
        repo.rows.add(new ShipRepository.SearchRow("440000072", full("440000072", "HANJIN B", null, null, 70), T.minusSeconds(4_000)));
        repo.rows.add(new ShipRepository.SearchRow("440000073", full("440000073", "HANJIN C", null, null, 70), T.minusSeconds(5 * 86_400)));
        repo.lastPositions.put("440000071", T.minusSeconds(7_200));  // 저장 위치가 더 이르다 → ship.last_seen
        repo.lastPositions.put("440000072", T.minusSeconds(3_700));  // 10분 창 안의 뒤 보고가 저장 위치로만 남음 → 그 시각
        var items = search("HANJIN", null).path("items");
        java.util.Map<String, tools.jackson.databind.JsonNode> by = new java.util.HashMap<>();
        for (var it : items) by.put(it.path("mmsi").asString(), it);
        assertThat(by.get("440000001").path("live").asBoolean()).isTrue();
        assertThat(by.get("440000001").path("last_seen_at").isNull()).isTrue();
        assertThat(Instant.parse(by.get("440000071").path("last_seen_at").asString())).isEqualTo(T.minusSeconds(3_600));
        assertThat(Instant.parse(by.get("440000072").path("last_seen_at").asString())).isEqualTo(T.minusSeconds(3_700));
        assertThat(Instant.parse(by.get("440000072").path("last_position_at").asString())).isEqualTo(T.minusSeconds(3_700));
        // 보존 72 h 밖: 위치는 없지만(null) 마지막 수신은 사실로 보인다
        assertThat(by.get("440000073").path("last_position_at").isNull()).isTrue();
        assertThat(Instant.parse(by.get("440000073").path("last_seen_at").asString())).isEqualTo(T.minusSeconds(5 * 86_400));
        // lookup 이 끊겨도 검색 행의 ship.last_seen 은 안다(저장 위치로 넓히지 못할 뿐)
        repo.lookupDown = true;
        var down = search("HANJIN C", null).path("items").get(0);
        assertThat(Instant.parse(down.path("last_seen_at").asString())).isEqualTo(T.minusSeconds(5 * 86_400));
        assertThat(down.path("last_position_at").isNull()).isTrue();
    }

    /** DB 에만 있는 선박: live=false, 위치·속력·보고 시각 null(지어내지 않는다), 마지막 저장 시각은 DB. 실시간 결과가 먼저, 중복 없음. */
    @Test void search_fillsFromDbAfterLive_withoutDuplicates() throws Exception {
        repo.rows.add(new ShipRepository.SearchRow("440000001", full("440000001", "HANJIN BUSAN", null, null, 70), T.minusSeconds(10)));
        repo.rows.add(new ShipRepository.SearchRow("440000077", full("440000077", "HANJIN OLD", "D7OLD", 9100007, 80), T.minusSeconds(86_400)));
        repo.rows.add(new ShipRepository.SearchRow("440000078", null, T.minusSeconds(3600))); // 정적 정보 없음 — 선명으로는 안 찾힌다
        repo.lastPositions.put("440000077", T.minusSeconds(86_000));
        var items = search("HANJIN", "10").path("items");
        assertThat(items.size()).isEqualTo(2);
        assertThat(items.get(0).path("mmsi").asString()).isEqualTo("440000001");
        assertThat(items.get(0).path("live").asBoolean()).isTrue();
        var old = items.get(1);
        assertThat(old.path("mmsi").asString()).isEqualTo("440000077");
        assertThat(old.path("live").asBoolean()).isFalse();
        for (String k : new String[]{"lat", "lon", "sog_kn", "seen_at"}) assertThat(old.path(k).isNull()).as(k).isTrue();
        assertThat(old.path("call_sign").asString()).isEqualTo("D7OLD");
        assertThat(old.path("imo").asInt()).isEqualTo(9100007);
        assertThat(old.path("category").asString()).isEqualTo("tanker");
        assertThat(Instant.parse(old.path("last_position_at").asString())).isEqualTo(T.minusSeconds(86_000));
        assertThat(repo.lastSearchLimit).as("room for duplicates of the live results").isEqualTo(10 + 1);
    }

    /**
     * 실시간인데 메모리에 정적 정보가 없는 선박(440000002)이 DB 의 선명으로 찾히면 실시간 위치와 함께 live=true(상세와 같은 DB 폴백).
     * 메모리 정적 정보가 있는데 일치하지 않는 선박(옛 선명으로만 찾힘)은 싣지 않는다 — 지금 보고와 맞지 않는 결과를 내지 않는다.
     */
    @Test void search_dbMatchOfALiveShip() throws Exception {
        repo.rows.add(new ShipRepository.SearchRow("440000002", full("440000002", "PAN OCEAN", null, null, 80), T.minusSeconds(60)));
        repo.rows.add(new ShipRepository.SearchRow("440000001", full("440000001", "PAN OLD NAME", null, null, 70), T.minusSeconds(60)));
        var items = search("PAN", null).path("items");
        assertThat(items.size()).isEqualTo(1);
        var it = items.get(0);
        assertThat(it.path("mmsi").asString()).isEqualTo("440000002");
        assertThat(it.path("live").asBoolean()).isTrue();
        assertThat(it.path("name").asString()).isEqualTo("PAN OCEAN");
        assertThat(it.path("category").asString()).isEqualTo("tanker");
        assertThat(it.path("lat").asDouble()).isEqualTo(35.2);
        // MMSI 로 찾힌 실시간 선박(메모리 정적 정보 없음)도 DB 의 저장 정적 정보로 채운다
        var byMmsi = search("440000002", null).path("items").get(0);
        assertThat(byMmsi.path("name").asString()).isEqualTo("PAN OCEAN");
        assertThat(byMmsi.path("live").asBoolean()).isTrue();
    }

    /** 숫자 규칙: 9자리 MMSI 정확 · 3–8자리 MMSI 앞부분 · 7자리 IMO 정확(+ MMSI 앞부분) · IMO 접두. 정확 일치가 먼저, 그다음 최근 보고 순. */
    @Test void search_numericRulesAndRanking() throws Exception {
        store.apply(List.of(pos("440000003", 35.3, 129.3, T.minusSeconds(1)), pos("563000004", 1.2, 103.8, T.minusSeconds(2))),
                List.of(full("440000003", "KOREA STAR", "DSAB", null, 60), full("563000004", "SG STAR", "9VAB", 4400000, 70)), T, "aisstream",
                System.currentTimeMillis());
        assertThat(search("440000003", null).path("items").get(0).path("name").asString()).isEqualTo("KOREA STAR");
        assertThat(search("440000009", null).path("items").size()).isZero();
        var prefix = search("440", null).path("items");
        assertThat(prefix.size()).isEqualTo(3);
        assertThat(prefix.get(0).path("mmsi").asString()).as("most recent report first").isEqualTo("440000003");
        // 7자리: IMO 4400000(정확 — 먼저) + MMSI 440000x 앞부분
        var seven = search("4400000", null).path("items");
        assertThat(seven.get(0).path("mmsi").asString()).isEqualTo("563000004");
        assertThat(seven.size()).isEqualTo(4);
        assertThat(search("IMO 4400000", null).path("items").size()).isEqualTo(1);
        assertThat(search("imo4400000", null).path("meta").path("q").asString()).isEqualTo("IMO4400000");
        // 선명·호출부호: 정확 일치가 먼저
        var star = search("SG STAR", null).path("items");
        assertThat(star.size()).isEqualTo(1);
        assertThat(search("9VAB", null).path("items").get(0).path("mmsi").asString()).isEqualTo("563000004");
    }

    @Test void search_limitStopsBeforeTheDb() throws Exception {
        List<ShipState> many = new ArrayList<>();
        List<ShipStatic> st = new ArrayList<>();
        for (int i = 0; i < 30; i++) {
            String m = String.format("%09d", 441_000_000 + i);
            many.add(pos(m, 34.0, 128.0 + i * 0.01, T.minusSeconds(i)));
            st.add(full(m, "FLEET " + i, null, null, 30));
        }
        store.apply(many, st, T, "aisstream", System.currentTimeMillis());
        var items = search("FLEET", "20").path("items");
        assertThat(items.size()).isEqualTo(20);
        assertThat(items.get(0).path("name").asString()).isEqualTo("FLEET 0");
        assertThat(search("FLEET", null).path("items").size()).as("default limit").isEqualTo(10);
        assertThat(repo.searchCalls).as("limit reached from memory — no DB search").isZero();
    }

    /**
     * 측정(성능 주장은 측정값만): 실시간 목록이 메모리 상한(60,000 척, 모두 정적 정보 있음)일 때 검색 한 번 — 선명 앞부분(11척 일치) · MMSI 앞부분
     * (3자리 "200" — 60,000척 모두 일치: 최악, 상위 limit 만 남기며 고른다) · MMSI 정확. MockMvc 포함, DB 는 가짜(0행). 결과는 표준 출력에 남긴다.
     */
    @Test void measure_searchOverTheLiveCap() throws Exception {
        ShipStore big = new ShipStore();
        List<ShipState> st = new ArrayList<>();
        List<ShipStatic> sc = new ArrayList<>();
        for (int i = 0; i < ShipStore.MAX_SHIPS; i++) {
            String m = String.format("%09d", 200_000_000 + i);
            st.add(pos(m, -60 + (i % 1200) * 0.1, -170 + (i / 1200) * 0.1, T.minusSeconds(i % 600)));
            sc.add(full(m, "SHIP " + i, "C" + i, null, 70));
        }
        big.apply(st, sc, T, "aisstream", System.currentTimeMillis());
        MockMvc m = MockMvcBuilders.standaloneSetup(new ShipController(big, repo, ais, dev.wakeline.rest.AircraftControllerTest.PROPS))
                .setControllerAdvice(new ProblemAdvice()).build();
        StringBuilder out = new StringBuilder("MEASURE ship search over " + ShipStore.MAX_SHIPS + " live ships:");
        for (String q : new String[]{"SHIP 1234", "200", "200012345"}) {
            for (int i = 0; i < 30; i++) m.perform(get("/api/v1/ships/search").param("q", q)).andExpect(status().isOk()); // 예열
            int n = 50;
            long t0 = System.nanoTime();
            for (int i = 0; i < n; i++) m.perform(get("/api/v1/ships/search").param("q", q)).andExpect(status().isOk());
            out.append(String.format(" q=%s %.2f ms;", q, (System.nanoTime() - t0) / 1e6 / n));
        }
        System.out.println(out);
        m.perform(get("/api/v1/ships/search").param("q", "SHIP 1234").param("limit", "20")).andExpect(jsonPath("$.items.length()").value(11))
                .andExpect(jsonPath("$.items[0].name").value("SHIP 1234"));
    }

    /** DB 장애: 실시간 결과는 그대로 200, meta.db_unavailable = true, 마지막 저장 시각은 모름(null). */
    @Test void search_dbOutageKeepsLiveResults() throws Exception {
        repo.down = true;
        var body = search("HANJIN", null);
        assertThat(body.path("items").size()).isEqualTo(1);
        assertThat(body.path("items").get(0).path("last_position_at").isNull()).isTrue();
        assertThat(body.path("meta").path("db_unavailable").asBoolean()).isTrue();
        assertThat(search("NOTHING HERE", null).path("items").size()).isZero();
    }

    /**
     * 부분 장애: 검색 문장은 성공하고 lookup 에서 DB 가 끊기면 이미 찾은 결과(실시간 + 저장만)는 그대로 200, 저장만 된 선박도 live=false 로 남고
     * 마지막 저장 시각은 모름(null), meta.db_unavailable = true.
     */
    @Test void search_lookupOutageAfterSearchKeepsStoredResults() throws Exception {
        repo.rows.add(new ShipRepository.SearchRow("440000077", full("440000077", "HANJIN OLD", "D7OLD", 9100007, 80), T.minusSeconds(86_400)));
        repo.lastPositions.put("440000001", T.minusSeconds(40));
        repo.lastPositions.put("440000077", T.minusSeconds(86_000));
        repo.lookupDown = true;
        var body = search("HANJIN", null);
        var items = body.path("items");
        assertThat(repo.searchCalls).isEqualTo(1);
        assertThat(repo.lookupCalls).isEqualTo(1);
        assertThat(items.size()).isEqualTo(2);
        assertThat(items.get(0).path("mmsi").asString()).isEqualTo("440000001");
        assertThat(items.get(0).path("live").asBoolean()).isTrue();
        var stored = items.get(1);
        assertThat(stored.path("mmsi").asString()).isEqualTo("440000077");
        assertThat(stored.path("live").asBoolean()).isFalse();
        assertThat(stored.path("name").asString()).as("static from the search row").isEqualTo("HANJIN OLD");
        for (String k : new String[]{"lat", "lon", "sog_kn", "seen_at"}) assertThat(stored.path(k).isNull()).as(k).isTrue();
        for (var it : items) assertThat(it.path("last_position_at").isNull()).as("unknown while the DB is down").isTrue();
        assertThat(body.path("meta").path("db_unavailable").asBoolean()).isTrue();
    }

    /**
     * last_position_at 은 저장된 위치(ship_position, 보존 72 h)의 마지막 시각 — 보존 밖의 선박은 null(ship.last_seen 은 10분 단위라 대신 쓰지 않는다).
     * DB 는 정상이므로 db_unavailable 은 없다.
     */
    @Test void search_storedOnlyShipBeyondPositionRetentionHasNullLastPosition() throws Exception {
        repo.rows.add(new ShipRepository.SearchRow("440000077", full("440000077", "HANJIN OLD", null, null, 80), T.minusSeconds(10 * 86_400)));
        var body = search("HANJIN OLD", null);
        var it = body.path("items").get(0);
        assertThat(it.path("live").asBoolean()).isFalse();
        assertThat(it.path("last_position_at").isNull()).isTrue();
        assertThat(body.path("meta").has("db_unavailable")).isFalse();
    }

    /** 9자리 MMSI 가 실시간에서 찾히면 DB 검색 문장을 내지 않는다(같은 MMSI 만 돌려준다) — 저장 정적 정보·마지막 저장 시각은 lookup 한 번. */
    @Test void search_liveExactMmsiSkipsTheDbSearch() throws Exception {
        repo.rows.add(new ShipRepository.SearchRow("440000002", full("440000002", "PAN OCEAN", null, null, 80), T.minusSeconds(60)));
        repo.lastPositions.put("440000002", T.minusSeconds(30));
        var it = search("440000002", null).path("items").get(0);
        assertThat(repo.searchCalls).isZero();
        assertThat(repo.lookupCalls).isEqualTo(1);
        assertThat(it.path("live").asBoolean()).isTrue();
        assertThat(it.path("name").asString()).as("stored static via lookup").isEqualTo("PAN OCEAN");
        assertThat(Instant.parse(it.path("last_position_at").asString())).isEqualTo(T.minusSeconds(30));
        // 실시간에 없는 MMSI 는 DB 에서 찾는다
        repo.rows.add(new ShipRepository.SearchRow("440000077", full("440000077", "HANJIN OLD", null, null, 80), T.minusSeconds(86_400)));
        assertThat(search("440000077", null).path("items").get(0).path("live").asBoolean()).isFalse();
        assertThat(repo.searchCalls).isEqualTo(1);
    }

    /**
     * 실시간 선박의 옛 저장 정적 정보로만 찾힌 DB 행은 걸러진다 — 그 몫이 limit 을 깎지 않도록 DB 에 더 있으면 모자란 만큼 다시 묻는다.
     * 두 실시간 선박(메모리 선명은 새 이름)이 옛 선명 "OLDNAME" 으로 DB 의 가장 최근 행이어도 limit 2 는 저장만 된 두 척으로 찬다.
     */
    @Test void search_refillsWhenLiveShipsDropStoredRows() throws Exception {
        store.apply(List.of(pos("440000003", 35.3, 129.3, T.minusSeconds(1))), List.of(full("440000003", "NEW NAME", null, null, 70)), T, "aisstream",
                System.currentTimeMillis());
        repo.rows.add(new ShipRepository.SearchRow("440000001", full("440000001", "OLDNAME A", null, null, 70), T.minusSeconds(10)));
        repo.rows.add(new ShipRepository.SearchRow("440000003", full("440000003", "OLDNAME B", null, null, 70), T.minusSeconds(20)));
        repo.rows.add(new ShipRepository.SearchRow("440000081", full("440000081", "OLDNAME C", null, null, 70), T.minusSeconds(100)));
        repo.rows.add(new ShipRepository.SearchRow("440000082", full("440000082", "OLDNAME D", null, null, 70), T.minusSeconds(200)));
        repo.rows.add(new ShipRepository.SearchRow("440000083", full("440000083", "OLDNAME E", null, null, 70), T.minusSeconds(300)));
        var items = search("OLDNAME", "2").path("items");
        assertThat(items.size()).isEqualTo(2);
        assertThat(items.get(0).path("mmsi").asString()).isEqualTo("440000081");
        assertThat(items.get(1).path("mmsi").asString()).isEqualTo("440000082");
        assertThat(repo.searchCalls).isEqualTo(2);
        // DB 에 더 없으면(행이 모자람) 다시 묻지 않는다 — 있는 만큼만
        repo.searchCalls = 0;
        assertThat(search("OLDNAME", "20").path("items").size()).isEqualTo(3);
        assertThat(repo.searchCalls).isEqualTo(1);
        // 어긋남이 많아도 검색 한 번의 DB 문장은 상한(3)까지 — 넘으면 있는 만큼만(여기서는 0척)
        store.apply(List.of(pos("440000004", 35.4, 129.4, T.minusSeconds(1)), pos("440000005", 35.5, 129.5, T.minusSeconds(1))),
                List.of(full("440000004", "NEW 4", null, null, 70), full("440000005", "NEW 5", null, null, 70)), T, "aisstream", System.currentTimeMillis());
        repo.rows.add(new ShipRepository.SearchRow("440000004", full("440000004", "OLDNAME F", null, null, 70), T.minusSeconds(11)));
        repo.rows.add(new ShipRepository.SearchRow("440000005", full("440000005", "OLDNAME G", null, null, 70), T.minusSeconds(12)));
        repo.searchCalls = 0;
        assertThat(search("OLDNAME", "1").path("items").size()).isZero();
        assertThat(repo.searchCalls).isEqualTo(ShipController.SEARCH_DB_ATTEMPTS);
    }
}
