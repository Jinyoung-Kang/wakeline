package dev.skywx.engine;

import dev.skywx.domain.AircraftState;
import dev.skywx.domain.SigmetRecord;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicLong;

import static dev.skywx.engine.TestData.*;
import static org.assertj.core.api.Assertions.assertThat;

/** FR-09: 히스테리시스(진입 2회, 이탈 3회). 경계 왕복 시퀀스에서 이벤트가 2건(ENTERED·LEFT)만 나와야 한다. */
class AlertStateMachineTest {
    private final AtomicLong ids = new AtomicLong();
    private final SigmetRecord s = sigmet("A", 14000, 21000);

    private List<AlertStateMachine.Event> step(AlertStateMachine fsm, boolean inside) {
        AircraftState a = ac("abc001", inside ? 36 : 40, 127, 17000, false);
        var hits = inside ? Map.of("abc001", List.of(new IntersectionEngine.Hit("abc001", s, 0, 17000))) : Map.<String, List<IntersectionEngine.Hit>>of();
        return fsm.step(hits, List.of(), Map.of("abc001", a), NOW);
    }

    @Test void boundaryFlapping_producesOnlyEnteredAndLeft() {
        AlertStateMachine fsm = new AlertStateMachine(ids::incrementAndGet);
        boolean[] seq = {true, true, false, true, false, true, false, false, false};
        List<AlertStateMachine.EventType> types = new ArrayList<>();
        for (boolean in : seq) for (var e : step(fsm, in)) types.add(e.type());
        assertThat(types).containsExactly(AlertStateMachine.EventType.ENTERED, AlertStateMachine.EventType.LEFT);
    }

    @Test void singleObservation_doesNotEnter() {
        AlertStateMachine fsm = new AlertStateMachine(ids::incrementAndGet);
        assertThat(step(fsm, true)).isEmpty();
        assertThat(step(fsm, false)).isEmpty();
        assertThat(fsm.activeObserved()).isEmpty();
    }

    @Test void evidenceIsAlwaysPresent() {
        AlertStateMachine fsm = new AlertStateMachine(ids::incrementAndGet);
        step(fsm, true);
        var ev = step(fsm, true);
        assertThat(ev).hasSize(1);
        assertThat(ev.getFirst().alert().evidence()).containsKeys("band_ft", "aircraft_alt_ft", "valid_to", "method", "judged_at");
        assertThat(ev.getFirst().alert().estimated()).isFalse();
    }

    @Test void prediction_onceThenUpdatedThenCleared_andSupersededByEntry() {
        AlertStateMachine fsm = new AlertStateMachine(ids::incrementAndGet);
        AircraftState a = ac("abc002", 36, 125, 17000, false);
        var p1 = new IntersectionEngine.Prediction("abc002", s, 0, 240, 17000, 30.0);
        var e1 = fsm.step(Map.of(), List.of(p1), Map.of("abc002", a), NOW);
        assertThat(e1).extracting(AlertStateMachine.Event::type).containsExactly(AlertStateMachine.EventType.PREDICTED);
        assertThat(e1.getFirst().alert().estimated()).isTrue();
        var e2 = fsm.step(Map.of(), List.of(new IntersectionEngine.Prediction("abc002", s, 0, 235, 17000, 29.0)), Map.of("abc002", a), NOW);
        assertThat(e2).isEmpty(); // ETA 변화 < 30 s → 이벤트 없음
        var e3 = fsm.step(Map.of(), List.of(new IntersectionEngine.Prediction("abc002", s, 0, 120, 17000, 15.0)), Map.of("abc002", a), NOW);
        assertThat(e3).extracting(AlertStateMachine.Event::type).containsExactly(AlertStateMachine.EventType.PREDICTION_UPDATED);
        // 관측 진입 확정 → 예측은 CLEARED
        // 관측 진입(예측기는 안에 있는 기체를 더 이상 예측하지 않음) → CLEARED 1회, 2회 연속 후 ENTERED 1회
        var hits = Map.of("abc002", List.of(new IntersectionEngine.Hit("abc002", s, 0, 17000)));
        var all = new ArrayList<>(fsm.step(hits, List.of(), Map.of("abc002", a), NOW));
        all.addAll(fsm.step(hits, List.of(), Map.of("abc002", a), NOW));
        assertThat(all).extracting(AlertStateMachine.Event::type)
                .containsExactly(AlertStateMachine.EventType.PREDICTION_CLEARED, AlertStateMachine.EventType.ENTERED);
        assertThat(fsm.activePredicted()).isEmpty();
        assertThat(fsm.activeObserved()).hasSize(1);
    }
}
