package dev.wakeline.ops;

import dev.wakeline.platform.config.AppProperties;
import dev.wakeline.platform.web.ApiPaths;
import dev.wakeline.platform.web.ProblemErrorReportValve;
import dev.wakeline.platform.web.ProblemJson;
import dev.wakeline.platform.web.RequestIdFilter;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.web.context.DelegatingSecurityContextRepository;
import org.springframework.security.web.context.HttpSessionSecurityContextRepository;
import org.springframework.security.web.context.RequestAttributeSecurityContextRepository;
import org.springframework.security.web.context.SecurityContextHolderFilter;
import org.springframework.security.web.context.SecurityContextRepository;
import org.springframework.security.web.csrf.CookieCsrfTokenRepository;
import org.springframework.security.web.csrf.CsrfException;
import org.springframework.security.web.csrf.CsrfFilter;
import org.springframework.security.web.csrf.CsrfToken;
import org.springframework.security.web.csrf.CsrfTokenRequestHandler;
import org.springframework.security.web.csrf.XorCsrfTokenRequestAttributeHandler;
import org.springframework.security.web.firewall.RequestRejectedHandler;
import org.springframework.session.web.http.CookieHttpSessionIdResolver;
import org.springframework.session.web.http.CookieSerializer;
import org.springframework.session.web.http.DefaultCookieSerializer;
import org.springframework.session.web.http.HttpSessionIdResolver;
import org.springframework.util.StringUtils;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.time.Clock;
import java.time.Duration;
import java.util.function.Supplier;

/**
 * 보안(6.2절 api 층). 공개 경로 허용, /api/v1/ops/** 는 ROLE_OPS + 세션 + CSRF(쿠키 WAKELINE_CSRF → 헤더 X-CSRF-Token — 헤더에서만 받는다).
 * 비인가는 404(존재 여부 비공개), CSRF 실패는 403, 허용 목록 밖 출처의 운영 변경 요청도 403({@link OpsOriginFilter}). 세션 쿠키 WAKELINE_SESSION: HttpOnly · SameSite=Strict.
 * 운영 세션은 유휴 한도와 별개로 로그인부터 절대 수명(wakeline.ops-session-max-age, 8 h)이 지나면 끝난다({@link OpsSessionLifetimeFilter}).
 */
@org.springframework.context.annotation.Profile("!cli & !migrate")  // CLI(ops-user)·마이그레이션 실행에서는 웹·소비자·잡을 띄우지 않는다
@Configuration
public class SecurityConfig {
    private static final Logger log = LoggerFactory.getLogger(SecurityConfig.class);
    public static final String SESSION_COOKIE = "WAKELINE_SESSION";
    public static final String SESSION_COOKIE_PATH = "/api";
    public static final String CSRF_COOKIE = "WAKELINE_CSRF";
    public static final String CSRF_HEADER = "X-CSRF-Token";

