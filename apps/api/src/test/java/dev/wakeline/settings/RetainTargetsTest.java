package dev.wakeline.settings;

import dev.wakeline.platform.web.Problem;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.node.JsonNodeFactory;

import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** 운영 설정 retain_targets(ADR-038 · 계약 v5 §G52): hex · MMSI 쉼표 목록, 20개까지, 같은 값 한 번, 빈 값 = 지정 없음. */
class RetainTargetsTest {
    @Test
    void parsesAircraftAndShipsAndLowercasesHex() {
        RetainTargets t = RetainTargets.parse(" 71BE01 ,440123456,a1b2c3");
        assertThat(t.aircraft()).containsExactly("71be01", "a1b2c3");
        assertThat(t.ships()).containsExactly("440123456");
        assertThat(RetainTargets.parse("").isEmpty()).isTrue();
        assertThat(RetainTargets.parse(null)).isEqualTo(RetainTargets.NONE);
    }

    @Test
    void rejectsBadIdsDuplicatesAndMoreThanTwenty() {
        for (String bad : List.of("71be0", "4401234567", "71be01,,440123456", "71be01,71BE01", "zzzzzz", "71be01 440123456"))
            assertThatThrownBy(() -> RetainTargets.parse(bad)).as(bad).isInstanceOf(IllegalArgumentException.class);
        StringBuilder many = new StringBuilder();
        for (int i = 0; i < 21; i++) many.append(i == 0 ? "" : ",").append(440000000 + i);
        assertThatThrownBy(() -> RetainTargets.parse(many.toString())).hasMessageContaining("at most 20");
    }

    @Test
    void theSettingIsValidatedTheSameWay() {
        assertThatCode(() -> SettingsService.validate("retain_targets", JsonNodeFactory.instance.stringNode("71be01,440123456"))).doesNotThrowAnyException();
        assertThatCode(() -> SettingsService.validate("retain_targets", JsonNodeFactory.instance.stringNode(""))).doesNotThrowAnyException();
        assertThatThrownBy(() -> SettingsService.validate("retain_targets", JsonNodeFactory.instance.stringNode("71be01,71be01"))).isInstanceOf(Problem.class);
        assertThatThrownBy(() -> SettingsService.validate("retain_targets", JsonNodeFactory.instance.numberNode(1))).isInstanceOf(Problem.class);
    }
}
