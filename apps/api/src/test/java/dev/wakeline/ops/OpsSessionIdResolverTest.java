package dev.wakeline.ops;

import jakarta.servlet.http.Cookie;
import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.session.web.http.CookieHttpSessionIdResolver;
import org.springframework.session.web.http.DefaultCookieSerializer;

import static org.assertj.core.api.Assertions.assertThat;

/** QA-102: 세션 쿠키(Path=/api)는 운영 경로에서만 세션 id 로 읽는다 — 공개 경로는 세션 저장소(Redis)에 닿지 않는다. 쿠키 쓰기 · 지우기는 그대로. */
class OpsSessionIdResolverTest {
    final OpsSessionIdResolver resolver;

    OpsSessionIdResolverTest() {
        DefaultCookieSerializer serializer = new DefaultCookieSerializer();
        serializer.setCookieName(SecurityConfig.SESSION_COOKIE);
        serializer.setCookiePath(SecurityConfig.SESSION_COOKIE_PATH);
        serializer.setUseBase64Encoding(false);
        CookieHttpSessionIdResolver cookies = new CookieHttpSessionIdResolver();
        cookies.setCookieSerializer(serializer);
        resolver = new OpsSessionIdResolver(cookies);
    }

    static MockHttpServletRequest withCookie(String uri) {
        MockHttpServletRequest r = new MockHttpServletRequest("GET", uri);
        r.setRequestURI(uri);
        r.setCookies(new Cookie(SecurityConfig.SESSION_COOKIE, "sid-1"));
        return r;
    }

    @Test
    void onlyOpsPathsResolveTheSessionCookie() {
        assertThat(resolver.resolveSessionIds(withCookie("/api/v1/ops/settings"))).containsExactly("sid-1");
        assertThat(resolver.resolveSessionIds(withCookie("/api/v1/%6Fps/settings"))).as("same matcher as the authorization rule").containsExactly("sid-1");
        assertThat(resolver.resolveSessionIds(withCookie("/api/v1/status"))).isEmpty();
        assertThat(resolver.resolveSessionIds(withCookie("/api/v1/aircraft"))).isEmpty();
    }

    @Test
    void writingAndExpiringTheCookieIsUnchanged() {
        MockHttpServletRequest req = withCookie("/api/v1/ops/session");
        MockHttpServletResponse res = new MockHttpServletResponse();
        resolver.setSessionId(req, res, "sid-2");
        assertThat(res.getHeader("Set-Cookie")).startsWith(SecurityConfig.SESSION_COOKIE + "=sid-2").contains("Path=/api");
        MockHttpServletResponse expired = new MockHttpServletResponse();
        resolver.expireSession(req, expired);
        assertThat(expired.getHeader("Set-Cookie")).startsWith(SecurityConfig.SESSION_COOKIE + "=;").contains("Max-Age=0");
    }
}
