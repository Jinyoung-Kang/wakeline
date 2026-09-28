package dev.wakeline.config;

import org.junit.jupiter.api.Test;
import org.springframework.boot.autoconfigure.AutoConfigurations;
import org.springframework.boot.security.autoconfigure.SecurityAutoConfiguration;
import org.springframework.boot.security.autoconfigure.web.servlet.ServletWebSecurityAutoConfiguration;
import org.springframework.boot.test.context.runner.WebApplicationContextRunner;
import org.springframework.context.ApplicationContext;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.security.web.csrf.CookieCsrfTokenRepository;
import org.springframework.session.web.http.CookieSerializer;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 쿠키 속성: Secure 는 설정(wakeline.cookie-secure, 기본 false — 로컬 HTTP)으로 켠다(R-90). 실제 Set-Cookie 를 만들어 본다.
 */
class SecurityCookieConfigTest {
    final WebApplicationContextRunner runner = new WebApplicationContextRunner()
            // SpringApplication 처럼 Boot 변환기(예: "8h" → Duration)를 건다
            .withInitializer(ctx -> ctx.getBeanFactory().setConversionService(new org.springframework.boot.convert.ApplicationConversionService()))
            .withConfiguration(AutoConfigurations.of(SecurityAutoConfiguration.class, ServletWebSecurityAutoConfiguration.class))
            .withUserConfiguration(SecurityConfig.class);

    /** [세션 쿠키 Set-Cookie, CSRF 쿠키 Set-Cookie] */
    static String[] setCookies(ApplicationContext ctx) {
        MockHttpServletRequest req = new MockHttpServletRequest("POST", "/api/v1/ops/session");
        MockHttpServletResponse res = new MockHttpServletResponse();
        ctx.getBean(CookieSerializer.class).writeCookieValue(new CookieSerializer.CookieValue(req, res, "session-id"));
        String session = res.getHeader("Set-Cookie");
        MockHttpServletResponse res2 = new MockHttpServletResponse();
        CookieCsrfTokenRepository csrf = ctx.getBean(CookieCsrfTokenRepository.class);
        csrf.saveToken(csrf.generateToken(req), req, res2);
        return new String[]{session, res2.getHeader("Set-Cookie")};
    }

    @Test
    void secureIsOffByDefaultForLocalHttp() {
        runner.run(ctx -> {
            for (String c : setCookies(ctx)) assertThat(c.toLowerCase()).doesNotContain("secure");
        });
    }

    /** R-97: 세션 쿠키는 /api 에만, CSRF 쿠키는 화면 JS 가 읽으므로 / . */
    @Test
    void sessionCookieIsScopedToTheApiPath() {
        runner.run(ctx -> {
            String[] c = setCookies(ctx);
            assertThat(c[0]).containsPattern("; Path=/api(;|$)");
            assertThat(c[1]).containsPattern("; Path=/(;|$)");
        });
    }

    @Test
    void secureCanBeSwitchedOnForHttpsDeployments() {
        runner.withPropertyValues("wakeline.cookie-secure=true").run(ctx -> {
            String[] c = setCookies(ctx);
            assertThat(c[0]).as("session cookie").containsIgnoringCase("; Secure").containsIgnoringCase("HttpOnly");
            assertThat(c[1]).as("CSRF cookie").containsIgnoringCase("; Secure").doesNotContainIgnoringCase("HttpOnly");
        });
    }
}
