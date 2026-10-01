package dev.wakeline.ops;

import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockFilterChain;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.mock.web.MockHttpSession;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneOffset;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** R-54 절대 수명 필터: 로그인 시각(없으면 세션 생성 시각) 기준, /api/v1/ops/** 에만, 경계값 포함. 실제 Redis 세션 경로는 SecurityIT. */
class OpsSessionLifetimeFilterTest {
    static final Instant NOW = Instant.parse("2026-09-28T12:00:00Z");
    static final OpsSessionLifetimeFilter FILTER = new OpsSessionLifetimeFilter(Duration.ofHours(8), Clock.fixed(NOW, ZoneOffset.UTC));

    static MockHttpServletRequest request(String uri, MockHttpSession session) {
        MockHttpServletRequest r = new MockHttpServletRequest("GET", uri);
        r.setRequestURI(uri);
        if (session != null) r.setSession(session);
        return r;
    }

    static MockHttpSession sessionLoggedInAgo(Duration ago) {
        MockHttpSession s = new MockHttpSession();
        s.setAttribute(OpsSessionLifetimeFilter.AUTH_AT, NOW.minus(ago).toEpochMilli());
        return s;
    }

    @Test
    void sessionOlderThanMaxAgeIsInvalidatedAndTheRequestContinuesAnonymously() throws Exception {
        MockHttpSession s = sessionLoggedInAgo(Duration.ofHours(8));
        MockFilterChain chain = new MockFilterChain();
        FILTER.doFilter(request("/api/v1/ops/providers", s), new MockHttpServletResponse(), chain);
        assertThat(s.isInvalid()).isTrue();
        assertThat(chain.getRequest()).as("the chain still runs (security answers 404)").isNotNull();
    }

    @Test
    void youngerSessionIsKept() throws Exception {
        MockHttpSession s = sessionLoggedInAgo(Duration.ofHours(8).minusMillis(1));
        FILTER.doFilter(request("/api/v1/ops/providers", s), new MockHttpServletResponse(), new MockFilterChain());
        assertThat(s.isInvalid()).isFalse();
    }

    @Test
    void withoutLoginTimeTheCreationTimeCounts() {
        MockHttpSession s = new MockHttpSession(); // 생성 시각 = 지금(실제 시계) — 고정 시계보다 한참 뒤
        assertThat(FILTER.expired(s, s.getCreationTime() + Duration.ofHours(8).toMillis())).isTrue();
        assertThat(FILTER.expired(s, s.getCreationTime() + Duration.ofHours(7).toMillis())).isFalse();
        s.setAttribute(OpsSessionLifetimeFilter.AUTH_AT, "not-a-long"); // 형식이 다르면 생성 시각
        assertThat(FILTER.expired(s, s.getCreationTime() + Duration.ofHours(8).toMillis())).isTrue();
    }

    @Test
    void onlyOpsPathsAreChecked() throws Exception {
        MockHttpSession s = sessionLoggedInAgo(Duration.ofDays(3));
        FILTER.doFilter(request("/api/v1/status", s), new MockHttpServletResponse(), new MockFilterChain());
        assertThat(s.isInvalid()).isFalse();
        // 세션 없는 요청(로그인 전)은 그대로 지나간다
        MockFilterChain chain = new MockFilterChain();
        FILTER.doFilter(request("/api/v1/ops/session", null), new MockHttpServletResponse(), chain);
        assertThat(chain.getRequest()).isNotNull();
    }

