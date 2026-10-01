package dev.wakeline.ops;

import dev.wakeline.config.AppProperties;
import dev.wakeline.config.ProblemAdvice;
import dev.wakeline.config.RateLimiter;
import jakarta.servlet.http.HttpServletRequest;
import org.junit.jupiter.api.Test;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import org.springframework.dao.DataAccessResourceFailureException;
import org.springframework.data.redis.RedisConnectionFailureException;
import org.springframework.mock.web.MockHttpSession;
import org.springframework.security.authentication.TestingAuthenticationToken;
import org.springframework.test.web.servlet.MvcResult;
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
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/** 로그인: 요청 제한은 실패 시 닫힘(Redis 장애 → 503, 비밀번호 검사도 하지 않음), 실패·잠금은 감사 기록(SEC-6). */
class OpsSessionControllerTest {
    static final AppProperties PROPS = new AppProperties("", "36.5,127.8", 250, 120, 200, 5, 10, 30, 2500, 0, "classpath:schemas", 72, 30,
            120, List.of("http://localhost:8700"));
    static final String BODY = "{\"username\":\"admin\",\"password\":\"not-the-password\"}";

    final List<String> audited = new ArrayList<>();
    final SimpleMeterRegistry meters = new SimpleMeterRegistry();
    int authCalls;
    /** true 면 감사 기록이 DB 장애로 실패한다. */
    boolean auditDown;
    /** 세션 목록(R-95) 호출 기록 "userId:sessionId" — registryDown 이면 로그아웃 정리가 Redis 장애로 실패한다. */
    final List<String> registered = new ArrayList<>();
    final List<String> unregistered = new ArrayList<>();
    boolean registryDown;

