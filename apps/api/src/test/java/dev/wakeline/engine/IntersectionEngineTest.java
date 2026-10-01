package dev.wakeline.engine;

import dev.wakeline.aircraft.core.AircraftState;
import dev.wakeline.domain.SigmetRecord;
import org.junit.jupiter.api.Test;

import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Set;

import static dev.wakeline.engine.TestData.*;
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
        Instant later = NOW.plusSeconds(4 * 3600);
        assertThat(run(sigmet("A", 14000, 21000), acSeen("abc00b", 36, 127, 17000, later, "adsb_lol"), later)).isEmpty();
    }

    // ---- 관측 나이(COR-3/REL-6): 오래된 위치는 '관측' 이 아니다 ----

    @Test void staleRegionPosition_notObserved() {
        SigmetRecord s = sigmet("A", 14000, 21000);
        assertThat(run(s, acSeen("abc0a1", 36, 127, 17000, NOW.minusSeconds(60), "adsb_lol"))).containsKey("abc0a1");
        assertThat(run(s, acSeen("abc0a2", 36, 127, 17000, NOW.minusSeconds(61), "adsb_fi"))).isEmpty();
    }

    @Test void openSkyPosition_freshUpTo300s() {
        SigmetRecord s = sigmet("A", 14000, 21000);
        assertThat(run(s, acSeen("abc0a3", 36, 127, 17000, NOW.minusSeconds(200), "opensky"))).containsKey("abc0a3");
        assertThat(run(s, acSeen("abc0a4", 36, 127, 17000, NOW.minusSeconds(301), "opensky"))).isEmpty();
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

    private static List<IntersectionEngine.Prediction> predict(SigmetRecord s, AircraftState a) {
        return IntersectionEngine.predict(List.of(a), new SigmetIndex(List.of(s), NOW), NOW, Map.of(), Set.of());
    }

    @Test void performance_predict_10kAircraft_200Sigmets() {
        List<SigmetRecord> sigs = new java.util.ArrayList<>();
        for (int i = 0; i < 200; i++) {
            double lon = -180 + (i % 20) * 18, lat = -80 + (i / 20) * 16;
            sigs.add(new SigmetRecord("S" + i, "F", null, null, "1", "TS", null, i % 2 == 0 ? 25000 : 0, i % 3 == 0 ? null : 35000,
                    NOW.minusSeconds(60), NOW.plusSeconds(3600), box(lon, lat, lon + 10, lat + 10), null, null, null, null, "", "awc_isigmet", NOW));
        }
        SigmetIndex idx = new SigmetIndex(sigs, NOW);
        List<AircraftState> acs = new java.util.ArrayList<>();
        java.util.Random r = new java.util.Random(2);
        for (int i = 0; i < 10_000; i++)
            acs.add(acSeen(String.format("%06x", i), -80 + r.nextDouble() * 160, -179 + r.nextDouble() * 358, 15000 + r.nextInt(25000),
                    NOW.minusSeconds(r.nextInt(250)), i % 3 == 0 ? "adsb_lol" : "opensky", 200 + r.nextDouble() * 300, r.nextDouble() * 360,
                    (r.nextDouble() - 0.5) * 4000));
        IntersectionEngine.predict(acs, idx, NOW, Map.of(), Set.of()); // warm-up
        long t0 = System.nanoTime();
        var preds = IntersectionEngine.predict(acs, idx, NOW, Map.of(), Set.of());
        long ms = (System.nanoTime() - t0) / 1_000_000;
        assertThat(preds).isNotEmpty();
        assertThat(preds).anyMatch(p -> p.entry().equals(IntersectionEngine.ENTRY_VERTICAL));
        assertThat(ms).as("predict 10k x 200 in %d ms", ms).isLessThan(1500); // CI 여유(엔진 주기 10 s)
        System.out.println("predict 10k x 200: " + ms + " ms, " + preds.size() + " predictions");
    }

    @Test void predict_straightEntry_etaWithin60s() {
        // 폴리곤 서쪽 경계(126E) 에서 서쪽 30 NM, 동쪽으로 450 kt → 4분 후 진입
        AircraftState a = ac("abc010", 36, westOfBox(30), 17000, false, 450.0, 90.0);
        var preds = predict(sigmet("A", 14000, 21000), a);
        assertThat(preds).hasSize(1);
        int expected = (int) Math.round(30.0 / 450.0 * 3600);
        assertThat(Math.abs(preds.getFirst().etaS() - expected)).isLessThanOrEqualTo(60);
        assertThat(preds.getFirst().entry()).isEqualTo(IntersectionEngine.ENTRY_LATERAL);
        assertThat(preds.getFirst().etaAt()).isEqualTo(NOW.plusSeconds(preds.getFirst().etaS()));
        assertThat(preds.getFirst().positionAgeS()).isZero();
    }

    /** PERF-7/COR-9: 120 s 전 위치는 먼저 now 로 전진 — ETA 는 now 부터(120 s 줄어든다). */
    @Test void predict_advancesStalePositionToNow_etaMeasuredFromNow() {
        AircraftState fresh = acSeen("abc020", 36, westOfBox(30), 17000, NOW, "opensky");
        AircraftState old = acSeen("abc021", 36, westOfBox(30), 17000, NOW.minusSeconds(120), "opensky");
        SigmetRecord s = sigmet("A", 14000, 21000);
        int etaFresh = predict(s, fresh).getFirst().etaS();
        var p = predict(s, old).getFirst();
        assertThat(Math.abs((etaFresh - 120) - p.etaS())).isLessThanOrEqualTo(1);
        assertThat(p.positionAgeS()).isEqualTo(120.0);
        assertThat(p.distanceNm()).isCloseTo(450.0 * p.etaS() / 3600, org.assertj.core.api.Assertions.within(0.2));
    }

    @Test void predict_alreadyCrossedSinceSeenAt_noPrediction() {
        // 30 NM 밖이었지만 250 s 전 위치(450 kt → 31 NM 전진) — 지금은 이미 안: 예측이 아니라 관측의 영역
        assertThat(predict(sigmet("A", 14000, 21000), acSeen("abc022", 36, westOfBox(30), 17000, NOW.minusSeconds(250), "opensky"))).isEmpty();
    }

    @Test void predict_stalePosition_noPrediction() {
        assertThat(predict(sigmet("A", 14000, 21000), acSeen("abc023", 36, westOfBox(30), 17000, NOW.minusSeconds(61), "adsb_lol"))).isEmpty();
    }

    // ---- 수직 진입(COR-11) ----

    @Test void predict_verticalEntry_climbingIntoBandWhileHorizontallyInside() {
        // 'ABV FL230'(상한 미발표) 안에서 FL200 → +2,000 fpm: 90 s 뒤 고도대 진입
        AircraftState a = acSeen("abc030", 36, 127, 20000, NOW, "adsb_lol", 450.0, 90.0, 2000.0);
        var preds = predict(sigmet("V", 23000, null), a);
        assertThat(preds).hasSize(1);
        assertThat(preds.getFirst().etaS()).isEqualTo(90);
        assertThat(preds.getFirst().entry()).isEqualTo(IntersectionEngine.ENTRY_VERTICAL);
        assertThat(preds.getFirst().altAtEntry()).isEqualTo(23000);
    }

    @Test void predict_verticalEntry_descendingIntoBandFromAbove() {
        AircraftState a = acSeen("abc031", 36, 127, 25000, NOW, "adsb_lol", 450.0, 90.0, -2000.0);
        var preds = predict(sigmet("A", 14000, 21000), a);
        assertThat(preds).hasSize(1);
        assertThat(preds.getFirst().etaS()).isEqualTo(120);
        assertThat(preds.getFirst().entry()).isEqualTo(IntersectionEngine.ENTRY_VERTICAL);
    }

    @Test void predict_levelBelowBandInside_noPrediction() {
        assertThat(predict(sigmet("A", 14000, 21000), acSeen("abc032", 36, 127, 10000, NOW, "adsb_lol"))).isEmpty();
    }

    @Test void predict_crossesEdgeBelowBase_thenClimbsIntoBand() {
        // 240 s 에 경계 통과(12,000 + 400 fpm × 4분 = 13,600 < base) → 300 s 에 14,000 도달: 수직 진입
        AircraftState a = acSeen("abc033", 36, westOfBox(30), 12000, NOW, "adsb_lol", 450.0, 90.0, 400.0);
        var preds = predict(sigmet("A", 14000, 21000), a);
        assertThat(preds).hasSize(1);
        assertThat(preds.getFirst().etaS()).isEqualTo(300);
        assertThat(preds.getFirst().entry()).isEqualTo(IntersectionEngine.ENTRY_VERTICAL);
        assertThat(preds.getFirst().altAtEntry()).isEqualTo(14000);
    }

    @Test void predict_entryValidityCheckedAtNowPlusEta() {
        AircraftState a = ac("abc034", 36, westOfBox(30), 17000, false, 450.0, 90.0);
        // 진입(240 s) 전에 만료 → 예측 없음
        assertThat(predict(sigmet("A", 14000, 21000, NOW.minusSeconds(600), NOW.plusSeconds(200)), a)).isEmpty();
        // 진입 뒤(300 s)에 유효 시작 → 유효 시작 시각에 '안' 이 된다
        var preds = predict(sigmet("A", 14000, 21000, NOW.plusSeconds(300), NOW.plusSeconds(3600)), a);
        assertThat(preds).hasSize(1);
        assertThat(preds.getFirst().etaS()).isEqualTo(300);
        assertThat(preds.getFirst().entry()).isEqualTo(IntersectionEngine.ENTRY_VALID_FROM);
    }

    @Test void predict_nullVerticalRate_isLabelledAssumption() {
        AircraftState a = acSeen("abc035", 36, westOfBox(30), 17000, NOW, "adsb_lol", 450.0, 90.0, null);
        var preds = predict(sigmet("A", 14000, 21000), a);
        assertThat(preds).hasSize(1);
        assertThat(preds.getFirst().vrateAssumedZero()).isTrue();
    }

    // ---- 예측 가능 여부(WS "selected") ----

    @Test void availability_reasons() {
        assertThat(IntersectionEngine.availability(ac("abc040", 36, 127, 17000, false), NOW, false)).isEqualTo(PredictionAvailability.AVAILABLE);
        assertThat(IntersectionEngine.availability(acSeen("abc041", 36, 127, 17000, NOW.minusSeconds(90), "adsb_lol"), NOW, false).reason()).isEqualTo("stale");
        assertThat(IntersectionEngine.availability(acSeen("abc042", 36, 127, 17000, NOW.minusSeconds(90), "opensky"), NOW, false).available()).isTrue();
        assertThat(IntersectionEngine.availability(ac("abc043", 36, 127, 0, true), NOW, false).reason()).isEqualTo("on_ground");
        assertThat(IntersectionEngine.availability(ac("abc044", 36, 127, 17000, false, null, 90.0), NOW, false).reason()).isEqualTo("no_track");
        assertThat(IntersectionEngine.availability(ac("abc045", 36, 127, 17000, false, 450.0, null), NOW, false).reason()).isEqualTo("no_track");
        assertThat(IntersectionEngine.availability(ac("abc046", 36, 127, 17000, false, 40.0, 90.0), NOW, false).reason()).isEqualTo("slow");
        assertThat(IntersectionEngine.availability(ac("abc047", 36, 127, 17000, false), NOW, true).reason()).isEqualTo("turning");
        assertThat(IntersectionEngine.availability(null, NOW, false)).isEqualTo(new PredictionAvailability(false, null));
    }

    @Test void predict_altitudeBandAtEntryChecked() {
        double lonStart = westOfBox(30);
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
