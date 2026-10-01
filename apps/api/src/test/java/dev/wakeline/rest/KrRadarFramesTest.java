package dev.wakeline.rest;

import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.json.JsonMapper;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * ADR-021: 기상청 합성 레이더의 부분 합성 프레임 — 수집기 목록 항목의 지점 수 · 코드 · 기준 · partial · 다시 받기 기록을 공개 /radar/kr frames[] 로
 * 옮긴다. 수집기 값을 믿지 않는다(R-72): 형식이 틀리거나 서로 맞지 않는 값은 키를 빼고(모름) 센다 — 지어내거나 0 으로 채우지 않는다.
 */
class KrRadarFramesTest {
    static final ObjectMapper JSON = JsonMapper.builder().build();
    static final String FETCHED = "2026-09-29T05:43:44.992264Z";

    static JsonNode node(String json) { return JSON.readTree(json); }

    static String full(String over) {
        return ("{\"tm\":\"202609291440\",\"obs_tm\":\"202609291440\",\"fetched_at\":\"" + FETCHED + "\",\"echo_cells\":8587,"
                + "\"stations\":2,\"station_ids\":[\"KSN\",\"GDK\"],\"stations_ref\":15,\"partial\":true,\"refetches\":1,\"upgrades\":0,"
                + "\"refetched_at\":\"2026-09-29T05:48:47Z\",\"refetch_until\":\"2026-09-29T06:10:00Z\"" + over + "}");
    }

    @Test
    void fullEntryPassesThroughWithAVersionedImageUrl() {
        List<String> errors = new ArrayList<>();
        Map<String, Object> f = KrRadarFrames.frame(node(full("")), errors::add);
        assertThat(errors).isEmpty();
        assertThat(f).containsEntry("tm", "202609291440").containsEntry("stations", 2).containsEntry("station_ids", List.of("KSN", "GDK"))
                .containsEntry("stations_ref", 15).containsEntry("partial", true).containsEntry("refetches", 1).containsEntry("upgrades", 0)
                .containsEntry("refetched_at", Instant.parse("2026-09-29T05:48:47Z")).containsEntry("refetch_until", Instant.parse("2026-09-29T06:10:00Z"))
                .containsEntry("echo_cells", 8587);
        // 다시 받아 바뀐 영상은 같은 tm 이라도 다른 URL — 브라우저 캐시(1 h)가 옛 영상을 보여 주지 않게
        assertThat(f.get("url")).isEqualTo("/api/v1/radar/kr/202609291440.png?v=" + Instant.parse(FETCHED).toEpochMilli());
    }

    @Test
    void legacyEntryWithoutSiteCountsHasNoCompositeKeys() {
        List<String> errors = new ArrayList<>();
        Map<String, Object> f = KrRadarFrames.frame(node("{\"tm\":\"202609291440\",\"obs_tm\":\"202609291440\",\"fetched_at\":\"x\",\"echo_cells\":12}"), errors::add);
        assertThat(errors).isEmpty(); // 옛 항목은 틀린 것이 아니라 모르는 것
        assertThat(f).doesNotContainKeys("stations", "station_ids", "stations_ref", "partial", "refetches", "upgrades", "refetched_at", "refetch_until");
        assertThat(f.get("url")).isEqualTo("/api/v1/radar/kr/202609291440.png"); // 받은 시각을 모르면 버전 없이
        assertThat(KrRadarFrames.frame(node("{\"tm\":\"bad-tm\"}"), errors::add)).isNull();
        assertThat(KrRadarFrames.frame(node("[1]"), errors::add)).isNull();
    }

    @Test
    void malformedOrInconsistentValuesAreDroppedAndCounted() {
        record Case(String over, String field, List<String> gone) {}
        List<Case> cases = List.of(
                new Case(",\"stations\":\"2\"", "stations", List.of("stations", "partial")),
                new Case(",\"stations\":-1", "stations", List.of("stations", "partial")),
                new Case(",\"stations\":49", "stations", List.of("stations", "partial")),
                new Case(",\"station_ids\":\"KSN,GDK\"", "station_ids", List.of("station_ids")),
                new Case(",\"station_ids\":[\"KSN\",\"G D K\"]", "station_ids", List.of("station_ids")),
                new Case(",\"station_ids\":[\"KSN\"]", "station_ids", List.of("station_ids")), // 지점 수와 다르다
                new Case(",\"stations_ref\":1", "stations_ref", List.of("stations_ref", "partial")), // 기준이 자기 지점 수보다 작다
                new Case(",\"stations_ref\":true", "stations_ref", List.of("stations_ref", "partial")),
                new Case(",\"partial\":\"1\"", "partial", List.of("partial")),
                new Case(",\"partial\":false", "partial", List.of("partial")), // 2 < 15 인데 부분 합성이 아니라고 한다
                new Case(",\"refetches\":-1", "refetches", List.of("refetches")),
                new Case(",\"upgrades\":1.5", "upgrades", List.of("upgrades")),
                new Case(",\"refetched_at\":\"yesterday\"", "refetched_at", List.of("refetched_at")),
                new Case(",\"refetch_until\":\"2026-09-29T06:10:00\"", "refetch_until", List.of("refetch_until")));
        for (Case c : cases) {
            List<String> errors = new ArrayList<>();
            // JSON 에서 뒤에 온 같은 키가 앞의 값을 덮는다
            Map<String, Object> f = KrRadarFrames.frame(node(full(c.over())), errors::add);
            assertThat(errors).as(c.over()).containsExactly(c.field());
            assertThat(f).as(c.over()).doesNotContainKeys(c.gone().toArray(String[]::new));
            assertThat(f).as(c.over()).containsKeys("tm", "url");
        }
    }

