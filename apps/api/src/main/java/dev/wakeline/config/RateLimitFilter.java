package dev.wakeline.config;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;

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
        return !ApiPaths.API.matches(request); // 컨트롤러와 같은 규칙(디코딩한 경로) — 원문 앞부분이면 /%61pi/… 가 제한을 건너뛴다
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
            res.setHeader("Retry-After", String.valueOf(Math.max(1, r[1])));
            // 다른 필터 · 밸브의 오류 본문과 같은 모양 · 같은 이스케이프(리뷰 cto-2026-10 I-2 — 예전에는 경로를 이스케이프하지 않고 이어 붙였다)
            ProblemJson.write(res, req, 429, "RATE_LIMITED", "rate limited", limit + " requests per minute per IP");
            return;
        }
        chain.doFilter(req, res);
    }
}
