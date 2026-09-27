package dev.skywx.rest;

import dev.skywx.config.AppProperties;
import dev.skywx.config.ProblemAdvice;
import dev.skywx.domain.AircraftState;
import dev.skywx.engine.EngineService;
import dev.skywx.ingest.SigmetStore;
import dev.skywx.ingest.Snapshot;
import dev.skywx.ingest.SnapshotStore;
import dev.skywx.persist.AircraftRepository;
import dev.skywx.persist.TrackRepository;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.CannotGetJdbcConnectionException;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

import java.time.Instant;
import java.util.List;
import java.util.Map;

import static org.hamcrest.Matchers.containsString;
import static org.hamcrest.Matchers.hasItem;
import static org.hamcrest.Matchers.nullValue;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * 항공기 REST: DB 없이도 실시간 상세는 200(static = null, meta.db_unavailable), 검색은 병합 뷰(전세계 포함)·호출부호,
 * 스냅샷 ETag·Cache-Control public·304.
 */
class AircraftControllerTest {
    static final AppProperties PROPS = new AppProperties("", "36.5,127.8", 250, 120, 200, 5, 10, 30, 2500, 0, "classpath:schemas", 72, 30,
            120, List.of("http://localhost:8700"));

    /** DB 가 내려간 저장소. */
    static class DbDown extends AircraftRepository {
        DbDown() { super(null, null); }
        @Override public Map<String, Object> find(String hex) { throw new CannotGetJdbcConnectionException("Failed to obtain JDBC Connection"); }
        @Override public List<Map<String, Object>> search(String prefix, int limit) { throw new CannotGetJdbcConnectionException("down"); }
    }

    final SnapshotStore snapshots = new SnapshotStore();
    MockMvc mvc;

    static AircraftState ac(String hex, String callsign, double lat, double lon, Instant seen, String provider) {
        return new AircraftState(hex, callsign, null, null, null, lat, lon, 30000, 450.0, 90.0, 0.0, false, "1200", seen, provider, seen, 0, false);
    }

    @BeforeEach
    void setUp() {
        Instant now = Instant.now();
        snapshots.replaceIfNewer(new Snapshot(snapshots.nextVersion(), "global", "opensky", now, now, "-",
                Map.of("a1b2c3", ac("a1b2c3", "UAL1  ", 40, -100, now.minusSeconds(20), "opensky"),
                        "b00001", ac("b00001", "UAL2", 41, -101, now.minusSeconds(900), "opensky"))));
        snapshots.replaceIfNewer(new Snapshot(snapshots.nextVersion(), "region", "adsb_lol", now, now, "-",
                Map.of("71be01", ac("71be01", "KAL081", 37.4, 126.5, now.minusSeconds(3), "adsb_lol"))));
        EngineService engine = new EngineService(snapshots, new SigmetStore(), e -> { }, new SimpleMeterRegistry());
        var controller = new AircraftController(snapshots, engine, new DbDown(), new TrackRepository(null), PROPS);
        mvc = MockMvcBuilders.standaloneSetup(controller).setControllerAdvice(new ProblemAdvice()).build();
    }

    @Test
    void liveDetailSurvivesDatabaseOutage() throws Exception {
        mvc.perform(get("/api/v1/aircraft/71be01")).andExpect(status().isOk())
                .andExpect(jsonPath("$.state.callsign").value("KAL081"))
                .andExpect(jsonPath("$.static").value(nullValue()))
                .andExpect(jsonPath("$.meta.db_unavailable").value(true))
                .andExpect(header().string("Cache-Control", containsString("public")));
        // 실시간 상태도 없고 DB 도 없으면 있는지 모른다 → 503(404 로 단정하지 않는다)
        mvc.perform(get("/api/v1/aircraft/ffffff")).andExpect(status().isServiceUnavailable()).andExpect(header().string("Retry-After", "10"));
    }

    @Test
    void searchUsesTheMergedSnapshotAndCallsigns() throws Exception {
        mvc.perform(get("/api/v1/aircraft/search").param("q", "ual"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.items[*].hex").value(hasItem("a1b2c3")))       // 전세계 스냅샷의 기체
                .andExpect(jsonPath("$.items.length()").value(1))                       // 600 s 넘은 전세계 기체는 '현재' 가 아니다
                .andExpect(jsonPath("$.items[0].live").value(true))
                .andExpect(jsonPath("$.meta.db_unavailable").value(true));
        mvc.perform(get("/api/v1/aircraft/search").param("q", "KAL0")).andExpect(jsonPath("$.items[0].hex").value("71be01"));
        mvc.perform(get("/api/v1/aircraft/search").param("q", "K%")).andExpect(status().isBadRequest()); // LIKE 와일드카드 차단
    }

    @Test
    void snapshotHasEtagPublicCachingAndSources() throws Exception {
        MvcResult r = mvc.perform(get("/api/v1/aircraft").param("bbox", "120,30,135,45")).andExpect(status().isOk())
                .andExpect(header().string("Cache-Control", containsString("public")))
                .andExpect(jsonPath("$.features.length()").value(1))
                .andExpect(jsonPath("$.meta.sources.region.provider").value("adsb_lol"))
                .andExpect(jsonPath("$.meta.sources.global.provider").value("opensky"))
                .andReturn();
        String etag = r.getResponse().getHeader("ETag");
        mvc.perform(get("/api/v1/aircraft").param("bbox", "120,30,135,45").header("If-None-Match", etag))
                .andExpect(status().isNotModified()).andExpect(header().string("Cache-Control", containsString("public")));
    }
}
