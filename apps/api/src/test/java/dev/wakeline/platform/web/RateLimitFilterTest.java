package dev.wakeline.platform.web;

import dev.wakeline.platform.config.AppProperties;
import org.junit.jupiter.api.Test;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.mock.web.MockFilterChain;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

/** 공개 API 요청 제한(2차): 넘으면 429 + Retry-After + RFC 9457 본문. */
class RateLimitFilterTest {
    static final AppProperties PROPS = new AppProperties("", "36.5,127.8", 250, 120, 200, 5, 10, 30, 2500, 0, "classpath:schemas", 72, 30, 120,
            List.of("http://localhost:8700"), List.of());

    /**
     * 리뷰 cto-2026-10 I-2: 429 본문을 손으로 이어 붙였다 — 요청 경로(instance)를 JSON 문자열로 이스케이프하지 않았다. Tomcat 이 원문 '"' · '\\' 를
     * 받지 않아 지금은 닿지 않지만, 다른 오류 본문과 같은 ProblemJson 으로 만든다(같은 모양 · 이스케이프).
     */
    @Test
    void the429BodyIsProblemJsonWithTheRequestPathEscaped() throws Exception {
        RateLimiter over = new RateLimiter(new StringRedisTemplate(), RateLimiterTest.breaker(), new io.micrometer.core.instrument.simple.SimpleMeterRegistry()) {
            @Override public long[] hit(String bucket, String ip, int windowS) { return new long[]{121, 42}; }
        };
        String path = "/api/v1/aircraft/\"x\\y";
        MockHttpServletRequest req = new MockHttpServletRequest("GET", path);
        req.setRequestURI(path);
        MockHttpServletResponse res = new MockHttpServletResponse();
        MockFilterChain chain = new MockFilterChain();
        new RateLimitFilter(over, PROPS).doFilter(req, res, chain);
        assertThat(chain.getRequest()).as("not passed on").isNull();
        assertThat(res.getStatus()).isEqualTo(429);
        assertThat(res.getHeader("Retry-After")).isEqualTo("42");
        assertThat(res.getHeader("X-RateLimit-Remaining")).isEqualTo("0");
        assertThat(res.getContentType()).startsWith("application/problem+json");
        JsonNode p = JsonMapper.builder().build().readTree(res.getContentAsString());
        assertThat(p.path("type").asString()).isEqualTo("https://wakeline.invalid/problems/rate-limited");
        assertThat(p.path("title").asString()).isEqualTo("rate limited");
        assertThat(p.path("status").asInt()).isEqualTo(429);
        assertThat(p.path("detail").asString()).isEqualTo("120 requests per minute per IP");
        assertThat(p.path("instance").asString()).isEqualTo(path);
        assertThat(p.path("code").asString()).isEqualTo("RATE_LIMITED");
        assertThat(p.has("request_id")).isTrue();
    }

    @Test
    void underTheLimitThePublicRequestPassesWithItsHeaders() throws Exception {
        RateLimiter under = new RateLimiter(new StringRedisTemplate(), RateLimiterTest.breaker(), new io.micrometer.core.instrument.simple.SimpleMeterRegistry()) {
            @Override public long[] hit(String bucket, String ip, int windowS) { return new long[]{3, 40}; }
        };
        MockHttpServletRequest req = new MockHttpServletRequest("GET", "/api/v1/status");
        req.setRequestURI("/api/v1/status");
        MockHttpServletResponse res = new MockHttpServletResponse();
        MockFilterChain chain = new MockFilterChain();
        new RateLimitFilter(under, PROPS).doFilter(req, res, chain);
        assertThat(chain.getRequest()).isNotNull();
        assertThat(res.getHeader("X-RateLimit-Remaining")).isEqualTo("117");
        assertThat(res.getHeader("X-RateLimit-Reset")).isEqualTo("40");
    }
}
