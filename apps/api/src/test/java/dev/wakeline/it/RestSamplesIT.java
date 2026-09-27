package dev.wakeline.it;

import dev.wakeline.engine.EngineService;
import dev.wakeline.ingest.RadarStore;
import dev.wakeline.ingest.SigmetStore;
import dev.wakeline.ingest.SnapshotStore;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIf;
import org.springframework.beans.factory.annotation.Autowired;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.JsonNodeFactory;
import tools.jackson.databind.node.ObjectNode;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneOffset;
import java.time.temporal.ChronoUnit;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Java → Python REST 계약(설계 14.1): 실제 앱이 만든 REST 응답을 build/rest-samples/*.json 으로 남긴다.
 * tools/rest_contract_check.py --dir apps/api/build/rest-samples 가 같은 기대 스키마(웹·도구가 읽는 필드)로 검증한다 —
 * 한쪽만 고치면 그 검사가 깨진다. 실행 중인 스택에는 같은 도구를 URL 로 돌린다(--base-url).
 * <p>자료는 수집기와 같은 경로(XADD → 소비)로 넣고, 공항·METAR 는 수집기 테이블이라 수집기 역할로 넣는다.
 */
@EnabledIf("dev.wakeline.DbTestSupport#dockerAvailable")
class RestSamplesIT extends IntegrationTest {
    static final Path OUT = Path.of("build", "rest-samples");
    static final Duration WAIT = Duration.ofSeconds(15);

    @Autowired SnapshotStore snapshots;
    @Autowired SigmetStore sigmets;
    @Autowired RadarStore radar;
    @Autowired EngineService engine;

    final Map<String, String> index = new LinkedHashMap<>();

    void record(String name, String path, int expectedStatus) throws IOException {
        Res r = get(path);
        assertThat(r.status()).as(name + " " + path + " → " + r.body()).isEqualTo(expectedStatus);
        ObjectNode sample = JsonNodeFactory.instance.objectNode();
        sample.put("name", name);
        sample.put("path", path);
        sample.put("status", r.status());
        sample.put("content_type", r.header("Content-Type"));
        sample.put("cache_control", r.header("Cache-Control"));
        sample.put("etag", r.header("ETag"));
        sample.set("body", r.json());
        Files.createDirectories(OUT);
        Files.writeString(OUT.resolve(name + ".json"), Streams.JSON.writeValueAsString(sample), StandardCharsets.UTF_8);
        index.put(name, path);
    }

