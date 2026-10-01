package dev.wakeline.weather.core;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.within;

class DeadReckoningTest {
    @Test void eastboundAtEquator_oneHour_450kt() {
        double[] p = DeadReckoning.predict(0, 0, 90, 450, 3600);
        assertThat(p[0]).isCloseTo(0, within(1e-6));
        assertThat(p[1]).isCloseTo(450 * 1.852 / (2 * Math.PI * 6371) * 360, within(0.01));
    }

    @Test void wrapsAcrossAntimeridian() {
        double[] p = DeadReckoning.predict(10, 179.9, 90, 600, 3600);
        assertThat(p[1]).isBetween(-171.0, -169.0); // 179.9 + ≈10.1° → 경도가 -170 부근으로 감긴다
        assertThat(DeadReckoning.wrap180(190)).isEqualTo(-170);
        assertThat(DeadReckoning.wrap180(-190)).isEqualTo(170);
    }

    @Test void zeroSpeed_staysPut() {
        double[] p = DeadReckoning.predict(37.46, 126.44, 82.5, 0, 600);
        assertThat(p[0]).isCloseTo(37.46, within(1e-9));
        assertThat(p[1]).isCloseTo(126.44, within(1e-9));
    }

    @Test void haversine_knownDistance() {
        // 인천(37.4602,126.4407) → 제주(33.5113,126.4930) ≈ 237 NM
        assertThat(DeadReckoning.haversineNm(37.4602, 126.4407, 33.5113, 126.4930)).isCloseTo(237, within(2.0));
    }
}
