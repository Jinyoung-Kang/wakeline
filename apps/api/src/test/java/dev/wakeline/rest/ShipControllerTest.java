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
        StoredShip stored;
        final List<TrackPoint> points = new ArrayList<>();
        final List<AisGap> gaps = new ArrayList<>();

        FakeRepo() { super(null, null); }

        @Override public StoredShip find(String mmsi) {
            if (down) throw new CannotGetJdbcConnectionException("down");
            return stored != null && stored.stat() != null && stored.stat().mmsi().equals(mmsi) ? stored : null;
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
                .andExpect(jsonPath("$.category").value("cargo"));
        // 실시간인데 정적 정보가 메모리에 없으면 DB 에서
        repo.stored = new ShipRepository.StoredShip(stat("440000002", "FROM DB", 80), T.minusSeconds(86_400), T.minusSeconds(600));
        mvc.perform(get("/api/v1/ships/440000002")).andExpect(status().isOk())
                .andExpect(jsonPath("$.static.name").value("FROM DB"))
                .andExpect(jsonPath("$.category").value("tanker"))
                .andExpect(jsonPath("$.first_recorded_at").exists())
                .andExpect(jsonPath("$.last_seen").doesNotExist());
        // 지금은 없고 DB 에만 있는 선박
        repo.stored = new ShipRepository.StoredShip(stat("440000099", "HISTORY", 30), T.minusSeconds(86_400), T.minusSeconds(86_000));
        repo.points.add(tp(T.minusSeconds(86_000), 129));
        mvc.perform(get("/api/v1/ships/440000099")).andExpect(status().isOk())
                .andExpect(jsonPath("$.last_position_at").exists())
                .andExpect(jsonPath("$.state").value(nullValue()))
                .andExpect(jsonPath("$.static.name").value("HISTORY"))
                .andExpect(jsonPath("$.meta.provider").value("db"));
        mvc.perform(get("/api/v1/ships/440000098")).andExpect(status().isNotFound());
        mvc.perform(get("/api/v1/ships/44000009")).andExpect(status().isBadRequest()).andExpect(jsonPath("$.code").value("BAD_MMSI"));
        // DB 장애: 실시간 선박은 200(db_unavailable), 모르는 선박은 503(없다고 단정하지 않는다)
        repo.down = true;
        mvc.perform(get("/api/v1/ships/440000002")).andExpect(status().isOk())
                .andExpect(jsonPath("$.static").value(nullValue()))
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
}
