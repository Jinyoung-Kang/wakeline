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

/** 선박 격자: 줌별 칸 크기, 칸 중심·수·대표 분류(동률은 열거 순서)·선종별 수(계약 v5 §B2), bbox 겹침 필터, 고정 격자 경계. */
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
        // 계약 v5 §B2: 다섯 번째 원소 = 선종별 수(ShipCategory 선언 순서 = schemas/vectors/ship-categories.v1.json) — 화물 2 · 유조 2 · 미상 1
        assertThat(j.size()).isEqualTo(5);
        assertThat(counts(j.get(4))).containsExactly(2, 2, 0, 0, 0, 0, 0, 0, 0, 0, 1);
        ShipGrid.Cell pole = java.util.Arrays.stream(fine).filter(c -> c.minLat() == 89.5 && c.minLon() == 179.5).findFirst().orElseThrow();
        assertThat(pole.dominant()).isEqualTo(ShipCategory.UNKNOWN);
        assertThat(counts(WsTestKit.parse(pole.json()).get(4))).containsExactly(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1);

        ShipGrid.Cell[] coarse = g.cells(5.0);
        assertThat(java.util.Arrays.stream(coarse).mapToInt(ShipGrid.Cell::count).sum()).isEqualTo(7);
        ShipGrid.Cell south = java.util.Arrays.stream(coarse).filter(c -> c.count() == 1 && c.minLat() == -15.0).findFirst().orElseThrow();
        assertThat(south.minLon()).isEqualTo(-35.0);
        assertThat(south.dominant()).isEqualTo(ShipCategory.FISHING);
        assertThatThrownBy(() -> g.cells(1.0)).isInstanceOf(IllegalArgumentException.class);
        // 모든 단계·모든 칸: 선종별 수의 합 = 칸의 척수, 대표 분류 = 가장 많은 선종(동률은 앞)
        for (double deg : ShipGrid.LEVELS) for (ShipGrid.Cell c : g.cells(deg)) {
            int[] n = counts(WsTestKit.parse(c.json()).get(4));
            assertThat(n).hasSize(ShipCategory.count());
            assertThat(java.util.Arrays.stream(n).sum()).as("cell %s at %s°", c.json(), deg).isEqualTo(c.count());
            int best = 0;
            for (int k = 1; k < n.length; k++) if (n[k] > n[best]) best = k;
            assertThat(c.dominant().ordinal()).isEqualTo(best);
        }
    }

    static int[] counts(JsonNode arr) {
        assertThat(arr.isArray()).as("per-category counts is an array: %s", arr).isTrue();
        int[] out = new int[arr.size()];
        for (int i = 0; i < out.length; i++) {
            assertThat(arr.get(i).isInt()).as("count %d is an integer", i).isTrue();
            out[i] = arr.get(i).asInt();
        }
        return out;
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

    /**
     * 측정(계약 v5 §B2 — 성능 주장은 측정값만): 칸마다 선종별 수 배열을 붙인 ships_grid 메시지 크기를 붙이기 전(네 원소 칸)과 비교한다.
     * 선박 60,000 척(메모리 상한), 위도 ±70° · 경도 전체에 고르게, 선종 11종에 고르게(합성 — 실제 분포는 해안에 몰려 칸이 더 적고 0 이 더 많다).
     * 네 원소 칸은 실제 칸 JSON 에서 다섯 번째 원소를 떼어 만든다. deflate 크기는 브라우저가 쓰는 permessage-deflate 의 근사
     * (java.util.zip.Deflater 기본 수준 · nowrap — 창 크기·문맥 이월은 다를 수 있다). 결과는 표준 출력에 남긴다.
     */
    @Test void measure_gridMessageSizeWithAndWithoutCategoryCounts() {
        ShipStore s = new ShipStore();
        java.util.Random r = new java.util.Random(7);
        int[] codes = {70, 80, 60, 30, 31, 36, 40, 50, 35, 90, 0}; // 선언 순서대로 한 코드씩(0 = 미상)
        List<ShipState> st = new ArrayList<>();
        List<ShipStatic> sc = new ArrayList<>();
        for (int i = 0; i < ShipStore.MAX_SHIPS; i++) {
            String m = String.format("%09d", 200_000_000 + i);
            st.add(pos(m, -70 + r.nextDouble() * 140, -180 + r.nextDouble() * 360));
            int code = codes[r.nextInt(codes.length)];
            if (code != 0) sc.add(stat(m, code));
        }
        s.apply(st, sc, T, "aisstream", System.currentTimeMillis());
        ShipGrid g = ShipGrid.build(s.view());
        record Case(String name, double deg, Bbox bbox) {}
        List<Case> cases = List.of(new Case("z<3 world 5deg", 5.0, Bbox.world()), new Case("z3-4 E.Asia 2deg", 2.0, new Bbox(100, 0, 160, 50)),
                new Case("capped 0.5deg", 0.5, new Bbox(120, 20, 150, 45)));
        for (Case c : cases) {
            String cells = g.cellsJson(c.deg(), c.bbox());
            JsonNode parsed = WsTestKit.parse(cells);
            StringBuilder legacy = new StringBuilder("[");
            for (JsonNode cell : parsed) {
                assertThat(cell.size()).isEqualTo(5);
                if (legacy.length() > 1) legacy.append(',');
                legacy.append('[').append(cell.get(0)).append(',').append(cell.get(1)).append(',').append(cell.get(2)).append(',').append(cell.get(3)).append(']');
            }
            legacy.append(']');
            String after = message(c.deg(), cells), before = message(c.deg(), legacy.toString());
            assertThat(WsTestKit.parse(before).path("cells").get(0).size()).isEqualTo(4);
            System.out.printf("MEASURE ships_grid %s: %d cells -> before %,d B (deflate %,d B) / after %,d B (deflate %,d B) = +%.0f%% raw, +%.0f%% deflate%n",
                    c.name(), parsed.size(), before.length(), deflated(before), after.length(), deflated(after),
                    100.0 * (after.length() - before.length()) / before.length(), 100.0 * (deflated(after) - deflated(before)) / deflated(before));
            // 칸 하나에 11개 정수 배열(최소 "[0,0,0,0,0,0,0,0,0,0,0]" 23자 + 쉼표)이 붙는다 — 칸마다 그 이상, 척수 자릿수만큼 더
            assertThat(after.length() - before.length()).isGreaterThanOrEqualTo(parsed.size() * 24);
        }
    }

    static String message(double deg, String cells) {
        return WsTestKit.JSON.writeValueAsString(new WsMessages.ShipsGridMsg("ships_grid", T, deg, cells, null));
    }

    static int deflated(String s) {
        java.util.zip.Deflater d = new java.util.zip.Deflater(java.util.zip.Deflater.DEFAULT_COMPRESSION, true);
        d.setInput(s.getBytes(java.nio.charset.StandardCharsets.UTF_8));
        d.finish();
        byte[] buf = new byte[64 * 1024];
        int n = 0;
        while (!d.finished()) n += d.deflate(buf);
        d.end();
        return n;
    }
}
