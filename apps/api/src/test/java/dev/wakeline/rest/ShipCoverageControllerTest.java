package dev.wakeline.rest;

import dev.wakeline.config.ProblemAdvice;
import dev.wakeline.coverage.CoverageSource;
import dev.wakeline.coverage.ShipCoverage;
import dev.wakeline.coverage.ShipCoverageFixtures;
import dev.wakeline.domain.ShipState;
import dev.wakeline.persist.ShipWriter;
import org.junit.jupiter.api.Test;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

import java.sql.SQLException;
import java.time.Instant;
import java.util.List;
import java.util.concurrent.atomic.AtomicLong;

import static org.assertj.core.api.Assertions.assertThat;
import static org.hamcrest.Matchers.contains;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * 관측 수신 범위 REST(계약 v5 §G27 · ADR-027) — GET /api/v1/ships/coverage: 칸 [lon0, lat0, 크기, 선박 수, 위치 수, 마지막 수신] · 창 · since · 덮음 상태 ·
 * 부트스트랩 · 상한, 공개 캐시 60 s · ETag → 304. 모르는 값은 키가 없다(부트스트랩 오류 · 끝난 시각).
 */
class ShipCoverageControllerTest {
    static final long START = Instant.parse("2026-09-30T09:37:25.500Z").toEpochMilli();

    static ShipState pos(String mmsi, double lat, double lon, long seenMs) {
        return new ShipState(mmsi, lat, lon, 10.0, 90.0, 90, 0, null, "epfs", Instant.ofEpochMilli(seenMs), "aisstream", "PositionReport", "A");
    }

    static MockMvc mvc(ShipCoverage c) {
        return MockMvcBuilders.standaloneSetup(new ShipCoverageController(c)).setControllerAdvice(new ProblemAdvice()).build();
    }

    @Test
    void servesCellsWindowSinceAndBootstrapState_withPublicCacheAndEtag() throws Exception {
        AtomicLong clock = new AtomicLong(START);
        ShipCoverage c = ShipCoverageFixtures.coverage(clock, ShipCoverageFixtures.empty());
        clock.set(START + 10_000);
        c.onSampled(new ShipWriter.Sampled(List.of(pos("440000001", 37.46, 126.44, START + 1_234), pos("440000002", 37.1, 126.01, START + 2_000))));
        MvcResult r = mvc(c).perform(get("/api/v1/ships/coverage"))
                .andExpect(status().isOk())
                .andExpect(header().string("Cache-Control", "max-age=60, public"))
                .andExpect(header().exists("ETag"))
                .andExpect(jsonPath("$.cell_deg").value(0.5))
                .andExpect(jsonPath("$.window.hours").value(24))
                .andExpect(jsonPath("$.window.bucket_s").value(3600))
                .andExpect(jsonPath("$.window.from").value("2026-09-29T09:00:00Z"))
                .andExpect(jsonPath("$.window.to").value("2026-09-30T09:37:35.500Z"))
                .andExpect(jsonPath("$.generated_at").value("2026-09-30T09:37:35.500Z"))
                .andExpect(jsonPath("$.since").value("2026-09-30T09:37:00Z"))
                .andExpect(jsonPath("$.covered").value("since_api_start"))
                .andExpect(jsonPath("$.api_started_at").value("2026-09-30T09:37:25.500Z"))
                .andExpect(jsonPath("$.live_from").value("2026-09-30T09:37:00Z"))
                .andExpect(jsonPath("$.bootstrap.state").value("pending"))
                .andExpect(jsonPath("$.bootstrap.hours_loaded").value(0))
                .andExpect(jsonPath("$.bootstrap.error").doesNotExist())
                .andExpect(jsonPath("$.bootstrap.finished_at").doesNotExist())
                .andExpect(jsonPath("$.cells.length()").value(1))
                // [lon0, lat0, 크기, 선박 수, 위치 수, 마지막 수신(초로 내림)]
                .andExpect(jsonPath("$.cells[0]", contains(126.0, 37.0, 0.5, 2, 2, "2026-09-30T09:37:27Z")))
                .andExpect(jsonPath("$.cell_count").value(1))
                .andExpect(jsonPath("$.positions").value(2))
                .andExpect(jsonPath("$.truncated").value(false))
                .andExpect(jsonPath("$.dropped_positions").value(0))
                .andExpect(jsonPath("$.limits.max_cells").value(ShipCoverage.MAX_CELLS))
                .andExpect(jsonPath("$.limits.max_ship_cells").value(ShipCoverage.MAX_SHIP_CELLS))
                .andExpect(jsonPath("$.sampling").value("first_fix_per_60s"))
                .andExpect(jsonPath("$.note").isString())
                .andExpect(jsonPath("$.time_zone").isString())
                .andExpect(jsonPath("$.meta.provider").value("aisstream"))
                .andExpect(jsonPath("$.meta.fetched_at").value("2026-09-30T09:37:27Z"))
                .andExpect(jsonPath("$.meta.request_id").exists())
                .andReturn();
        String etag = r.getResponse().getHeader("ETag");
        mvc(c).perform(get("/api/v1/ships/coverage").header("If-None-Match", etag)).andExpect(status().isNotModified())
                .andExpect(header().string("ETag", etag)).andExpect(header().string("Cache-Control", "max-age=60, public"));
    }

    @Test
    void aFailedBootstrapIsNamed_andTruncationIsVisible() throws Exception {
        AtomicLong clock = new AtomicLong(START + 30_000);
        CoverageSource failing = () -> { throw new SQLException("Connection refused", "08001"); };
        ShipCoverage c = ShipCoverageFixtures.coverage(clock, failing, 1);
        ShipCoverageFixtures.bootstrap(c);
        c.onSampled(new ShipWriter.Sampled(List.of(pos("440000001", 37.46, 126.44, START + 1_000), pos("440000002", 1.1, 1.1, START + 1_000))));
        mvc(c).perform(get("/api/v1/ships/coverage"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.bootstrap.state").value("failed"))
                .andExpect(jsonPath("$.bootstrap.error").value("connection"))
                .andExpect(jsonPath("$.bootstrap.finished_at").exists())
                .andExpect(jsonPath("$.covered").value("since_api_start"))
                .andExpect(jsonPath("$.truncated").value(true))
                .andExpect(jsonPath("$.dropped_positions").value(1))
                .andExpect(jsonPath("$.limits.max_cells").value(1));
    }

    @Test
    void anEmptyGridHasNoFetchedAt_andIsStale() throws Exception {
        ShipCoverage c = ShipCoverageFixtures.coverage(new AtomicLong(START), ShipCoverageFixtures.empty());
        mvc(c).perform(get("/api/v1/ships/coverage"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.cells.length()").value(0))
                .andExpect(jsonPath("$.meta.fetched_at").doesNotExist())
                .andExpect(jsonPath("$.meta.stale").value(true));
        assertThat(ShipCoverageController.STALE_AFTER_S).isEqualTo(900);
    }
}
