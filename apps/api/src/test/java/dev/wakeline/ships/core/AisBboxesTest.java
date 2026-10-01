package dev.wakeline.ships.core;

import org.junit.jupiter.api.Test;

import java.time.Instant;
import java.util.Collections;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** 계약 v4 §D: AIS 구역 문법('|' 로 최대 3 구역, 구역마다 상자 1~16, 전체 1,024자) · 구역 포함 판정 · 공백의 구역 적용. */
class AisBboxesTest {
    static final String OPS = "-90,-180,90,0|-90,45,90,180"; // 운영 권장값(계약 v4 §D)

    @Test void parseShards_noPipeIsOneShard_pipeSplitsInOrder() {
        List<List<double[]>> one = AisBboxes.parseShards("18,105,46,150; 30,-10,60,40;");
        assertThat(one).hasSize(1);
        assertThat(one.getFirst()).hasSize(2);
        List<List<double[]>> two = AisBboxes.parseShards(OPS);
        assertThat(two).hasSize(2);
        assertThat(two.get(0).getFirst()).containsExactly(-90, -180, 90, 0);
        assertThat(two.get(1).getFirst()).containsExactly(-90, 45, 90, 180);
        assertThat(AisBboxes.parseShards(" 0,0,1,1 | 2,2,3,3;4,4,5,5 | 6,6,7,7 ")).extracting(List::size).containsExactly(1, 2, 1);
    }

    @Test void parseShards_limits() {
        String sixteen = String.join(";", Collections.nCopies(16, "0,0,1,1"));
        assertThat(AisBboxes.parseShards(sixteen + "|" + sixteen + "|" + sixteen)).as("16 boxes per shard, 3 shards").hasSize(3);
        String seventeen = String.join(";", Collections.nCopies(17, "0,0,1,1"));
        String tenLong = String.join(";", Collections.nCopies(10, "0.123456,0.123456,1.123456,1.123456")); // 359자 — 구역 하나로는 유효
        assertThat(AisBboxes.parseShards(tenLong + "|" + tenLong)).hasSize(2);
        for (String bad : new String[]{"0,0,1,1|0,0,1,1|0,0,1,1|0,0,1,1", "0,0,1,1|", "|0,0,1,1", "0,0,1,1||2,2,3,3", "0,0,1,1| |2,2,3,3",
                "0,0,1,1|;", "0,0,1,1|" + seventeen, "0,0,1,1|91,0,1,1", "0,0,1,1|0,0,1", "", "|",
                tenLong + "|" + tenLong + "|" + tenLong}) // 전체 1,079자 > 1,024
            assertThatThrownBy(() -> AisBboxes.parseShards(bad)).as(bad).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> AisBboxes.parseShards("0,0,1,1|0,0,1,1|0,0,1,1|0,0,1,1")).hasMessageContaining("at most 3 shards");
        assertThatThrownBy(() -> AisBboxes.parseShards("0,0,1,1|")).hasMessageContaining("empty shard");
        assertThatThrownBy(() -> AisBboxes.parseShards("1".repeat(1025))).hasMessageContaining("1024");
        // 구역 하나(scope)는 '|' 를 받지 않는다
        assertThatThrownBy(() -> AisBboxes.parse(OPS)).isInstanceOf(IllegalArgumentException.class);
    }

    @Test void contains_cornersInAnyOrder_boundaryIncluded() {
        List<double[]> boxes = AisBboxes.parse("46,150,18,105;-10,-20,-5,-30");
        assertThat(AisBboxes.contains(boxes, 35, 129)).isTrue();
        assertThat(AisBboxes.contains(boxes, 18, 105)).as("corner").isTrue();
        assertThat(AisBboxes.contains(boxes, -7, -25)).isTrue();
        assertThat(AisBboxes.contains(boxes, 17.9, 129)).isFalse();
        assertThat(AisBboxes.contains(boxes, 35, 30)).isFalse();
    }

    @Test void scope_equalityByText_coverageAndContains() {
        AisScope a = AisScope.parse(" -90,-180,90,0 ");
        assertThat(a.text()).isEqualTo("-90,-180,90,0");
        assertThat(a).isEqualTo(AisScope.parse("-90,-180,90,0")).hasSameHashCodeAs(AisScope.parse("-90,-180,90,0"));
        assertThat(a).isNotEqualTo(AisScope.parse("-90,45,90,180")).isNotEqualTo("-90,-180,90,0");
        assertThat(a.toString()).isEqualTo("-90,-180,90,0");
        assertThat(a.coverage()).containsExactly(List.of(-90.0, -180.0, 90.0, 0.0));
        assertThat(a.contains(40, -70)).isTrue();
        assertThat(a.contains(35, 129)).isFalse();
        assertThatThrownBy(() -> AisScope.parse(null)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> AisScope.parse("")).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> AisScope.parse(OPS)).isInstanceOf(IllegalArgumentException.class);
    }

    @Test void gap_appliesEverywhereWithoutScope_onlyInsideWithScope() {
        Instant t = Instant.parse("2026-09-28T03:00:00Z");
        AisGap legacy = new AisGap(t, t.plusSeconds(60), "r", "aisstream");
        assertThat(legacy.scope()).isNull();
        assertThat(legacy.scopeText()).isNull();
        assertThat(legacy.appliesAt(35, 129)).isTrue();
        assertThat(legacy.appliesAt(40, -70)).isTrue();
        AisGap asia = new AisGap(t, t.plusSeconds(60), "r", "aisstream", AisScope.parse("-90,45,90,180"));
        assertThat(asia.scopeText()).isEqualTo("-90,45,90,180");
        assertThat(asia.appliesAt(35, 129)).isTrue();
        assertThat(asia.appliesAt(40, -70)).isFalse();
    }
}
