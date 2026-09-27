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

        @Override public List<AisGap> gaps(Instant from, Instant to, int limit) {
            if (down) throw new CannotGetJdbcConnectionException("down");
            return gaps.stream().filter(g -> g.startedAt().isBefore(to) && g.endedAt().isAfter(from)).limit(limit).toList();
        }
    }

    static ShipState pos(String mmsi, double lat, double lon, Instant seen) {
        return new ShipState(mmsi, lat, lon, 12.0, 45.0, null, 0, null, "estimated", seen, "aisstream", "PositionReport", "A");
    }

    static ShipStatic stat(String mmsi, String name, Integer type) {
        return new ShipStatic(mmsi, name, null, null, type, null, null, null, null, null, "KR PUS", null, null, null, null, T.minusSeconds(60), "aisstream");
    }

    static ShipRepository.TrackPoint tp(Instant ts, double lon) {
        return new ShipRepository.TrackPoint(ts, lon, 35.0, 10.0, null, null, null, "gnss", "aisstream");
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
                .andExpect(jsonPath("$.points[0].position_source").value("gnss"))
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
        java.lang.reflect.Method update = AisStatus.class.getDeclaredMethod("update", java.util.Map.class);
        update.setAccessible(true);
        update.invoke(ais, h);
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
}
