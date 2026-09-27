package dev.wakeline.ws;

import dev.wakeline.domain.Bbox;
import dev.wakeline.domain.ShipCategory;
import dev.wakeline.domain.ShipState;
import dev.wakeline.domain.ShipStatic;
import dev.wakeline.ingest.ShipStore;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** 선박 격자: 줌별 칸 크기, 칸 중심·수·대표 분류(동률은 열거 순서), bbox 겹침 필터, 고정 격자 경계. */
class ShipGridTest {
    static final Instant T = Instant.now();

    static ShipState pos(String mmsi, double lat, double lon) {
        return new ShipState(mmsi, lat, lon, 5.0, 10.0, null, null, null, "epfs", T, "aisstream", "PositionReport", "A");
    }

    static ShipStatic stat(String mmsi, Integer type) {
        return new ShipStatic(mmsi, null, null, null, type, null, null, null, null, null, null, null, null, null, null, T, "aisstream");
    }

    @Test void cellDegByZoom() {
        assertThat(ShipGrid.cellDegFor(0)).isEqualTo(5.0);
        assertThat(ShipGrid.cellDegFor(2)).isEqualTo(5.0);
        assertThat(ShipGrid.cellDegFor(3)).isEqualTo(2.0);
        assertThat(ShipGrid.cellDegFor(4)).isEqualTo(2.0);
        assertThat(ShipGrid.cellDegFor(5)).isEqualTo(0.5);
        assertThat(ShipGrid.cellDegFor(6)).isEqualTo(0.5);
    }

    @Test void countsCentresAndDominantCategory() {
        ShipStore s = new ShipStore();
        List<ShipState> st = new ArrayList<>();
        List<ShipStatic> sc = new ArrayList<>();
        // 0.5° 칸 [35.0,35.5)×[129.0,129.5): 화물 2 · 탱커 2(동률 → 열거 순서의 앞: cargo) · 미상 1
        st.add(pos("440000001", 35.1, 129.1)); sc.add(stat("440000001", 70));
        st.add(pos("440000002", 35.2, 129.2)); sc.add(stat("440000002", 71));
        st.add(pos("440000003", 35.3, 129.3)); sc.add(stat("440000003", 80));
        st.add(pos("440000004", 35.4, 129.4)); sc.add(stat("440000004", 81));
        st.add(pos("440000005", 35.45, 129.45));
        // 다른 칸: 어선 1
        st.add(pos("440000006", -10.2, -30.7)); sc.add(stat("440000006", 30));
        // 격자 끝(북극·날짜변경선) — 마지막 칸에 들어간다
        st.add(pos("440000007", 90, 180));
        s.apply(st, sc, T, "aisstream", System.currentTimeMillis());
        ShipGrid g = ShipGrid.build(s.view());
        assertThat(g.version).isEqualTo(s.view().version());

        ShipGrid.Cell[] fine = g.cells(0.5);
        assertThat(fine).hasSize(3);
        ShipGrid.Cell busan = java.util.Arrays.stream(fine).filter(c -> c.minLat() == 35.0 && c.minLon() == 129.0).findFirst().orElseThrow();
        assertThat(busan.count()).isEqualTo(5);
        assertThat(busan.dominant()).isEqualTo(ShipCategory.CARGO);
        JsonNode j = WsTestKit.parse(busan.json());
        assertThat(j.get(0).asDouble()).isEqualTo(35.25);
        assertThat(j.get(1).asDouble()).isEqualTo(129.25);
        assertThat(j.get(2).asInt()).isEqualTo(5);
        assertThat(j.get(3).asString()).isEqualTo("cargo");
        ShipGrid.Cell pole = java.util.Arrays.stream(fine).filter(c -> c.minLat() == 89.5 && c.minLon() == 179.5).findFirst().orElseThrow();
        assertThat(pole.dominant()).isEqualTo(ShipCategory.UNKNOWN);

        ShipGrid.Cell[] coarse = g.cells(5.0);
        assertThat(java.util.Arrays.stream(coarse).mapToInt(ShipGrid.Cell::count).sum()).isEqualTo(7);
        ShipGrid.Cell south = java.util.Arrays.stream(coarse).filter(c -> c.count() == 1 && c.minLat() == -15.0).findFirst().orElseThrow();
        assertThat(south.minLon()).isEqualTo(-35.0);
        assertThat(south.dominant()).isEqualTo(ShipCategory.FISHING);
        assertThatThrownBy(() -> g.cells(1.0)).isInstanceOf(IllegalArgumentException.class);
    }

    @Test void cellsJsonFiltersByBboxOverlap() {
        ShipStore s = new ShipStore();
        s.apply(List.of(pos("440000001", 35.1, 129.1), pos("440000002", -10, -30)), List.of(), T, "aisstream", System.currentTimeMillis());
        ShipGrid g = ShipGrid.build(s.view());
        JsonNode all = WsTestKit.parse(g.cellsJson(2.0, Bbox.world()));
        assertThat(all.size()).isEqualTo(2);
        // 칸 [34,36)×[128,130) 과 모서리만 겹치는 bbox 도 포함(보이는 칸은 모두)
        JsonNode edge = WsTestKit.parse(g.cellsJson(2.0, new Bbox(129.9, 35.9, 131, 37)));
        assertThat(edge.size()).isEqualTo(1);
        assertThat(WsTestKit.parse(g.cellsJson(2.0, new Bbox(0, 0, 10, 10))).size()).isZero();
        assertThat(WsTestKit.parse(ShipGrid.build(new ShipStore().view()).cellsJson(0.5, Bbox.world())).size()).isZero();
        assertThat(ShipGrid.key(-90, -180, 5)).isZero();
    }

    /**
     * 측정(성능 주장은 측정값만): 선박 60,000 척(메모리 상한) 격자 세 단계 한 번 만들기(버전당 한 번)와 세션 하나의 bbox 거르기.
     * 결과는 표준 출력에 남긴다.
     */
    @Test void measure_gridBuildAndPerSessionFilter() {
        ShipStore s = new ShipStore();
        java.util.Random r = new java.util.Random(3);
        List<ShipState> st = new ArrayList<>();
        for (int i = 0; i < ShipStore.MAX_SHIPS; i++) st.add(pos(String.format("%09d", 200_000_000 + i), -70 + r.nextDouble() * 140, -180 + r.nextDouble() * 360));
        s.apply(st, List.of(), T, "aisstream", System.currentTimeMillis());
        for (int w = 0; w < 3; w++) ShipGrid.build(s.view()); // 예열
        long t0 = System.nanoTime();
        ShipGrid g = ShipGrid.build(s.view());
        double buildMs = (System.nanoTime() - t0) / 1e6;
        long t1 = System.nanoTime();
        int n = 0;
        for (int i = 0; i < 100; i++) n += g.cellsJson(0.5, new Bbox(120, 20, 150, 45)).length();
        double filterMs = (System.nanoTime() - t1) / 1e6 / 100;
        long t2 = System.nanoTime();
        int[] c = {0};
        for (int i = 0; i < 100; i++) s.view().forEachIn(new Bbox(128, 34, 130, 36), x -> c[0]++);
        double bboxMs = (System.nanoTime() - t2) / 1e6 / 100;
        System.out.printf("MEASURE ship grid: %d ships -> build 3 levels %.1f ms (once per version); per-session 0.5deg filter %.2f ms (%d cells total); "
                + "z>=7 bbox scan %.3f ms%n", ShipStore.MAX_SHIPS, buildMs, filterMs, g.cells(0.5).length, bboxMs);
        assertThat(n).isPositive();
        assertThat(buildMs).isLessThan(5_000);
    }
}
