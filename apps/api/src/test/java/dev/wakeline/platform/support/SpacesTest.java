package dev.wakeline.platform.support;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

/** 요청 값의 앞뒤 공백 지우기(계약 v5 §G43 · QA-1103): 공백 글자만 지우고 제어 문자(Cc)는 남긴다 — String.strip() · trim() 과 다른 점. */
class SpacesTest {
    @Test
    void stripsSpaceCharactersButKeepsControlCharacters() {
        assertThat(Spaces.strip("  71be01 ")).isEqualTo("71be01");
        assertThat(Spaces.strip("　71be01 ")).as("유니코드 공백 분리자는 strip() 처럼 지운다").isEqualTo("71be01");
        // strip() 은 이것들을 지웠다(Character.isWhitespace) — 남아야 형식 검사가 400 으로 거른다
        for (String c : new String[]{"\t", "\n", "\r", "\u000B", "\f", "\u001C", "\u001D", "\u001E", "\u001F", "\u0000", "\u0085"}) {
            assertThat(Spaces.strip("71be01" + c)).as("뒤의 U+%04X", (int) c.charAt(0)).isEqualTo("71be01" + c);
            assertThat(Spaces.strip(" " + c + "71be01")).as("앞의 U+%04X", (int) c.charAt(0)).isEqualTo(c + "71be01");
        }
        assertThat(Spaces.strip(null)).isNull();
        assertThat(Spaces.strip("   ")).isEmpty();
    }

    @Test
    void aValueOfOnlyControlCharactersIsNotBlank() {
        assertThat(Spaces.isBlank(null)).isTrue();
        assertThat(Spaces.isBlank("")).isTrue();
        assertThat(Spaces.isBlank(" 　 ")).isTrue();
        assertThat(Spaces.isBlank("\u001F")).isFalse();
        assertThat(Spaces.isBlank(" \t ")).isFalse();
    }
}
