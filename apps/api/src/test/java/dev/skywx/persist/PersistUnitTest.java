package dev.skywx.persist;

import dev.skywx.domain.Alert;
import dev.skywx.domain.SigmetRecord;
import dev.skywx.engine.AlertStateMachine.Event;
import dev.skywx.engine.AlertStateMachine.EventType;
import org.junit.jupiter.api.Test;

import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

/** DB 없이 확인하는 저장 규칙: 닫힘 이유, 이전 형식 SIGMET 출처(추정 없음), 내용 비교, 공항 관측 나이. */
class PersistUnitTest {
    static final Instant NOW = Instant.parse("2026-09-27T12:00:00Z");

    static Alert alert(String reason) {
        return new Alert(1, "OBSERVED", "abc123", null, "S", null, null, null, NOW, NOW, reason, null, null, null, Map.of(), false);
    }

    @Test
    void closeReasonFollowsTheEngineThenTheEventType() {
        assertThat(AlertRepository.closeReason(new Event(EventType.LOST, alert("signal_lost")))).isEqualTo("signal_lost");
        assertThat(AlertRepository.closeReason(new Event(EventType.LOST, alert(null)))).isEqualTo("signal_lost");
        assertThat(AlertRepository.closeReason(new Event(EventType.LEFT, alert(null)))).isEqualTo("left");
        assertThat(AlertRepository.closeReason(new Event(EventType.PREDICTION_CLEARED, alert(null)))).isEqualTo("prediction_cleared");
    }

    @Test
    void legacySigmetSourcesAreDeterministicOnly() {
        var zero = new SigmetRecord("A", "X", null, null, "1", "TS", null, 0, null, NOW, NOW.plusSeconds(60), null, "no_polygon", null, null, null, "r", "p", NOW);
        var band = new SigmetRecord("B", "X", null, null, "1", "TS", null, 3000, 20000, NOW, NOW.plusSeconds(60), null, "no_polygon", null, null, null, "r", "p", NOW);
        assertThat(SigmetRepository.dbBaseSource(zero)).isEqualTo("unknown");
        assertThat(SigmetRepository.dbTopSource(zero)).isEqualTo("unknown");
        assertThat(SigmetRepository.dbBaseSource(band)).isEqualTo("json");
        assertThat(SigmetRepository.dbTopSource(band)).isEqualTo("json");
        // 수신 시각만 다른 같은 경보는 같은 내용
        var later = new SigmetRecord("A", "X", null, null, "1", "TS", null, 0, null, NOW, NOW.plusSeconds(60), null, "no_polygon", null, null, null, "r", "p",
                NOW.plusSeconds(300));
        assertThat(SigmetRepository.contentOf(later)).isEqualTo(SigmetRepository.contentOf(zero));
    }

    @Test
    void airportObservationAge() {
        Map<String, Object> fresh = new LinkedHashMap<>(Map.of("obs_time", NOW.minusSeconds(600)));
        assertThat(AirportRepository.withAge(fresh, NOW)).containsEntry("obs_age_s", 600L).containsEntry("stale", false);
        Map<String, Object> old = new LinkedHashMap<>(Map.of("obs_time", NOW.minusSeconds(7_201)));
        assertThat(AirportRepository.withAge(old, NOW)).containsEntry("stale", true);
        Map<String, Object> none = new LinkedHashMap<>();
        none.put("obs_time", null);
        Map<String, Object> r = AirportRepository.withAge(none, NOW);
        assertThat(r.get("obs_age_s")).isNull();
        assertThat(r.get("stale")).isNull(); // 관측이 없으면 '오래됨' 도 '최신' 도 아니다
    }
}
