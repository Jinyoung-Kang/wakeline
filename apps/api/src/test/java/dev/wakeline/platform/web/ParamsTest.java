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

    /** QA 2026-10 기능 개선 제안 5: ASCII 코드는 ASCII 로만 — 바꾸기 전에 검사한다(비 ASCII 글자가 대 · 소문자 바꾸기로 ASCII 가 되어 지나지 않게). */
    @Test
    void asciiCodesAreCheckedBeforeTheirCaseIsChanged() {
        assertThat(Params.icao(" rksi ")).isEqualTo("RKSI");
        assertThatThrownBy(() -> Params.icao("rks\u0131")).isInstanceOf(Problem.class).hasMessageContaining("icao"); // 점 없는 ı — 대문자는 I
        assertThatThrownBy(() -> Params.icao("RKS\u0130")).isInstanceOf(Problem.class); // 점 있는 İ
        assertThatThrownBy(() -> Params.icao("RKS")).isInstanceOf(Problem.class);
        assertThat(Params.hex("71BE01")).isEqualTo("71be01");
        assertThatThrownBy(() -> Params.hex("71be0\u212a")).isInstanceOf(Problem.class); // 켈빈 기호 K — 소문자는 k
        assertThatThrownBy(() -> Params.hex("\uff17\uff11be01")).isInstanceOf(Problem.class); // 전각 숫자
    }

    /** 계약 v5 §G42: 정해진 값 중 하나를 고르는 필터 — 없으면 기본값, 대소문자 무관, 모르는 값은 400 BAD_FILTER. */
    @Test
    void aChoiceFilterAcceptsItsValuesInAnyCaseAndRejectsOthers() {
        assertThat(Params.choice("kind", null, null, "observed", "predicted")).isNull();
        assertThat(Params.choice("kind", " ", null, "observed", "predicted")).isNull();
        assertThat(Params.choice("kind", "OBSERVED", null, "observed", "predicted")).isEqualTo("observed");
        assertThat(Params.choice("group", null, "fir", "fir", "hazard")).isEqualTo("fir");
        assertThatThrownBy(() -> Params.choice("detail", "bogus", "lite", "lite", "full"))
                .isInstanceOf(Problem.class).hasMessageContaining("detail must be one of lite, full");
    }
}