    @Test
    void recordsRestResponsesForThePythonContractCheck() throws Exception {
        // 자료: SIGMET 1(관측 판정 대상) + 관심 지역 3대(1대는 SIGMET 안) + 전세계 1대 + 레이더 프레임 + 공항·METAR
        String sigmetId = "RKRR:IT-REST:" + System.currentTimeMillis();
        Instant fs = Streams.nextFetchedAt();
        // 판정 제외(좌표 없음 — geometry null) 1건, 상한 미발표(top unknown)·하한 미발표(SFC 가정) 1건도 함께 — 출처 표시와 GeoJSON 형식 확인용
        Map<String, Object> excluded = Streams.sigmet(sigmetId + "-X", 0, 0, 1, 1, 0, 30000, fs);
        excluded.put("geometry", null);
        excluded.put("excluded_reason", "no_coordinates");
        Map<String, Object> unknownTop = Streams.sigmet(sigmetId + "-U", 125.0, 33.0, 126.0, 34.0, 0, 0, fs);
        unknownTop.put("top_ft", null);
        unknownTop.put("top_source", "unknown");
        unknownTop.put("base_source", "assumed_surface");
        Streams.xadd(Streams.SIGMET, Streams.sigmets(fs, List.of(Streams.sigmet(sigmetId, 128.0, 34.0, 129.5, 35.5, 0, 40000, fs), excluded, unknownTop)));
        await("sigmet", WAIT, () -> sigmets.get(sigmetId) != null);
        Instant fr = Streams.nextFetchedAt();
        Streams.xadd(Streams.RADAR, Streams.radar(fr, fr.getEpochSecond() - fr.getEpochSecond() % 600));
        await("radar", WAIT, () -> radar.frames().fetchedAt().equals(fr));
        Instant fg = Streams.nextFetchedAt();
        Streams.xadd(Streams.AIRCRAFT, Streams.aircraft("global", fg, List.of(Streams.state("a1d0aa", 51.47, -0.45, 35000, fg.minusSeconds(20), fg))));
        await("global", WAIT, () -> snapshots.global().fetchedAt().equals(fg));
        String inside = "a1d001";
        for (int i = 0; i < 2; i++) { // 2번 관측 → 관측 알림(ENTERED)
            Instant f = Streams.nextFetchedAt();
            Instant seen = f.minusMillis(500);
            Streams.xadd(Streams.AIRCRAFT, Streams.aircraft("region", f, List.of(
                    Streams.state(inside, 34.8 + i * 0.01, 128.7, 30000, seen, f),
                    Streams.state("a1d002", 37.46, 126.44, 5000, seen, f),
                    Streams.state("a1d003", 36.0, 127.0, null, seen, f))));
            await("region " + i, WAIT, () -> snapshots.region().fetchedAt().equals(f));
            Thread.sleep(20);
        }
        await("alert", WAIT, () -> engine.activeAlerts("OBSERVED").stream().anyMatch(a -> a.hex().equals(inside)));
        await("alert persisted", WAIT, () -> count("SELECT count(*) FROM alert_event WHERE hex = ?", inside) >= 1);
        await("track", WAIT, () -> count("SELECT count(*) FROM track_point WHERE hex = ?", inside) >= 2);
        await("static", WAIT, () -> count("SELECT count(*) FROM aircraft WHERE hex = ?", inside) == 1);
        // 공항·METAR 는 수집기 테이블 — 수집기와 같은 역할(wakeline_collector)로 쓴다
        var adm = org.springframework.jdbc.core.simple.JdbcClient.create(new org.springframework.jdbc.datasource.DriverManagerDataSource(
                dev.wakeline.DbTestSupport.jdbcUrl(ItStack.DB), "wakeline_collector", dev.wakeline.DbTestSupport.COLLECTOR_PW));
        adm.sql("INSERT INTO airport (icao, iata, name, country, geom, elev_ft, watched) VALUES ('RKSI', 'ICN', 'Incheon', 'KR', "
                + "ST_SetSRID(ST_MakePoint(126.45, 37.46), 4326), 23, true) ON CONFLICT (icao) DO NOTHING").update();
        adm.sql("""
                INSERT INTO metar_obs (icao, obs_time, raw, temp_c, dewp_c, wind_dir, wind_kt, vis_sm, ceiling_ft, ceiling_state, flight_cat, flight_cat_source, provider, fetched_at)
                VALUES ('RKSI', date_trunc('hour', now()), 'RKSI 271200Z 27010KT 9999 BKN030 20/15 Q1013', 20, 15, 270, 10, 6.2, 3000, 'measured', 'VFR', 'awc', 'awc', now())
                ON CONFLICT DO NOTHING""").update();

        String day = LocalDate.now(ZoneOffset.UTC).toString();
        String bbox = "124,33,132,39";
        record("status", "/api/v1/status", 200);
        record("aircraft", "/api/v1/aircraft?bbox=" + bbox, 200);
        record("aircraft_full", "/api/v1/aircraft?bbox=" + bbox + "&detail=full", 200);
        record("aircraft_detail", "/api/v1/aircraft/" + inside, 200);
        record("aircraft_search", "/api/v1/aircraft/search?q=ITD0", 200);
        // 지금은 없고 DB 에만 남은 항공기(과거 정적 정보, live=false · last_seen)
        db.sql("INSERT INTO aircraft (hex, registration, type_code, source, first_seen, last_seen) VALUES ('a1d0db', 'HLDB01', 'B738', 'fixture', "
                + "now() - interval '2 days', now() - interval '1 day') ON CONFLICT (hex) DO NOTHING").update();
        record("aircraft_search_db", "/api/v1/aircraft/search?q=HLDB", 200);
        record("aircraft_track", "/api/v1/aircraft/" + inside + "/track", 200);
        record("sigmets", "/api/v1/sigmets", 200);
        record("sigmet_detail", "/api/v1/sigmets/" + sigmetId, 200);
        record("alerts", "/api/v1/alerts", 200);
        record("alerts_history", "/api/v1/alerts/history", 200);
        record("radar_frames", "/api/v1/radar/frames", 200);
        record("airports", "/api/v1/airports", 200);
        record("airport_wx", "/api/v1/airports/RKSI/wx", 200);
        record("replay", "/api/v1/replay?at=" + Instant.now().minusSeconds(5).truncatedTo(ChronoUnit.SECONDS) + "&bbox=" + bbox, 200);
        record("stats_traffic", "/api/v1/stats/traffic?day=" + day, 200);
        record("stats_alerts", "/api/v1/stats/alerts", 200);
        record("stats_sigmet", "/api/v1/stats/sigmet", 200);
        record("problem_400", "/api/v1/aircraft?bbox=1,2,3", 400);
        record("problem_404", "/api/v1/ops/providers", 404);
        Files.writeString(OUT.resolve("index.json"), Streams.JSON.writeValueAsString(index), StandardCharsets.UTF_8);

        // Java 쪽 최소 확인(자세한 필드 검증은 Python 도구가 한다)
        // RFC 7946 §3.2: Feature 는 geometry 멤버를 반드시 가진다 — 위치가 없으면 null(키를 빼면 GeoJSON 이 아니다)
        JsonNode sigFc = Streams.JSON.readTree(Files.readString(OUT.resolve("sigmets.json"))).path("body");
        assertThat(sigFc.path("features").size()).isEqualTo(3);
        for (JsonNode f : sigFc.path("features")) {
            assertThat(f.has("geometry")).as("geometry member of " + f.path("id").asString()).isTrue();
            if (f.path("id").asString().endsWith("-X")) {
                assertThat(f.get("geometry").isNull()).isTrue();
                assertThat(f.path("properties").path("excluded_reason").asString()).isEqualTo("no_coordinates");
            }
            if (f.path("id").asString().endsWith("-U")) { // 미발표 상한을 숫자로 채우지 않는다
                assertThat(f.path("properties").has("top_ft")).isFalse();
                assertThat(f.path("properties").path("top_source").asString()).isEqualTo("unknown");
                assertThat(f.path("properties").path("base_source").asString()).isEqualTo("assumed_surface");
            }
        }
        JsonNode alerts = Streams.JSON.readTree(Files.readString(OUT.resolve("alerts.json"))).path("body");
        boolean found = false;
        for (JsonNode a : alerts.path("items")) if (inside.equals(a.path("hex").asString())) {
            found = true;
            assertThat(a.path("kind").asString()).isEqualTo("OBSERVED");
            assertThat(a.path("evidence").path("confirmations").asInt()).isEqualTo(2);
        }
        assertThat(found).isTrue();
        JsonNode dbItem = Streams.JSON.readTree(Files.readString(OUT.resolve("aircraft_search_db.json"))).path("body").path("items").get(0);
        assertThat(dbItem.path("hex").asString()).isEqualTo("a1d0db");
        assertThat(dbItem.path("live").asBoolean()).isFalse();
        assertThat(dbItem.has("lat")).as("no current position for a DB-only aircraft").isFalse();
    }
}
