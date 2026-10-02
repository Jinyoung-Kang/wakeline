package dev.wakeline.qa;

import dev.wakeline.ops.OpsSessionLifetimeFilter;
import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockFilterChain;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.mock.web.MockHttpSession;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneOffset;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * QA-101 재현: DB 장애 중 운영 요청은 세션 자격 확인(R-95 후속, OpsSessionLifetimeFilter)에서 503 이 되는데, 이 503 에는 Retry-After 가 없다.
 * 계약 §2 의 503 은 Retry-After(기본 10 s)를 싣고(공개 경로 · ProblemAdvice · Problem.unavailable — 스택 B 에서 공개 503 은 모두 Retry-After: 10),
 * §G14 는 해결 목록의 503 에 Retry-After: 30 을 약속한다. 화면은 Retry-After 가 있을 때만 'N초 뒤 다시 시도' 를 보인다(VERIFICATION 재생 503 안내).
 * 스택 B 증거: docs/qa/2026-10/evidence/reliability/sweeps/ops-db-down.json — 운영 GET 11개 모두 503 · Retry-After 없음.
 * <p>/ops/logs 가 DB 장애 중 503 인 것 자체는 의도다(Redis 만 읽는 경로지만 운영 요청은 모두 세션 자격 확인 — R-95 의 실패-닫힘 — 을 먼저 지난다,
 * ADR-017 §6 S3 · ADR-024 고침). 이 시험은 Retry-After 만 본다(처음 판은 상태 503 도 단언했다 — 그 상태는 OpsSessionLifetimeFilterTest 가 본다).
 */
class Qa101OpsUnavailableRetryAfterTest {
    static final Instant NOW = Instant.parse("2026-10-02T03:00:00Z");

    @Test
    void opsRequestRefusedBecauseTheCredentialCannotBeReadCarriesRetryAfter() throws Exception {
        OpsSessionLifetimeFilter dbDown = new OpsSessionLifetimeFilter(Duration.ofHours(8), Clock.fixed(NOW, ZoneOffset.UTC),
                uid -> { throw new IllegalStateException("db down"); });
        MockHttpSession s = new MockHttpSession();
        s.setAttribute(OpsSessionLifetimeFilter.AUTH_AT, NOW.minus(Duration.ofMinutes(5)).toEpochMilli());
        s.setAttribute(OpsSessionLifetimeFilter.USER_ID, 7);
        s.setAttribute(OpsSessionLifetimeFilter.CREDENTIAL, "tag");
        for (String[] c : new String[][] {{"/api/v1/ops/logs", "10"}, {"/api/v1/ops/resolutions", "30"}, {"/api/v1/ops/providers", "10"}}) {
            String path = c[0];
            MockHttpServletRequest req = new MockHttpServletRequest("GET", path);
            req.setRequestURI(path);
            req.setSession(s);
            MockHttpServletResponse res = new MockHttpServletResponse();
            dbDown.doFilter(req, res, new MockFilterChain());
            assertThat(res.getHeader("Retry-After")).as("%s: 503 은 Retry-After 를 싣는다(계약 §2 — 공개 503 은 10, §G14 — 해결 목록은 30)", path)
                    .isEqualTo(c[1]);
        }
    }
}
