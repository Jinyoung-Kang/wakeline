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

    /**
     * 계약 v5 §G26(2026-09-30 저녁): 수집기가 지금 확인 간격(초)을 missing_probe_every_s 로 싣는다 — 5분마다(300) 또는 긴 연속에서 늦춘 15분(900, 수집기 선택값).
     * 공개 missing 에 probe_every_s(정수 초)로 그대로. 비었으면(옛 수집기) 키가 없고 세지 않는다. 틀리면(수 아님 · 0 · 하루 넘음) 그 키만 빼고 센다 — 웹이 간격을
     * 모르면 'N분마다'를 적지 않고 '확인 멈춤' 기준도 전처럼 15분으로 둔다. 고치기 전(키를 읽지 않음)에는 이 시험이 실패했다.
     */
    @Test
    void theProbeIntervalPassesThroughInSecondsAndAWrongValueDropsOnlyThatKey() {
        List<String> errors = new ArrayList<>();
        Map<String, Object> m = KrRadarMissing.from(hash(Map.of("missing_probe_every_s", "900")), errors::add);
        assertThat(errors).isEmpty();
        assertThat(m).containsEntry("probe_every_s", 900);
        assertThat(new ArrayList<>(m.keySet())).containsExactly("since_tm", "last_tm", "tms", "checked_at", "file", "listed", "probe_every_s");
        assertThat(KrRadarMissing.from(hash(Map.of("missing_probe_every_s", "300")), errors::add)).containsEntry("probe_every_s", 300);
        assertThat(KrRadarMissing.from(hash(Map.of("missing_probe_every_s", "")), errors::add)).doesNotContainKey("probe_every_s");
        assertThat(KrRadarMissing.from(hash(Map.of()), errors::add)).doesNotContainKey("probe_every_s");
        assertThat(errors).as("unknown (empty or absent) is not wrong").isEmpty();
        for (String bad : List.of("15min", "0", "-900", "86401", "9.5")) {
            List<String> e = new ArrayList<>();
            Map<String, Object> w = KrRadarMissing.from(hash(Map.of("missing_probe_every_s", bad)), e::add);
            assertThat(w).as(bad).containsKeys("since_tm", "tms").doesNotContainKey("probe_every_s");
            assertThat(e).as(bad).containsExactly("missing_probe_every_s");
        }
    }

    /**
     * 계약 v5 §G26 개정(2026-10-01 — 운영 00:50 KST: 기상청 목록이 19:50 에서 멈췄고 새 날 목록은 비어 확인할 tm 이 없었다): 수집기가 확인마다 목록이 보인 것을
     * missing_list_tm(읽은 목록의 가장 새 tm — 없으면 빈 값) · missing_list_newer(확인 전 last_tm 뒤로 실은 tm 수 — 0 이면 목록도 자라지 않았다, 모르면 빈 값)로
     * 싣는다. 공개 missing 에 list_tm · list_newer 로 그대로 — 비었으면 키가 없고 세지 않는다. 틀리면 그 키만 빼고 센다. list_newer 가 0 인데 list_tm 이 last_tm 보다
     * 새로우면 서로 맞지 않는다(0 은 last_tm 뒤로 싣지 않았다는 뜻) — list_newer 를 빼고 센다(웹이 '목록에도 … 새 tm 없음'을 틀리게 말하지 않게).
     * 고치기 전(키를 읽지 않음)에는 이 시험이 실패했다.
     */
    @Test
    void whatTheListingShowedAtTheLastCheckPassesThroughAndAWrongValueDropsOnlyThatKey() {
        List<String> errors = new ArrayList<>();
        Map<String, Object> m = KrRadarMissing.from(hash(Map.of("missing_probe_every_s", "900", "missing_list_tm", "202609300950", "missing_list_newer", "0")), errors::add);
        assertThat(errors).isEmpty();
        assertThat(m).containsEntry("list_tm", "202609300950").containsEntry("list_newer", 0);
        assertThat(new ArrayList<>(m.keySet())).containsExactly("since_tm", "last_tm", "tms", "checked_at", "file", "listed", "probe_every_s", "list_tm", "list_newer");
        // 목록이 비었다(가장 새 tm 없음) · 목록이 last_tm 의 날을 덮지 못했다(뒤로 실은 수 모름) — 빈 값은 틀린 값이 아니다
        Map<String, Object> empty = KrRadarMissing.from(hash(Map.of("missing_list_tm", "", "missing_list_newer", "0")), errors::add);
        assertThat(empty).doesNotContainKey("list_tm").containsEntry("list_newer", 0);
        assertThat(KrRadarMissing.from(hash(Map.of("missing_list_tm", "202609300950", "missing_list_newer", "")), errors::add))
                .containsEntry("list_tm", "202609300950").doesNotContainKey("list_newer");
        assertThat(KrRadarMissing.from(hash(Map.of()), errors::add)).doesNotContainKeys("list_tm", "list_newer"); // 옛 수집기
        assertThat(KrRadarMissing.from(hash(Map.of("missing_list_tm", "202609300955", "missing_list_newer", "1")), errors::add))
                .containsEntry("list_tm", "202609300955").containsEntry("list_newer", 1); // 목록이 자랐다(새 tm 을 확인했다)
        assertThat(errors).as("unknown (empty or absent) is not wrong").isEmpty();
        for (Map<String, String> bad : List.of(Map.of("missing_list_tm", "19:50"), Map.of("missing_list_tm", "2026093019500"))) {
            List<String> e = new ArrayList<>();
            Map<String, String> over = new HashMap<>(bad);
            over.put("missing_list_newer", "0");
            Map<String, Object> w = KrRadarMissing.from(hash(over), e::add);
            assertThat(w).as(bad.toString()).containsKeys("since_tm", "tms", "list_newer").doesNotContainKey("list_tm");
            assertThat(e).as(bad.toString()).containsExactly("missing_list_tm");
        }
        for (String bad : List.of("-1", "none", "1.0", "1234567")) {
            List<String> e = new ArrayList<>();
            Map<String, Object> w = KrRadarMissing.from(hash(Map.of("missing_list_tm", "202609300950", "missing_list_newer", bad)), e::add);
            assertThat(w).as(bad).containsKeys("since_tm", "tms", "list_tm").doesNotContainKey("list_newer");
            assertThat(e).as(bad).containsExactly("missing_list_newer");
        }
        // 0(뒤로 싣지 않았다)인데 목록의 가장 새 tm 이 last_tm(09:50) 뒤 — 서로 맞지 않는다: '새 tm 없음'을 말하지 않게 list_newer 를 뺀다
        List<String> e = new ArrayList<>();
        Map<String, Object> w = KrRadarMissing.from(hash(Map.of("missing_list_tm", "202609300955", "missing_list_newer", "0")), e::add);
        assertThat(w).containsEntry("list_tm", "202609300955").doesNotContainKey("list_newer");
        assertThat(e).containsExactly("missing_list_newer");
    }
}
