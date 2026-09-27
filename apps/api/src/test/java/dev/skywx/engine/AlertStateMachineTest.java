package dev.skywx.engine;

import dev.skywx.domain.AircraftState;
import dev.skywx.domain.Alert;
import dev.skywx.domain.SigmetRecord;
import org.junit.jupiter.api.Test;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.atomic.AtomicLong;

import static dev.skywx.engine.AlertStateMachine.EventType.*;
import static dev.skywx.engine.TestData.*;
import static org.assertj.core.api.Assertions.assertThat;

/**
 * FR-09: 히스테리시스(진입 2회, 이탈 3회)는 서로 다른 관측(seen_at 변화)을 센다.
 * 같은 위치의 재판정(다른 스코프·SIGMET 갱신으로 엔진이 다시 돌 때)은 세지 않는다.
 * 안에 있던 기체가 사라지면 LEFT 가 아니라 LOST(signal_lost) — 그 기체 스코프의 새 스냅샷 3번 뒤.
 */
class AlertStateMachineTest {
    private static final String HEX = "abc001";
    private static final Set<String> REGION = Set.of(HEX);
    private final AtomicLong ids = new AtomicLong();
    private final SigmetRecord s = sigmet("A", 14000, 21000);

    /** region 기체 한 번의 관측(seen_at = NOW + i×10 s)과, 그 관측을 담은 region 스냅샷 버전 i. */
    private static AircraftState obs(int i, boolean inside) {
        Instant t = NOW.plusSeconds(10L * i);
        return acSeen(HEX, inside ? 36 : 40, 127, 17000, t, "adsb_lol");
    }

    private Map<String, List<IntersectionEngine.Hit>> hitsFor(AircraftState a, boolean inside) {
        return inside ? Map.of(a.hex(), List.of(new IntersectionEngine.Hit(a.hex(), s, 0, 17000))) : Map.of();
    }

    private List<AlertStateMachine.Event> stepObs(AlertStateMachine fsm, int i, boolean inside) {
        AircraftState a = obs(i, inside);
        return fsm.step(hitsFor(a, inside), List.of(), Map.of(HEX, a), a.seenAt(), cycle(i, 0, REGION));
    }

    private List<AlertStateMachine.EventType> types(List<AlertStateMachine.Event> evs) {
        return evs.stream().map(AlertStateMachine.Event::type).toList();
    }

    @Test void boundaryFlapping_producesOnlyEnteredAndLeft() {
        AlertStateMachine fsm = new AlertStateMachine(ids::incrementAndGet);
        boolean[] seq = {true, true, false, true, false, true, false, false, false};
        List<AlertStateMachine.EventType> types = new ArrayList<>();
        for (int i = 0; i < seq.length; i++) types.addAll(types(stepObs(fsm, i + 1, seq[i])));
        assertThat(types).containsExactly(ENTERED, LEFT);
    }

    @Test void singleObservation_doesNotEnter() {
        AlertStateMachine fsm = new AlertStateMachine(ids::incrementAndGet);
        assertThat(stepObs(fsm, 1, true)).isEmpty();
        assertThat(stepObs(fsm, 2, false)).isEmpty();
        assertThat(fsm.activeObserved()).isEmpty();
    }

    /** PERF-5/COR-1: 같은 AircraftState(같은 seen_at)를 여러 번 판정해도 진입이 확정되지 않는다. */
    @Test void sameObservationReJudged_doesNotConfirmEntry() {
        AlertStateMachine fsm = new AlertStateMachine(ids::incrementAndGet);
        AircraftState a = acSeen("abc0ff", 36, 127, 17000, NOW, "opensky"); // global 기체, 2분마다 한 번 관측
        var hits = hitsFor(a, true);
        // global 스냅샷(gv=1) 한 번 + 그 뒤 region 주기 5번(v=2..6)·SIGMET 재판정 — 모두 같은 관측
        List<AlertStateMachine.Event> all = new ArrayList<>();
        for (int v = 1; v <= 6; v++) all.addAll(fsm.step(hits, List.of(), Map.of(a.hex(), a), NOW.plusSeconds(10L * v), cycle(v + 1, 1, Set.of())));
        assertThat(all).isEmpty();
        // 다음 global 스냅샷에서 새 관측(seen_at 변화)이 안쪽이면 그때 확정
        AircraftState b = acSeen("abc0ff", 36, 127.1, 17000, NOW.plusSeconds(120), "opensky");
        var ev = fsm.step(hitsFor(b, true), List.of(), Map.of(b.hex(), b), NOW.plusSeconds(125), cycle(8, 7, Set.of()));
        assertThat(types(ev)).containsExactly(ENTERED);
        assertThat(ev.getFirst().alert().evidence().get("confirmations_seen_at"))
                .isEqualTo(List.of(NOW.toString(), NOW.plusSeconds(120).toString()));
    }

