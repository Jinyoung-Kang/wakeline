package dev.skywx.domain;

import dev.skywx.config.Problem;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class BboxTest {
    @Test void parsesAndChecksArea() {
        Bbox b = Bbox.parse("124,33,132,39", 2500);
        assertThat(b.area()).isEqualTo(48);
        assertThat(b.contains(36, 127)).isTrue();
        assertThat(b.contains(40, 127)).isFalse();
    }

    @Test void tooLarge_is422() {
        assertThatThrownBy(() -> Bbox.parse("-180,-90,180,90", 2500)).isInstanceOf(Problem.class)
                .satisfies(e -> assertThat(((Problem) e).code()).isEqualTo("BBOX_TOO_LARGE"));
    }

    @Test void malformed_is400() {
        assertThatThrownBy(() -> Bbox.parse("1,2,3", 2500)).isInstanceOf(Problem.class);
        assertThatThrownBy(() -> Bbox.parse("10,5,1,9", 2500)).isInstanceOf(Problem.class);
    }
}
