package dev.wakeline.config;

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

    @Test
    void maxAgeMustBePositive() {
        assertThatThrownBy(() -> new OpsSessionLifetimeFilter(Duration.ZERO, Clock.systemUTC())).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new OpsSessionLifetimeFilter(Duration.ofHours(-1), Clock.systemUTC())).isInstanceOf(IllegalArgumentException.class);
    }
}
