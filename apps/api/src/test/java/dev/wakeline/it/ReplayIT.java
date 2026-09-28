package dev.wakeline.it;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIf;
import tools.jackson.databind.JsonNode;

import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

/** 재생(/api/v1/replay) 응답 — 리뷰 v1 의 재생 항목. */
@EnabledIf("dev.wakeline.DbTestSupport#dockerAvailable")
class ReplayIT extends IntegrationTest {

    void sigmet(String id, String wkt) {
        admin().sql("""
                INSERT INTO sigmet (id, fir_id, series_id, hazard, valid_from, valid_to, geom, raw_text, provider, fetched_at)
                VALUES (:id, 'XXXX', :id, 'TS', now() - interval '1 hour', now() + interval '1 hour',
                        CASE WHEN :wkt::text IS NULL THEN NULL ELSE ST_Multi(ST_GeomFromText(:wkt, 4326)) END, 'r', 'awc', now())
                ON CONFLICT (id) DO NOTHING""").param("id", id).param("wkt", wkt).update();
    }

    /**
     * R-26: 재생 SIGMET 은 요청 bbox 와 겹치는 것만(도형이 없는 경보는 위치를 모르므로 남긴다). 이전에는 bbox 와 무관한 전세계 SIGMET 이
     * 응답의 약 70 % 였고 재생 중 매초 다시 받았다.
     */
    @Test
    void replaySigmetsAreLimitedToTheRequestedBbox() {
        String tag = "R26-" + System.nanoTime();
        sigmet(tag + "-KR", "POLYGON((126 34, 129 34, 129 37, 126 37, 126 34))");   // 한반도 — bbox 안
        sigmet(tag + "-EU", "POLYGON((0 45, 10 45, 10 50, 0 50, 0 45))");           // 유럽 — bbox 밖
        sigmet(tag + "-EDGE", "POLYGON((131 38, 140 38, 140 45, 131 45, 131 38))"); // bbox 모서리와 겹침
        sigmet(tag + "-NOGEOM", null);                                             // 좌표 없음 — 위치를 모른다
        String at = Instant.now().minusSeconds(60).truncatedTo(ChronoUnit.SECONDS).toString();
        JsonNode body = get("/api/v1/replay?at=" + at + "&bbox=124,33,132,39").json();
        List<String> ids = new ArrayList<>();
        for (JsonNode s : body.path("sigmets")) if (s.path("id").asString().startsWith(tag)) ids.add(s.path("id").asString());
        assertThat(ids).containsExactlyInAnyOrder(tag + "-KR", tag + "-EDGE", tag + "-NOGEOM");
        admin().sql("DELETE FROM sigmet WHERE id LIKE :t").param("t", tag + "-%").update(); // 다른 통합 테스트의 재생 기록에 남지 않게
    }
}