    @Test void evidence_recordsRealConfirmingObservations_andAssumptions() {
        AlertStateMachine fsm = new AlertStateMachine(ids::incrementAndGet);
        stepObs(fsm, 1, true);
        var ev = stepObs(fsm, 2, true);
        assertThat(ev).hasSize(1);
        Alert al = ev.getFirst().alert();
        assertThat(al.evidence()).containsKeys("band_ft", "aircraft_alt_ft", "valid_to", "method", "judged_at", "seen_at", "position_age_s");
        assertThat(al.evidence().get("confirmations")).isEqualTo(2);
        assertThat(al.evidence().get("confirmations_seen_at")).isEqualTo(List.of(NOW.plusSeconds(10).toString(), NOW.plusSeconds(20).toString()));
        assertThat(al.estimated()).isFalse();
        assertThat(al.closeReason()).isNull();
        assertThat(al.evidence()).doesNotContainKeys("top_assumed_unbounded", "base_assumed_surface");
    }

    @Test void unboundedTopAndSurfaceBase_areLabelledAsAssumptions() {
        SigmetRecord open = sigmet("B", null, null);
        AlertStateMachine fsm = new AlertStateMachine(ids::incrementAndGet);
        List<AlertStateMachine.Event> out = new ArrayList<>();
        for (int i = 1; i <= 2; i++) {
            AircraftState a = obs(i, true);
            out.addAll(fsm.step(Map.of(HEX, List.of(new IntersectionEngine.Hit(HEX, open, 0, 17000))), List.of(), Map.of(HEX, a), a.seenAt(), cycle(i, 0, REGION)));
        }
        Map<String, Object> ev = out.getFirst().alert().evidence();
        assertThat(ev.get("band_ft")).isEqualTo(java.util.Arrays.asList(0, null));
        assertThat(ev).containsEntry("top_assumed_unbounded", true).containsEntry("base_assumed_surface", true)
                .containsEntry("top_source", "unknown").containsEntry("base_source", "assumed_surface");
    }

    /** 이탈은 서로 다른 바깥 관측 3회 — 같은 바깥 관측을 여러 번 판정해도 LEFT 가 아니다. */
    @Test void leave_needsThreeDistinctOutsideObservations() {
        AlertStateMachine fsm = new AlertStateMachine(ids::incrementAndGet);
        stepObs(fsm, 1, true);
        stepObs(fsm, 2, true);
        AircraftState out1 = obs(3, false);
        for (int k = 0; k < 5; k++)
            assertThat(fsm.step(Map.of(), List.of(), Map.of(HEX, out1), out1.seenAt().plusSeconds(k), cycle(3, k, REGION))).isEmpty();
        assertThat(stepObs(fsm, 4, false)).isEmpty();
        var ev = stepObs(fsm, 5, false);
        assertThat(types(ev)).containsExactly(LEFT);
        Alert left = ev.getFirst().alert();
        assertThat(left.closeReason()).isEqualTo(Alert.CLOSE_LEFT);
        assertThat(left.leftAt()).isEqualTo(NOW.plusSeconds(50));
        assertThat((List<?>) left.evidence().get("left_confirmations_seen_at")).hasSize(3);
        assertThat(left.evidence()).doesNotContainKey("sigmet_expired");
    }

