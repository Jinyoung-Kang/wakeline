package dev.skywx.ws;

import dev.skywx.domain.AircraftState;
import dev.skywx.domain.Bbox;
import org.junit.jupiter.api.Test;

import java.time.Instant;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

class DiffCalculatorTest {
    static final Instant T = Instant.parse("2026-09-27T05:10:00Z");
    static final Bbox KR = new Bbox(124, 33, 132, 39);

    static AircraftState st(String hex, double lat, double lon, int alt) {
        return new AircraftState(hex, null, null, null, null, lat, lon, alt, 400.0, 90.0, 0.0, false, null, T, "adsb_lol", T, 0, false);
    }

    @Test void firstDiffUpsertsEverythingInBbox_andIgnoresOutside() {
        Map<String, AircraftState> sent = new HashMap<>();
        var d = DiffCalculator.compute(sent, List.of(st("a", 36, 127, 1000), st("b", 50, 10, 1000)), KR);
        assertThat(d.upsert()).extracting(AircraftState::hex).containsExactly("a");
        assertThat(d.remove()).isEmpty();
    }

    @Test void unchangedWithinThresholds_isNotResent() {
        Map<String, AircraftState> sent = new HashMap<>();
        DiffCalculator.compute(sent, List.of(st("a", 36, 127, 1000)), KR);
        var d = DiffCalculator.compute(sent, List.of(st("a", 36.00005, 127.00005, 1010)), KR);
        assertThat(d.isEmpty()).isTrue();
    }

    @Test void movedOrVanished_isRemoved() {
        Map<String, AircraftState> sent = new HashMap<>();
        DiffCalculator.compute(sent, List.of(st("a", 36, 127, 1000), st("b", 36, 128, 1000)), KR);
        var d = DiffCalculator.compute(sent, List.of(st("a", 50, 10, 1000)), KR); // a 는 밖으로, b 는 사라짐
        assertThat(d.remove()).containsExactlyInAnyOrder("a", "b");
        assertThat(sent).isEmpty();
    }

    @Test void changedAltitude_isUpserted() {
        Map<String, AircraftState> sent = new HashMap<>();
        DiffCalculator.compute(sent, List.of(st("a", 36, 127, 1000)), KR);
        var d = DiffCalculator.compute(sent, List.of(st("a", 36, 127, 1100)), KR);
        assertThat(d.upsert()).hasSize(1);
    }
}
