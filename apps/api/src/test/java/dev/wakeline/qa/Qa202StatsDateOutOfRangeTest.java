package dev.wakeline.qa;

import dev.wakeline.DbTestSupport;
import dev.wakeline.aircraft.data.TrackRepository;
import dev.wakeline.history.HistoryController;
import dev.wakeline.history.StatsRepository;
import dev.wakeline.platform.web.ProblemAdvice;
import dev.wakeline.status.StatusService;
import dev.wakeline.weather.data.SigmetRepository;
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
 * QA-202(QA 2026-10 기능): 공개 통계의 날짜 파라미터(KST LocalDate)가 끝값이거나 PostgreSQL timestamp 범위(294276 AD) 밖이면 400 이 아니라
 * 500 INTERNAL + ERROR 스택 로그가 된다.
 * <ul>
 *   <li>from = to = +999999999-12-31: 범위 검사 {@code f.plusDays(92)} 가 DateTimeException(HistoryController.range).</li>
 *   <li>to = -999999999-01-01(from 없음): 기본 from {@code t.minusDays(7)} 이 DateTimeException.</li>
 *   <li>+300000 년 이틀: 범위 검사는 통과하고 StatsRepository.days 의 generate_series(date → timestamp)가 'date out of range for timestamp'.</li>
 *   <li>/stats/traffic day = +6000000-01-01: 검사 없이 DB 로 가서 'date out of range'(PostgreSQL date 상한 5874897 AD).</li>
 * </ul>
 * 실제 PostGIS 에 진짜 StatsRepository 로 묻는다 — 격리 스택 A 에서 같은 요청이 500 이었다.
 */
@EnabledIf("dev.wakeline.DbTestSupport#dockerAvailable")
class Qa202StatsDateOutOfRangeTest {
    static MockMvc mvc;

    @BeforeAll
    static void setUp() {
        var db = DbTestSupport.apiClient();
        var controller = new HistoryController(new TrackRepository(db), mock(SigmetRepository.class), new StatsRepository(db), mock(StatusService.class),
                DbTestSupport.PROPS);
        mvc = MockMvcBuilders.standaloneSetup(controller).setControllerAdvice(new ProblemAdvice()).build();
    }

    static MockHttpServletRequestBuilder req(String path, String query) {
        var b = get(path);
        for (String kv : query.split("&")) {
            int i = kv.indexOf('=');
            b = b.param(kv.substring(0, i), kv.substring(i + 1));
        }
        return b;
    }

    @ParameterizedTest(name = "{0}?{1}")
    @CsvSource(delimiter = '|', value = {
            "/api/v1/stats/sigmet | from=+999999999-12-31&to=+999999999-12-31",
            "/api/v1/stats/sigmet | to=-999999999-01-01",
            "/api/v1/stats/sigmet | from=+300000-01-01&to=+300000-01-02",
            "/api/v1/stats/alerts | from=+999999999-12-31&to=+999999999-12-31",
            "/api/v1/stats/alerts | to=-999999999-01-01",
            "/api/v1/stats/alerts | from=+300000-01-01&to=+300000-01-02",
            "/api/v1/stats/traffic | day=+6000000-01-01",
    })
    void outOfRangeDateIsAClientErrorNotA500(String path, String query) throws Exception {
        MvcResult r = mvc.perform(req(path, query)).andReturn();
        int st = r.getResponse().getStatus();
        assertThat(st).as("%s?%s → %d %s", path, query, st, r.getResponse().getContentAsString()).isEqualTo(400);
        assertThat(r.getResponse().getContentType()).startsWith("application/problem+json");
    }
}