    @Test
    void partialNeedsBothCountsToBeKnown() {
        List<String> errors = new ArrayList<>();
        Map<String, Object> f = KrRadarFrames.frame(node(
                "{\"tm\":\"202609291440\",\"obs_tm\":\"202609291440\",\"fetched_at\":\"" + FETCHED + "\",\"echo_cells\":1,\"stations\":7,\"partial\":true}"), errors::add);
        assertThat(f).containsEntry("stations", 7).doesNotContainKeys("partial", "stations_ref");
        assertThat(errors).containsExactly("partial");
        Map<String, Object> ok = KrRadarFrames.frame(node(full(",\"stations\":15,\"station_ids\":null,\"partial\":false")), errors::add);
        assertThat(ok).containsEntry("stations", 15).containsEntry("stations_ref", 15).containsEntry("partial", false).doesNotContainKey("station_ids");
    }

    @Test
    void latestMirrorsTheLastListedFrame() {
        List<String> errors = new ArrayList<>();
        Map<String, Object> older = KrRadarFrames.frame(node(full(",\"tm\":\"202609291435\",\"stations\":15,\"station_ids\":null,\"partial\":false")), errors::add);
        Map<String, Object> last = KrRadarFrames.frame(node(full("")), errors::add);
        assertThat(KrRadarFrames.latest(List.of(older, last))).containsExactlyInAnyOrderEntriesOf(
                Map.of("stations", 2, "station_ids", List.of("KSN", "GDK"), "stations_ref", 15, "partial", true));
        assertThat(KrRadarFrames.latest(List.of())).isEmpty();
        Map<String, Object> legacy = KrRadarFrames.frame(node("{\"tm\":\"202609291440\",\"fetched_at\":\"x\",\"echo_cells\":1}"), errors::add);
        assertThat(KrRadarFrames.latest(List.of(older, legacy))).isEmpty(); // 최신 프레임을 모르면 이전 프레임 값으로 채우지 않는다
    }

    /**
     * 리뷰 cto-2026-10 A2(B5-a): Jackson 3 의 asInt() 는 숫자가 아니거나 int 밖이면 던진다 — 수집기 항목의 echo_cells 가 틀리면 /radar/kr 가 500 이었다(R-72 의
     * 빈틈 — 이 클래스는 수집기 값으로 500 이 나지 않는다고 약속한다). 계약은 0 이상 정수(tools/rest_contract_check.py)라 틀린 값이면 프레임을 빼고 센다
     * (틀린 tm 처럼). 없거나 null 인 옛 항목은 예전처럼 0.
     */
    @Test
    void echoCellsMustBeANonNegativeIntOrTheFrameIsDroppedAndCounted() {
        record Row(String value, Integer kept) {}
        for (Row r : List.of(new Row("8587", 8587), new Row("0", 0), new Row(null, 0), new Row("null", 0),
                new Row("\"n/a\"", null), new Row("\"12\"", null), new Row("-1", null), new Row("1.5", null), new Row("1e10", null),
                new Row("2147483648", null), new Row("123456789012345678901234567890", null), new Row("true", null), new Row("{}", null), new Row("[1]", null))) {
            List<String> errors = new ArrayList<>();
            String json = "{\"tm\":\"202609291440\",\"obs_tm\":\"202609291440\",\"fetched_at\":\"" + FETCHED + "\""
                    + (r.value() == null ? "" : ",\"echo_cells\":" + r.value()) + "}";
            Map<String, Object> f = KrRadarFrames.frame(node(json), errors::add);
            if (r.kept() == null) {
                assertThat(f).as(r.value()).isNull();
                assertThat(errors).as(r.value()).containsExactly("echo_cells");
            } else {
                assertThat(f).as(String.valueOf(r.value())).containsEntry("echo_cells", r.kept());
                assertThat(errors).as(String.valueOf(r.value())).isEmpty();
            }
        }
    }
}
