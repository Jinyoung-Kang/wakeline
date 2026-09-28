package dev.wakeline.it;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIf;
import tools.jackson.databind.JsonNode;

import java.time.Instant;
import java.time.temporal.ChronoUnit;

import static org.assertj.core.api.Assertions.assertThat;

/** /api/v1/aircraft/{hex}/track — 리뷰 v1 항목. */
@EnabledIf("dev.wakeline.DbTestSupport#dockerAvailable")
class AircraftTrackIT extends IntegrationTest {

    void points(String hex, Instant from, int n, int stepMs) {
        admin().sql("""
                INSERT INTO track_point (hex, ts, geom, alt_ft, provider, fetched_at)
                SELECT :h, :from::timestamptz + g * (:step::int * interval '1 millisecond'), ST_SetSRID(ST_MakePoint(127 + g * 0.0001, 36), 4326),
                       30000, 'fixture', now()
                FROM generate_series(0, :n::int - 1) g ON CONFLICT DO NOTHING""")
                .param("h", hex).param("from", java.time.OffsetDateTime.ofInstant(from, java.time.ZoneOffset.UTC)).param("step", stepMs).param("n", n).update();
    }

    /**
     * R-52: 점 수 상한이 없어 24 h 범위가 수천 점·MB 단위가 될 수 있었다. 선박 항적과 같이 5,000점에서 자르고 properties.truncated 로 밝힌다
     * (앞에서부터 — 시간순). 상한 안이면 truncated = false.
     */
    @Test
    void trackIsCappedAt5000PointsAndSaysSo() {
        Instant now = Instant.now().truncatedTo(ChronoUnit.SECONDS);
        Instant from = now.minusSeconds(7200);
        points("a1f0c1", from, 5_010, 1_400);
        JsonNode big = get("/api/v1/aircraft/a1f0c1/track?from=" + from.minusSeconds(1) + "&to=" + now).json();
        assertThat(big.path("points").size()).isEqualTo(5_000);
        assertThat(big.path("geometry").path("coordinates").size()).isEqualTo(5_000);
        assertThat(big.path("properties").path("points").asInt()).isEqualTo(5_000);
        assertThat(big.path("properties").path("truncated").asBoolean(false)).isTrue();
        assertThat(big.path("points").get(0).path("ts").asString()).as("oldest first").isEqualTo(from.toString());

        points("a1f0c2", from, 10, 60_000);
        JsonNode small = get("/api/v1/aircraft/a1f0c2/track?from=" + from.minusSeconds(1) + "&to=" + now).json();
        assertThat(small.path("points").size()).isEqualTo(10);
        assertThat(small.path("properties").has("truncated")).isTrue();
        assertThat(small.path("properties").path("truncated").asBoolean(true)).isFalse();
    }

    /** R-71: 범위 한도 24 h 를 절삭(toHours) 없이 비교한다 — 24 h 59 m 이 통과했다(선박 항적은 정확히 거절). 정확히 24 h 는 허용. */
    @Test
    void rangeLimitIsExact() {
        Instant to = Instant.now().truncatedTo(ChronoUnit.SECONDS);
        String path = "/api/v1/aircraft/a1f0c3/track";
        assertProblem(get(path + "?from=" + to.minusSeconds(24 * 3600 + 59 * 60) + "&to=" + to), 400, "BAD_RANGE", path);
        assertProblem(get(path + "?from=" + to.minusSeconds(24 * 3600 + 1) + "&to=" + to), 400, "BAD_RANGE", path);
        assertThat(get(path + "?from=" + to.minusSeconds(24 * 3600) + "&to=" + to).status()).isEqualTo(200);
    }
}
