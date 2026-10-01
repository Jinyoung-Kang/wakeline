package dev.wakeline.platform.web;

import dev.wakeline.geo.Bbox;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** REST bbox 해석 — BboxTest 에서 Bbox.parse 와 함께 옮겼다(api-review §2.5-2 BboxParam). */
class BboxParamTest {
    @Test void parsesAndChecksArea() {
        Bbox b = BboxParam.parse("124,33,132,39", 2500);
        assertThat(b.area()).isEqualTo(48);
        assertThat(b.contains(36, 127)).isTrue();
        assertThat(b.contains(40, 127)).isFalse();
    }

    @Test void tooLarge_is422() {
        assertThatThrownBy(() -> BboxParam.parse("-180,-90,180,90", 2500)).isInstanceOf(Problem.class)
                .satisfies(e -> assertThat(((Problem) e).code()).isEqualTo("BBOX_TOO_LARGE"));
    }

    @Test void malformed_is400() {
        assertThatThrownBy(() -> BboxParam.parse("1,2,3", 2500)).isInstanceOf(Problem.class);
        assertThatThrownBy(() -> BboxParam.parse("10,5,1,9", 2500)).isInstanceOf(Problem.class);
    }

    /**
     * R-16: NaN 은 모든 비교가 거짓이라 범위·면적 검사를 통과해 재생 면적 상한(2500 sq°)을 우회했다(전세계 조회). NaN·Infinity·지수 표기·16진 실수·
     * 형 접미사는 모두 400 BAD_BBOX — WS(WakelineWsHandler.parseBbox)와 같은 규칙(유한한 값만).
     */
    @Test void nonFiniteOrNonDecimalNumbersAreBadBbox() {
        for (String bad : new String[]{"-180,NaN,180,NaN", "NaN,NaN,NaN,NaN", "124,33,132,Infinity", "-Infinity,33,132,39", "124,33,132,+Infinity",
                "1e1,1,2e1,2", "124,33,132,3.9E1", "0x1p3,1,9,2", "124d,33,132,39", "124,33f,132,39", "124,33,132,", ",33,132,39", "1 2,3,4,5",
                "124,33,132,39,", "--1,33,132,39", "124,33,132,39.", "１２４,33,132,39"}) {
            assertThatThrownBy(() -> BboxParam.parse(bad, 2500)).as(bad).isInstanceOf(Problem.class)
                    .satisfies(e -> assertThat(((Problem) e).code()).isEqualTo("BAD_BBOX"));
        }
        // 정상 소수 표기는 그대로(부호·소수점·앞뒤 공백)
        assertThat(BboxParam.parse(" -1.5, +2.25 ,3,4.5", 2500)).isEqualTo(new Bbox(-1.5, 2.25, 3, 4.5));
        assertThat(BboxParam.parse("-1,.5,3,4.5", 2500)).isEqualTo(new Bbox(-1, 0.5, 3, 4.5));
        assertThat(BboxParam.parse("-180,-90,-130,-40", 2500)).isEqualTo(new Bbox(-180, -90, -130, -40));
    }
}
