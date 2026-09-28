package dev.wakeline.config;

import jakarta.servlet.http.HttpServletRequest;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.HttpMethod;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.web.context.DelegatingSecurityContextRepository;
import org.springframework.security.web.context.HttpSessionSecurityContextRepository;
import org.springframework.security.web.context.RequestAttributeSecurityContextRepository;
import org.springframework.security.web.context.SecurityContextHolderFilter;
import org.springframework.security.web.context.SecurityContextRepository;
import org.springframework.security.web.csrf.CookieCsrfTokenRepository;
import org.springframework.security.web.csrf.CsrfException;
import org.springframework.security.web.firewall.RequestRejectedHandler;
import org.springframework.session.web.http.CookieSerializer;
import org.springframework.session.web.http.DefaultCookieSerializer;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.time.Clock;
import java.time.Duration;

/**
 * 보안(6.2절 api 층). 공개 경로 허용, /api/v1/ops/** 는 ROLE_OPS + 세션 + CSRF(쿠키 WAKELINE_CSRF → 헤더 X-CSRF-Token).
 * 비인가는 404(존재 여부 비공개), CSRF 실패는 403. 세션 쿠키 WAKELINE_SESSION: HttpOnly · SameSite=Strict.
 * 운영 세션은 유휴 한도와 별개로 로그인부터 절대 수명(wakeline.ops-session-max-age, 8 h)이 지나면 끝난다({@link OpsSessionLifetimeFilter}).
 */
@org.springframework.context.annotation.Profile("!cli & !migrate")  // CLI(ops-user)·마이그레이션 실행에서는 웹·소비자·잡을 띄우지 않는다
@Configuration
public class SecurityConfig {
    private static final Logger log = LoggerFactory.getLogger(SecurityConfig.class);
    public static final String SESSION_COOKIE = "WAKELINE_SESSION";
    public static final String CSRF_COOKIE = "WAKELINE_CSRF";
    public static final String CSRF_HEADER = "X-CSRF-Token";

    @Bean
    SecurityFilterChain api(HttpSecurity http, SecurityContextRepository contextRepository, CookieCsrfTokenRepository csrfRepository,
                            @Value("${wakeline.ops-session-max-age:8h}") Duration opsSessionMaxAge) throws Exception {
        http
                // 절대 수명(R-54): 보안 컨텍스트를 세션에서 읽기 전에 오래된 운영 세션을 끝낸다 → 익명 → 404
                .addFilterBefore(new OpsSessionLifetimeFilter(opsSessionMaxAge, Clock.systemUTC()), SecurityContextHolderFilter.class)
                .authorizeHttpRequests(a -> a
                        .requestMatchers(HttpMethod.POST, "/api/v1/ops/session").permitAll()
                        .requestMatchers("/api/v1/ops/**").hasRole("OPS")
                        .anyRequest().permitAll())
                // CSRF 는 세션 쿠키로 인증되는 ops 변경 요청에만 적용한다. 공개 API 는 쿠키 인증이 없으므로 대상이 아니다.
                .csrf(c -> c.spa().csrfTokenRepository(csrfRepository)
                        .ignoringRequestMatchers(req -> !req.getRequestURI().startsWith("/api/v1/ops/") || "GET".equals(req.getMethod())
                                || (isLogin(req) && !hasCookie(req, SESSION_COOKIE))))
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

    /**
     * Spring 방화벽(StrictHttpFirewall)이 거절한 요청(//·;·/./·인코딩된 . 등)도 RFC 9457 로(R-84). 기본은 예외를 컨테이너로 올려 Boot 기본
     * JSON 오류 본문이 나갔다. 거절 자체는 그대로다(우회 없음). WebSecurity 가 이 빈을 FilterChainProxy 에 건다.
     */
    /** Tomcat 이 앱에 닿기 전에 거절한 요청(예: %2F)의 본문도 problem+json(R-84) — {@link ProblemErrorReportValve}. */
    @Bean
    static ProblemErrorReportValve.Customizer problemErrorReportValveCustomizer() {
        return new ProblemErrorReportValve.Customizer();
    }

    @Bean
    RequestRejectedHandler requestRejectedHandler() {
        return (req, res, ex) -> {
            log.debug("request rejected by the firewall request_id={}: {}", RequestIdFilter.current(req), ex.getMessage());
            problem(res, req, 400, "BAD_REQUEST", "bad request", "request rejected");
        };
    }

    private static boolean isLogin(HttpServletRequest req) {
        return "/api/v1/ops/session".equals(req.getRequestURI()) && "POST".equals(req.getMethod());
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

    @Bean
    CookieCsrfTokenRepository csrfTokenRepository() {
        CookieCsrfTokenRepository repo = CookieCsrfTokenRepository.withHttpOnlyFalse(); // 화면 스크립트가 읽어 헤더로 되돌려 보낸다
        repo.setCookieName(CSRF_COOKIE);
        repo.setHeaderName(CSRF_HEADER);
        repo.setCookiePath("/");
        repo.setCookieCustomizer(c -> c.sameSite("Strict").secure(false)); // 로컬 HTTP. 배포 시 secure(true)
        return repo;
    }

    @Bean
    CookieSerializer cookieSerializer() {
        var c = new DefaultCookieSerializer();
        c.setCookieName(SESSION_COOKIE);
        c.setCookiePath("/");
        c.setUseHttpOnlyCookie(true);
        c.setSameSite("Strict");
        c.setUseSecureCookie(false); // 로컬 HTTP. 배포(HTTPS) 시 true
        return c;
    }

    @Bean
    SecurityContextRepository securityContextRepository() {
        return new DelegatingSecurityContextRepository(new RequestAttributeSecurityContextRepository(), new HttpSessionSecurityContextRepository());
    }
}
