package dev.wakeline.ws;

import dev.wakeline.domain.AircraftState;
import dev.wakeline.domain.Bbox;
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
    static AircraftState at(String hex, Instant seen, String provider, int quality) {
        return new AircraftState(hex, null, null, null, null, 36, 127, 1000, 400.0, 90.0, 0.0, false, null, seen, provider, seen, quality, false);
    }

    /** 서 있는 항공기: 값이 그대로여도 seen_at 이 20 s 이상 앞으로 가면 다시 보낸다(클라이언트가 stale 로 잘못 보지 않게). */
    @Test void stationaryAircraft_seenAtRefreshedEvery20s() {
        Map<String, AircraftState> sent = new HashMap<>();
        DiffCalculator.compute(sent, List.of(at("a", T, "adsb_lol", 0)), KR);
        assertThat(DiffCalculator.compute(sent, List.of(at("a", T.plusSeconds(10), "adsb_lol", 0)), KR).isEmpty()).isTrue();
        var d = DiffCalculator.compute(sent, List.of(at("a", T.plusSeconds(20), "adsb_lol", 0)), KR);
        assertThat(d.upsert()).hasSize(1);
        assertThat(sent.get("a").seenAt()).isEqualTo(T.plusSeconds(20));
    }

    /** 공급자(stale 기준 60 s/300 s 가 바뀐다)·품질이 바뀌면 다시 보낸다. */
    @Test void providerOrQualityChange_isUpserted() {
        Map<String, AircraftState> sent = new HashMap<>();
        DiffCalculator.compute(sent, List.of(at("a", T, "adsb_lol", 0)), KR);
        assertThat(DiffCalculator.compute(sent, List.of(at("a", T, "opensky", 0)), KR).upsert()).hasSize(1);
        assertThat(DiffCalculator.compute(sent, List.of(at("a", T, "opensky", 2)), KR).upsert()).hasSize(1);
        assertThat(DiffCalculator.compute(sent, List.of(at("a", T, "opensky", 2)), KR).isEmpty()).isTrue();
    }
}
