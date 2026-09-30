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
    /** REST /status 가 보는 값(WS 와 같은 3 s 캐시, R-53) — 기다릴 때도 같은 값을 본다. */
    @Autowired dev.wakeline.ws.WsHub status;
    @Autowired dev.wakeline.route.RouteReader routes;
    /** 연안 교통량 읽기(ADR-023) — 5 s 메모. 기다림은 이것으로(REST 요청 제한을 쓰지 않게). */
    @Autowired dev.wakeline.rest.TrafficGridReader trafficGrid;
    /** 관측 수신 범위(계약 v5 §G27 · ADR-027) — 스냅숏(60 s 캐시)을 새로 만들어 기다린다(REST 요청 제한을 쓰지 않게) */
    @Autowired dev.wakeline.coverage.ShipCoverage coverage;
    /** 일 통계 집계(계약 v5 §G20) — 끝난 KST 날짜를 실제로 집계해 통계 응답에 행이 있게 한다 */
    @Autowired dev.wakeline.persist.MaintenanceJobs jobs;

    final Map<String, String> index = new LinkedHashMap<>();
    static final String ASIA_PACIFIC = "-90,45,90,180";

    /** ais 상태 해시 shards 원소(계약 v4 §D 필드 그대로 — 합성 값). */
    static String shard(String scope, Instant hb) {
        return "{\"scope\":\"" + scope + "\",\"state\":\"receiving\",\"connected\":true,\"last_msg_at\":\"" + hb + "\",\"msgs_per_s\":2.1,"
                + "\"lag_p50_s\":1.9,\"gap_open_since\":null,\"gap_reason\":null,\"sessions_ended\":0,\"ping_rtt_max_s\":0.31,\"ws_queue_max\":2}";
    }

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

    /** 수집기가 쓰는 모양의 기상청 프레임 목록(합성 값): 부분 합성 1 · 완전 1. */
    static String krFrames(String partialTm, String fullTm, Instant at) {
        String ids15 = String.join(",", List.of("\"KWK\"", "\"GDK\"", "\"GNG\"", "\"KSN\"", "\"JNI\"", "\"MYN\"", "\"PSN\"", "\"GSN\"", "\"SSP\"",
                "\"BRI\"", "\"GAS\"", "\"GRS\"", "\"SBS\"", "\"SDS\"", "\"MHS\""));
        return ("[{\"tm\":\"%s\",\"obs_tm\":\"%s\",\"fetched_at\":\"%s\",\"expires_at\":\"%s\",\"bytes\":68,\"echo_cells\":8587,\"raw_ref\":\"kma_radar/a.bin.gz\","
                + "\"stations\":7,\"station_ids\":[\"KWK\",\"GDK\",\"GNG\",\"KSN\",\"JNI\",\"MYN\",\"PSN\"],\"stations_ref\":15,\"partial\":true,"
                + "\"refetches\":1,\"upgrades\":0,\"refetched_at\":\"%s\",\"refetch_until\":\"%s\"},"
                + "{\"tm\":\"%s\",\"obs_tm\":\"%s\",\"fetched_at\":\"%s\",\"expires_at\":\"%s\",\"bytes\":68,\"echo_cells\":38060,\"raw_ref\":\"kma_radar/b.bin.gz\","
                + "\"stations\":15,\"station_ids\":[%s],\"stations_ref\":15,\"partial\":false,\"refetches\":0,\"upgrades\":0,\"refetch_until\":\"%s\"}]")
                .formatted(partialTm, partialTm, at.minusSeconds(600), at.plusSeconds(3600), at.minusSeconds(60), at.plusSeconds(900),
                        fullTm, fullTm, at.minusSeconds(300), at.plusSeconds(3600), ids15, at.plusSeconds(1200));
    }

    static Map<String, String> krMeta(String latestTm, Instant at) {
        return Map.ofEntries(Map.entry("available", "1"), Map.entry("status", "200"), Map.entry("note", ""), Map.entry("latest_tm", latestTm),
                Map.entry("product", "HSR"), Map.entry("cmp", "HSR"), Map.entry("coordinates", "[[121.8,39.9],[132.9,39.9],[132.9,31.6],[121.8,31.6]]"),
                Map.entry("width", "640"), Map.entry("height", "480"), Map.entry("projection", "EPSG:3857"), Map.entry("grid", "{\"nx\":2305,\"ny\":2881}"),
                Map.entry("legend", "[[5,[120,190,255,150]]]"), Map.entry("min_dbz", "5.0"), Map.entry("stations", "15"),
                Map.entry("station_ids", "KWK,GDK,GNG,KSN,JNI,MYN,PSN,GSN,SSP,BRI,GAS,GRS,SBS,SDS,MHS"), Map.entry("stations_ref", "15"), Map.entry("partial", "0"),
                Map.entry("fetched_at", at.minusSeconds(300).toString()), Map.entry("checked_at", at.toString()));
    }

    /**
     * 기상청 내려받기 '파일 없음' 연속(운영 로그 2026-09-30 — 수집기 missing_*): 14:50 부터 5 tm 이 목록에는 EXT 로 있고 내려받기는 없음으로 답했다.
     * 확인 간격 300 s(5분마다 — 연속이 60분을 넘으면 수집기가 900 으로 늦춘다, 계약 v5 §G26). 마지막 확인의 목록은 15:10 에서 멈췄다 — 가장 새 tm 15:10 ·
     * 15:10 뒤로 실은 tm 0(계약 v5 §G26 개정 2026-10-01).
     */
    static Map<String, String> krMissing(Instant at) {
        return Map.of("missing_since_tm", "202609291450", "missing_last_tm", "202609291510", "missing_tms", "5",
                "missing_checked_at", at.toString(), "missing_file", "RDR_CMP_HSR_PUB_202609291510.bin.gz", "missing_listed", "EXT",
                "missing_probe_every_s", "300", "missing_list_tm", "202609291510", "missing_list_newer", "0");
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
                INSERT INTO metar_obs (icao, obs_time, raw, temp_c, dewp_c, wind_dir, wind_kt, vis_sm, vis_raw, ceiling_ft, ceiling_state, flight_cat, flight_cat_source, provider, fetched_at)
                VALUES ('RKSI', date_trunc('hour', now()), 'RKSI 271200Z 27010KT 9999 BKN030 20/15 Q1013', 20, 15, 270, 10, 6.0, '6+', 3000, 'measured', 'VFR', 'awc', 'awc', now())
                ON CONFLICT DO NOTHING""").update();

        String day = dev.wakeline.persist.MaintenanceJobs.today().toString(); // 통계 날짜 = KST 날짜(계약 v5 §G20)
        String bbox = "124,33,132,39";
        record("status", "/api/v1/status", 200);
        record("aircraft", "/api/v1/aircraft?bbox=" + bbox, 200);
        record("aircraft_full", "/api/v1/aircraft?bbox=" + bbox + "&detail=full", 200);
        // 등록 노선(계약 v4 §A): 수집기가 쓰는 캐시 키에 합성 노선(가상 공항) — api 는 wakeline_api 로 읽기만 한다
        String callsign = "IT" + inside.substring(2).toUpperCase();
        String routeKey = "wakeline:route:" + callsign;
        ItStack.admin().opsForValue().set(routeKey, dev.wakeline.route.RouteInfoTest.found(callsign).toString(), Duration.ofMinutes(5));
        try {
            await("route cache", WAIT, () -> "found".equals(routes.forCallsign(callsign).status())); // api 의 5 s 메모리 캐시가 지나기를
            record("aircraft_detail", "/api/v1/aircraft/" + inside, 200);
        } finally {
            ItStack.admin().delete(routeKey);
        }
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
        // 기상청 합성 레이더(ADR-021): 수집기 역할로 영상 · 목록 · meta — 14:40 은 부분 합성(7/15곳, 한 번 다시 받음), 14:45 는 완전(15/15곳)
        String krPartial = "202609291440", krFull = "202609291445";
        Instant krAt = Instant.now().truncatedTo(ChronoUnit.SECONDS);
        try {
            for (String tm : List.of(krPartial, krFull)) ItStack.collector().opsForValue().set("wakeline:radar_kr:frame:" + tm, RadarKrIT.PNG_1X1);
            ItStack.collector().opsForValue().set("wakeline:radar_kr:frames", krFrames(krPartial, krFull, krAt));
            ItStack.hset(ItStack.collector(), "wakeline:radar_kr:meta", krMeta(krFull, krAt));
            record("radar_kr", "/api/v1/radar/kr", 200);
            ItStack.hset(ItStack.collector(), "wakeline:radar_kr:meta", krMissing(krAt));
            record("radar_kr_missing", "/api/v1/radar/kr", 200); // 저장된 프레임은 그대로 · 새 프레임은 기상청 파일이 없어 오지 않는다
        } finally {
            ItStack.deleteKeys("wakeline:radar_kr:*");
        }
        // 연안 교통량(ADR-023): 수집기 역할로 스냅샷(SET EX 1200) — 칸 2 · 해양격자에 없는 칸 1 · 위치 조회 실패 칸 1(부정 캐시)
        try {
            TrafficGridIT.clearHeartbeat();
            TrafficGridIT.publish(TrafficGridIT.snapshot(Instant.now().truncatedTo(ChronoUnit.SECONDS).minusSeconds(90), 12));
            await("traffic grid snapshot", WAIT, () -> "ok".equals(trafficGrid.read().status()));
            record("traffic_grid", "/api/v1/traffic/grid", 200);
        } finally {
            ItStack.deleteKeys("wakeline:traffic_grid");
        }
        record("airports", "/api/v1/airports", 200);
        record("airport_wx", "/api/v1/airports/RKSI/wx", 200);
        record("replay", "/api/v1/replay?at=" + Instant.now().minusSeconds(5).truncatedTo(ChronoUnit.SECONDS) + "&bbox=" + bbox, 200);
        // 통계(계약 v5 §G20 — 리뷰 2026-09-30): 오늘(KST)은 집계 전이라 items 가 비어, 교통량 KST 시 · 한 날짜 · 시마다 한 행 규칙이 실제 응답을 보지 못했다.
        // 끝난 KST 날짜(어제)에 관심 지역 항적 — 00:30 KST(앞 UTC 날 파티션) · 23:30 KST(그 UTC 날 파티션) — · 그날 발표된 SIGMET · 그 안의 알림을 넣고
        // 실제 집계(MaintenanceJobs.aggregateDay)를 돌린 뒤 기록한다. 오늘(집계 전)의 응답은 stats_traffic_today 로 따로 남긴다.
        java.time.LocalDate statsDay = dev.wakeline.persist.MaintenanceJobs.today().minusDays(1);
        Instant k0 = statsDay.atStartOfDay(dev.wakeline.persist.MaintenanceJobs.DAY_ZONE).toInstant();
        String statsSigmet = "RKRR:IT-REST-STATS:" + System.currentTimeMillis();
        var root = admin();
        dev.wakeline.DbTestSupport.ensureTrackPartitions(ItStack.DB, k0, k0.plusSeconds(24 * 3600 - 1));
        try {
            for (var p : List.of(Map.entry("a1d0f1", k0.plusSeconds(30 * 60)), Map.entry("a1d0f2", k0.plusSeconds(23 * 3600 + 30 * 60))))
                root.sql("""
                        INSERT INTO track_point (hex, ts, geom, alt_ft, provider, fetched_at)
                        VALUES (:h, :t, ST_SetSRID(ST_MakePoint(127.8, 36.5), 4326), 30000, 'adsb_lol', :t)""")
                        .param("h", p.getKey()).param("t", java.sql.Timestamp.from(p.getValue())).update();
            root.sql("""
                    INSERT INTO sigmet (id, fir_id, series_id, hazard, valid_from, valid_to, raw_text, provider, fetched_at)
                    VALUES (:id, 'RKRR', 'S1', 'TS', :f, :f::timestamptz + interval '4 hours', 'WSKR31 RKSI 290100', 'awc', now())""")
                    .param("id", statsSigmet).param("f", java.sql.Timestamp.from(k0.plusSeconds(3600))).update();
            root.sql("""
                    INSERT INTO alert_event (hex, sigmet_id, kind, entered_at, left_at, close_reason, evidence)
                    VALUES ('a1d0f1', :s, 'OBSERVED', :e, :e::timestamptz + interval '10 minutes', 'left', '{}'::jsonb)""")
                    .param("s", statsSigmet).param("e", java.sql.Timestamp.from(k0.plusSeconds(3660))).update();
            jobs.aggregateDay(statsDay);
            record("stats_traffic", "/api/v1/stats/traffic?day=" + statsDay, 200);
            record("stats_traffic_today", "/api/v1/stats/traffic?day=" + day, 200);
            record("stats_alerts", "/api/v1/stats/alerts", 200);
            record("stats_sigmet", "/api/v1/stats/sigmet", 200);
        } finally { // 다른 시험(같은 DB)에 남기지 않는다
            root.sql("DELETE FROM alert_event WHERE sigmet_id = :s").param("s", statsSigmet).update();
            root.sql("DELETE FROM sigmet WHERE id = :s").param("s", statsSigmet).update();
            root.sql("DELETE FROM track_point WHERE hex IN ('a1d0f1', 'a1d0f2') AND ts >= :a AND ts < :b")
                    .param("a", java.sql.Timestamp.from(k0)).param("b", java.sql.Timestamp.from(k0.plusSeconds(24 * 3600))).update();
            root.sql("DELETE FROM stats_daily WHERE day = :d").param("d", statsDay).update();
        }
        JsonNode traffic = Streams.JSON.readTree(Files.readString(OUT.resolve("stats_traffic.json"))).path("body");
        assertThat(traffic.path("aggregated").asBoolean()).isTrue();
        // 같은 DB 를 쓰는 다른 통합 시험의 항적이 그날 다른 시에 있을 수 있다 — 넣은 두 순간의 KST 시(00 · 23)가 그 날짜의 행으로 있는지만 본다(나머지 규칙은 Python 도구)
        Map<String, Integer> hours = new LinkedHashMap<>();
        for (JsonNode it : traffic.path("items")) {
            assertThat(it.path("day").asString()).isEqualTo(statsDay.toString());
            hours.put(it.path("dim").asString(), it.path("value").asInt());
        }
        assertThat(hours).as("KST hours of that KST day — 00:30 and 23:30 KST").containsKeys("00", "23");
        assertThat(hours.get("00")).isPositive();
        assertThat(hours.get("23")).isPositive();
        for (String f : List.of("stats_alerts", "stats_sigmet"))
            assertThat(Streams.JSON.readTree(Files.readString(OUT.resolve(f + ".json"))).path("body").path("items")).as(f).isNotEmpty();
        record("problem_400", "/api/v1/aircraft?bbox=1,2,3", 400);
        record("problem_404", "/api/v1/ops/providers", 404);

        // 선박(계약 v2 §B3): ais 수집기와 같은 ACL 사용자로 발행 → 소비 → 메모리·DB. 공백 1건(끝난 것).
        String mmsi = "440700100";
        Instant seenShip = Instant.now().minusSeconds(5);
        Streams.xaddAis(Streams.ships(Streams.nextFetchedAt(), List.of(Streams.shipState(mmsi, 35.1, 129.05, seenShip),
                Streams.shipState("440700101", 35.2, 129.1, seenShip)), List.of(Streams.shipStatic(mmsi, "IT SAMPLE", 70, seenShip.minusSeconds(60)))));
        Instant gapStart = Instant.now().minusSeconds(1800).truncatedTo(ChronoUnit.MILLIS);
        Streams.xaddAis(Streams.aisGap(Streams.nextFetchedAt(), gapStart, gapStart.plusSeconds(95), "server closed (1006)"));
        // 구역 공백(계약 v4 §D): 아시아·태평양 구역만 끊겼다 — 부산 선박의 항적·공백 목록에 scope 와 함께
        Streams.xaddAis(Streams.aisGap(Streams.nextFetchedAt(), gapStart.plusSeconds(300), gapStart.plusSeconds(400), "idle 120 s — no messages", ASIA_PACIFIC));
        await("ship rows", WAIT, () -> count("SELECT count(*) FROM ship_position WHERE mmsi = ?", mmsi) == 1
                && count("SELECT count(*) FROM ship WHERE mmsi = ?", mmsi) == 1);
        await("gap row", WAIT, () -> count("SELECT count(*) FROM ingest_gap WHERE reason = 'server closed (1006)'") >= 1);
        await("scoped gap row", WAIT, () -> count("SELECT count(*) FROM ingest_gap WHERE scope = ?", ASIA_PACIFIC) >= 1);
        record("ships", "/api/v1/ships?bbox=128,34,130,36", 200);
        record("ship_detail", "/api/v1/ships/" + mmsi, 200);
        record("ship_track", "/api/v1/ships/" + mmsi + "/track", 200);
        record("ais_gaps", "/api/v1/ais/gaps", 200);
        record("problem_bad_mmsi", "/api/v1/ships/12345", 400);
        record("ship_detail_nostatic", "/api/v1/ships/440700101", 200); // 정적 정보 없음 → 분류 unknown(추정하지 않는다)
        // 선박 검색(계약 v5 §B1): 실시간(선명 앞부분) · DB 에만 있는 선박(live=false, 위치 null, 마지막 저장 시각 · 마지막 수신 기록 §G4) · 형식 오류
        record("ship_search", "/api/v1/ships/search?q=IT%20SAMPLE", 200);
        db.sql("""
                INSERT INTO ship (mmsi, name, call_sign, imo, ship_type, first_seen, last_seen, updated_at, provider)
                VALUES ('440700199', 'IT STORED ONLY', NULL, NULL, 52, now() - interval '3 days', now() - interval '2 days', now() - interval '2 days', 'fixture')
                ON CONFLICT (mmsi) DO NOTHING""").update();
        db.sql("""
                INSERT INTO ship_position (mmsi, ts, geom, position_source, provider)
                VALUES ('440700199', date_trunc('second', now()) - interval '2 hours', ST_SetSRID(ST_MakePoint(129.1, 35.05), 4326), 'epfs', 'fixture')
                ON CONFLICT DO NOTHING""").update();
        record("ship_search_db", "/api/v1/ships/search?q=it%20stored", 200);
        record("ship_detail_stored", "/api/v1/ships/440700199", 200); // 실시간 아님 — 마지막 수신 기록 last_seen_at(계약 v5 §G4)
        record("problem_bad_ship_query", "/api/v1/ships/search?q=a", 400);
        // 관측 수신 범위(계약 v5 §G27): 셈은 api 시작 분부터 — 지금 시각의 보고 하나(부산 앞바다 129.0 · 35.0 칸)가 칸이 되기를 기다린다
        Instant seenCov = Instant.now();
        Streams.xaddAis(Streams.ships(Streams.nextFetchedAt(), List.of(Streams.shipState("440700102", 35.15, 129.2, seenCov)), List.of()));
        await("observed coverage cell", WAIT, () -> coverage.snapshotNow().cells().stream()
                .anyMatch(c -> c.lon0() == 129.0 && c.lat0() == 35.0 && c.lastSeenMs() >= seenCov.toEpochMilli()));
        record("ship_coverage", "/api/v1/ships/coverage", 200);

        // 상태(계약 v2 §A3·§B3): ais 수집기 heartbeat → status.sources.ais, 수집기 heartbeat 의 adsb_fi_rps_1m → status.demand.
        // 수집기 heartbeat 는 다른 테스트(수집기 없음 → adsb_fi_rps_1m 모름)에 남지 않게 기록 뒤 지운다.
        Instant hb = Instant.now();
        // state · bbox(계약 v3 §A) → status.sources.ais.state · coverage, shards(계약 v4 §D — 구역마다 연결 하나) → shards · coverage(구역 상자의 합)
        String shards = "[" + shard("-90,-180,90,0", hb) + "," + shard(ASIA_PACIFIC, hb) + "]";
        ItStack.hset(ItStack.ais(), "wakeline:ais:status", Map.of("provider", "fixture", "connected", "1", "msgs_per_s", "4.20",
                "last_msg_at", hb.toString(), "updated_at", hb.toString(), "gap_open_since", "", "state", "receiving",
                "bbox", "-90,-180,90,0|" + ASIA_PACIFIC, "shards", shards));
        try {
            ItStack.hset(ItStack.collector(), "wakeline:collector", Map.of("adsb_fi_rps_1m", "0.4167", "demand_at", hb.toString()));
            Map<String, String> kr = new java.util.HashMap<>(krMeta(krPartial, krAt));
            kr.putAll(Map.of("stations", "7", "stations_ref", "15", "partial", "1", "station_ids", "KWK,GDK,GNG,KSN,JNI,MYN,PSN"));
            kr.putAll(krMissing(krAt));
            ItStack.hset(ItStack.collector(), "wakeline:radar_kr:meta", kr);
            await("status sources.ais, demand rate and radar_kr sites", WAIT, () -> {
                Map<String, Object> st = status.status();
                return st.get("sources") instanceof Map<?, ?> src && src.get("ais") instanceof Map<?, ?> ais && Boolean.TRUE.equals(ais.get("connected"))
                        && st.get("demand") instanceof Map<?, ?> d && d.get("adsb_fi_rps_1m") != null
                        && st.get("radar_kr") instanceof Map<?, ?> k && k.get("partial") != null && k.get("missing") != null;
            });
            record("status_ais", "/api/v1/status", 200);
        } finally {
            ItStack.deleteKeys("wakeline:collector");
            ItStack.deleteKeys("wakeline:radar_kr:*");
        }
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
        JsonNode shipFc = Streams.JSON.readTree(Files.readString(OUT.resolve("ships.json"))).path("body");
        assertThat(shipFc.path("type").asString()).isEqualTo("FeatureCollection");
        for (JsonNode f : shipFc.path("features")) assertThat(f.has("geometry")).isTrue();
        JsonNode shipTrack = Streams.JSON.readTree(Files.readString(OUT.resolve("ship_track.json"))).path("body");
        assertThat(shipTrack.path("geometry").path("type").asString()).isEqualTo("MultiLineString");
        // DH-7/GAP-17: 이력에도 시정 원문 — '6+'(6 SM 이상, 하한)가 정확한 값 6 처럼 보이지 않게
        JsonNode wx = Streams.JSON.readTree(Files.readString(OUT.resolve("airport_wx.json"))).path("body");
        assertThat(wx.path("latest").path("vis_raw").asString()).isEqualTo("6+");
        assertThat(wx.path("history").get(0).path("vis_raw").asString()).isEqualTo("6+");
        JsonNode route = Streams.JSON.readTree(Files.readString(OUT.resolve("aircraft_detail.json"))).path("body").path("route");
        assertThat(route.path("status").asString()).isEqualTo("found");
        assertThat(route.path("callsign").asString()).isEqualTo("ITD001");
        assertThat(route.path("origin").path("icao").asString()).isEqualTo("ZZAA");
        JsonNode dest = Streams.JSON.readTree(Files.readString(OUT.resolve("ship_detail.json"))).path("body").path("destination_info");
        assertThat(dest.path("raw").asString()).isEqualTo("KR PUS");
        assertThat(dest.path("to").path("locode").asString()).isEqualTo("KRPUS");
        JsonNode noStatic = Streams.JSON.readTree(Files.readString(OUT.resolve("ship_detail_nostatic.json"))).path("body");
        assertThat(noStatic.has("static")).isFalse();
        assertThat(noStatic.has("destination_info")).isFalse();
        assertThat(noStatic.path("category").asString()).isEqualTo("unknown");
        JsonNode krBody = Streams.JSON.readTree(Files.readString(OUT.resolve("radar_kr.json"))).path("body");
        assertThat(krBody.path("frames").size()).isEqualTo(2);
        assertThat(krBody.path("frames").get(0).path("partial").asBoolean()).isTrue();
        assertThat(krBody.path("frames").get(0).path("stations").asInt()).isEqualTo(7);
        assertThat(krBody.path("stations").asInt()).as("top level = the latest frame").isEqualTo(15);
        assertThat(krBody.has("missing")).as("no streak in the collector hash — no key").isFalse();
        JsonNode krMissing = Streams.JSON.readTree(Files.readString(OUT.resolve("radar_kr_missing.json"))).path("body");
        assertThat(krMissing.path("missing").path("since_tm").asString()).isEqualTo("202609291450");
        assertThat(krMissing.path("missing").path("tms").asInt()).isEqualTo(5);
        assertThat(krMissing.path("missing").path("probe_every_s").asInt()).as("the collector's probe interval (§G26)").isEqualTo(300);
        assertThat(krMissing.path("missing").path("list_tm").asString()).as("the newest tm the last check's listing had").isEqualTo("202609291510");
        assertThat(krMissing.path("missing").path("list_newer").isInt()).isTrue();
        assertThat(krMissing.path("missing").path("list_newer").asInt()).as("the listing did not grow past last_tm").isZero();
        assertThat(krMissing.path("frames").size()).as("stored frames are still served").isEqualTo(2);
        JsonNode st = Streams.JSON.readTree(Files.readString(OUT.resolve("status_ais.json"))).path("body");
        assertThat(st.path("radar_kr").path("stations").asInt()).isEqualTo(7);
        assertThat(st.path("radar_kr").path("partial").asBoolean()).isTrue();
        assertThat(st.path("radar_kr").path("missing").path("listed").toString()).isEqualTo("[\"EXT\"]");
        assertThat(st.path("sources").path("ais").path("msgs_per_s").asDouble()).isEqualTo(4.2);
        assertThat(st.path("sources").path("ais").path("state").asString()).isEqualTo("receiving");
        assertThat(st.path("sources").path("ais").path("coverage").toString()).isEqualTo("[[-90.0,-180.0,90.0,0.0],[-90.0,45.0,90.0,180.0]]");
        JsonNode shardView = st.path("sources").path("ais").path("shards");
        assertThat(shardView.size()).isEqualTo(2);
        assertThat(shardView.get(1).path("coverage").toString()).isEqualTo("[[-90.0,45.0,90.0,180.0]]");
        assertThat(shardView.get(1).path("state").asString()).isEqualTo("receiving");
        assertThat(shardView.get(1).path("connected").asBoolean()).isTrue();
        assertThat(shardView.get(1).has("gap_open_since")).isFalse();
        // 구역 공백: 항적·공백 목록에 scope, 구역 없는 옛 형식은 키 없음
        boolean scopedInTrack = false;
        for (JsonNode g : shipTrack.path("gaps")) if (ASIA_PACIFIC.equals(g.path("scope").asString(""))) scopedInTrack = true;
        assertThat(scopedInTrack).as("the Busan ship's track lists the Asia-Pacific gap with its scope").isTrue();
        JsonNode aisGaps = Streams.JSON.readTree(Files.readString(OUT.resolve("ais_gaps.json"))).path("body").path("items");
        assertThat(aisGaps).anySatisfy(g -> assertThat(g.path("scope").asString("")).isEqualTo(ASIA_PACIFIC));
        assertThat(aisGaps).anySatisfy(g -> assertThat(g.has("scope")).isFalse());
        // 스트림의 레거시 "gnss" 는 받자마자 모름(계약 v3 §B) — REST 는 키를 뺀다
        assertThat(shipFc.path("features").get(0).path("properties").has("position_source")).isFalse();
        assertThat(shipTrack.path("points").get(0).has("position_source")).isFalse();
        assertThat(shipTrack.path("properties").path("gap_break_min_s").asInt()).isEqualTo(60);
        assertThat(shipTrack.path("properties").path("gaps_truncated").asBoolean(true)).isFalse();
        assertThat(st.path("demand").path("adsb_fi_rps_1m").asDouble()).isEqualTo(0.417); // 수집기 값(0.4167)을 api 가 소수 셋째 자리로
        JsonNode cov = Streams.JSON.readTree(Files.readString(OUT.resolve("ship_coverage.json"))).path("body");
        assertThat(cov.path("cells").size()).isPositive();
        assertThat(cov.path("cell_deg").asDouble()).isEqualTo(0.5);
        JsonNode shipHit = Streams.JSON.readTree(Files.readString(OUT.resolve("ship_search.json"))).path("body").path("items").get(0);
        assertThat(shipHit.path("mmsi").asString()).isEqualTo(mmsi);
        assertThat(shipHit.path("live").asBoolean()).isTrue();
        JsonNode storedHit = Streams.JSON.readTree(Files.readString(OUT.resolve("ship_search_db.json"))).path("body").path("items").get(0);
        assertThat(storedHit.path("mmsi").asString()).isEqualTo("440700199");
        assertThat(storedHit.path("live").asBoolean()).isFalse();
        assertThat(storedHit.path("lat").isNull()).as("no current position for a stored-only ship — explicit null").isTrue();
        assertThat(storedHit.path("last_position_at").isString()).isTrue();
        JsonNode dbItem = Streams.JSON.readTree(Files.readString(OUT.resolve("aircraft_search_db.json"))).path("body").path("items").get(0);
        assertThat(dbItem.path("hex").asString()).isEqualTo("a1d0db");
        assertThat(dbItem.path("live").asBoolean()).isFalse();
        assertThat(dbItem.has("lat")).as("no current position for a DB-only aircraft").isFalse();
    }
}
