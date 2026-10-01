package dev.wakeline.engine;

import dev.wakeline.aircraft.core.AircraftState;
import dev.wakeline.domain.Alert;
import dev.wakeline.domain.SigmetRecord;
import org.junit.jupiter.api.Test;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.atomic.AtomicLong;

import static dev.wakeline.engine.AlertStateMachine.EventType.*;
import static dev.wakeline.engine.TestData.*;
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

    // ---------- 경보 종료(SIGMET_ENDED, DH-6·API-CONC-4) ----------

    private static AlertStateMachine.Cycle cycleWith(long v, AlertStateMachine.SigmetSet set) {
        return new AlertStateMachine.Cycle(v, 0, false, false, REGION, set);
    }

    private static AlertStateMachine.SigmetSet setOf(Instant fetchedAt, SigmetRecord... recs) {
        Map<String, SigmetRecord> m = new java.util.LinkedHashMap<>();
        for (SigmetRecord r : recs) m.put(r.id(), r);
        return AlertStateMachine.SigmetSet.of(m, fetchedAt);
    }

    /** 확정(진입) 뒤 i=3..n 은 세트 set 으로 판정 — 항공기는 계속 같은 자리(안쪽)에 있다. */
    private List<AlertStateMachine.Event> enterThen(AlertStateMachine fsm, SigmetRecord sig, AlertStateMachine.SigmetSet before,
                                                    AlertStateMachine.SigmetSet after, int steps) {
        List<AlertStateMachine.Event> out = new ArrayList<>();
        for (int i = 1; i <= steps; i++) {
            AircraftState a = obs(i, true);
            boolean inIndex = i <= 2;
            var hits = inIndex ? Map.of(HEX, List.of(new IntersectionEngine.Hit(HEX, sig, 0, 17000))) : Map.<String, List<IntersectionEngine.Hit>>of();
            out.addAll(fsm.step(hits, List.of(), Map.of(HEX, a), a.seenAt(), cycleWith(i, inIndex ? before : after)));
        }
        return out;
    }

    @Test void sigmetExpiry_closesAsSigmetEnded_atValidTo_notLeft() {
        SigmetRecord shortLived = sigmet("C", 14000, 21000, NOW.minusSeconds(600), NOW.plusSeconds(25));
        AlertStateMachine.SigmetSet set = setOf(NOW, shortLived);
        AlertStateMachine fsm = new AlertStateMachine(ids::incrementAndGet);
        var out = enterThen(fsm, shortLived, set, set, 6);
        assertThat(types(out)).containsExactly(ENTERED, SIGMET_ENDED); // 이탈(LEFT)이 아니다 — 항공기는 그대로 안에 있었다
        Alert ended = out.get(1).alert();
        assertThat(ended.closeReason()).isEqualTo(Alert.CLOSE_SIGMET_ENDED);
        assertThat(ended.leftAt()).isEqualTo(NOW.plusSeconds(25));          // 만료 시각(판정 주기 시각이 아니라)
        assertThat(ended.evidence()).containsEntry("end_cause", "expired").containsEntry("sigmet_valid_to", NOW.plusSeconds(25).toString())
                .doesNotContainKey("sigmet_set_fetched_at").doesNotContainKey("sigmet_expired");
        assertThat(fsm.activeObserved()).isEmpty();
    }

    @Test void sigmetWithdrawnFromTheSet_closesAsSigmetEnded_withdrawn() {
        SigmetRecord other = sigmet("OTHER", 14000, 21000);
        AlertStateMachine.SigmetSet before = setOf(NOW, s, other);
        Instant f2 = NOW.plusSeconds(25);
        AlertStateMachine.SigmetSet after = setOf(f2, other); // 같은 공급자의 다른 경보는 있다 → 철회(취소·대체)
        AlertStateMachine fsm = new AlertStateMachine(ids::incrementAndGet);
        var out = enterThen(fsm, s, before, after, 3);
        assertThat(types(out)).containsExactly(ENTERED, SIGMET_ENDED);
        Alert ended = out.get(1).alert();
        assertThat(ended.leftAt()).isEqualTo(f2);
        assertThat(ended.evidence()).containsEntry("end_cause", "withdrawn").containsEntry("sigmet_set_fetched_at", f2.toString());
    }

    @Test void sigmetMissingTogetherWithItsWholeProvider_isNotCalledWithdrawn() {
        SigmetRecord us = new SigmetRecord("US1", "KZNY", null, null, "U1", "TS", null, 0, null, NOW.minusSeconds(600), NOW.plusSeconds(3600),
                box(126, 35, 128, 37), null, null, null, null, "RAW", "awc_airsigmet", NOW, SigmetRecord.BASE_ASSUMED_SURFACE, SigmetRecord.TOP_UNKNOWN);
        AlertStateMachine.SigmetSet before = setOf(NOW, s, us);
        AlertStateMachine.SigmetSet after = setOf(NOW.plusSeconds(25), s); // awc_airsigmet 피드가 통째로 빠진 세트
        AlertStateMachine fsm = new AlertStateMachine(ids::incrementAndGet);
        var out = enterThen(fsm, us, before, after, 3);
        assertThat(types(out)).containsExactly(ENTERED, SIGMET_ENDED);
        assertThat(out.get(1).alert().evidence()).containsEntry("end_cause", "provider_missing");
    }

    @Test void endedSigmet_dropsUnconfirmedTracksSilently_andLeftAtNeverPrecedesEntry() {
        AlertStateMachine fsm = new AlertStateMachine(ids::incrementAndGet);
        AircraftState a1 = obs(1, true);
        fsm.step(hitsFor(a1, true), List.of(), Map.of(HEX, a1), a1.seenAt(), cycleWith(1, setOf(NOW, s)));
        AircraftState a2 = obs(2, true);
        // 확정 전(안쪽 1회)에 경보가 빠졌다 — 알림이 없었으므로 아무것도 내지 않는다
        assertThat(fsm.step(Map.of(), List.of(), Map.of(HEX, a2), a2.seenAt(), cycleWith(2, setOf(NOW.minusSeconds(3600))))).isEmpty();
        assertThat(fsm.activeObserved()).isEmpty();
        // 수집기 시계가 늦어 세트 수신 시각이 진입보다 앞서도 left_at 은 진입 시각보다 앞서지 않는다
        AlertStateMachine fsm2 = new AlertStateMachine(ids::incrementAndGet);
        var out = enterThen(fsm2, s, setOf(NOW, s, sigmet("OTHER", 1, 2)), setOf(NOW.minusSeconds(3600), sigmet("OTHER", 1, 2)), 3);
        Alert ended = out.get(1).alert();
        assertThat(ended.leftAt()).isEqualTo(ended.enteredAt());
    }

    @Test void predictionOfAnEndedSigmet_isClearedWithTheCause() {
        AlertStateMachine fsm = new AlertStateMachine(ids::incrementAndGet);
        AircraftState a = acSeen("abc002", 36, 125, 17000, NOW, "adsb_lol");
        fsm.step(Map.of(), List.of(pred(s, 240, NOW)), Map.of("abc002", a), NOW, new AlertStateMachine.Cycle(1, 0, false, false, Set.of("abc002"), setOf(NOW, s, sigmet("OTHER", 1, 2))));
        var ev = fsm.step(Map.of(), List.of(), Map.of("abc002", a), NOW.plusSeconds(10),
                new AlertStateMachine.Cycle(2, 0, false, false, Set.of("abc002"), setOf(NOW.plusSeconds(5), sigmet("OTHER", 1, 2))));
        assertThat(types(ev)).containsExactly(PREDICTION_CLEARED);
        assertThat(ev.getFirst().alert().evidence()).containsEntry("cleared_by", "sigmet_ended").containsEntry("end_cause", "withdrawn");
        assertThat(ev.getFirst().alert().closeReason()).isEqualTo(Alert.CLOSE_PREDICTION_CLEARED);
    }

    /** DH-4: "TOP ABV FL390" 은 상한의 하한 — 판정은 무제한 가정, 근거에 두 가정을 밝힌다. */
    @Test void lowerBoundTop_isJudgedUnbounded_andBothAssumptionsAreLabelled() {
        SigmetRecord abv = new SigmetRecord("ABV", "FIMM", null, null, "A01", "TS", "EMBD", 0, 39000, NOW.minusSeconds(600), NOW.plusSeconds(3600),
                box(126, 35, 128, 37), null, null, null, null, "EMBD TS ... TOP ABV FL390", "awc_isigmet", NOW,
                SigmetRecord.BASE_ASSUMED_SURFACE, SigmetRecord.TOP_RAW_TEXT_LOWER_BOUND);
        assertThat(abv.topIsLowerBound()).isTrue();
        assertThat(abv.judgedTopFt()).isNull();
        assertThat(abv.bandContains(41000)).as("FL410 is inside a SIGMET whose tops are above FL390").isTrue();
        AlertStateMachine fsm = new AlertStateMachine(ids::incrementAndGet);
        List<AlertStateMachine.Event> out = new ArrayList<>();
        for (int i = 1; i <= 2; i++) {
            AircraftState a = obs(i, true);
            out.addAll(fsm.step(Map.of(HEX, List.of(new IntersectionEngine.Hit(HEX, abv, 0, 41000))), List.of(), Map.of(HEX, a), a.seenAt(), cycle(i, 0, REGION)));
        }
        Map<String, Object> ev = out.getFirst().alert().evidence();
        assertThat(ev.get("band_ft")).isEqualTo(java.util.Arrays.asList(0, 39000));
        assertThat(ev).containsEntry("top_source", "raw_text_lower_bound").containsEntry("top_is_lower_bound", true)
                .containsEntry("top_assumed_unbounded", true);
        // 발표된 상한(json)은 그대로 상한이다
        assertThat(sigmet("J", 14000, 21000).bandContains(21001)).isFalse();
        assertThat(sigmet("J", 14000, 21000).topIsLowerBound()).isFalse();
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

    // ---------- 수요 스코프(계약 v2 §A3) · 신선도 병합(DH-2) ----------

    /** 테스트용 스코프 정보: hex → 출처, 스코프 → 버전, 끊긴 스코프, 조회가 끝난 (출처, hex). */
    static final class FakeScopes implements AlertStateMachine.Scopes {
        final Map<String, String> source = new java.util.HashMap<>();
        final Map<String, Long> versions = new java.util.HashMap<>();
        final Set<String> stale = new java.util.HashSet<>();
        final Set<String> ended = new java.util.HashSet<>();

        @Override public String scopeOf(String hex) {
            String src = source.get(hex);
            return src == null ? null : src.startsWith("hot:") ? "hot" : src;
        }
        @Override public String sourceOf(String hex) { return source.get(hex); }
        @Override public long version(String scope) { return versions.getOrDefault(scope, 0L); }
        @Override public boolean feedStale(String scope) { return stale.contains(scope); }
        @Override public boolean covering(String src, String hex) { return !ended.contains(src + "|" + hex); }
    }

    private static AlertStateMachine.Cycle cyc(FakeScopes sc) {
        return new AlertStateMachine.Cycle(sc.version("region"), sc.version("global"), false, false, Set.of(), null, sc);
    }

    /** focus(5 s) 관측으로 진입 → 선택 해제로 focus 조회가 끝나고 관측이 없어짐 → focus 메시지 3번 뒤 LOST(coverage_ended). */
    @Test void focusScope_absenceCountedOnFocusMessages_coverageEndedFlagged() {
        AlertStateMachine fsm = new AlertStateMachine(ids::incrementAndGet);
        FakeScopes sc = new FakeScopes();
        String hex = "abc0f1";
        sc.source.put(hex, "focus");
        for (int i = 1; i <= 2; i++) {
            sc.versions.put("focus", (long) i);
            AircraftState a = acSeen(hex, 36, 127, 17000, NOW.plusSeconds(5L * i), "adsb_fi");
            var ev = fsm.step(hitsFor(a, true), List.of(), Map.of(hex, a), a.seenAt(), cyc(sc));
            if (i == 2) assertThat(types(ev)).containsExactly(ENTERED);
        }
        sc.source.remove(hex);
        sc.ended.add("focus|" + hex); // 선택 해제 — 임대에서 빠졌다
        // region 메시지는 focus 스코프의 부재로 세지 않는다
        sc.versions.put("region", 100L);
        assertThat(fsm.step(Map.of(), List.of(), Map.of(), NOW.plusSeconds(20), cyc(sc))).isEmpty();
        List<AlertStateMachine.Event> all = new ArrayList<>();
        for (long v = 3; v <= 5; v++) {
            sc.versions.put("focus", v);
            all.addAll(fsm.step(Map.of(), List.of(), Map.of(), NOW.plusSeconds(20 + v), cyc(sc)));
        }
        assertThat(types(all)).containsExactly(LOST);
        Map<String, Object> ev = all.getFirst().alert().evidence();
        assertThat(ev).containsEntry("scope", "focus").containsEntry("coverage_ended", true);
    }

    /** 수요 스코프 피드가 끊기면(수집기 focus 중단) 다른 스코프의 새 메시지로 센다 — 알림이 얼어붙지 않는다. 조회 중이면 coverage_ended 없음. */
    @Test void hotScope_feedStale_countsAnyScope_noCoverageFlagWhileStillCovered() {
        AlertStateMachine fsm = new AlertStateMachine(ids::incrementAndGet);
        FakeScopes sc = new FakeScopes();
        String hex = "abc0f2";
        sc.source.put(hex, "hot:35.5:139.5:150");
        for (int i = 1; i <= 2; i++) {
            sc.versions.put("hot", (long) i);
            AircraftState a = acSeen(hex, 36, 127, 17000, NOW.plusSeconds(30L * i), "adsb_fi");
            fsm.step(hitsFor(a, true), List.of(), Map.of(hex, a), a.seenAt(), cyc(sc));
        }
        assertThat(fsm.activeObserved()).hasSize(1);
        sc.source.remove(hex);
        sc.stale.add("hot");
        List<AlertStateMachine.Event> all = new ArrayList<>();
        for (long v = 10; v <= 12; v++) {
            sc.versions.put("region", v);
            all.addAll(fsm.step(Map.of(), List.of(), Map.of(), NOW.plusSeconds(200 + v), cyc(sc)));
        }
        assertThat(types(all)).containsExactly(LOST);
        assertThat(all.getFirst().alert().evidence()).containsEntry("scope", "hot").doesNotContainKey("coverage_ended");
    }

    /** DH-2: 병합 관측이 global 이면 부재는 global 기준(관심 지역 스냅샷이 계속 와도 소실로 세지 않는다). */
    @Test void scopeFollowsChosenObservation_notRegionMembership() {
        AlertStateMachine fsm = new AlertStateMachine(ids::incrementAndGet);
        FakeScopes sc = new FakeScopes();
        String hex = "abc0f3";
        sc.source.put(hex, "global"); // region 스냅샷에도 있지만(동결) 더 새 global 관측이 뽑혔다
        for (int i = 1; i <= 2; i++) {
            sc.versions.put("global", (long) i);
            AircraftState a = acSeen(hex, 36, 127, 17000, NOW.plusSeconds(120L * i), "opensky");
            fsm.step(hitsFor(a, true), List.of(), Map.of(hex, a), a.seenAt(), new AlertStateMachine.Cycle(0, i, false, false, Set.of(hex), null, sc));
        }
        assertThat(fsm.activeObserved()).hasSize(1);
        sc.source.remove(hex);
        for (long v = 50; v <= 60; v++) { // region 스냅샷만 계속 — global 은 그대로
            sc.versions.put("region", v);
            assertThat(fsm.step(Map.of(), List.of(), Map.of(), NOW.plusSeconds(300 + v), cyc(sc))).isEmpty();
        }
    }
}
