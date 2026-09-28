package dev.wakeline.config;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import jakarta.servlet.http.HttpSession;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;
import java.time.Clock;
import java.time.Duration;

/**
 * 운영 세션의 절대 수명(R-54, ADR-017 §3). Spring Session 의 timeout 은 유휴 기준이라 요청마다 연장된다 — /ops 탭의 15 s 폴링이 세션을
 * 무기한 살려 두었다. 여기서는 로그인 시각({@link #AUTH_AT}, 없으면 세션 생성 시각)부터 {@code maxAge} 가 지난 세션을 요청이 와도 끝낸다.
 * <p>
 * 보안 필터 체인에서 SecurityContextHolderFilter 앞에 둔다: 세션을 먼저 무효화하므로(Redis 에서 삭제) 그 요청은 보안 컨텍스트 없이
 * 익명으로 처리되고 /api/v1/ops/** 는 404(존재 비공개)가 된다. 로그인(POST /api/v1/ops/session)도 같다 — 만료된 세션은 지우고 새로 로그인한다.
 * 컴포넌트로 등록하지 않는다(서블릿 필터로 한 번 더 걸리지 않게) — {@link SecurityConfig} 가 만든다.
 */
public class OpsSessionLifetimeFilter extends OncePerRequestFilter {
    /** 로그인 시각(epoch ms, Long) 세션 속성. 세션 역직렬화 허용 목록(java.lang.Long)에 이미 있다. */
    public static final String AUTH_AT = "ops_auth_at";
    static final String OPS_PREFIX = "/api/v1/ops/";

    private final long maxAgeMs;
    private final Clock clock;

    public OpsSessionLifetimeFilter(Duration maxAge, Clock clock) {
        if (maxAge.isNegative() || maxAge.isZero()) throw new IllegalArgumentException("ops session max age must be positive: " + maxAge);
        this.maxAgeMs = maxAge.toMillis();
        this.clock = clock;
    }

    @Override
    protected boolean shouldNotFilter(HttpServletRequest request) {
        return !request.getRequestURI().startsWith(OPS_PREFIX);
    }

    @Override
    protected void doFilterInternal(HttpServletRequest req, HttpServletResponse res, FilterChain chain) throws ServletException, IOException {
        HttpSession s = req.getSession(false);
        if (s != null && expired(s, clock.millis())) s.invalidate();
        chain.doFilter(req, res);
    }

    /** 로그인(또는 속성이 없으면 세션 생성)으로부터 maxAge 이상 지났는가. */
    boolean expired(HttpSession s, long nowMs) {
        Object at = s.getAttribute(AUTH_AT);
        long since = at instanceof Long l ? l : s.getCreationTime();
        return nowMs - since >= maxAgeMs;
    }
}
