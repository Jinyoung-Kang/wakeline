package dev.wakeline.qa;

import dev.wakeline.DbTestSupport;
import dev.wakeline.aircraft.core.SnapshotStore;
import dev.wakeline.aircraft.data.AircraftRepository;
import dev.wakeline.aircraft.data.TrackRepository;
import dev.wakeline.aircraft.web.AircraftController;
import dev.wakeline.platform.web.ProblemAdvice;
import dev.wakeline.route.RouteReader;
import dev.wakeline.ships.core.AisStatus;
import dev.wakeline.ships.core.ShipStore;
import dev.wakeline.ships.data.ShipRepository;
import dev.wakeline.ships.web.ShipController;
import dev.wakeline.weather.core.EngineService;
import dev.wakeline.weather.core.RadarStore;
import dev.wakeline.weather.core.SigmetStore;
import dev.wakeline.weather.data.AirportRepository;
import dev.wakeline.weather.data.AlertRepository;
import dev.wakeline.weather.data.KrRadarReader;
import dev.wakeline.weather.data.SigmetRepository;
import dev.wakeline.weather.web.WeatherController;
import dev.wakeline.platform.data.OrderedWriter;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.condition.EnabledIf;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;

/**
 * QA-201(QA 2026-10 기능): 공개 시각 파라미터(ISO Instant)가 PostgreSQL timestamptz 범위(4713 BC – 294276 AD) 밖이거나 Instant 끝값이면
 * 400 이 아니라 500 INTERNAL + ERROR 스택 로그가 된다 — 익명 요청 하나로 운영 로그(/logs)에 서버 오류를 만들 수 있다(SEC-10 의 '4xx 는 INFO' 규칙 위반).
 * <ul>
 *   <li>+300000 년 구간: 범위 검사(≤ 24 h · from &lt; to)는 통과하고 DB 가 'timestamp out of range'(22008 → DataIntegrityViolationException)로 거절한다.</li>
 *   <li>to = -1000000000 년(Instant.MIN 근처): 컨트롤러의 기본 from 계산(end.minus(…))이 DateTimeException.</li>
 *   <li>/alerts/history from = -1000000000 년: 범위 검사의 toEpochMilli() 가 ArithmeticException.</li>
 * </ul>
 * 실제 PostGIS(운영과 같은 이미지)에 진짜 저장소로 묻는다 — 격리 스택 A 에서 같은 요청이 500 이었다(docs/qa/2026-10/evidence/functional).
 */
@EnabledIf("dev.wakeline.DbTestSupport#dockerAvailable")
class Qa201TimeParamOutOfRangeTest {
    static MockMvc mvc;

    @BeforeAll
    static void setUp() {
        var db = DbTestSupport.apiClient();
        var meters = new SimpleMeterRegistry();
        var snapshots = new SnapshotStore();
        var sigmets = new SigmetStore();
        var engine = new EngineService(snapshots, sigmets, e -> { }, meters);
        var aircraft = new AircraftController(snapshots, engine, new AircraftRepository(null, null), new TrackRepository(db), DbTestSupport.PROPS,
                new RouteReader(k -> null, DbTestSupport.JSON, System::currentTimeMillis));
        var store = new ShipStore();
        var ships = new ShipController(store, new ShipRepository(DbTestSupport.apiJdbc(), db), new AisStatus(store), DbTestSupport.PROPS);
        var alerts = new AlertRepository(db, DbTestSupport.JSON, mock(SigmetRepository.class), sigmets, mock(OrderedWriter.class), meters);
        var weather = new WeatherController(sigmets, engine, new RadarStore(), new AirportRepository(db), alerts, DbTestSupport.PROPS,
                new KrRadarReader(null), DbTestSupport.JSON, meters);
        mvc = MockMvcBuilders.standaloneSetup(aircraft, ships, weather).setControllerAdvice(new ProblemAdvice()).build();
    }

    static MockHttpServletRequestBuilder req(String path, String query) {
        var b = get(path);
        if (query == null || query.isBlank()) return b;
        for (String kv : query.split("&")) {
            int i = kv.indexOf('=');
            b = b.param(kv.substring(0, i), kv.substring(i + 1));
        }
        return b;
    }

    @ParameterizedTest(name = "{0}?{1}")
    @CsvSource(delimiter = '|', value = {
            "/api/v1/aircraft/71be01/track | from=+300000-01-01T00:00:00Z&to=+300000-01-01T01:00:00Z",
            "/api/v1/aircraft/71be01/track | to=-1000000000-01-01T00:00:00Z",
            "/api/v1/ships/440123450/track | from=+300000-01-01T00:00:00Z&to=+300000-01-01T01:00:00Z",
            "/api/v1/ships/440123450/track | to=-1000000000-01-01T00:00:00Z",
            "/api/v1/ais/gaps              | from=+300000-01-01T00:00:00Z&to=+300000-01-01T01:00:00Z",
            "/api/v1/ais/gaps              | to=-1000000000-01-01T00:00:00Z",
            "/api/v1/alerts/history        | from=+300000-01-01T00:00:00Z&to=+300000-01-01T01:00:00Z",
            "/api/v1/alerts/history        | from=-1000000000-01-01T00:00:00Z",
    })
    void outOfRangeTimeIsAClientErrorNotA500(String path, String query) throws Exception {
        MvcResult r = mvc.perform(req(path, query)).andReturn();
        int st = r.getResponse().getStatus();
        assertThat(st).as("%s?%s → %d %s", path, query, st, r.getResponse().getContentAsString()).isEqualTo(400);
        assertThat(r.getResponse().getContentType()).startsWith("application/problem+json");
    }
}
