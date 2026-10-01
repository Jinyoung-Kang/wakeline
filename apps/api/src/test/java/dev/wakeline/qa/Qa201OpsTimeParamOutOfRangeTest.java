package dev.wakeline.qa;

import dev.wakeline.DbTestSupport;
import dev.wakeline.history.MaintenanceJobs;
import dev.wakeline.logs.LogReader;
import dev.wakeline.logs.LogsController;
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
import org.junit.jupiter.params.provider.CsvSource;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;

/**
 * QA-201(운영 경로 쪽 — 공개 경로는 {@link Qa201TimeParamOutOfRangeTest}): 운영 GET 의 since 가 Instant 끝값이거나 PostgreSQL 범위 밖이면 400 이 아니라
 * 500 INTERNAL + ERROR 스택 로그다.
 * <ul>
 *   <li>/ops/runs since = ±1000000000 년: Sql.ts(OffsetDateTime.ofInstant)가 DateTimeException, +300000 년: DB 'timestamp out of range'.</li>
 *   <li>/ops/logs · /ops/logs/groups since = ±1000000000 년: LogReader.lowerBound 의 toEpochMilli() 가 ArithmeticException(Redis 에 닿기 전).</li>
 * </ul>
 * 격리 스택 A 에서 qa-b 세션으로 같은 요청이 500 이었다(fuzz-20261001T172925Z).
 */
@EnabledIf("dev.wakeline.DbTestSupport#dockerAvailable")
class Qa201OpsTimeParamOutOfRangeTest {
    static MockMvc mvc;

    @BeforeAll
    static void setUp() {
        var ops = new OpsController(mock(StatusService.class), mock(OpsQueries.class), mock(SettingsService.class), mock(AuditService.class),
                mock(MaintenanceJobs.class), DbTestSupport.apiTx(), mock(ProviderSwitchService.class), mock(ResolutionService.class),
                new IngestRunRepository(DbTestSupport.apiClient()));
        var logs = new LogsController(new LogReader(mock(StringRedisTemplate.class)), mock(ResolutionService.class));
        mvc = MockMvcBuilders.standaloneSetup(ops, logs).setControllerAdvice(new ProblemAdvice()).build();
    }

    @ParameterizedTest(name = "{0}?since={1}")
    @CsvSource({
            "/api/v1/ops/runs, +1000000000-12-31T23:59:59Z",
            "/api/v1/ops/runs, -1000000000-01-01T00:00:00Z",
            "/api/v1/ops/runs, +300000-01-01T00:00:00Z",
            "/api/v1/ops/logs, +1000000000-12-31T23:59:59Z",
            "/api/v1/ops/logs, -1000000000-01-01T00:00:00Z",
            "/api/v1/ops/logs/groups, +1000000000-12-31T23:59:59Z",
    })
    void outOfRangeSinceIsAClientErrorNotA500(String path, String since) throws Exception {
        MvcResult r = mvc.perform(get(path).param("since", since)).andReturn();
        int st = r.getResponse().getStatus();
        assertThat(st).as("%s?since=%s → %d %s", path, since, st, r.getResponse().getContentAsString()).isEqualTo(400);
    }
}
