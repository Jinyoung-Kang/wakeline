package dev.wakeline.ops;

import dev.wakeline.config.Problem;
import dev.wakeline.domain.Bbox;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.node.JsonNodeFactory;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.assertj.core.api.Assertions.within;

/** 관심 지역 해석은 collector(runtime_settings.region)와 같은 규칙, 설정 검증은 숫자 범위(COR-12). */
class RegionSettingsTest {
    static final RegionSettings.Region DEF = new RegionSettings.Region(36.5, 127.8, 250);

    @Test
    void parsesLikeTheCollector() {
        assertThat(RegionSettings.parse("35.5,139.7", "300", DEF)).isEqualTo(new RegionSettings.Region(35.5, 139.7, 300));
        assertThat(RegionSettings.parse(" 35.5 , 139.7 ", "300", DEF)).isEqualTo(new RegionSettings.Region(35.5, 139.7, 300));
        assertThat(RegionSettings.parse(null, null, DEF)).isEqualTo(DEF);                  // 해시에 값 없음 → 기본값
        assertThat(RegionSettings.parse("nonsense", "abc", DEF)).isEqualTo(DEF);           // 해석 실패 → 기본값
        assertThat(RegionSettings.parse("1,2,3", "250", DEF)).isEqualTo(DEF);
        assertThat(RegionSettings.parse("36,127", "10", DEF).radiusNm()).isEqualTo(50);    // [50, 500] 로 자른다
        assertThat(RegionSettings.parse("36,127", "9999", DEF).radiusNm()).isEqualTo(500);
    }

    @Test
    void bboxCoversTheRegionCircle() {
        Bbox b = new RegionSettings.Region(36.0, 127.0, 60).bbox();
        assertThat(b.lamin()).isCloseTo(35.0, within(1e-9));
        assertThat(b.lamax()).isCloseTo(37.0, within(1e-9));
        assertThat(b.lomax() - 127.0).isCloseTo(1.0 / Math.cos(Math.toRadians(36)), within(1e-9));
        Bbox edge = new RegionSettings.Region(0, 179.5, 120).bbox();
        assertThat(edge.lomax()).isEqualTo(180.0);
    }

    @Test
    void regionCenterIsValidatedNumerically() {
        assertThatCode(() -> SettingsService.validate("region_center", JsonNodeFactory.instance.stringNode("36.5,127.8"))).doesNotThrowAnyException();
        assertThatCode(() -> SettingsService.validate("region_center", JsonNodeFactory.instance.stringNode("-85,-180"))).doesNotThrowAnyException();
        for (String bad : new String[]{"99,127", "36.5,999", "85.1,0", "36.5,180.5", "36.5", "a,b", "36.5;127.8"})
            assertThatThrownBy(() -> SettingsService.validate("region_center", JsonNodeFactory.instance.stringNode(bad))).as(bad).isInstanceOf(Problem.class);
        assertThatThrownBy(() -> SettingsService.validate("region_center", JsonNodeFactory.instance.numberNode(36))).isInstanceOf(Problem.class);
    }
}