    MockMvc mvc(Supplier<long[]> limiterResult, OpsUserService.AuthResult auth) {
        RateLimiter limiter = new RateLimiter(new StringRedisTemplate(), meters) {
            @Override public long[] hitStrict(String bucket, String ip, int windowS) { return limiterResult.get(); }
        };
        OpsUserService users = new OpsUserService(null, null) {
            @Override public AuthResult authenticate(String username, String password) { authCalls++; return auth; }
        };
        AuditService audit = new AuditService(null, null, PROPS) {
            @Override public void record(HttpServletRequest req, Integer userId, String action, String target, Object before, Object after) {
                if (auditDown) throw new DataAccessResourceFailureException("db down");
                audited.add(action + ":" + target);
            }
        };
        OpsSessionRegistry registry = new OpsSessionRegistry(null, "wakeline:session", java.time.Duration.ofHours(8)) {
            @Override public void register(int userId, String sessionId) { registered.add(userId + ":" + sessionId); }
            @Override public void unregister(int userId, String sessionId) {
                if (registryDown) throw new org.springframework.data.redis.RedisConnectionFailureException("down");
                unregistered.add(userId + ":" + sessionId);
            }
        };
        var controller = new OpsSessionController(users, new HttpSessionSecurityContextRepository(), audit, limiter, PROPS, meters, registry,
                org.springframework.security.web.csrf.CookieCsrfTokenRepository.withHttpOnlyFalse());
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

    /** R-55: 없는 계정이면 입력한 아이디 원문 대신 'unknown account'. 잠긴 계정은 있는 계정이라 이름을 남긴다. */
    @Test
    void unknownAccountFailureDoesNotRecordTheTypedName() throws Exception {
        mvc(() -> new long[]{1, 60}, OpsUserService.AuthResult.fail(OpsUserService.Failure.UNKNOWN_USER, false))
                .perform(post("/api/v1/ops/session").contentType(MediaType.APPLICATION_JSON).content(BODY))
                .andExpect(status().isUnauthorized());
        mvc(() -> new long[]{1, 60}, OpsUserService.AuthResult.fail(OpsUserService.Failure.LOCKED, false))
                .perform(post("/api/v1/ops/session").contentType(MediaType.APPLICATION_JSON).content(BODY))
                .andExpect(status().isUnauthorized());
        assertThat(audited).containsExactly("LOGIN_FAILED:unknown account", "LOGIN_FAILED:admin");
    }

    @Test
    void successfulLoginIsAudited() throws Exception {
        mvc(() -> new long[]{1, 60}, OpsUserService.AuthResult.ok(new OpsUserService.User(1, "admin", "OPS"), "tag-1"))
                .perform(post("/api/v1/ops/session").contentType(MediaType.APPLICATION_JSON).content(BODY))
                .andExpect(status().isOk());
        assertThat(audited).containsExactly("LOGIN:admin");
        assertThat(Optional.of(authCalls)).contains(1);
    }

    /** API-CONC-6: LOGIN 감사 기록이 실패하면 세션·보안 컨텍스트를 만들지 않는다(감사 기록 없는 인증 세션 금지). */
    @Test
    void loginAuditFailureCreatesNoSession() throws Exception {
        auditDown = true;
        MvcResult r = mvc(() -> new long[]{1, 60}, OpsUserService.AuthResult.ok(new OpsUserService.User(1, "admin", "OPS"), "tag-1"))
                .perform(post("/api/v1/ops/session").contentType(MediaType.APPLICATION_JSON).content(BODY))
                .andExpect(status().isServiceUnavailable()).andReturn();
        assertThat(r.getRequest().getSession(false)).as("no session on audit failure").isNull();
        assertThat(r.getResponse().getHeader("Set-Cookie")).isNull();
    }

    @Test
    void successfulLoginCreatesTheSessionAfterTheAuditRow() throws Exception {
        MvcResult r = mvc(() -> new long[]{1, 60}, OpsUserService.AuthResult.ok(new OpsUserService.User(7, "admin", "OPS"), "tag-7"))
                .perform(post("/api/v1/ops/session").contentType(MediaType.APPLICATION_JSON).content(BODY))
                .andExpect(status().isOk()).andReturn();
        assertThat(audited).containsExactly("LOGIN:admin");
        assertThat(r.getRequest().getSession(false)).isNotNull();
        assertThat(r.getRequest().getSession(false).getAttribute(dev.wakeline.config.OpsSessionLifetimeFilter.USER_ID)).isEqualTo(7);
        // R-95 후속: 세션은 로그인 때 확인한 자격 표식에 묶인다
        assertThat(r.getRequest().getSession(false).getAttribute(dev.wakeline.config.OpsSessionLifetimeFilter.CREDENTIAL)).isEqualTo("tag-7");
        // R-95: 최종 세션 id(교체 뒤)를 사용자 목록에 올린다
        assertThat(registered).containsExactly("7:" + r.getRequest().getSession(false).getId());
    }

    /** R-95: 로그아웃은 목록에서 빼고, 목록 정리가 실패해도(Redis 장애) 세션은 끝낸다. */
    @Test
    void logoutRemovesTheSessionFromTheUserListAndStillEndsItWhenThatFails() throws Exception {
        var auth = new OpsAuthentication(new OpsUserService.User(7, "admin", "OPS"), List.of());
        MockHttpSession session = new MockHttpSession();
        mvc(() -> new long[]{1, 60}, OpsUserService.AuthResult.fail(OpsUserService.Failure.BAD_PASSWORD, false))
                .perform(delete("/api/v1/ops/session").session(session).principal(auth))
                .andExpect(status().isNoContent());
        assertThat(unregistered).containsExactly("7:" + session.getId());
        registryDown = true;
        MockHttpSession second = new MockHttpSession();
        mvc(() -> new long[]{1, 60}, OpsUserService.AuthResult.fail(OpsUserService.Failure.BAD_PASSWORD, false))
                .perform(delete("/api/v1/ops/session").session(second).principal(auth))
                .andExpect(status().isNoContent());
        assertThat(second.isInvalid()).isTrue();
    }

    /** 로그아웃은 감사 기록이 실패해도 세션을 끝내고 204 — 실패는 지표로 센다. */
    @Test
    void logoutInvalidatesTheSessionEvenWhenTheAuditFails() throws Exception {
        auditDown = true;
        MockHttpSession session = new MockHttpSession();
        mvc(() -> new long[]{1, 60}, OpsUserService.AuthResult.fail(OpsUserService.Failure.BAD_PASSWORD, false))
                .perform(delete("/api/v1/ops/session").session(session).principal(new TestingAuthenticationToken("admin", "")))
                .andExpect(status().isNoContent());
        assertThat(session.isInvalid()).isTrue();
        assertThat(meters.counter("wakeline_audit_failures_total", "action", "LOGOUT").count()).isEqualTo(1.0);
    }

    @Test
    void logoutIsAudited() throws Exception {
        MockHttpSession session = new MockHttpSession();
        mvc(() -> new long[]{1, 60}, OpsUserService.AuthResult.fail(OpsUserService.Failure.BAD_PASSWORD, false))
                .perform(delete("/api/v1/ops/session").session(session).principal(new TestingAuthenticationToken("admin", "")))
                .andExpect(status().isNoContent());
        assertThat(audited).containsExactly("LOGOUT:admin");
        assertThat(session.isInvalid()).isTrue();
    }
}
