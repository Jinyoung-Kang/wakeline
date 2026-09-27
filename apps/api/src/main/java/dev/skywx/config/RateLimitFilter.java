package dev.skywx.config;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;
import java.nio.charset.StandardCharsets;

/** /api/** 요청을 IP당 분당 N 회로 제한. 초과 시 429 + Retry-After + RFC 9457 본문. */
@org.springframework.context.annotation.Profile("!cli & !migrate")
@Component
@Order(10)
public class RateLimitFilter extends OncePerRequestFilter {
    private final RateLimiter limiter;
    private final AppProperties props;

    public RateLimitFilter(RateLimiter limiter, AppProperties props) {
        this.limiter = limiter;
        this.props = props;
    }

    @Override
    protected boolean shouldNotFilter(HttpServletRequest request) {
        return !request.getRequestURI().startsWith("/api/");
    }

    @Override
    protected void doFilterInternal(HttpServletRequest req, HttpServletResponse res, FilterChain chain)
            throws ServletException, IOException {
        String ip = ClientIp.resolve(req, props.trustedProxy());
        int limit = props.publicRateLimitPerMin();
        long[] r = limiter.hit("api", ip, 60);
        long remaining = Math.max(0, limit - r[0]);
        res.setHeader("X-RateLimit-Limit", String.valueOf(limit));
        res.setHeader("X-RateLimit-Remaining", String.valueOf(remaining));
        res.setHeader("X-RateLimit-Reset", String.valueOf(r[1]));
        if (r[0] > limit) {
            res.setStatus(429);
            res.setHeader("Retry-After", String.valueOf(Math.max(1, r[1])));
            res.setContentType("application/problem+json");
            String body = """
                    {"type":"https://skywx.dev/problems/rate-limited","title":"rate limited","status":429,
                    "detail":"%d requests per minute per IP","instance":"%s","code":"RATE_LIMITED","request_id":"%s"}"""
                    .formatted(limit, req.getRequestURI(), RequestIdFilter.current(req));
            res.getOutputStream().write(body.getBytes(StandardCharsets.UTF_8));
            return;
        }
        chain.doFilter(req, res);
    }
}
