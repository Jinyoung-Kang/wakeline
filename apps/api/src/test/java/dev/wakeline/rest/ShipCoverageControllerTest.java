package dev.wakeline.rest;

import dev.wakeline.coverage.CoverageSource;
import dev.wakeline.coverage.ShipCoverage;
import dev.wakeline.coverage.ShipCoverageFixtures;
import dev.wakeline.platform.web.ProblemAdvice;
import dev.wakeline.ships.core.ShipEvents;
import dev.wakeline.ships.core.ShipState;
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
        c.onSampled(new ShipEvents.ShipsSampled(List.of(pos("440000001", 37.46, 126.44, START + 1_234), pos("440000002", 37.1, 126.01, START + 2_000))));
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
        // edge 가 gzip 으로 줄이며 약하게 바꾼 ETag(W/"…")를 브라우저가 되돌려 보내도 304(리뷰 2026-09-30 밤 — 전에는 글자 그대로 견줘 200)
        mvc(c).perform(get("/api/v1/ships/coverage").header("If-None-Match", "W/" + etag)).andExpect(status().isNotModified());
        mvc(c).perform(get("/api/v1/ships/coverage").header("If-None-Match", "\"other\", W/" + etag)).andExpect(status().isNotModified());
        mvc(c).perform(get("/api/v1/ships/coverage").header("If-None-Match", "W/\"other\"")).andExpect(status().isOk());
    }

    @Test
    void aFailedBootstrapIsNamed_andTruncationIsVisible() throws Exception {
        AtomicLong clock = new AtomicLong(START + 30_000);
        CoverageSource failing = () -> { throw new SQLException("Connection refused", "08001"); };
        ShipCoverage c = ShipCoverageFixtures.coverage(clock, failing, 1);
        ShipCoverageFixtures.bootstrap(c);
        c.onSampled(new ShipEvents.ShipsSampled(List.of(pos("440000001", 37.46, 126.44, START + 1_000), pos("440000002", 1.1, 1.1, START + 1_000))));
        mvc(c).perform(get("/api/v1/ships/coverage"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.bootstrap.state").value("failed"))
                .andExpect(jsonPath("$.bootstrap.error").value("connection"))
                .andExpect(jsonPath("$.bootstrap.finished_at").exists())
                // 다시 읽기(1 · 2 · 5 · 10분 뒤)에도 연결되지 않아 포기한 시 — 창 안의 25시간 모두, 오래된 것부터
                .andExpect(jsonPath("$.bootstrap.missing.length()").value(25))
                .andExpect(jsonPath("$.bootstrap.missing[0].from").value("2026-09-29T09:00:00Z"))
                .andExpect(jsonPath("$.bootstrap.missing[0].to").value("2026-09-29T10:00:00Z"))
                .andExpect(jsonPath("$.bootstrap.missing[0].state").value("given_up"))
                .andExpect(jsonPath("$.bootstrap.missing[0].attempts").value(5))
                .andExpect(jsonPath("$.bootstrap.missing[0].error").value("connection"))
                .andExpect(jsonPath("$.bootstrap.missing[24].to").value("2026-09-30T09:37:00Z"))
                .andExpect(jsonPath("$.bootstrap.retry_backoff_s", contains(60, 120, 300, 600)))
                .andExpect(jsonPath("$.bootstrap.next_retry_at").doesNotExist())
                .andExpect(jsonPath("$.bootstrap.next_retry").doesNotExist())
                .andExpect(jsonPath("$.covered").value("since_api_start"))
                .andExpect(jsonPath("$.truncated").value(true))
                .andExpect(jsonPath("$.dropped_positions").value(1))
                .andExpect(jsonPath("$.limits.max_cells").value(1));
    }

    /**
     * 2026-09-30 22:49 KST 배포 직후 부트스트랩이 statement_timeout 하나로 멈췄다 — 이제 그 시는 나중에 다시 읽는다. 기다리는 동안 응답은 빈 시(retry · 읽지 못한 차례 수 ·
     * 종류)와 다음 다시 읽기 시각, 고른 간격을 싣고, since · covered 는 빈 시 앞까지만 셌다고 말한다. 수정 전 실패(멈췄고 키가 없었다).
     */
    @Test
    void anHourWaitingToBeReadAgainIsServedAsMissing_withTheNextRetryTime() throws Exception {
        AtomicLong clock = new AtomicLong(START + 30_000);
        long hour0 = Instant.parse("2026-09-30T09:00:00Z").toEpochMilli();
        java.util.concurrent.atomic.AtomicInteger reads = new java.util.concurrent.atomic.AtomicInteger();
        CoverageSource once = () -> new CoverageSource.Session() {
            @Override
            public void read(long fromMs, long toMs, java.util.function.Consumer<CoverageSource.Row> sink) throws SQLException {
                if (reads.incrementAndGet() == 2) throw new SQLException("canceling statement due to statement timeout", "57014");
            }

            @Override public void close() {}
        };
        ShipCoverage c = ShipCoverageFixtures.coverage(clock, once);
        MvcResult[] during = new MvcResult[1];
        ShipCoverageFixtures.onRetryWait(c, clock, () -> {
            if (during[0] != null) return;
            try { during[0] = mvc(c).perform(get("/api/v1/ships/coverage")).andReturn(); } catch (Exception e) { throw new IllegalStateException(e); }
        });
        ShipCoverageFixtures.bootstrap(c);
        String body = during[0].getResponse().getContentAsString();
        org.springframework.test.web.servlet.ResultMatcher[] m = {
                jsonPath("$.bootstrap.state").value("running"),
                jsonPath("$.bootstrap.hours_loaded").value(24),
                jsonPath("$.bootstrap.missing.length()").value(1),
                jsonPath("$.bootstrap.missing[0].from").value(Instant.ofEpochMilli(hour0 - 3_600_000).toString()),
                jsonPath("$.bootstrap.missing[0].to").value(Instant.ofEpochMilli(hour0).toString()),
                jsonPath("$.bootstrap.missing[0].state").value("retry"),
                jsonPath("$.bootstrap.missing[0].attempts").value(1),
                jsonPath("$.bootstrap.missing[0].error").value("statement_timeout"),
                jsonPath("$.bootstrap.next_retry_at").value("2026-09-30T09:38:55.500Z"),
                jsonPath("$.bootstrap.next_retry").value(1),
                jsonPath("$.bootstrap.retry_backoff_s", contains(60, 120, 300, 600)),
                jsonPath("$.bootstrap.error").doesNotExist(),
                jsonPath("$.bootstrap.finished_at").doesNotExist(),
                jsonPath("$.since").value("2026-09-30T09:00:00Z"),
                jsonPath("$.covered").value("partial"),
        };
        for (var x : m) x.match(during[0]);
        assertThat(body).contains("\"missing\"");
        // 다시 읽은 뒤: 빈 시 없음 · 다음 시각 키 없음 · 창 전체
        mvc(c).perform(get("/api/v1/ships/coverage"))
                .andExpect(jsonPath("$.bootstrap.state").value("done"))
                .andExpect(jsonPath("$.bootstrap.missing.length()").value(0))
                .andExpect(jsonPath("$.bootstrap.next_retry_at").doesNotExist())
                .andExpect(jsonPath("$.bootstrap.next_retry").doesNotExist())
                .andExpect(jsonPath("$.covered").value("full"));
    }

    /**
     * 리뷰(2026-09-30): 200 응답마다 칸 목록(최대 16,000개의 List.of · Instant 문자열)을 다시 만들었다. 이제 스냅숏(ETag)마다 한 번 — meta.request_id 만 요청마다.
     * 수정 전에는 이 창구가 없었다(컴파일 실패).
     */
    @Test
    void theCellRowsAreBuiltOncePerSnapshot_notPerRequest() {
        AtomicLong clock = new AtomicLong(START);
        ShipCoverage c = ShipCoverageFixtures.coverage(clock, ShipCoverageFixtures.empty());
        c.onSampled(new ShipEvents.ShipsSampled(List.of(pos("440000001", 37.46, 126.44, START + 1_000))));
        ShipCoverageController ctrl = new ShipCoverageController(c);
        ShipCoverage.Snapshot s = c.snapshotNow();
        List<List<Object>> rows = ctrl.cellRows(s);
        assertThat(rows).hasSize(1);
        assertThat(ctrl.cellRows(s)).as("same snapshot → same rows").isSameAs(rows);
        clock.addAndGet(1_000);
        ShipCoverage.Snapshot next = c.snapshotNow();
        assertThat(ctrl.cellRows(next)).as("a new snapshot builds its own rows").isNotSameAs(rows).isEqualTo(rows);
    }

    /**
     * 리뷰(2026-09-30): meta.fetched_at 은 가장 늦은 마지막 수신인데, 수집기 시계가 빠르면(계약이 5분까지 허용) 응답 시각보다 미래다 — Meta 가 lag < 0 을
     * '모름'으로 보고 stale=true · lag_s 없음으로 냈다(가장 새 자료를 오래됐다고). 이제 fetched_at = min(가장 늦은 마지막 수신, 스냅숏 시각). 칸의 마지막 수신은
     * 받은 그대로다. 수정 전 실패.
     */
    @Test
    void aReportAheadOfTheApiClockIsNotStale_fetchedAtIsClampedToTheSnapshotTime() throws Exception {
        long now = System.currentTimeMillis(); // Meta 는 벽시계로 lag 를 잰다
        AtomicLong clock = new AtomicLong(now);
        ShipCoverage c = ShipCoverageFixtures.coverage(clock, ShipCoverageFixtures.empty());
        long ahead = now + 120_000; // 수집기 시계 2분 빠름(5분 안 — 센다)
        c.onSampled(new ShipEvents.ShipsSampled(List.of(pos("440000001", 37.46, 126.44, ahead))));
        ShipCoverage.Snapshot s = c.snapshotNow();
        mvc(c).perform(get("/api/v1/ships/coverage"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.cells[0][5]").value(Instant.ofEpochMilli(ahead).truncatedTo(java.time.temporal.ChronoUnit.SECONDS).toString()))
                .andExpect(jsonPath("$.meta.fetched_at").value(s.generatedAt().toString()))
                .andExpect(jsonPath("$.meta.stale").value(false))
                .andExpect(jsonPath("$.meta.lag_s").isNumber());
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
