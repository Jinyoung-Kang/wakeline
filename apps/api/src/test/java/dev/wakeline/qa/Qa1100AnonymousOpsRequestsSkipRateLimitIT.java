package dev.wakeline.qa;

import dev.wakeline.it.IntegrationTest;
import dev.wakeline.it.ItStack;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIf;

import java.nio.charset.StandardCharsets;
import java.util.Map;
import java.util.TreeMap;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * QA-1100(QA 2026-10-aws · api 보안): 공개 요청 제한(RateLimitFilter — "/api/** 요청을 IP당 분당 N 회로 제한", 계약 §2 의 IP당 분당 120)이 Spring Security
 * 필터 체인 뒤에서 돈다. RateLimitFilter 는 서블릿 필터 @Order(10) 이고 보안 체인(DelegatingFilterProxy)은 Boot 기본 -100 이라, 보안 체인이 끝낸 요청
 * — 익명 운영 요청의 404(존재 비공개) · CSRF 없는 변경의 403 · 허용 목록 밖 Origin 의 403 · 방화벽 400 — 은 제한기에 닿지 않는다. 그런 요청은 몇 번이든
 * 429 가 되지 않고, 카운터(rl:api:{ip}:{분})도 오르지 않으며 X-RateLimit-* 헤더도 없다. 같은 IP 의 공개 경로 121번째 요청은 429 다(SecurityIT 대조군).
 * <p>기대: /api/** 의 모든 요청(디코딩한 경로 — ApiPaths.API)이 같은 분당 한도에 세진다 — 121번째 익명 운영 요청은 429 RATE_LIMITED.
 * <p>실행: {@code cd apps/api && ./gradlew --offline test --tests 'dev.wakeline.qa.Qa1100AnonymousOpsRequestsSkipRateLimitIT'}
 */
@EnabledIf("dev.wakeline.DbTestSupport#dockerAvailable")
class Qa1100AnonymousOpsRequestsSkipRateLimitIT extends IntegrationTest {
    static final int LIMIT = 120; // IntegrationTest 의 wakeline.public-rate-limit-per-min

    @BeforeEach
    void clearCounters() {
        ItStack.deleteKeys("rl:*");
    }

    /** 분 단위 고정 창(rl:api:{ip}:{epoch/60})의 경계를 건너지 않게 — 남은 시간이 짧으면 다음 분까지 기다린다. */
    static void awaitFreshMinuteWindow(int minRemainingS) throws InterruptedException {
        long ms = System.currentTimeMillis() % 60_000;
        if (60_000 - ms < minRemainingS * 1000L) Thread.sleep(60_000 - ms + 200);
    }

    @Test
    void anonymousOpsGetsAreCountedAgainstThePerIpLimit() throws Exception {
        awaitFreshMinuteWindow(25);
        Map<Integer, Integer> statuses = new TreeMap<>();
        QaRawHttp.Res first = null, last = null;
        for (int i = 1; i <= LIMIT + 1; i++) {
            last = QaRawHttp.get(port, "/api/v1/ops/providers");
            if (first == null) first = last;
            statuses.merge(last.status(), 1, Integer::sum);
        }
        assertThat(first.header("X-RateLimit-Limit")).as("X-RateLimit-Limit on an anonymous /api/v1/ops request (statuses of %d requests: %s)",
                LIMIT + 1, statuses).isEqualTo(String.valueOf(LIMIT));
        assertThat(last.status()).as("request #%d of anonymous GET /api/v1/ops/providers within one minute (statuses: %s)", LIMIT + 1, statuses)
                .isEqualTo(429);
    }

    @Test
    void anonymousOpsWritesRefusedByCsrfAreCountedToo() throws Exception {
        awaitFreshMinuteWindow(25);
        Map<Integer, Integer> statuses = new TreeMap<>();
        QaRawHttp.Res last = null;
        byte[] body = "{\"value\":20}".getBytes(StandardCharsets.UTF_8);
        for (int i = 1; i <= LIMIT + 1; i++) {
            last = QaRawHttp.send(port, "PUT", "/api/v1/ops/settings/region_poll_s", Map.of("Content-Type", "application/json", "If-Match", "1"), body);
            statuses.merge(last.status(), 1, Integer::sum);
        }
        assertThat(ItStack.admin().keys("rl:api:127.0.0.1:*")).as("api limiter counter after %d anonymous ops writes (statuses: %s)", LIMIT + 1, statuses)
                .hasSize(1);
        assertThat(last.status()).as("request #%d of anonymous PUT /api/v1/ops/settings/… within one minute (statuses: %s)", LIMIT + 1, statuses)
                .isEqualTo(429);
    }
}