    @Bean
    SecurityFilterChain api(HttpSecurity http, SecurityContextRepository contextRepository, CookieCsrfTokenRepository csrfRepository,
                            @Value("${wakeline.ops-session-max-age:8h}") Duration opsSessionMaxAge,
                            dev.wakeline.ops.OpsUserService opsUsers, AppProperties props) throws Exception {
        http
                // 절대 수명(R-54): 보안 컨텍스트를 세션에서 읽기 전에 오래된 운영 세션을 끝낸다 → 익명 → 404
                // 자격 확인(R-95 후속): 비밀번호가 바뀐 뒤의 세션도 같은 자리에서 끝낸다
                .addFilterBefore(new OpsSessionLifetimeFilter(opsSessionMaxAge, Clock.systemUTC(), opsUsers::currentCredentialTag), SecurityContextHolderFilter.class)
                // 출처 검사(S1): 허용 목록 밖 Origin · same-origin 이 아닌 Sec-Fetch-Site 의 운영 변경 요청은 CSRF 검사 전에 403
                .addFilterBefore(new OpsOriginFilter(props.originPatterns()), CsrfFilter.class)
                .authorizeHttpRequests(a -> a
                        .requestMatchers(ApiPaths.OPS_LOGIN).permitAll()
                        .requestMatchers(ApiPaths.OPS).hasRole("OPS")
                        .anyRequest().permitAll())
                // CSRF 는 세션 쿠키로 인증되는 ops 변경 요청에만 적용한다. 공개 API 는 쿠키 인증이 없으므로 대상이 아니다.
                .csrf(c -> c.csrfTokenRepository(csrfRepository).csrfTokenRequestHandler(new HeaderOnlyCsrfTokenRequestHandler())
                        // 경로는 인가와 같은 매처로 판단한다(ApiPaths) — 원문 URI 앞부분이면 /api/v1/%6Fps/… 가 CSRF 없이 운영 변경을 했다
                        .ignoringRequestMatchers(req -> !ApiPaths.OPS.matches(req) || "GET".equals(req.getMethod())
                                || (ApiPaths.OPS_LOGIN.matches(req) && !hasCookie(req, SESSION_COOKIE))))
                .securityContext(s -> s.securityContextRepository(contextRepository))
                .formLogin(f -> f.disable())
                .httpBasic(b -> b.disable())
                .logout(l -> l.disable())
                .requestCache(r -> r.disable())
                .exceptionHandling(e -> e
                        .authenticationEntryPoint((req, res, ex) -> problem(res, req, 404, "NOT_FOUND", "not found", "no such resource"))
                        .accessDeniedHandler((req, res, ex) -> {
                            if (ex instanceof CsrfException) problem(res, req, 403, "CSRF_INVALID", "forbidden", "missing or invalid CSRF token");
                            else problem(res, req, 404, "NOT_FOUND", "not found", "no such resource");
                        }))
                // 보안 헤더는 한 계층에서만(R-84): X-Content-Type-Options · X-Frame-Options · Referrer-Policy · Permissions-Policy 는 edge
                // (infra/edge/security_headers.conf)가 모든 응답 — 웹·api·421·방화벽 거절까지 — 에 붙인다. 여기서도 붙이면 두 번 나가고 한쪽만
                // 바꾸면 값이 충돌한다. api 는 JSON 응답에만 의미 있는 CSP 와 Spring 기본 캐시 헤더만 둔다.
                .headers(h -> h
                        .contentTypeOptions(c -> c.disable())
                        .frameOptions(f -> f.disable())
                        .contentSecurityPolicy(csp -> csp.policyDirectives("default-src 'none'; frame-ancestors 'none'")));
        return http.build();
    }

    /** Tomcat 이 앱에 닿기 전에 거절한 요청(예: %2F)의 본문도 problem+json(R-84) — {@link ProblemErrorReportValve}. */
    @Bean
    static ProblemErrorReportValve.Customizer problemErrorReportValveCustomizer(@Value("${wakeline.trusted-proxy:}") String trustedProxy) {
        return new ProblemErrorReportValve.Customizer(trustedProxy);
    }

    /**
     * Spring 방화벽(StrictHttpFirewall)이 거절한 요청(//·;·/./·인코딩된 . 등)도 RFC 9457 로(R-84). 기본은 예외를 컨테이너로 올려 Boot 기본
     * JSON 오류 본문이 나갔다. 거절 자체는 그대로다(우회 없음). WebSecurity 가 이 빈을 FilterChainProxy 에 건다.
     */
    @Bean
    RequestRejectedHandler requestRejectedHandler() {
        return (req, res, ex) -> {
            log.debug("request rejected by the firewall request_id={}: {}", RequestIdFilter.current(req), ex.getMessage());
            problem(res, req, 400, "BAD_REQUEST", "bad request", "request rejected");
        };
    }

    private static boolean hasCookie(HttpServletRequest req, String name) {
        var cookies = req.getCookies();
        if (cookies == null) return false;
        for (var c : cookies) if (name.equals(c.getName())) return true;
        return false;
    }

    private static void problem(jakarta.servlet.http.HttpServletResponse res, HttpServletRequest req, int status, String code, String title, String detail) throws java.io.IOException {
        ProblemJson.write(res, req, status, code, title, detail);
    }

