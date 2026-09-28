package dev.wakeline.config;

import org.springframework.http.HttpMethod;
import org.springframework.security.web.servlet.util.matcher.PathPatternRequestMatcher;
import org.springframework.security.web.util.matcher.RequestMatcher;

/**
 * 경로 판단은 한 규칙으로 한다: 인가({@link SecurityConfig})·Spring MVC 와 같은 PathPattern 매칭(퍼센트 디코딩한 경로 조각).
 * {@code getRequestURI()} 는 원문이라 {@code /api/v1/%6Fps/…} 가 {@code /api/v1/ops/} 로 시작하지 않는다 — 그런데 인가와 컨트롤러는 이
 * 요청을 운영 API 로 처리한다. 원문 앞부분으로 판단하던 절대 수명(R-54)·CSRF 면제·요청 제한이 이 요청에서 빠졌다.
 */
public final class ApiPaths {
    private ApiPaths() {}

    private static final PathPatternRequestMatcher.Builder PATHS = PathPatternRequestMatcher.withDefaults();

    /** 공개·운영 REST 전체. */
    public static final RequestMatcher API = PATHS.matcher("/api/**");
    /** 운영 API(ROLE_OPS · 세션 · CSRF). */
    public static final String OPS_PATTERN = "/api/v1/ops/**";
    public static final RequestMatcher OPS = PATHS.matcher(OPS_PATTERN);
    /** 운영 로그인. */
    public static final String OPS_LOGIN_PATH = "/api/v1/ops/session";
    public static final RequestMatcher OPS_LOGIN = PATHS.matcher(HttpMethod.POST, OPS_LOGIN_PATH);
}