    /**
     * 보안 규칙(/api/v1/ops/**)은 디코딩한 경로로 맞추므로 %6Fps(= ops) 는 운영 경로로 인가된다. 이 필터가 원문 URI 앞부분만 보면 같은 요청에서
     * 수명 검사를 건너뛴다(R-54 후속) — 인가와 같은 규칙으로 판단해야 한다.
     */
    @Test
    void percentEncodedOpsPathIsCheckedLikeTheAuthorizationRule() throws Exception {
        for (String uri : new String[] {"/api/v1/%6Fps/providers", "/api/v1/o%70s/settings", "/api/v%31/ops/audit"}) {
            MockHttpSession s = sessionLoggedInAgo(Duration.ofHours(9));
            FILTER.doFilter(request(uri, s), new MockHttpServletResponse(), new MockFilterChain());
            assertThat(s.isInvalid()).as(uri).isTrue();
        }
    }

    /** R-95 후속: 자격 표식이 지금 값과 다르거나 없거나 사용자가 없으면 끝낸다. DB 를 읽지 못하면 세션은 두고 503. */
    @Test
    void sessionIsBoundToTheCredentialItWasCreatedWith() throws Exception {
        java.util.Map<Integer, String> current = new java.util.HashMap<>(java.util.Map.of(7, "tag-new"));
        OpsSessionLifetimeFilter f = new OpsSessionLifetimeFilter(Duration.ofHours(8), Clock.fixed(NOW, ZoneOffset.UTC),
                uid -> java.util.Optional.ofNullable(current.get(uid)));
        java.util.function.BiFunction<Integer, String, MockHttpSession> session = (uid, tag) -> {
            MockHttpSession s = sessionLoggedInAgo(Duration.ofMinutes(5));
            s.setAttribute(OpsSessionLifetimeFilter.USER_ID, uid);
            if (tag != null) s.setAttribute(OpsSessionLifetimeFilter.CREDENTIAL, tag);
            return s;
        };
        MockHttpSession same = session.apply(7, "tag-new"), changed = session.apply(7, "tag-old"), none = session.apply(7, null), gone = session.apply(8, "tag-x");
        for (MockHttpSession s : new MockHttpSession[] {same, changed, none, gone})
            f.doFilter(request("/api/v1/ops/providers", s), new MockHttpServletResponse(), new MockFilterChain());
        assertThat(same.isInvalid()).isFalse();
        assertThat(changed.isInvalid()).as("password changed").isTrue();
        assertThat(none.isInvalid()).as("session without a credential tag").isTrue();
        assertThat(gone.isInvalid()).as("user deleted").isTrue();

        OpsSessionLifetimeFilter down = new OpsSessionLifetimeFilter(Duration.ofHours(8), Clock.fixed(NOW, ZoneOffset.UTC),
                uid -> { throw new IllegalStateException("db down"); });
        MockHttpSession kept = session.apply(7, "tag-new");
        MockHttpServletResponse res = new MockHttpServletResponse();
        MockFilterChain chain = new MockFilterChain();
        down.doFilter(request("/api/v1/ops/providers", kept), res, chain);
        assertThat(res.getStatus()).isEqualTo(503);
        assertThat(res.getHeader("Retry-After")).as("QA-101: contract §2 default").isEqualTo("10");
        MockHttpServletResponse list = new MockHttpServletResponse();
        down.doFilter(request("/api/v1/ops/resolutions", kept), list, new MockFilterChain());
        assertThat(list.getHeader("Retry-After")).as("QA-101: §G14 — the resolution read interval").isEqualTo("30");
        MockHttpServletRequest revoke = request("/api/v1/ops/resolutions/12", kept);
        revoke.setMethod("DELETE");
        MockHttpServletResponse write = new MockHttpServletResponse();
        down.doFilter(revoke, write, new MockFilterChain());
        assertThat(write.getHeader("Retry-After")).isEqualTo("10");
        assertThat(chain.getRequest()).as("not passed on unverified").isNull();
        assertThat(kept.isInvalid()).as("unknown is not a logout").isFalse();
    }

