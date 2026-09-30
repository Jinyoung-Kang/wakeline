package dev.wakeline.it;

import dev.wakeline.coverage.ShipCoverage;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIf;
import org.springframework.beans.factory.annotation.Autowired;
import tools.jackson.databind.JsonNode;

import java.time.Duration;
import java.time.Instant;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 관측 수신 범위(계약 v5 §G27 · ADR-027) 경로 전체를 실제 Redis(ais 수집기와 같은 ACL 사용자) · 실제 PostGIS 로: XADD wakeline:ships → 소비 → 선박 저장기가
 * 고른 60 s 표본(IngestEvents.ShipsSampled) → 격자 → 공개 GET /api/v1/ships/coverage(공개 캐시 · ETag → 304 · 요청 제한 헤더). /ships/coverage 는
 * /ships/{mmsi} 로 해석되지 않는다(MMSI 형식 오류 400 이 아니다). 셈은 api 시작 분부터라 보고 시각은 지금으로 준다.
 */
@EnabledIf("dev.wakeline.DbTestSupport#dockerAvailable")
class ShipCoverageIT extends IntegrationTest {
    static final Duration WAIT = Duration.ofSeconds(15);

    @Autowired ShipCoverage coverage;
    @Autowired dev.wakeline.ingest.ShipStore ships;

    static boolean hasCell(ShipCoverage.Snapshot s, double lon0, double lat0, int minShips) {
        return s.cells().stream().anyMatch(c -> c.lon0() == lon0 && c.lat0() == lat0 && c.ships() >= minShips);
    }

    @Test
    void liveShipsBecomeObservedCells_servedWithPublicCacheEtagAndRateLimitHeaders() {
        awaitFreshMinuteWindow(5); // 두 보고(0.9 s 차이)가 같은 60 s 창에 들게
        Instant seen = Instant.now();
        assertThat(seen.toEpochMilli()).as("the IT app started before this test — live counting has begun").isGreaterThanOrEqualTo(coverage.liveFromMs());
        // 아일랜드 서쪽 먼바다(다른 시험의 선박과 겹치지 않는 칸 −15.0 · 52.0) 두 척, 한 척은 같은 60 s 창에 두 번 — 표본은 하나
        Streams.xaddAis(Streams.ships(Streams.nextFetchedAt(), List.of(Streams.shipState("440790001", 52.2, -14.8, seen),
                Streams.shipState("440790002", 52.3, -14.7, seen)), List.of()));
        Streams.xaddAis(Streams.ships(Streams.nextFetchedAt(), List.of(Streams.shipState("440790001", 52.21, -14.79, seen.plusMillis(900))), List.of()));
        await("second report consumed", WAIT, () -> {
            var sh = ships.view().get("440790001");
            return sh != null && sh.state().seenAt().toEpochMilli() == seen.plusMillis(900).toEpochMilli();
        });
        await("observed cell", WAIT, () -> hasCell(coverage.snapshotNow(), -15.0, 52.0, 2));
        ShipCoverage.Snapshot s = coverage.snapshotNow();
        Res r = get("/api/v1/ships/coverage");
        assertThat(r.status()).isEqualTo(200);
        assertThat(r.header("Content-Type")).startsWith("application/json");
        assertThat(r.header("Cache-Control")).contains("public").contains("max-age=60");
        assertThat(r.header("X-RateLimit-Limit")).isNotBlank();
        String etag = r.header("ETag");
        assertThat(etag).isEqualTo(s.etag());
        JsonNode b = r.json();
        JsonNode cell = null;
        for (JsonNode c : b.path("cells")) if (c.get(0).asDouble() == -15.0 && c.get(1).asDouble() == 52.0) cell = c;
        assertThat(cell).as("the observed cell is served").isNotNull();
        assertThat(cell.get(2).asDouble()).isEqualTo(0.5);
        assertThat(cell.get(3).asInt()).isEqualTo(2);
        assertThat(cell.get(4).asInt()).as("one sample per ship per 60 s window").isEqualTo(2);
        assertThat(Instant.parse(cell.get(5).asString())).isBetween(seen.minusSeconds(1), seen.plusSeconds(1));
        assertThat(b.path("window").path("hours").asInt()).isEqualTo(24);
        assertThat(b.path("covered").asString()).isIn("full", "partial", "since_api_start");
        assertThat(Instant.parse(b.path("since").asString())).isAfterOrEqualTo(Instant.parse(b.path("window").path("from").asString()));
        assertThat(b.path("meta").path("request_id").asString()).isNotBlank();
        Res again = get("/api/v1/ships/coverage", headers("If-None-Match", etag));
        assertThat(again.status()).isEqualTo(304);
    }
}
