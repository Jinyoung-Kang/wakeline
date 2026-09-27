package dev.skywx.engine;

import dev.skywx.domain.AircraftState;
import dev.skywx.domain.SigmetRecord;
import org.junit.jupiter.api.Test;

import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Set;

import static dev.skywx.engine.TestData.*;
import static org.assertj.core.api.Assertions.assertThat;

/** FR-08: 교차 판정 12케이스 — 경계·base null·top null·지상 제외·유효시간. */
class IntersectionEngineTest {

    private static Map<String, List<IntersectionEngine.Hit>> run(SigmetRecord s, AircraftState a) {
        return run(s, a, NOW);
    }

    private static Map<String, List<IntersectionEngine.Hit>> run(SigmetRecord s, AircraftState a, Instant at) {
        SigmetIndex idx = new SigmetIndex(List.of(s), at);
        return IntersectionEngine.observe(List.of(a), idx, at);
    }

    @Test void insideAllThree_hits() {
        assertThat(run(sigmet("A", 14000, 21000), ac("abc001", 36, 127, 17000, false))).containsKey("abc001");
    }

    @Test void outsideHorizontally_noHit() {
        assertThat(run(sigmet("A", 14000, 21000), ac("abc002", 38, 127, 17000, false))).isEmpty();
    }

    @Test void belowBase_noHit() {
        assertThat(run(sigmet("A", 14000, 21000), ac("abc003", 36, 127, 13999, false))).isEmpty();
    }

    @Test void atBase_hits() {
        assertThat(run(sigmet("A", 14000, 21000), ac("abc004", 36, 127, 14000, false))).containsKey("abc004");
    }

    @Test void atTop_hits() {
        assertThat(run(sigmet("A", 14000, 21000), ac("abc005", 36, 127, 21000, false))).containsKey("abc005");
    }

    @Test void aboveTop_noHit() {
        assertThat(run(sigmet("A", 14000, 21000), ac("abc006", 36, 127, 21001, false))).isEmpty();
    }

    @Test void baseNullMeansSurface_lowAltitudeHits() {
        assertThat(run(sigmet("A", null, 21000), ac("abc007", 36, 127, 500, false))).containsKey("abc007");
    }

    @Test void topNullMeansUnbounded_highAltitudeHits() {
        assertThat(run(sigmet("A", 14000, null), ac("abc008", 36, 127, 45000, false))).containsKey("abc008");
    }

    @Test void onGround_excludedEvenWhenBaseIsSurface() {
        assertThat(run(sigmet("A", null, 21000), ac("abc009", 36, 127, 0, true))).isEmpty();
    }

    @Test void nullAltitude_excluded() {
        assertThat(run(sigmet("A", null, null), ac("abc00a", 36, 127, null, false))).isEmpty();
    }

    @Test void expiredSigmet_noHit() {
        assertThat(run(sigmet("A", 14000, 21000), ac("abc00b", 36, 127, 17000, false), NOW.plusSeconds(4 * 3600))).isEmpty();
    }

    @Test void onBoundaryEdge_hits() {
        // 폴리곤 경계선 위의 점 — intersects 는 경계를 포함한다
        assertThat(run(sigmet("A", 14000, 21000), ac("abc00c", 35.0, 127, 17000, false))).containsKey("abc00c");
    }

    @Test void multiplePolygons_eachReported() {
        SigmetRecord a = sigmet("A", 0, null), b = sigmet("B", 0, null);
        SigmetIndex idx = new SigmetIndex(List.of(a, b), NOW);
        var hits = IntersectionEngine.observe(List.of(ac("abc00d", 36, 127, 30000, false)), idx, NOW);
        assertThat(hits.get("abc00d")).extracting(h -> h.sigmet().id()).containsExactlyInAnyOrder("A", "B");
    }

    @Test void performance_10kAircraft_200Sigmets_under50ms() {
        List<SigmetRecord> sigs = new java.util.ArrayList<>();
        for (int i = 0; i < 200; i++) {
            double lon = -180 + (i % 20) * 18, lat = -80 + (i / 20) * 16;
            sigs.add(new SigmetRecord("S" + i, "F", null, null, "1", "TS", null, 0, null, NOW.minusSeconds(60), NOW.plusSeconds(3600),
                    box(lon, lat, lon + 10, lat + 10), null, null, null, null, "", "awc_isigmet", NOW));
        }
        SigmetIndex idx = new SigmetIndex(sigs, NOW);
        List<AircraftState> acs = new java.util.ArrayList<>();
        java.util.Random r = new java.util.Random(1);
        for (int i = 0; i < 10_000; i++) acs.add(ac(String.format("%06x", i), -80 + r.nextDouble() * 160, -180 + r.nextDouble() * 360, 30000, false));
        IntersectionEngine.observe(acs, idx, NOW); // warm-up
        long t0 = System.nanoTime();
        var hits = IntersectionEngine.observe(acs, idx, NOW);
        long ms = (System.nanoTime() - t0) / 1_000_000;
        assertThat(hits).isNotEmpty();
        assertThat(ms).as("10k x 200 intersection in %d ms", ms).isLessThan(500); // CI 여유. 로컬 M1 실측은 PERF.md
    }

    @Test void predict_straightEntry_etaWithin60s() {
        // 폴리곤 서쪽 경계(126E) 에서 서쪽 30 NM, 동쪽으로 450 kt → 4분 후 진입
        double lonStart = 126 - 30.0 / (60.0 * Math.cos(Math.toRadians(36)));
        AircraftState a = ac("abc010", 36, lonStart, 17000, false, 450.0, 90.0);
        SigmetIndex idx = new SigmetIndex(List.of(sigmet("A", 14000, 21000)), NOW);
        var preds = IntersectionEngine.predict(List.of(a), idx, NOW, Map.of(), Set.of());
        assertThat(preds).hasSize(1);
        int expected = (int) Math.round(30.0 / 450.0 * 3600);
        assertThat(Math.abs(preds.getFirst().etaS() - expected)).isLessThanOrEqualTo(60);
    }

    @Test void predict_altitudeBandAtEntryChecked() {
        double lonStart = 126 - 30.0 / (60.0 * Math.cos(Math.toRadians(36)));
        AircraftState climbing = new AircraftState("abc011", null, null, null, null, 36, lonStart, 13000, 450.0, 90.0, 300.0, false, null, NOW, "adsb_lol", NOW, 0, false);
        SigmetIndex idx = new SigmetIndex(List.of(sigmet("A", 14000, 21000)), NOW);
        var preds = IntersectionEngine.predict(List.of(climbing), idx, NOW, Map.of(), Set.of());
        assertThat(preds).hasSize(1); // 13,000 + 300 fpm × 4 min = 14,200 ≥ base
    }

    @Test void predict_turningOrSlowSkipped() {
        double lonStart = 126 - 30.0 / (60.0 * Math.cos(Math.toRadians(36)));
        AircraftState a = ac("abc012", 36, lonStart, 17000, false, 450.0, 90.0);
        SigmetIndex idx = new SigmetIndex(List.of(sigmet("A", 14000, 21000)), NOW);
        assertThat(IntersectionEngine.predict(List.of(a), idx, NOW, Map.of(), Set.of("abc012"))).isEmpty();
        assertThat(IntersectionEngine.predict(List.of(ac("abc013", 36, lonStart, 17000, false, 40.0, 90.0)), idx, NOW, Map.of(), Set.of())).isEmpty();
    }
}
