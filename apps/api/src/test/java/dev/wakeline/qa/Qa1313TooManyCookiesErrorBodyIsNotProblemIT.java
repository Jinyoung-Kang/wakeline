package dev.wakeline.qa;

import dev.wakeline.it.IntegrationTest;
import dev.wakeline.it.ItStack;
import org.assertj.core.api.SoftAssertions;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIf;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.stream.Collectors;
import java.util.stream.IntStream;

/**
 * QA-1313(QA 2026-10-aws · api-live — 오류 응답 형식): {@code Cookie} 헤더의 쿠키가 200개를 넘으면(Tomcat 의 maxCookieCount 기본 200) 모든 /api 경로가
 * 400 으로 답하는데, 본문이 RFC 9457 문제 응답이 아니라 Spring Boot 기본 오류 JSON({@code {"timestamp":…,"status":400,"error":"Bad Request","path":…}})이다 —
 * {@code code} · {@code request_id} · {@code type} 이 없고 {@code X-Request-Id} 헤더도 없으며, GeoJSON 경로에서는 Content-Type 이
 * {@code application/geo+json} 이다(본문은 GeoJSON 이 아니다). 계약 v5 의 공통 규칙(모든 오류는 problem+json · {@code request_id} = {@code X-Request-Id})과
 * 다르다. 앞선 리뷰(REVIEW-v1 R-84)가 같은 부류(방화벽 · 인코딩된 슬래시)를 {@code ProblemErrorReportValve} · requestRejectedHandler 로 고쳤는데,
 * Tomcat 이 쿠키를 해석하다 {@code sendError(400)} 로 /error 로 넘기는 이 길은 남았다(라이브 스택 A: 199 · 200개 200, 201개부터 400 기본 JSON).
 * <p>기대: 400 {@code application/problem+json} · {@code code} · {@code request_id}(= X-Request-Id).
 * <p>실행: {@code cd apps/api && ./gradlew --offline test --tests 'dev.wakeline.qa.Qa1313TooManyCookiesErrorBodyIsNotProblemIT'}
 */
@EnabledIf("dev.wakeline.DbTestSupport#dockerAvailable")
class Qa1313TooManyCookiesErrorBodyIsNotProblemIT extends IntegrationTest {
    static String cookies(int n) {
        return IntStream.range(0, n).mapToObj(i -> "c" + i + "=v").collect(Collectors.joining("; "));
    }

    @BeforeEach
    void clearCounters() {
        ItStack.deleteKeys("rl:*");
    }

    @Test
    void tooManyCookiesIsAProblemResponse() {
        Map<String, QaRawHttp.Res> res = new LinkedHashMap<>();
        for (String path : new String[]{"/api/v1/status", "/api/v1/aircraft?bbox=126,37,127,38", "/api/v1/ops/providers"})
            res.put(path, QaRawHttp.get(port, path, Map.of("Accept", "application/geo+json, application/json, application/problem+json", "Cookie", cookies(201))));
        QaRawHttp.Res control = QaRawHttp.get(port, "/api/v1/status", Map.of("Accept", "application/json", "Cookie", cookies(200)));

        SoftAssertions soft = new SoftAssertions();
        soft.assertThat(control.status()).as("control: 200 cookies").isEqualTo(200);
        res.forEach((path, r) -> {
            soft.assertThat(r.status()).as("GET %s with 201 cookies — status", path).isEqualTo(400);
            soft.assertThat(r.header("Content-Type")).as("GET %s with 201 cookies — Content-Type (body %s)", path, r.body()).startsWith("application/problem+json");
            soft.assertThat(r.body()).as("GET %s with 201 cookies — body", path).contains("\"code\":").contains("\"request_id\":").doesNotContain("\"timestamp\"");
            soft.assertThat(r.header("X-Request-Id")).as("GET %s with 201 cookies — X-Request-Id", path).isNotNull();
        });
        soft.assertAll();
    }
}