    /** COR-4: 안에 있던 region 기체가 스냅샷에서 사라지면 region 스냅샷 3번 뒤 LOST(signal_lost). LEFT 가 아니다. */
    @Test void disappearedWhileInside_isLostAfterThreeRegionSnapshots_notLeft() {
        AlertStateMachine fsm = new AlertStateMachine(ids::incrementAndGet);
        stepObs(fsm, 1, true);
        assertThat(types(stepObs(fsm, 2, true))).containsExactly(ENTERED);
        Instant t = NOW.plusSeconds(25);
        // 같은 region 버전으로 여러 번(SIGMET·global 재판정) — 부재로 세지 않는다
        for (int k = 0; k < 4; k++) assertThat(fsm.step(Map.of(), List.of(), Map.of(), t, cycle(2, 10 + k, Set.of()))).isEmpty();
        assertThat(fsm.step(Map.of(), List.of(), Map.of(), t.plusSeconds(10), cycle(3, 20, Set.of()))).isEmpty();
        assertThat(fsm.step(Map.of(), List.of(), Map.of(), t.plusSeconds(20), cycle(4, 20, Set.of()))).isEmpty();
        var ev = fsm.step(Map.of(), List.of(), Map.of(), t.plusSeconds(30), cycle(5, 20, Set.of()));
        assertThat(types(ev)).containsExactly(LOST);
        Alert lost = ev.getFirst().alert();
        assertThat(lost.closeReason()).isEqualTo(Alert.CLOSE_SIGNAL_LOST);
        assertThat(lost.leftAt()).isEqualTo(t.plusSeconds(30));
        assertThat(lost.evidence()).containsEntry("last_seen_at", NOW.plusSeconds(20).toString()).containsEntry("absent_snapshots", 3);
        assertThat(fsm.activeObserved()).isEmpty();
    }

    /** 위치가 오래된(60 s 초과) region 기체는 관측이 아니라 부재로 센다 — 얼어붙은 위치로 '안' 이 유지되지 않는다. */
    @Test void stalePositionCountsAsAbsence() {
        AlertStateMachine fsm = new AlertStateMachine(ids::incrementAndGet);
        stepObs(fsm, 1, true);
        stepObs(fsm, 2, true);
        AircraftState frozen = obs(2, true); // seen_at = NOW+20 s 그대로
        var hits = hitsFor(frozen, true);    // (엔진은 오래된 위치를 판정하지 않지만, FSM 도 스스로 거른다)
        List<AlertStateMachine.Event> all = new ArrayList<>();
        for (int v = 3; v <= 5; v++) all.addAll(fsm.step(hits, List.of(), Map.of(HEX, frozen), NOW.plusSeconds(90 + 10L * v), cycle(v, 0, REGION)));
        assertThat(types(all)).containsExactly(LOST);
    }

    /** global 기체의 부재는 global 스냅샷마다 센다 — region 주기(10 s)로 30 s 만에 소실 처리하지 않는다. */
    @Test void globalAircraftAbsence_countsGlobalSnapshotsOnly_untilGlobalFeedStale() {
        AlertStateMachine fsm = new AlertStateMachine(ids::incrementAndGet);
        AircraftState g1 = acSeen("abc0aa", 36, 127, 17000, NOW, "opensky");
        AircraftState g2 = acSeen("abc0aa", 36, 127.1, 17000, NOW.plusSeconds(120), "opensky");
        fsm.step(hitsFor(g1, true), List.of(), Map.of(g1.hex(), g1), NOW, cycle(1, 1, Set.of()));
        assertThat(types(fsm.step(hitsFor(g2, true), List.of(), Map.of(g2.hex(), g2), NOW.plusSeconds(121), cycle(2, 2, Set.of())))).containsExactly(ENTERED);
        // 사라짐: region 주기 10번(v 3..12, global 2 그대로, global 피드 살아 있음) → 아직 아님
        for (int v = 3; v <= 12; v++)
            assertThat(fsm.step(Map.of(), List.of(), Map.of(), NOW.plusSeconds(121 + v), cycle(v, 2, Set.of()))).isEmpty();
        // global 스냅샷 2번 → 아직, 3번째에 LOST
        assertThat(fsm.step(Map.of(), List.of(), Map.of(), NOW.plusSeconds(240), cycle(13, 13, Set.of()))).isEmpty();
        assertThat(fsm.step(Map.of(), List.of(), Map.of(), NOW.plusSeconds(360), cycle(14, 14, Set.of()))).isEmpty();
        assertThat(types(fsm.step(Map.of(), List.of(), Map.of(), NOW.plusSeconds(480), cycle(15, 15, Set.of())))).containsExactly(LOST);
    }

