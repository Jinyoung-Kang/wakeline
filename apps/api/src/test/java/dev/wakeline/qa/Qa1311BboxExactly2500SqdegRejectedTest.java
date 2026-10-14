package dev.wakeline.qa;

import dev.wakeline.geo.Bbox;
import dev.wakeline.platform.web.BboxParam;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;

/**
 * QA-1311(QA 2026-10-aws · api-live — 공개 bbox 면적 경계): 계약은 bbox 면적이 2,500 sq° '초과'일 때만 422 {@code BBOX_TOO_LARGE} 다
 * (넓이 ≤ 2,500 은 받는다 — {@code /aircraft} · {@code /ships} · {@code /replay}, WS subscribe 도 같은 {@code Bbox.area()}).
 * 그런데 면적을 소수 그대로 {@code (lomax − lomin) × (lamax − lamin)} 로 재서, 경도 · 위도 폭이 정확히 50° 인 상자도 경계 값의 10진 표기에 따라
 * 이진 부동소수 뺄셈 오차(150.3 − 100.3 = 50.000000000000014)로 2,500 을 넘는다 — 같은 50° × 50° 상자가 어떤 자리에서는 200, 어떤 자리에서는
 * 422 "bbox area 2500 sq° exceeds 2500" 이다(라이브 스택 A 재현: {@code /api/v1/aircraft?bbox=100.3,10.3,150.3,60.3} → 422,
 * {@code bbox=124.1,10.1,174.1,60.1} → 200 — docs/qa/2026-10-aws/evidence/api-live/qa-1311-*.txt).
 * <p>기대: 10진 표기로 폭이 정확히 50 · 50 인 상자(넓이 2,500)는 어디서나 받는다.
 * <p>실행: {@code cd apps/api && ./gradlew --offline test --tests 'dev.wakeline.qa.Qa1311BboxExactly2500SqdegRejectedTest'}
 */
class Qa1311BboxExactly2500SqdegRejectedTest {
    @ParameterizedTest(name = "{0}")
    @ValueSource(strings = {
            "124.1,10.1,174.1,60.1",   // 대조군 — 지금도 받는다
            "0,0,50,50",               // 대조군 — 지금도 받는다
            "100.3,10.3,150.3,60.3",   // 50° × 50° — 지금은 422
            "100.3,0,150.3,50",        // 경도 폭만 10진 50 · 이진 50.000000000000014
            "0,14.4,50,64.4",          // 위도 폭만
            "101.8,14.9,151.8,64.9",
            "-177.8,-89.9,-127.8,-39.9",
    })
    void aBoxOfExactly50By50DegreesIsWithinTheLimit(String bbox) {
        assertThatCode(() -> {
            Bbox b = BboxParam.parse(bbox, 2500);
            assertThat(b).isNotNull();
        }).as("bbox=%s — 10진 표기 폭 50° × 50° = 2,500 sq° (≤ 상한)", bbox).doesNotThrowAnyException();
    }
}
