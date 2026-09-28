package dev.wakeline.config;

import org.apache.catalina.util.ServerInfo;
import org.junit.jupiter.api.Test;

import java.util.Arrays;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * R-37: 내장 Tomcat 이 CRITICAL CVE 3건(CVE-2026-65182 · 65905 · 68525)을 고친 11.0.25 이상이다. 버전은 build.gradle.kts 의
 * constraints 가 정한다(Boot 4.1.1 BOM 은 11.0.24) — 제약을 지우거나 BOM 이 더 낮은 버전을 고르면 여기서 깨진다.
 */
class TomcatVersionTest {
    static final int[] MIN = {11, 0, 25};

    static int[] parts(String version) {
        return Arrays.stream(version.split("\\.")).limit(3).mapToInt(Integer::parseInt).toArray();
    }

    @Test
    void embeddedTomcatIsAtLeast11_0_25() {
        String v = ServerInfo.getServerNumber(); // 예: 11.0.26.0
        assertThat(Arrays.compare(parts(v), MIN)).as("embedded Tomcat %s must be >= 11.0.25", v).isGreaterThanOrEqualTo(0);
    }

    @Test
    void versionComparisonIsNumeric() {
        assertThat(Arrays.compare(parts("11.0.24.0"), MIN)).isNegative();
        assertThat(Arrays.compare(parts("11.0.25.0"), MIN)).isZero();
        assertThat(Arrays.compare(parts("11.0.100.0"), MIN)).isPositive();
    }
}
