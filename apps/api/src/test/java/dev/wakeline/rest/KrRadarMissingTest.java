package dev.wakeline.rest;

import org.junit.jupiter.api.Test;

import java.time.Instant;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 기상청 내려받기 '파일 없음' 연속(운영 로그 2026-09-30 — 목록은 EXT 로 싣는데 내려받기가 RDR_CMP_HSR_PUB_&lt;tm&gt;.bin.gz 없음으로 답함):
 * 수집기 해시의 missing_* → 공개 missing{since_tm, last_tm, tms, checked_at, file?, listed?}. 수집기 값을 믿지 않는다(R-72) — 핵심 값이 틀리면
 * 연속 전체를 모름(키 없음)으로 두고 센다. 파일 이름 · 목록 종류만 틀리면 그 키만 뺀다. 연속이 없으면(빈 값) 키가 없고 세지 않는다.
 */
class KrRadarMissingTest {
    static Map<String, Object> hash(Map<String, String> over) {
        Map<String, Object> h = new HashMap<>(Map.of("missing_since_tm", "202609300815", "missing_last_tm", "202609300950", "missing_tms", "20",
                "missing_checked_at", "2026-09-30T00:50:31Z", "missing_file", "RDR_CMP_HSR_PUB_202609300950.bin.gz", "missing_listed", "EXT"));
        h.putAll(over);
        return h;
    }

    @Test
    void aStreakPassesThroughWithTheFileNameAndTheListedKindsAsGiven() {
        List<String> errors = new ArrayList<>();
        Map<String, Object> m = KrRadarMissing.from(hash(Map.of("missing_listed", "EXT,KMA")), errors::add);
        assertThat(errors).isEmpty();
        assertThat(m).containsExactly(Map.entry("since_tm", "202609300815"), Map.entry("last_tm", "202609300950"), Map.entry("tms", 20),
                Map.entry("checked_at", Instant.parse("2026-09-30T00:50:31Z")), Map.entry("file", "RDR_CMP_HSR_PUB_202609300950.bin.gz"),
                Map.entry("listed", List.of("EXT", "KMA")));
    }

    @Test
    void noStreakIsNoKeyAndNotAnError() {
        List<String> errors = new ArrayList<>();
        assertThat(KrRadarMissing.from(Map.of(), errors::add)).isNull(); // 옛 수집기 · 연속 없음
        assertThat(KrRadarMissing.from(hash(Map.of("missing_since_tm", "", "missing_last_tm", "", "missing_tms", "", "missing_checked_at", "",
                "missing_file", "", "missing_listed", "")), errors::add)).isNull(); // 닫힌 연속(빈 값)
        assertThat(errors).isEmpty();
    }

    @Test
    void aWrongCoreValueMakesTheWholeStreakUnknownAndIsCounted() {
        for (Map<String, String> bad : List.of(Map.of("missing_since_tm", "08:15"), Map.of("missing_last_tm", "202609300810"), // 첫 tm 보다 이르다
                Map.of("missing_last_tm", ""), Map.of("missing_tms", "0"), Map.of("missing_tms", "many"), Map.of("missing_checked_at", "2026-09-30T00:50:31"),
                Map.of("missing_checked_at", "yesterday"))) {
            List<String> errors = new ArrayList<>();
            assertThat(KrRadarMissing.from(hash(bad), errors::add)).as(bad.toString()).isNull();
            assertThat(errors).as(bad.toString()).containsExactly("missing");
        }
    }

    @Test
    void aWrongFileNameOrListedKindDropsOnlyThatKey() {
        List<String> errors = new ArrayList<>();
        Map<String, Object> m = KrRadarMissing.from(hash(Map.of("missing_file", "<html>busy</html>", "missing_listed", "EXT,ext;")), errors::add);
        assertThat(m).containsKeys("since_tm", "last_tm", "tms", "checked_at").doesNotContainKeys("file", "listed");
        assertThat(errors).containsExactly("missing_file", "missing_listed");
        List<String> none = new ArrayList<>();
        assertThat(KrRadarMissing.from(hash(Map.of("missing_file", "", "missing_listed", "")), none::add)).doesNotContainKeys("file", "listed");
        assertThat(none).as("unknown (empty) is not wrong").isEmpty();
    }
}