    /** global 피드가 끊기면(OpenSky 일시 중지 등) region 스냅샷으로 부재를 센다 — 얼어붙은 알림이 몇 시간 남지 않게. */
    @Test void globalFeedStale_absenceCountedOnRegionSnapshots() {
        AlertStateMachine fsm = new AlertStateMachine(ids::incrementAndGet);
        AircraftState g1 = acSeen("abc0bb", 36, 127, 17000, NOW, "opensky");
        AircraftState g2 = acSeen("abc0bb", 36, 127.1, 17000, NOW.plusSeconds(120), "opensky");
        fsm.step(hitsFor(g1, true), List.of(), Map.of(g1.hex(), g1), NOW, cycle(1, 1, Set.of()));
        fsm.step(hitsFor(g2, true), List.of(), Map.of(g2.hex(), g2), NOW.plusSeconds(121), cycle(2, 2, Set.of()));
        List<AlertStateMachine.Event> all = new ArrayList<>();
        for (int v = 3; v <= 5; v++)
            all.addAll(fsm.step(Map.of(), List.of(), Map.of(), NOW.plusSeconds(700 + v), new AlertStateMachine.Cycle(v, 2, false, true, Set.of())));
        assertThat(types(all)).containsExactly(LOST);
    }

    @Test void totalOutage_noNewSnapshots_keepsAlertOpen() {
        AlertStateMachine fsm = new AlertStateMachine(ids::incrementAndGet);
        stepObs(fsm, 1, true);
        stepObs(fsm, 2, true);
        // 스냅샷이 전혀 바뀌지 않는(버전 그대로) SIGMET 재판정만 반복
        for (int k = 0; k < 10; k++)
            assertThat(fsm.step(Map.of(), List.of(), Map.of(), NOW.plusSeconds(600 + k * 300L), new AlertStateMachine.Cycle(2, 0, true, true, REGION))).isEmpty();
        assertThat(fsm.activeObserved()).hasSize(1);
    }

    @Test void airborneWithoutAltitude_isNotCountedAsOutside() {
        AlertStateMachine fsm = new AlertStateMachine(ids::incrementAndGet);
        stepObs(fsm, 1, true);
        stepObs(fsm, 2, true);
        for (int i = 3; i <= 8; i++) {
            AircraftState noAlt = acSeen(HEX, 36, 127, null, NOW.plusSeconds(10L * i), "adsb_lol");
            assertThat(fsm.step(Map.of(), List.of(), Map.of(HEX, noAlt), noAlt.seenAt(), cycle(i, 0, REGION))).isEmpty();
        }
        assertThat(fsm.activeObserved()).hasSize(1);
    }

    @Test void leftAfterSigmetExpiry_isMarked() {
        SigmetRecord shortLived = sigmet("C", 14000, 21000, NOW.minusSeconds(600), NOW.plusSeconds(25));
        AlertStateMachine fsm = new AlertStateMachine(ids::incrementAndGet);
        List<AlertStateMachine.Event> out = new ArrayList<>();
        for (int i = 1; i <= 5; i++) {
            AircraftState a = obs(i, true);
            var hits = i <= 2 ? Map.of(HEX, List.of(new IntersectionEngine.Hit(HEX, shortLived, 0, 17000))) : Map.<String, List<IntersectionEngine.Hit>>of();
            out.addAll(fsm.step(hits, List.of(), Map.of(HEX, a), a.seenAt(), cycle(i, 0, REGION)));
        }
        assertThat(types(out)).containsExactly(ENTERED, LEFT);
        assertThat(out.get(1).alert().evidence()).containsEntry("sigmet_expired", true);
    }

    private static IntersectionEngine.Prediction pred(SigmetRecord s, int etaS, Instant judgedAt) {
        return new IntersectionEngine.Prediction("abc002", s, 0, etaS, judgedAt.plusSeconds(etaS), 17000, etaS * 450 / 3600.0,
                IntersectionEngine.ENTRY_LATERAL, 0, false);
    }

