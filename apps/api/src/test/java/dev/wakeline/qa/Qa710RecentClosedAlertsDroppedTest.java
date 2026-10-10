package dev.wakeline.qa;

import dev.wakeline.watch.RecentClosedAlerts;
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

/**
 * QA-710(출시 QA 2차 · 기능): /api/v1/watch 의 closed_dropped 는 "닫힌 것은 최근 15분 · 상한 5,000건 — 버린 수"(계약 v5 §G50) — 상한 때문에 창 안의 닫힘을
 * 잃었다는 표시다. 그런데 15분 지난 항목은 /watch(항공기 포함) 요청이 올 때만 지워지므로, 요청이 없는 동안 지난 항목이 상한을 채우고 그 뒤의 닫힘마다 '버림'이
 * 늘어난다 — 창 안의 것은 하나도 잃지 않았는데 창이 짧아졌다고 알린다.
 */
class Qa710RecentClosedAlertsDroppedTest {
    static AlertStateMachine.Event closed(long id, Instant leftAt) {
        Alert a = new Alert(id, "OBSERVED", "aaaaaa", null, "S1", "RKRR", "TS", null, leftAt.minusSeconds(600), null, null, null, null, null, Map.of(), false);
        return new AlertStateMachine.Event(AlertStateMachine.EventType.LEFT, a.closed(leftAt, Alert.CLOSE_LEFT, null));
    }

    @Test
    void expiredEntriesDoNotCountAsDropped() {
        RecentClosedAlerts r = new RecentClosedAlerts();
        Instant now = Instant.now();
        List<AlertStateMachine.Event> old = new ArrayList<>();
        for (int i = 0; i < 5_000; i++) old.add(closed(i, now.minusSeconds(3600)));  // 한 시간 전 닫힘 — 이미 창(15분) 밖
        r.onAlerts(new EngineEvents.AlertsChanged(old));
        r.onAlerts(new EngineEvents.AlertsChanged(List.of(closed(9_999, now.minusSeconds(5)))));  // 지금 닫힘 하나
        assertThat(r.forHexes(Set.of("aaaaaa"), now).get("aaaaaa")).extracting(Alert::id).containsExactly(9_999L);
        assertThat(r.dropped()).as("nothing inside the 15-minute window was lost").isZero();
    }
}
