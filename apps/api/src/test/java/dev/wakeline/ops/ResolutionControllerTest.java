package dev.wakeline.ops;

import dev.wakeline.config.ProblemAdvice;
import jakarta.servlet.http.HttpServletRequest;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;
import org.springframework.transaction.support.TransactionTemplate;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicLong;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * /api/v1/ops/resolutions 의 HTTP 모양(계약 v5 §G14) — DB 없이: 201 본문(note 명시적 null) · 감사 행동 이름과 운영자 · 415 · 400 BAD_RESOLUTION ·
 * 404 · 해결 기록을 한 번도 읽지 못했을 때 503(빈 목록으로 "해결 없음" 을 지어내지 않는다) · 마지막 값이면 resolution_state = stale.
 * (세션 · CSRF · 익명 404 는 OpsResolutionsIT — 이 경로는 /api/v1/ops/** 보안 규칙을 그대로 따른다.)
 */
class ResolutionControllerTest {
    static final OpsAuthentication ALICE = new OpsAuthentication(new OpsUserService.User(7, "alice", "OPS"), List.of(new SimpleGrantedAuthority("ROLE_OPS")));

    final ResolutionServiceTest.FakeRepo repo = new ResolutionServiceTest.FakeRepo();
    final AtomicLong nanos = new AtomicLong(1);
    final List<String> audits = new ArrayList<>();
    MockMvc mvc;

    @BeforeEach
    void setUp() {
        var svc = new ResolutionService(repo, new TransactionTemplate(ResolutionServiceTest.NO_TX), () -> ResolutionServiceTest.NOW, nanos::get);
        AuditService audit = new AuditService(null, null, null) {
            @Override
            public void record(HttpServletRequest req, Integer userId, String action, String target, Object before, Object after) {
                audits.add(action + " " + userId + " " + target);
            }
        };
        mvc = MockMvcBuilders.standaloneSetup(new ResolutionController(svc, audit)).setControllerAdvice(new ProblemAdvice()).build();
    }

    @Test
    void createListAndRevoke() throws Exception {
        mvc.perform(post("/api/v1/ops/resolutions").principal(ALICE).contentType("application/json")
                        .content("{\"kind\":\"provider_error\",\"key\":\"awc\",\"upto\":\"2026-09-29T04:00:00Z\"}"))
                .andExpect(status().isCreated()).andExpect(jsonPath("$.id").value(1)).andExpect(jsonPath("$.kind").value("provider_error"))
                .andExpect(jsonPath("$.key").value("awc")).andExpect(jsonPath("$.upto").value("2026-09-29T04:00:00Z"))
                .andExpect(jsonPath("$.resolvedBy").value("alice")).andExpect(jsonPath("$.note").isEmpty())
                .andExpect(content().string(org.hamcrest.Matchers.containsString("\"note\":null")));
        mvc.perform(get("/api/v1/ops/resolutions").principal(ALICE)).andExpect(status().isOk())
                .andExpect(jsonPath("$.items.length()").value(1)).andExpect(jsonPath("$.items[0].id").value(1))
                .andExpect(jsonPath("$.resolution_state").value("ok"));
        mvc.perform(delete("/api/v1/ops/resolutions/1").principal(ALICE)).andExpect(status().isNoContent());
        mvc.perform(delete("/api/v1/ops/resolutions/1").principal(ALICE)).andExpect(status().isNotFound())
                .andExpect(jsonPath("$.code").value("NOT_FOUND"));
        assertThat(audits).containsExactly("RESOLVE 7 provider_error:awc", "UNRESOLVE 7 provider_error:awc");
    }

    @Test
    void wrongMediaTypeIs415_andBadBodiesAre400() throws Exception {
        mvc.perform(post("/api/v1/ops/resolutions").principal(ALICE).contentType("text/plain").content("kind=log_group"))
                .andExpect(status().isUnsupportedMediaType());
        mvc.perform(post("/api/v1/ops/resolutions").principal(ALICE).contentType("application/json").content("{\"kind\":\"log_group\",\"key\":\"nope\"}"))
                .andExpect(status().isBadRequest()).andExpect(content().contentTypeCompatibleWith("application/problem+json"))
                .andExpect(jsonPath("$.code").value("BAD_RESOLUTION"));
        mvc.perform(post("/api/v1/ops/resolutions").principal(ALICE).contentType("application/json"))
                .andExpect(status().isBadRequest()).andExpect(jsonPath("$.code").value("BAD_RESOLUTION"));
        assertThat(audits).isEmpty();
        assertThat(repo.rows).isEmpty();
    }

    @Test
    void theListIs503WhenResolutionsWereNeverReadable_andStaleWhenTheLastSnapshotIsServed() throws Exception {
        repo.fail = true;
        mvc.perform(get("/api/v1/ops/resolutions").principal(ALICE)).andExpect(status().isServiceUnavailable())
                .andExpect(header().string("Retry-After", "30")).andExpect(jsonPath("$.code").value("UNAVAILABLE")); // 다시 읽는 간격(30 s) — 10 s 뒤 재시도는 같은 503
        repo.fail = false;
        repo.insert("log_group", "0123456789abcdef", Instant.parse("2026-09-29T04:00:00Z"), "bob", "x");
        nanos.addAndGet(31_000_000_000L);
        mvc.perform(get("/api/v1/ops/resolutions").principal(ALICE)).andExpect(jsonPath("$.resolution_state").value("ok"));
        repo.fail = true;
        nanos.addAndGet(6_000_000_000L);
        mvc.perform(get("/api/v1/ops/resolutions").principal(ALICE)).andExpect(status().isOk())
                .andExpect(jsonPath("$.items[0].resolvedBy").value("bob")).andExpect(jsonPath("$.resolution_state").value("stale"));
    }
}