    /**
     * CSRF 토큰은 X-CSRF-Token 헤더에서만 읽는다(리뷰 cto-2026-10 S1). csrf.spa() 의 처리기는 헤더가 없으면 _csrf 요청 파라미터(쿼리 · 폼 본문)로도
     * 받았다 — 쿠키는 포트를 가리지 않아 다른 localhost 포트의 페이지가 쿠키 값으로 사전 요청 없는 단순 POST(폼 · no-cors fetch)를 만들어 운영 변경을
     * 실행할 수 있었다. 사용자 헤더는 교차 출처에서 사전 요청 없이는 붙일 수 없다. 화면(웹 lib/api.ts)은 쿠키 값을 그대로 헤더로 보낸다.
     * 요청마다 토큰을 읽어 쿠키를 내주는 것은 spa() 와 같다(가림 처리기 · 속성 이름 null — 토큰이 없으면 첫 응답이 쿠키를 만든다).
     */
    static final class HeaderOnlyCsrfTokenRequestHandler implements CsrfTokenRequestHandler {
        private final XorCsrfTokenRequestAttributeHandler attributes = new XorCsrfTokenRequestAttributeHandler();

        HeaderOnlyCsrfTokenRequestHandler() { attributes.setCsrfRequestAttributeName(null); }

        @Override
        public void handle(HttpServletRequest request, jakarta.servlet.http.HttpServletResponse response, Supplier<CsrfToken> token) {
            attributes.handle(request, response, token);
        }

        @Override
        public String resolveCsrfTokenValue(HttpServletRequest request, CsrfToken token) {
            String header = request.getHeader(token.getHeaderName());
            return StringUtils.hasText(header) ? header : null;
        }
    }

    @Bean
    CookieCsrfTokenRepository csrfTokenRepository(@Value("${wakeline.cookie-secure:false}") boolean secure) {
        CookieCsrfTokenRepository repo = CookieCsrfTokenRepository.withHttpOnlyFalse(); // 화면 스크립트가 읽어 헤더로 되돌려 보낸다
        repo.setCookieName(CSRF_COOKIE);
        repo.setHeaderName(CSRF_HEADER);
        repo.setCookiePath("/");
        repo.setCookieCustomizer(c -> c.sameSite("Strict").secure(secure));
        return repo;
    }

    /**
     * 세션 쿠키. Secure 는 설정으로(R-90): 기본 false — edge 가 127.0.0.1 의 평문 HTTP 로만 받는다. HTTPS(TLS 종단 edge·터널)로 노출하면
     * WAKELINE_COOKIE_SECURE=true 로 세션·CSRF 쿠키 모두 Secure 가 된다(그때는 edge 에 TLS·HSTS 가 있어야 한다 — 없으면 브라우저가 쿠키를 보내지 않는다).
     */
    @Bean
    CookieSerializer cookieSerializer(@Value("${wakeline.cookie-secure:false}") boolean secure) {
        var c = new DefaultCookieSerializer();
        c.setCookieName(SESSION_COOKIE);
        // R-97(ADR-017 §3): 세션은 api 경로에서만 쓴다 — Path=/ 이면 같은 호스트의 웹(Next) 요청마다 실렸다. CSRF 쿠키는 화면 JS 가 읽어야 해서 / 그대로.
        // 같은 호스트명의 다른 포트로 가는 것은 쿠키 규칙(RFC 6265 — 포트 구분 없음)이라 여기서 막을 수 없다.
        c.setCookiePath(SESSION_COOKIE_PATH);
        c.setUseHttpOnlyCookie(true);
        c.setSameSite("Strict");
        c.setUseSecureCookie(secure);
        return c;
    }

    /**
     * 세션 id 해석(QA-102): 위 쿠키(이름 · Path · SameSite)를 운영 경로에서만 읽는다({@link OpsSessionIdResolver}) — 공개 경로는 세션 저장소(Redis)에
     * 닿지 않아, Redis 장애 중에도 쿠키를 실은 공개 요청이 쿠키 없는 요청과 같게 답한다.
     */
    @Bean
    HttpSessionIdResolver httpSessionIdResolver(CookieSerializer cookieSerializer) {
        CookieHttpSessionIdResolver cookies = new CookieHttpSessionIdResolver();
        cookies.setCookieSerializer(cookieSerializer);
        return new OpsSessionIdResolver(cookies);
    }

    @Bean
    SecurityContextRepository securityContextRepository() {
        return new DelegatingSecurityContextRepository(new RequestAttributeSecurityContextRepository(), new HttpSessionSecurityContextRepository());
    }
}
