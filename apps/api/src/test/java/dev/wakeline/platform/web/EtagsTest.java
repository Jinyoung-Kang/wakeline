package dev.wakeline.platform.web;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * If-None-Match 의 약한 비교(RFC 9110 §13.1.2): edge(nginx)가 gzip 으로 줄인 응답의 ETag 를 W/ 로 바꾸므로 되돌아오는 값은 W/"…" 이다(리뷰 2026-09-30 밤).
 */
class EtagsTest {
    @Test
    void weakAndListedAndWildcardTagsMatch_missingOrOtherTagsDoNot() {
        assertThat(Etags.notModified("\"v1\"", "\"v1\"")).isTrue();
        assertThat(Etags.notModified("\"v1\"", "W/\"v1\"")).as("weakened by the edge's gzip").isTrue();
        assertThat(Etags.notModified("\"v1\"", " \"a\" , W/\"v1\" ")).isTrue();
        assertThat(Etags.notModified("\"v1\"", "*")).isTrue();
        assertThat(Etags.notModified("\"v1\"", "\"v2\"")).isFalse();
        assertThat(Etags.notModified("\"v1\"", "W/\"v12\"")).isFalse();
        assertThat(Etags.notModified("\"v1\"", "v1")).as("unquoted is another tag").isFalse();
        assertThat(Etags.notModified("\"v1\"", null)).isFalse();
        assertThat(Etags.notModified("\"v1\"", " ")).isFalse();
    }
}
