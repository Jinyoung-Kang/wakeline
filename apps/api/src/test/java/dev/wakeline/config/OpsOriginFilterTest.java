package dev.wakeline.config;

import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockFilterChain;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;

import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

/** 운영 변경 요청의 출처 검사(리뷰 cto-2026-10 S1) — 실제 보안 체인 · 세션 경로는 SecurityIT. */
class OpsOriginFilterTest {
    final OpsOriginFilter filter = new OpsOriginFilter(List.of("http://localhost:8700", "http://127.0.0.1:8700"));

    /** @return 다음 필터로 넘겼으면 0, 아니면 응답 상태 */
    int run(String method, String uri, String origin, String site) throws Exception {
        MockHttpServletRequest req = new MockHttpServletRequest(method, uri);
        req.setRequestURI(uri);
        if (origin != null) req.addHeader("Origin", origin);
        if (site != null) req.addHeader("Sec-Fetch-Site", site);
        MockHttpServletResponse res = new MockHttpServletResponse();
        MockFilterChain chain = new MockFilterChain();
        filter.doFilter(req, res, chain);
        if (chain.getRequest() != null) return 0;
        assertThat(res.getContentType()).startsWith("application/problem+json");
        assertThat(res.getContentAsString()).contains("\"code\":\"ORIGIN_NOT_ALLOWED\"");
        return res.getStatus();
    }

    @Test
    void unsafeOpsRequestsNeedAnAllowedOriginAndASameOriginFetch() throws Exception {
        String ops = "/api/v1/ops/providers/opensky/disable";
        assertThat(run("POST", ops, null, null)).as("no browser headers — not a browser").isZero();
        assertThat(run("POST", ops, "http://localhost:8700", "same-origin")).isZero();
        assertThat(run("POST", ops, "http://127.0.0.1:8700", null)).isZero();
        assertThat(run("PUT", ops, null, "same-origin")).isZero();
        assertThat(run("POST", ops, "http://localhost:9999", null)).isEqualTo(403);
        assertThat(run("POST", ops, "null", null)).isEqualTo(403);
        assertThat(run("DELETE", ops, null, "same-site")).isEqualTo(403);
        assertThat(run("PUT", ops, "http://localhost:8700", "cross-site")).isEqualTo(403);
        assertThat(run("POST", ops, null, "none")).isEqualTo(403);
        assertThat(run("POST", "/api/v1/%6Fps/providers/opensky/disable", "http://localhost:9999", null)).as("decoded path, like authorization").isEqualTo(403);
    }

    @Test
    void safeMethodsAndPublicPathsAreNotChecked() throws Exception {
        for (String m : List.of("GET", "HEAD", "OPTIONS", "TRACE"))
            assertThat(run(m, "/api/v1/ops/providers", "http://localhost:9999", "cross-site")).as(m).isZero();
        assertThat(run("POST", "/api/v1/client-errors", "http://localhost:9999", "cross-site")).as("public write — no session cookie").isZero();
    }
}