    @Test void prediction_onceThenUpdatedThenCleared_andSupersededByEntry() {
        AlertStateMachine fsm = new AlertStateMachine(ids::incrementAndGet);
        AircraftState a = acSeen("abc002", 36, 125, 17000, NOW, "adsb_lol");
        var e1 = fsm.step(Map.of(), List.of(pred(s, 240, NOW)), Map.of("abc002", a), NOW, cycle(1, 0, Set.of("abc002")));
        assertThat(types(e1)).containsExactly(PREDICTED);
        Alert p = e1.getFirst().alert();
        assertThat(p.estimated()).isTrue();
        assertThat(p.etaAt()).isEqualTo(NOW.plusSeconds(240));
        assertThat(p.evidence()).containsEntry("judged_at", NOW.toString()).containsKeys("position_age_s", "entry");
        // 10 s 뒤 ETA 230 s = 같은 예상 진입 시각 → 이벤트 없음(카운트다운은 클라이언트가 eta_at 으로)
        var e2 = fsm.step(Map.of(), List.of(pred(s, 230, NOW.plusSeconds(10))), Map.of("abc002", a), NOW.plusSeconds(10), cycle(2, 0, Set.of("abc002")));
        assertThat(e2).isEmpty();
        // 예상 진입 시각이 2분 당겨짐 → UPDATED(같은 id)
        var e3 = fsm.step(Map.of(), List.of(pred(s, 110, NOW.plusSeconds(10))), Map.of("abc002", a), NOW.plusSeconds(10), cycle(3, 0, Set.of("abc002")));
        assertThat(types(e3)).containsExactly(PREDICTION_UPDATED);
        assertThat(e3.getFirst().alert().id()).isEqualTo(p.id());
        // 관측 진입(예측기는 안에 있는 기체를 더 이상 예측하지 않음) → CLEARED 1회, 서로 다른 관측 2회 후 ENTERED 1회
        List<AlertStateMachine.Event> all = new ArrayList<>();
        for (int i = 4; i <= 5; i++) {
            AircraftState in = acSeen("abc002", 36, 127, 17000, NOW.plusSeconds(10L * i), "adsb_lol");
            all.addAll(fsm.step(Map.of("abc002", List.of(new IntersectionEngine.Hit("abc002", s, 0, 17000))), List.of(),
                    Map.of("abc002", in), in.seenAt(), cycle(i, 0, Set.of("abc002"))));
        }
        assertThat(types(all)).containsExactly(PREDICTION_CLEARED, ENTERED);
        assertThat(all.getFirst().alert().closeReason()).isEqualTo(Alert.CLOSE_PREDICTION_CLEARED);
        assertThat(fsm.activePredicted()).isEmpty();
        assertThat(fsm.activeObserved()).hasSize(1);
    }

    @Test void predictionThatDisappears_isClearedWithReason() {
        AlertStateMachine fsm = new AlertStateMachine(ids::incrementAndGet);
        AircraftState a = acSeen("abc002", 36, 125, 17000, NOW, "adsb_lol");
        fsm.step(Map.of(), List.of(pred(s, 240, NOW)), Map.of("abc002", a), NOW, cycle(1, 0, Set.of("abc002")));
        var ev = fsm.step(Map.of(), List.of(), Map.of("abc002", a), NOW.plusSeconds(10), cycle(2, 0, Set.of("abc002")));
        assertThat(types(ev)).containsExactly(PREDICTION_CLEARED);
        assertThat(ev.getFirst().alert().closeReason()).isEqualTo(Alert.CLOSE_PREDICTION_CLEARED);
        assertThat(ev.getFirst().alert().leftAt()).isEqualTo(NOW.plusSeconds(10));
    }

    @Test void severalPolygonsOfSameSigmet_yieldOnePrediction() {
        AlertStateMachine fsm = new AlertStateMachine(ids::incrementAndGet);
        AircraftState a = acSeen("abc002", 36, 125, 17000, NOW, "adsb_lol");
        var p0 = pred(s, 300, NOW);
        var p1 = new IntersectionEngine.Prediction("abc002", s, 1, 200, NOW.plusSeconds(200), 17000, 25.0, IntersectionEngine.ENTRY_LATERAL, 0, false);
        var ev = fsm.step(Map.of(), List.of(p0, p1), Map.of("abc002", a), NOW, cycle(1, 0, Set.of("abc002")));
        assertThat(types(ev)).containsExactly(PREDICTED);
        assertThat(ev.getFirst().alert().etaS()).isEqualTo(200);
    }
}
