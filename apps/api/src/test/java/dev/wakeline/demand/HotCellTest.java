package dev.wakeline.demand;

import dev.wakeline.geo.Bbox;
import dev.wakeline.geo.Geo;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.within;

/** 핫 리전 셀(계약 v2 §A1): 0.5° 격자 · 반경 50 NM 단위 50–250 · 키 형식 · 범위 검증. */
class HotCellTest {

    @Test void key_formatMatchesContract() {
        assertThat(new HotCell(35.5, 139.5, 150).key()).isEqualTo("35.5:139.5:150");
        assertThat(new HotCell(-0.5, -179.5, 50).key()).isEqualTo("-0.5:-179.5:50");
        assertThat(new HotCell(5.0, 0.0, 250).key()).isEqualTo("5.0:0.0:250");
    }

    @Test void parse_acceptsContractKeys_rejectsFormatAndRange() {
        assertThat(HotCell.parse("35.5:139.5:150")).isEqualTo(new HotCell(35.5, 139.5, 150));
        assertThat(HotCell.parse("-85.0:-180.0:50")).isEqualTo(new HotCell(-85.0, -180.0, 50));
        assertThat(HotCell.parse("85.5:10.0:50")).isNull();      // 위도 ±85 밖
        assertThat(HotCell.parse("10.0:180.5:50")).isNull();     // 경도 ±180 밖
        assertThat(HotCell.parse("35.3:139.5:150")).isNull();    // 0.5° 격자가 아님
        assertThat(HotCell.parse("35.5:139.5:120")).isNull();    // 50 단위가 아님
        assertThat(HotCell.parse("35.5:139.5:300")).isNull();    // 250 초과
        assertThat(HotCell.parse("35:139.5:150")).isNull();
        assertThat(HotCell.parse("35.5:139.5:150;x")).isNull();
        assertThat(HotCell.parse(null)).isNull();
        assertThat(HotCell.parse("1".repeat(40))).isNull();
    }

    @Test void forViewport_centreSnapsToHalfDegree_radiusRoundsUpBy50_clampedTo50And250() {
        // 작은 화면(줌 ~10): 반대각선 ≈ 21 NM → 최소 50
        HotCell small = HotCell.forViewport(new Bbox(139.4, 35.4, 139.9, 35.7));
        assertThat(small.lat()).isEqualTo(35.5);
        assertThat(small.lon()).isEqualTo(139.5);
        assertThat(small.radiusNm()).isEqualTo(50);
        // 중간(≈ 3°×2°): 반대각선을 50 NM 단위로 올림
        HotCell mid = HotCell.forViewport(new Bbox(138.0, 34.0, 141.0, 36.0));
        double diag = Math.max(Geo.haversineNm(34.0, 138.0, 36.0, 141.0), Geo.haversineNm(36.0, 138.0, 34.0, 141.0)) / 2;
        assertThat(mid.radiusNm()).isEqualTo((int) (Math.ceil(diag / 50) * 50));
        assertThat(mid.radiusNm()).isBetween(100, 250);
        // 큰 화면(줌 7, ≈ 15°×10°): 250 상한
        assertThat(HotCell.forViewport(new Bbox(130, 30, 145, 40)).radiusNm()).isEqualTo(250);
        // 음수 좌표도 격자(-0.2 → 0.0, 음의 0 이 아님)
        HotCell neg = HotCell.forViewport(new Bbox(-0.3, -0.3, -0.1, -0.1));
        assertThat(neg.key()).isEqualTo("0.0:0.0:50");
        HotCell neg2 = HotCell.forViewport(new Bbox(-40.9, -12.9, -40.5, -12.5));
        assertThat(neg2.key()).startsWith("-12.5:-40.5:");
    }

    @Test void forViewport_beyond85Lat_isNull() {
        assertThat(HotCell.forViewport(new Bbox(10, 85, 20, 89))).isNull();
        assertThat(HotCell.forViewport(new Bbox(10, -89, 20, -85.5))).isNull();
    }

    @Test void geo_haversine_knownDistance() {
        // 위도 1° ≈ 60 NM
        assertThat(Geo.haversineNm(0, 0, 1, 0)).isCloseTo(60.04, within(0.1));
        assertThat(Geo.haversineNm(10, 10, 10, 10)).isZero();
    }

    @Test void bbox_intersects() {
        Bbox a = new Bbox(0, 0, 10, 10);
        assertThat(a.intersects(new Bbox(5, 5, 15, 15))).isTrue();
        assertThat(a.intersects(new Bbox(10, 10, 20, 20))).isTrue(); // 경계 포함
        assertThat(a.intersects(new Bbox(11, 0, 20, 10))).isFalse();
        assertThat(a.intersects(new Bbox(0, 11, 10, 20))).isFalse();
        assertThat(a.intersects(null)).isFalse();
    }
}
