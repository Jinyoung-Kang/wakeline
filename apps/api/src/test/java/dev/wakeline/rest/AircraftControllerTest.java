package dev.wakeline.rest;

import dev.wakeline.config.AppProperties;
import dev.wakeline.config.ProblemAdvice;
import dev.wakeline.domain.AircraftState;
import dev.wakeline.engine.EngineService;
import dev.wakeline.ingest.SigmetStore;
import dev.wakeline.ingest.Snapshot;
import dev.wakeline.ingest.SnapshotStore;
import dev.wakeline.persist.AircraftRepository;
import dev.wakeline.persist.TrackRepository;
import dev.wakeline.route.RouteInfoTest;
import dev.wakeline.route.RouteReader;
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
    /** 가짜 Redis(노선 캐시 키 → 값, 합성). */
    final Map<String, String> routeCache = new java.util.HashMap<>();
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
                Map.of("71be01", ac("71be01", "KAL081", 37.4, 126.5, now.minusSeconds(3), "adsb_lol"),
                        "71be02", ac("71be02", " syn736 ", 50.0, 10.0, now.minusSeconds(3), "adsb_lol"),
                        "71be03", ac("71be03", null, 50.1, 10.1, now.minusSeconds(3), "adsb_lol"))));
        EngineService engine = new EngineService(snapshots, new SigmetStore(), e -> { }, new SimpleMeterRegistry());
        RouteReader routes = new RouteReader(routeCache::get, RouteInfoTest.JSON, System::currentTimeMillis);
        var controller = new AircraftController(snapshots, engine, new DbDown(), new TrackRepository(null), PROPS, routes);
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

    /** 계약 v4 §A: 상세의 route — 상태의 콜사인(trim·대문자)으로 Redis 캐시를 읽는다. 없으면 pending, 콜사인이 없으면 no_callsign. */
    @Test
    void detailCarriesTheRegisteredRouteOfTheLiveCallsign() throws Exception {
        routeCache.put("wakeline:route:SYN736", RouteInfoTest.found("SYN736").toString());
        mvc.perform(get("/api/v1/aircraft/71be02")).andExpect(status().isOk())
                .andExpect(jsonPath("$.route.status").value("found"))
                .andExpect(jsonPath("$.route.callsign").value("SYN736"))
                .andExpect(jsonPath("$.route.source").value("adsbdb"))
                .andExpect(jsonPath("$.route.origin.icao").value("ZZAA"))
                .andExpect(jsonPath("$.route.origin.country_iso").value("ZZ"))
                .andExpect(jsonPath("$.route.destination.icao").value("ZZBB"))
                .andExpect(jsonPath("$.route.airline.iata").value("S9"))
                .andExpect(jsonPath("$.route.fetched_at").value("2026-09-28T03:21:00Z"));
        mvc.perform(get("/api/v1/aircraft/71be01")).andExpect(jsonPath("$.route.status").value("pending"))
                .andExpect(jsonPath("$.route.callsign").value("KAL081"));
        mvc.perform(get("/api/v1/aircraft/71be03")).andExpect(jsonPath("$.route.status").value("no_callsign"))
                .andExpect(jsonPath("$.route.callsign").doesNotExist());
    }

    /**
     * 계약 v4 §G: 수집기가 묻지 않은 노선(A-2 — fixture 모드·운영자가 adsbdb 끔)은 disabled(조회 시각 없음), ASCII 가 아닌 콜사인(A-1)은
     * no_callsign — 대문자 변환으로 다른 콜사인(IAB12S)이 되어 그 노선을 붙이지 않는다.
     */
    @Test
    void detailRoute_disabledByOperator_andNonAsciiCallsignIsNoCallsign() throws Exception {
        routeCache.put("wakeline:route:KAL081", RouteInfoTest.cached("disabled", "KAL081").toString());
        routeCache.put("wakeline:route:IAB12S", RouteInfoTest.found("IAB12S").toString());
        mvc.perform(get("/api/v1/aircraft/71be01")).andExpect(status().isOk())
                .andExpect(jsonPath("$.route.status").value("disabled"))
                .andExpect(jsonPath("$.route.callsign").value("KAL081"))
                .andExpect(jsonPath("$.route.source").value("adsbdb"))
                .andExpect(jsonPath("$.route.fetched_at").doesNotExist());
        Instant now = Instant.now();
        snapshots.replaceIfNewer(new Snapshot(snapshots.nextVersion(), "region", "adsb_lol", now.plusSeconds(1), now, "-",
                Map.of("71be04", ac("71be04", "ıab12ſ", 50.2, 10.2, now, "adsb_lol"))));
        mvc.perform(get("/api/v1/aircraft/71be04")).andExpect(status().isOk())
                .andExpect(jsonPath("$.route.status").value("no_callsign"))
                .andExpect(jsonPath("$.route.callsign").doesNotExist())
                .andExpect(jsonPath("$.route.origin").doesNotExist());
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
