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
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;

/**
 * QA-207(QA 2026-10 기능 · 성능 · 보안 영역과 겹침): 공개 /stats/sigmet · /stats/alerts 에 PostgreSQL 날짜 하한(4713 BC) 앞의 from 을 주면 pgjdbc 가
 * 그 LocalDate 를 '-infinity' 로 보내고, StatsRepository.days 의 {@code generate_series(:from::date, :to::date, interval '1 day') ... ORDER BY d} 가
 * 끝나지 않는 계열을 정렬하며 임시 파일을 쓰다가 공개 조회 한도(3 s — Sql.publicRead)에 끊긴다. 응답은 400 이 아니라 '저장소 일시 장애' 503 +
 * Retry-After 10(다시 해도 같다)이고, 그동안 DB 백엔드 하나가 CPU 100 % 로 돈다 — 격리 스택 A 에서 요청 하나에 임시 파일 약 828 MB(pg_stat_database.temp_bytes).
 * 범위 검사(HistoryController.range — 92일 · from ≤ to)는 통과한다.
 */
@EnabledIf("dev.wakeline.DbTestSupport#dockerAvailable")
class Qa207StatsBcDateRunsAwayTest {
    static MockMvc mvc;

    @BeforeAll
    static void setUp() {
        var db = DbTestSupport.apiClient();
        var controller = new HistoryController(new TrackRepository(db), mock(SigmetRepository.class), new StatsRepository(db), mock(StatusService.class),
                DbTestSupport.PROPS);
        mvc = MockMvcBuilders.standaloneSetup(controller).setControllerAdvice(new ProblemAdvice()).build();
    }

    @ParameterizedTest(name = "{0}?from=-5000-01-01&to=-5000-01-02")
    @ValueSource(strings = {"/api/v1/stats/sigmet", "/api/v1/stats/alerts"})
    void aDateBeforePostgresMinimumIsRejectedQuicklyNotRunUntilTheTimeout(String path) throws Exception {
        long t0 = System.nanoTime();
        MvcResult r = mvc.perform(get(path).param("from", "-5000-01-01").param("to", "-5000-01-02")).andReturn();
        long ms = (System.nanoTime() - t0) / 1_000_000;
        int st = r.getResponse().getStatus();
        assertThat(st).as("%s → %d after %d ms %s", path, st, ms, r.getResponse().getContentAsString()).isEqualTo(400);
        assertThat(ms).as("answered without running the statement to its limit").isLessThan(1000);
    }
}
