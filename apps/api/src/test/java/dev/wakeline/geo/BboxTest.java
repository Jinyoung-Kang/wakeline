package dev.wakeline.geo;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

class BboxTest {
    @Test void sharedRuleRejectsNonFiniteAndOutOfRange() {
        assertThat(Bbox.checked(124, 33, 132, 39)).isEqualTo(new Bbox(124, 33, 132, 39));
        assertThat(Bbox.checked(Double.NaN, 33, 132, 39)).isNull();
        assertThat(Bbox.checked(124, 33, Double.POSITIVE_INFINITY, 39)).isNull();
        assertThat(Bbox.checked(124, 33, 132, 91)).isNull();
        assertThat(Bbox.checked(132, 33, 124, 39)).isNull();
    }
}
