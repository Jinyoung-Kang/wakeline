package dev.wakeline.qa;

import dev.wakeline.DbTestSupport;
import dev.wakeline.history.MaintenanceJobs;
import dev.wakeline.ops.AuditService;
import dev.wakeline.ops.IngestRunRepository;
import dev.wakeline.ops.OpsController;
import dev.wakeline.ops.OpsQueries;
import dev.wakeline.ops.ProviderSwitchService;
import dev.wakeline.ops.ResolutionService;
import dev.wakeline.platform.web.ProblemAdvice;
import dev.wakeline.settings.RegionSettings;
import dev.wakeline.settings.SettingsService;
import dev.wakeline.status.StatusService;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIf;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;

/**
 * QA-208(QA 2026-10 기능 · 운영): POST /api/v1/ops/stats/aggregate?day= 는 '오늘(KST) 이전'만 본다(OpsController.aggregate). PostgreSQL date 하한(4713 BC)
 * 앞의 날(-5000-01-01)을 주면 200 {day:"-5000-01-01"} 으로 답하고 감사에도 그 날짜를 적지만, pgjdbc 가 그 LocalDate 를 '-infinity' 로 보내 stats_daily 에
 * day = -infinity 인 완료 표식 행이 생긴다 — 응답 · 감사와 저장된 값이 다르다. 더 이른 날(-999999999-01-01)은 500(QA-202 와 같은 뿌리).
 * 격리 스택 A 에서 같은 요청으로 '-infinity|aggregated_at|sigmet' 행이 생겼다(정리함 — evidence/functional/qa-208-aggregate-bc-day.txt).
 * 운영 화면은 날짜 입력으로 이 값을 보낼 수 있다(시험 계정 세션 · CSRF 필요).
 */
@EnabledIf("dev.wakeline.DbTestSupport#dockerAvailable")
class Qa208AggregateBcDayWritesInfinityTest {
    static MockMvc mvc;

    @BeforeAll
    static void setUp() {
        var api = DbTestSupport.apiClient();
        var jobs = new MaintenanceJobs(api, DbTestSupport.PROPS, new RegionSettings(new StringRedisTemplate(), api, DbTestSupport.JSON, DbTestSupport.PROPS),
                DbTestSupport.apiTx());
        var controller = new OpsController(mock(StatusService.class), mock(OpsQueries.class), mock(SettingsService.class), mock(AuditService.class),
                jobs, DbTestSupport.apiTx(), mock(ProviderSwitchService.class), mock(ResolutionService.class), new IngestRunRepository(api));
        mvc = MockMvcBuilders.standaloneSetup(controller).setControllerAdvice(new ProblemAdvice()).build();
    }

    @AfterEach
    void cleanUp() {
        DbTestSupport.admin().sql("DELETE FROM stats_daily WHERE day = '-infinity'::date").update();
    }

    @Test
    void aDayBeforePostgresMinimumIsRejectedAndWritesNothing() throws Exception {
        MvcResult r = mvc.perform(post("/api/v1/ops/stats/aggregate").param("day", "-5000-01-01")).andReturn();
        Integer infinityRows = DbTestSupport.admin().sql("SELECT count(*)::int FROM stats_daily WHERE day = '-infinity'::date").query(Integer.class).single();
        assertThat(r.getResponse().getStatus()).as("POST ?day=-5000-01-01 → %d %s; rows with day = -infinity: %d",
                r.getResponse().getStatus(), r.getResponse().getContentAsString(), infinityRows).isEqualTo(400);
        assertThat(infinityRows).isZero();
    }
}
