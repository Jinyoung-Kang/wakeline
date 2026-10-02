package dev.wakeline.it;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIf;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 공항 ICAO · 항공기 hex 같은 ASCII 코드는 ASCII 로만 받는다(QA 2026-10 기능 개선 제안 5). 예전에는 대소문자를 먼저 바꾼 뒤 검사해 'rksı'(점 없는 ı — 어느
 * 로캘에서든 대문자가 I)가 RKSI 로 찾아졌다. 이제 바꾸기 전에 ASCII 를 검사하고, 바꿀 때는 Locale.ROOT(JVM 기본 로캘에 기대지 않는다).
 */
@EnabledIf("dev.wakeline.DbTestSupport#dockerAvailable")
class NonAsciiCodesIT extends IntegrationTest {
    @Test
    void anIcaoWithANonAsciiLetterIsRejectedNotMatchedToItsAsciiLookalike() {
        assertThat(get("/api/v1/airports/rksi/wx").status()).as("ASCII 소문자는 검사를 지난다(자료가 있으면 200, 없으면 404)").isIn(200, 404);
        Res r = get("/api/v1/airports/rks%C4%B1/wx"); // rksı
        assertThat(r.status()).isEqualTo(400);
        assertThat(r.body()).contains("\"code\":\"BAD_ICAO\"");
    }
}
