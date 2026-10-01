package dev.wakeline.platform.config;

import org.junit.jupiter.api.Test;

import java.util.Arrays;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * VERIFICATION #50: jackson-databind CVE-2026-68497(HIGH, trivy — 3.1.6 · 2.22.2 에서 수정). api 는 Jackson 3(Boot 4 기본)과
 * Jackson 2(springdoc · json-schema-validator 가 가져온다)를 함께 싣는다 — 둘 다 build.gradle.kts 의 jackson BOM 제약이 올린다
 * (Boot 4.1.1 BOM 은 3.1.5 · 2.22.1). 제약을 지우거나 BOM 이 더 낮은 버전을 고르면 여기서 깨진다.
 */
class JacksonVersionTest {
    static final int[] MIN_3 = {3, 1, 6};
    static final int[] MIN_2 = {2, 22, 2};

    static int[] parts(String version) {
        return Arrays.stream(version.split("[.-]")).limit(3).mapToInt(Integer::parseInt).toArray();
    }

    @Test
    void jackson3DatabindIsAtLeast3_1_6() {
        String v = tools.jackson.databind.cfg.PackageVersion.VERSION.toString();
        assertThat(Arrays.compare(parts(v), MIN_3)).as("tools.jackson databind %s must be >= 3.1.6", v).isGreaterThanOrEqualTo(0);
    }

    @Test
    void jackson2DatabindIsAtLeast2_22_2() {
        String v = com.fasterxml.jackson.databind.cfg.PackageVersion.VERSION.toString();
        assertThat(Arrays.compare(parts(v), MIN_2)).as("com.fasterxml databind %s must be >= 2.22.2", v).isGreaterThanOrEqualTo(0);
    }

    @Test
    void versionComparisonIsNumeric() {
        assertThat(Arrays.compare(parts("3.1.5"), MIN_3)).isNegative();
        assertThat(Arrays.compare(parts("3.1.6"), MIN_3)).isZero();
        assertThat(Arrays.compare(parts("3.1.10-SNAPSHOT"), MIN_3)).isPositive();
        assertThat(Arrays.compare(parts("2.22.1"), MIN_2)).isNegative();
    }
}
