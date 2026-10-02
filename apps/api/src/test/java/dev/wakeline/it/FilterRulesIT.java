package dev.wakeline.it;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIf;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 공개 조회 파라미터의 같은 규칙(QA 2026-10 기능 개선 제안 2 · 3, 사용자 결정 2026-10-03 — 계약 v5 §G41 · §G42):
 * <ul>
 *   <li>정해진 값 중 하나를 고르는 필터(kind · group · detail)는 모르는 값이면 400 BAD_FILTER — 예전에는 경로마다 달랐다(kind=bogus → 관측 + 예측 모두,
 *       group=bogus → fir, detail=bogus → lite). 맞는 값은 대소문자를 가리지 않는다. hazard 는 열린 값(공급자가 주는 글자 그대로)이라 그대로 — 일치가 없으면 0건.</li>
 *   <li>목록 크기(limit)는 범위 밖이면 끝값으로 잘라 쓴다 — 예전에는 /ships/search 만 400 BAD_LIMIT 이었다(나머지는 이미 잘라 썼다).</li>
 * </ul>
 */
@EnabledIf("dev.wakeline.DbTestSupport#dockerAvailable")
class FilterRulesIT extends IntegrationTest {
    static final String BBOX = "120,30,135,43";

    @Test
    void anUnknownValueForAChoiceFilterIs400() {
        assertProblem(get("/api/v1/alerts?kind=bogus"), 400, "BAD_FILTER", "/api/v1/alerts");
        assertThat(get("/api/v1/alerts?kind=OBSERVED").status()).isEqualTo(200);
        assertThat(get("/api/v1/alerts?kind=predicted").status()).isEqualTo(200);
        assertThat(get("/api/v1/alerts").status()).isEqualTo(200);

        assertProblem(get("/api/v1/stats/sigmet?group=bogus"), 400, "BAD_FILTER", "/api/v1/stats/sigmet");
        assertThat(get("/api/v1/stats/sigmet?group=hazard").json().path("group").asString()).isEqualTo("hazard");
        assertThat(get("/api/v1/stats/sigmet").json().path("group").asString()).isEqualTo("fir");

        assertProblem(get("/api/v1/aircraft?bbox=" + BBOX + "&detail=bogus"), 400, "BAD_FILTER", "/api/v1/aircraft");
        assertThat(get("/api/v1/aircraft?bbox=" + BBOX + "&detail=full").status()).isEqualTo(200);
        assertThat(get("/api/v1/aircraft?bbox=" + BBOX + "&detail=LITE").status()).isEqualTo(200);

        Res hz = get("/api/v1/sigmets?hazard=bogus"); // 열린 값 — 400 이 아니라 일치 0건
        assertThat(hz.status()).isEqualTo(200);
        assertThat(hz.json().path("features").size()).isZero();
    }

    @Test
    void aListSizeOutsideItsRangeIsClampedNot400() {
        Res over = get("/api/v1/ships/search?q=it%20search&limit=21");
        assertThat(over.status()).as("limit 21 → 20 으로 잘라 쓴다(예전 400 BAD_LIMIT)").isEqualTo(200);
        assertThat(over.json().path("items").size()).isLessThanOrEqualTo(20);
        Res under = get("/api/v1/ships/search?q=it%20search&limit=0");
        assertThat(under.status()).isEqualTo(200);
        assertThat(under.json().path("items").size()).isLessThanOrEqualTo(1);
        assertThat(get("/api/v1/ships/search?q=it%20search&limit=x").status()).as("정수가 아니면 그대로 400").isEqualTo(400);
    }
}
