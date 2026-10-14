package dev.wakeline.platform.web;

import dev.wakeline.platform.config.AppProperties;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.boot.security.autoconfigure.web.servlet.SecurityFilterProperties;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;

/**
 * /api/** 요청을 IP당 분당 N 회로 제한. 초과 시 429 + Retry-After + RFC 9457 본문.
 * <p>보안 필터 체인(Spring Security — 서블릿 필터 순서 {@link SecurityFilterProperties#DEFAULT_FILTER_ORDER})보다 앞에서 돈다(QA-1100): 예전 순서(10)는
 * 체인 뒤라, 체인이 끝낸 요청 — 익명 운영 요청의 404(존재 비공개) · CSRF 403 · 허용 목록 밖 Origin 403 · 방화벽 400 · 세션 저장소 503 — 이 제한에 세지지
 * 않았다(몇 번이든 429 가 되지 않고 X-RateLimit-* 도 없었다). 요청 id({@link RequestIdFilter} — 가장 앞)는 그대로 먼저 붙는다. 이 필터가 쓴 429 는
 * 보안 체인 밖의 응답이라 방화벽 400 처럼 체인의 헤더(CSP · Cache-Control)가 붙지 않는다(edge 의 보안 헤더는 그대로).
 */
@org.springframework.context.annotation.Profile("!cli & !migrate")
@Component
@Order(RateLimitFilter.ORDER)
public class RateLimitFilter extends OncePerRequestFilter {
    /** 보안 필터 체인 바로 앞. */
    public static final int ORDER = SecurityFilterProperties.DEFAULT_FILTER_ORDER - 1;

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
