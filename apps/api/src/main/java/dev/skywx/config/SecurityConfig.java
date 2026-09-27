package dev.skywx.config;

import jakarta.servlet.http.HttpServletRequest;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.HttpMethod;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.web.context.DelegatingSecurityContextRepository;
import org.springframework.security.web.context.HttpSessionSecurityContextRepository;
import org.springframework.security.web.context.RequestAttributeSecurityContextRepository;
import org.springframework.security.web.context.SecurityContextRepository;
import org.springframework.security.web.csrf.CookieCsrfTokenRepository;
import org.springframework.security.web.csrf.CsrfException;
import org.springframework.security.web.header.writers.ReferrerPolicyHeaderWriter.ReferrerPolicy;
import org.springframework.security.web.header.writers.StaticHeadersWriter;
import org.springframework.session.web.http.CookieSerializer;
import org.springframework.session.web.http.DefaultCookieSerializer;

import java.nio.charset.StandardCharsets;

/**
 * 보안(6.2절 api 층). 공개 경로 허용, /api/v1/ops/** 는 ROLE_OPS + 세션 + CSRF(쿠키 SKYWX_CSRF → 헤더 X-CSRF-Token).
 * 비인가는 404(존재 여부 비공개), CSRF 실패는 403. 세션 쿠키 SKYWX_SESSION: HttpOnly · SameSite=Strict.
 */
@org.springframework.context.annotation.Profile("!cli")  // --create-ops-user CLI 에서는 웹·소비자·잡을 띄우지 않는다
@Configuration
public class SecurityConfig {
    public static final String SESSION_COOKIE = "SKYWX_SESSION";
    public static final String CSRF_COOKIE = "SKYWX_CSRF";
    public static final String CSRF_HEADER = "X-CSRF-Token";

    @Bean
    SecurityFilterChain api(HttpSecurity http, SecurityContextRepository contextRepository, CookieCsrfTokenRepository csrfRepository) throws Exception {
        http
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
                .headers(h -> h
                        .referrerPolicy(r -> r.policy(ReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN))
                        .addHeaderWriter(new StaticHeadersWriter("Permissions-Policy", "camera=(), microphone=(), geolocation=()"))
                        .contentSecurityPolicy(csp -> csp.policyDirectives("default-src 'none'; frame-ancestors 'none'")));
        return http.build();
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
        res.setStatus(status);
        res.setContentType("application/problem+json");
        String body = """
                {"type":"https://skywx.dev/problems/%s","title":"%s","status":%d,"detail":"%s","instance":"%s","code":"%s","request_id":"%s"}"""
                .formatted(code.toLowerCase().replace('_', '-'), title, status, detail, req.getRequestURI(), code, RequestIdFilter.current(req));
        res.getOutputStream().write(body.getBytes(StandardCharsets.UTF_8));
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
