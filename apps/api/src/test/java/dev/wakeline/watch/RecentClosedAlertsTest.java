package dev.wakeline.watch;

import dev.wakeline.weather.core.Alert;
import dev.wakeline.weather.core.AlertStateMachine;
import dev.wakeline.weather.core.EngineEvents;
import org.junit.jupiter.api.Test;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;

import static org.assertj.core.api.Assertions.assertThat;

/** 최근 닫힌 알림(§G50): 닫힌 사건만 · 15분 창 · 상한을 넘으면 오래된 것부터 버리고 센다. */
class RecentClosedAlertsTest {
    static final Instant T = Instant.parse("2026-10-09T10:00:00Z");

    static AlertStateMachine.Event ev(AlertStateMachine.EventType type, long id, String hex, Instant leftAt) {
        Alert a = new Alert(id, "OBSERVED", hex, null, "S1", "RKRR", "TS", null, T.minusSeconds(3600), null, null, null, null, null, Map.of(), false);
        return new AlertStateMachine.Event(type, leftAt == null ? a : a.closed(leftAt, Alert.CLOSE_LEFT, null));
    }

    @Test
    void keepsOnlyClosedAlertsInsideTheWindow() {
        RecentClosedAlerts r = new RecentClosedAlerts();
        r.onAlerts(new EngineEvents.AlertsChanged(List.of(ev(AlertStateMachine.EventType.ENTERED, 1, "aaaaaa", null),
                ev(AlertStateMachine.EventType.LEFT, 2, "aaaaaa", T.minusSeconds(1000)),
                ev(AlertStateMachine.EventType.LEFT, 3, "aaaaaa", T.minusSeconds(100)),
                ev(AlertStateMachine.EventType.LOST, 4, "bbbbbb", T.minusSeconds(50)))));
        var got = r.forHexes(Set.of("aaaaaa", "cccccc"), T);
        assertThat(got).containsOnlyKeys("aaaaaa");
        assertThat(got.get("aaaaaa")).extracting(Alert::id).containsExactly(3L);
        assertThat(r.forHexes(Set.of(), T)).isEmpty();
    }

    @Test
    void dropsTheOldestOverTheCap() {
        RecentClosedAlerts r = new RecentClosedAlerts();
        List<AlertStateMachine.Event> evs = new ArrayList<>();
        for (int i = 0; i < RecentClosedAlerts.MAX + 3; i++) evs.add(ev(AlertStateMachine.EventType.LEFT, i, "aaaaaa", T.minusSeconds(10)));
        r.onAlerts(new EngineEvents.AlertsChanged(evs));
        assertThat(r.dropped()).isEqualTo(3);
        assertThat(r.forHexes(Set.of("aaaaaa"), T).get("aaaaaa")).hasSize(RecentClosedAlerts.MAX).first().extracting(Alert::id).isEqualTo(3L);
    }
}
