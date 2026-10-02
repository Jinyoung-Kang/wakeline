package dev.wakeline.platform.web;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** 공용 파라미터 규칙: hex(6자리 16진) · 자유 글자 필터의 제어 문자(QA-205 — 400 BAD_FILTER, 저장소에 닿기 전). */
class ParamsTest {
    @Test
    void filterTextRejectsControlCharactersAndKeepsEverythingElse() {
        assertThat(Params.filterText("job", null)).isNull();
        assertThat(Params.filterText("job", "kma_radar")).isEqualTo("kma_radar");
        assertThat(Params.filterText("provider", "adsb.fi 한글 'quote'")).isEqualTo("adsb.fi 한글 'quote'");
        for (String bad : new String[]{"a\u0000", "a\nb", "\t", "x\u007f", "\u0085"})
            assertThatThrownBy(() -> Params.filterText("status", bad)).isInstanceOfSatisfying(Problem.class, p -> {
                assertThat(p.status().value()).isEqualTo(400);
                assertThat(p.code()).isEqualTo("BAD_FILTER");
                assertThat(p.getMessage()).isEqualTo("status must not contain control characters");
            });
    }

    @Test
    void hexIsSixHexDigitsLowercased() {
        assertThat(Params.hex(" 71BE01 ")).isEqualTo("71be01");
        assertThatThrownBy(() -> Params.hex("71be0")).isInstanceOf(Problem.class);
        assertThatThrownBy(() -> Params.hex(null)).isInstanceOf(Problem.class);
    }
}