    /**
     * 리뷰 cto-2026-10 S3(B4): 로그아웃은 권한을 줄이는 요청이다 — 자격 확인(DB)을 하지 않는다. 예전에는 DB 장애 중 로그아웃이 503 으로 막혀 세션이 계속
     * 유효했다(OpsSessionController: 로그아웃은 실패하지 않게). 절대 수명은 그대로 본다(지난 세션은 끝내고 익명으로 — 컨트롤러가 204).
     */
    @Test
    void logoutReachesTheControllerWhenTheCredentialLookupFails() throws Exception {
        OpsSessionLifetimeFilter down = new OpsSessionLifetimeFilter(Duration.ofHours(8), Clock.fixed(NOW, ZoneOffset.UTC),
                uid -> { throw new IllegalStateException("db down"); });
        MockHttpSession s = sessionLoggedInAgo(Duration.ofMinutes(5));
        s.setAttribute(OpsSessionLifetimeFilter.USER_ID, 7);
        s.setAttribute(OpsSessionLifetimeFilter.CREDENTIAL, "tag");
        MockHttpServletRequest logout = request("/api/v1/ops/session", s);
        logout.setMethod("DELETE");
        MockHttpServletResponse res = new MockHttpServletResponse();
        MockFilterChain chain = new MockFilterChain();
        down.doFilter(logout, res, chain);
        assertThat(res.getStatus()).as("not 503").isEqualTo(200);
        assertThat(chain.getRequest()).as("the controller invalidates the session").isNotNull();
        assertThat(s.isInvalid()).isFalse();
        // 다른 운영 요청은 그대로 503(모름 — 끝내지도 통과시키지도 않는다), 지난 세션의 로그아웃은 수명 검사가 끝낸다
        MockHttpServletResponse other = new MockHttpServletResponse();
        down.doFilter(request("/api/v1/ops/session", s), other, new MockFilterChain());
        assertThat(other.getStatus()).isEqualTo(503);
        MockHttpSession old = sessionLoggedInAgo(Duration.ofHours(9));
        old.setAttribute(OpsSessionLifetimeFilter.USER_ID, 7);
        MockHttpServletRequest lateLogout = request("/api/v1/ops/session", old);
        lateLogout.setMethod("DELETE");
        down.doFilter(lateLogout, new MockHttpServletResponse(), new MockFilterChain());
        assertThat(old.isInvalid()).isTrue();
    }

    /** QA-102: 세션 저장소(Redis)를 읽지 못하면 운영 요청은 503 + Retry-After 10 — 넘기지 않는다(예전: 예외가 필터 밖으로 나가 500). */
    @Test
    void anOpsRequestWhoseSessionCannotBeReadIs503WithRetryAfter() throws Exception {
        for (RuntimeException down : new RuntimeException[] {new org.springframework.data.redis.RedisSystemException("Redis exception",
                new IllegalStateException("Currently not connected")), new org.springframework.dao.QueryTimeoutException("Redis command timed out")}) {
            MockHttpServletRequest req = new MockHttpServletRequest("GET", "/api/v1/ops/settings") {
                @Override public jakarta.servlet.http.HttpSession getSession(boolean create) { throw down; }
            };
            req.setRequestURI("/api/v1/ops/settings");
            MockHttpServletResponse res = new MockHttpServletResponse();
            MockFilterChain chain = new MockFilterChain();
            FILTER.doFilter(req, res, chain);
            assertThat(res.getStatus()).isEqualTo(503);
            assertThat(res.getHeader("Retry-After")).isEqualTo("10");
            assertThat(res.getContentType()).isEqualTo("application/problem+json");
            assertThat(res.getContentAsString()).contains("\"code\":\"UNAVAILABLE\"");
            assertThat(chain.getRequest()).as("not passed on").isNull();
        }
    }

    @Test
    void maxAgeMustBePositive() {
        assertThatThrownBy(() -> new OpsSessionLifetimeFilter(Duration.ZERO, Clock.systemUTC())).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new OpsSessionLifetimeFilter(Duration.ofHours(-1), Clock.systemUTC())).isInstanceOf(IllegalArgumentException.class);
    }
}
