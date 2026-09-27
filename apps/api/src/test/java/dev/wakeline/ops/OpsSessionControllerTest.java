package dev.wakeline.ops;

import dev.wakeline.config.AppProperties;
import dev.wakeline.config.ProblemAdvice;
import dev.wakeline.config.RateLimiter;
import jakarta.servlet.http.HttpServletRequest;
import org.junit.jupiter.api.Test;
import org.springframework.data.redis.RedisConnectionFailureException;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.http.MediaType;
import org.springframework.security.web.context.HttpSessionSecurityContextRepository;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import java.util.function.Supplier;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/** 로그인: 요청 제한은 실패 시 닫힘(Redis 장애 → 503, 비밀번호 검사도 하지 않음), 실패·잠금은 감사 기록(SEC-6). */
class OpsSessionControllerTest {
    static final AppProperties PROPS = new AppProperties("", "36.5,127.8", 250, 120, 200, 5, 10, 30, 2500, 0, "classpath:schemas", 72, 30,
            120, List.of("http://localhost:8700"));
    static final String BODY = "{\"username\":\"admin\",\"password\":\"not-the-password\"}";

    final List<String> audited = new ArrayList<>();
    int authCalls;

    MockMvc mvc(Supplier<long[]> limiterResult, OpsUserService.AuthResult auth) {
        RateLimiter limiter = new RateLimiter(new StringRedisTemplate()) {
            @Override public long[] hitStrict(String bucket, String ip, int windowS) { return limiterResult.get(); }
        };
        OpsUserService users = new OpsUserService(null) {
            @Override public AuthResult authenticate(String username, String password) { authCalls++; return auth; }
        };
        AuditService audit = new AuditService(null, null, PROPS) {
            @Override public void record(HttpServletRequest req, Integer userId, String action, String target, Object before, Object after) {
                audited.add(action + ":" + target);
            }
        };
        var controller = new OpsSessionController(users, new HttpSessionSecurityContextRepository(), audit, limiter, PROPS);
        return MockMvcBuilders.standaloneSetup(controller).setControllerAdvice(new ProblemAdvice()).build();
    }

    @Test
    void limiterFailsClosedWhenRedisIsDown() throws Exception {
        mvc(() -> { throw new RedisConnectionFailureException("down"); }, OpsUserService.AuthResult.fail(OpsUserService.Failure.BAD_PASSWORD, false))
                .perform(post("/api/v1/ops/session").contentType(MediaType.APPLICATION_JSON).content(BODY))
                .andExpect(status().isServiceUnavailable()).andExpect(header().string("Retry-After", "10"));
        assertThat(authCalls).isZero(); // 제한을 확인하지 못하면 비밀번호 대입을 받지 않는다
    }

    @Test
    void tooManyAttemptsAre429WithRetryAfter() throws Exception {
        mvc(() -> new long[]{11, 42}, OpsUserService.AuthResult.fail(OpsUserService.Failure.BAD_PASSWORD, false))
                .perform(post("/api/v1/ops/session").contentType(MediaType.APPLICATION_JSON).content(BODY))
                .andExpect(status().isTooManyRequests()).andExpect(header().string("Retry-After", "42"));
        assertThat(authCalls).isZero();
    }

    @Test
    void failedAndLockingLoginsAreAudited() throws Exception {
        mvc(() -> new long[]{1, 60}, OpsUserService.AuthResult.fail(OpsUserService.Failure.BAD_PASSWORD, true))
                .perform(post("/api/v1/ops/session").contentType(MediaType.APPLICATION_JSON).content(BODY))
                .andExpect(status().isUnauthorized());
        assertThat(audited).containsExactly("LOGIN_FAILED:admin", "ACCOUNT_LOCKED:admin");
    }

    @Test
    void successfulLoginIsAudited() throws Exception {
        mvc(() -> new long[]{1, 60}, OpsUserService.AuthResult.ok(new OpsUserService.User(1, "admin", "OPS")))
                .perform(post("/api/v1/ops/session").contentType(MediaType.APPLICATION_JSON).content(BODY))
                .andExpect(status().isOk());
        assertThat(audited).containsExactly("LOGIN:admin");
        assertThat(Optional.of(authCalls)).contains(1);
    }
}
