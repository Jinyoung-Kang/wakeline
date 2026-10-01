package dev.wakeline.config;

import org.junit.jupiter.api.Test;

import java.util.Arrays;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

/** 허용 Origin 목록 정리(SEC-7) — WS 핸드셰이크(OriginAllowList)가 쓰는 목록. */
class AppPropertiesTest {
    @Test void originPatterns_dropWildcardAndBlanks_fallBackToDefaultWhenEmpty() {
        assertThat(AppProperties.normalizeOrigins(Arrays.asList(" http://a:1/ ", "*", "", null, "http://a:1"))).containsExactly("http://a:1");
        assertThat(AppProperties.normalizeOrigins(List.of("*"))).isEqualTo(AppProperties.DEFAULT_ALLOWED_ORIGINS);
        assertThat(AppProperties.normalizeOrigins(null)).isEqualTo(AppProperties.DEFAULT_ALLOWED_ORIGINS);
        assertThat(props(List.of("http://localhost:8701/", "http://127.0.0.1:8701")).originPatterns())
                .containsExactly("http://localhost:8701", "http://127.0.0.1:8701");
    }

    static AppProperties props(List<String> origins) {
        return new AppProperties("", "36.5,127.8", 250, 120, 200, 5, 10, 30, 2500, 0, "classpath:schemas", 72, 30, 120, origins);
    }
}
