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
import dev.wakeline.settings.SettingsService;
import dev.wakeline.status.StatusService;
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
 * QA-205(QA 2026-10 기능 · 운영): GET /api/v1/ops/runs 의 목록 필터 job · provider · status 는 글자를 그대로 SQL 매개변수로 넘긴다. NUL(U+0000)이 든 값은
 * PostgreSQL 이 'invalid byte sequence for encoding "UTF8": 0x00'(22021 → DataIntegrityViolationException)으로 거절해 400 이 아니라 500 INTERNAL + ERROR
 * 스택 로그가 된다(since 의 범위 밖 시각도 같은 500 — QA-201 과 같은 뿌리). 운영 세션이 있어야 닿는 경로다.
 * 실제 PostGIS 에 진짜 IngestRunRepository 로 묻는다 — 격리 스택 A 에서 같은 요청(qa-b 세션)이 500 이었다.
 */
@EnabledIf("dev.wakeline.DbTestSupport#dockerAvailable")
class Qa205OpsRunsFilterNulTest {
    static MockMvc mvc;

    @BeforeAll
    static void setUp() {
        var controller = new OpsController(mock(StatusService.class), mock(OpsQueries.class), mock(SettingsService.class), mock(AuditService.class),
                mock(MaintenanceJobs.class), DbTestSupport.apiTx(), mock(ProviderSwitchService.class), mock(ResolutionService.class),
                new IngestRunRepository(DbTestSupport.apiClient()));
        mvc = MockMvcBuilders.standaloneSetup(controller).setControllerAdvice(new ProblemAdvice()).build();
    }

    @ParameterizedTest(name = "{0}=a\\u0000")
    @ValueSource(strings = {"job", "provider", "status"})
    void aNulInARunsFilterIsAClientErrorNotA500(String param) throws Exception {
        MvcResult r = mvc.perform(get("/api/v1/ops/runs").param(param, "a\u0000")).andReturn();
        int st = r.getResponse().getStatus();
        assertThat(st).as("/api/v1/ops/runs?%s=a%%00 → %d %s", param, st, r.getResponse().getContentAsString()).isEqualTo(400);
    }
}
