package dev.wakeline.ws;

import dev.wakeline.demand.CollectorDemandStatus;
import dev.wakeline.demand.DemandStats;
import dev.wakeline.aircraft.core.AircraftState;
import dev.wakeline.weather.core.Alert;
import dev.wakeline.domain.HotCell;
import dev.wakeline.domain.ShipState;
import dev.wakeline.domain.ShipStatic;
import dev.wakeline.weather.core.SigmetRecord;
import dev.wakeline.weather.core.AlertStateMachine;
import dev.wakeline.weather.core.EngineEvents;
import dev.wakeline.weather.core.EngineService;
import dev.wakeline.ingest.AisStatus;
import dev.wakeline.ingest.AisStatusReader;
import dev.wakeline.ingest.IngestEvents;
import dev.wakeline.weather.core.RadarStore;
import dev.wakeline.platform.support.Receipt;
import dev.wakeline.ingest.ShipStore;
import dev.wakeline.settings.RegionSettings;
import dev.wakeline.persist.StoredStaticReader;
import dev.wakeline.portcalls.PortCallFixtures;
import dev.wakeline.portcalls.PortCallIndex;
import dev.wakeline.portcalls.PortCallReader;
import dev.wakeline.status.StatusService;
import dev.wakeline.route.RouteInfoTest;
import dev.wakeline.route.RouteReader;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.locationtech.jts.geom.Coordinate;
import org.locationtech.jts.geom.GeometryFactory;
import org.locationtech.jts.geom.Polygon;
import org.springframework.boot.autoconfigure.AutoConfigurations;
import org.springframework.boot.env.YamlPropertySourceLoader;
import org.springframework.boot.jackson.autoconfigure.JacksonAutoConfiguration;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;
import org.springframework.core.env.EnumerablePropertySource;
import org.springframework.core.env.PropertySource;
import org.springframework.core.io.ClassPathResource;
import org.springframework.data.redis.core.HashOperations;
import org.springframework.data.redis.core.StringRedisTemplate;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;
import tools.jackson.databind.node.ArrayNode;
import tools.jackson.databind.node.JsonNodeFactory;
import tools.jackson.databind.node.ObjectNode;
import tools.jackson.databind.node.StringNode;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Predicate;
import java.util.regex.Pattern;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * WS 메시지 계약(계약 v5 §E1 · ADR-020 · R-76). 서버 메시지 17종은 실제 빌더 — WsMessages · WsHub(스냅샷·diff·알림·SIGMET·레이더·status·ping)
 * · ShipFanout · ShipGrid · DemandService.message · StatusService · RouteReader · DestinationParser — 가 <b>운영과 같은 JSON 설정</b>
 * (application.yml 의 spring.jackson.* 를 JacksonAutoConfiguration 에 그대로 — null 인 맵 값도 뺀다)으로 만든 것을 FakeWsSession 에서 받아
 * schemas/ws/server.v1.json 으로 검증한다. 클라이언트 메시지 10종(lib/ws.ts 가 보내는 모양)은 schemas/ws/client.v1.json 으로 검증하고 실제 핸들러가
 * 오류 없이 받는지 본다.
 * <p>표본은 웹 시험 fixture {@code apps/web/tests/fixtures/ws-samples.v1.json}(커밋)으로 남긴다 — 웹 검증기(lib/ws-validate.ts)는 모든 표본을 받아야 한다.
 * 기본 실행은 커밋된 fixture 가 지금 빌더의 출력과 같은지 비교한다(시각·지연처럼 실행마다 달라지는 값은 가리고, 순서가 없는 목록은 정렬해서) —
 * 빌더를 바꾸고 fixture 를 다시 만들지 않으면 여기서 실패한다. 다시 만들기(스키마·빌더를 의도적으로 바꿨을 때):
 * {@code cd apps/api && ./gradlew test --tests 'dev.wakeline.ws.WsSchemaContractTest' -PupdateWsSamples} 또는 {@code make ws-samples}.
 */
class WsSchemaContractTest {
    static final Path SCHEMA_DIR = WsSchemas.DIR;
    static final Path STREAM_SCHEMA_DIR = Path.of("../../schemas").toAbsolutePath().normalize();
    static final Path SAMPLES = Path.of("../../apps/web/tests/fixtures/ws-samples.v1.json").toAbsolutePath().normalize();
    /** 입출항 표본의 고정 시각(색인 창 · 날짜가 실행마다 같게 — 2026-09-29 22:00 KST). */
    static final Instant PC_NOW = Instant.parse("2026-09-29T13:00:00Z");

    /** 공유 fixture 행(수집기가 실제 전체 기록을 해석한 것)의 호출부호만 바꾼 행. */
    static PortCallIndex.Row portCallRow(String cs) {
        PortCallIndex.Row r = PortCallFixtures.row(PC_NOW.minusSeconds(900));
        return new PortCallIndex.Row(r.portAuthorityCode(), r.portAuthority(), cs, r.listedDate(), r.reportedName(), r.nationality(), r.kind(), r.purpose(),
                r.firstPortCode(), r.firstPortName(), r.prevPortCode(), r.prevPortName(), r.nextPortCode(), r.nextPortName(), r.destPortCode(),
                r.destPortName(), r.entryAt(), r.entryRevision(), r.exitAt(), r.exitRevision(), r.berth(), r.fetchedAt());
    }
    static final String REGENERATE = "cd apps/api && ./gradlew test --tests 'dev.wakeline.ws.WsSchemaContractTest' -PupdateWsSamples";

    /** 서버 → 클라이언트 17종(계약 v5 §E1). */
    static final List<String> SERVER_TYPES = List.of("welcome", "snapshot", "diff", "alerts", "alerts_batch", "selected", "error", "demand",
            "sigmets", "radar", "status", "ping", "pong", "ships_snapshot", "ships_diff", "ships_grid", "ship_selected");
    /** 클라이언트 → 서버 10종(WakelineWsHandler 의 switch). */
    static final List<String> CLIENT_TYPES = List.of("hello", "subscribe", "select", "pause", "resume", "resync", "layers", "select_ship", "pong", "ping");

    static JsonMapper json;

    @BeforeAll
    static void load() throws Exception {
        json = productionMapper();
    }

    /**
     * 운영 매퍼: application.yml 의 spring.jackson.* 를 JacksonAutoConfiguration 에 넣어 만든다(ObjectMapper 를 직접 설정하는 코드는 없다).
     * WsTestKit.JSON 은 값 포함 규칙만 non_null 이라 null 인 맵 값을 그대로 쓴다 — 운영은 내용 포함 규칙도 non_null(맵의 null 값을 뺀다).
     */
    static JsonMapper productionMapper() throws Exception {
        List<String> props = new ArrayList<>();
        for (PropertySource<?> ps : new YamlPropertySourceLoader().load("application", new ClassPathResource("application.yml"))) {
            if (!(ps instanceof EnumerablePropertySource<?> e)) continue;
            for (String n : e.getPropertyNames()) if (n.startsWith("spring.jackson.")) props.add(n + "=" + e.getProperty(n));
        }
        assertThat(props).as("application.yml spring.jackson.*").contains("spring.jackson.default-property-inclusion=non_null",
                "spring.jackson.property-naming-strategy=SNAKE_CASE");
        AtomicReference<JsonMapper> out = new AtomicReference<>();
        new ApplicationContextRunner().withConfiguration(AutoConfigurations.of(JacksonAutoConfiguration.class))
                .withPropertyValues(props.toArray(String[]::new))
                .run(ctx -> out.set(ctx.getBean(JsonMapper.class)));
        return out.get();
    }

    /**
     * 운영 EngineService(selected.prediction) · StatusService 의 공개 상태(연결 없는 Redis — 오류는 삼키고 "redis unavailable")를 WsHub 의 출처로 넣는다.
     * status 는 이 시점의 값 — 자료를 넣은 뒤에 부른다.
     */
    static void realStatus(WsTestKit k) {
        EngineService engine = new EngineService(k.snapshots, k.sigmets, e -> { }, k.meters);
        k.prediction = engine::predictionAvailability;
        k.status.set(new StatusService(k.snapshots, k.sigmets, k.radar, engine, new StringRedisTemplate(), k.props).publicStatus());
    }

    /**
     * Redis 에 수집기 heartbeat · 기상청 레이더 메타 · 활성 공급자 · AIS 상태 해시가 있을 때의 운영 StatusService 공개 상태(2차 리뷰 — 연결 없는 Redis 만으로는
     * sources.ais · radar_kr · active_providers · demand.adsb_fi_rps_1m 이 표본에 없어 웹 검증기가 그 값을 본 적이 없었다). 해시 값은 합성(수집기가 쓰는 모양).
     */
    @SuppressWarnings({"unchecked", "rawtypes"})
    static Map<String, Object> populatedStatus(WsTestKit k, Instant now) {
        HashOperations<String, Object, Object> hash = mock(HashOperations.class);
        Map<String, Map<Object, Object>> h = Map.of(
                "wakeline:collector", Map.of("fixture", "0", "adsb_fi_rps_1m", "0.2667", "region_at", now.minusSeconds(5).toString()),
                "wakeline:radar_kr:meta", Map.ofEntries(Map.entry("available", "1"), Map.entry("status", "200"), Map.entry("latest_tm", "202609290500"),
                        Map.entry("fetched_at", now.minusSeconds(120).toString()), Map.entry("checked_at", now.minusSeconds(30).toString()),
                        Map.entry("stations", "7"), Map.entry("stations_ref", "15"), Map.entry("partial", "1"), Map.entry("station_ids", "KSN,GDK,JNI,MYN,PSN,GSN,SSP"), // ADR-021
                        // 기상청 내려받기 '파일 없음' 연속(2026-09-30)
                        Map.entry("missing_since_tm", "202609290505"), Map.entry("missing_last_tm", "202609290525"), Map.entry("missing_tms", "5"),
                        Map.entry("missing_checked_at", now.minusSeconds(30).toString()), Map.entry("missing_file", "RDR_CMP_HSR_PUB_202609290525.bin.gz"),
                        Map.entry("missing_listed", "EXT,KMA"), Map.entry("missing_probe_every_s", "900"), // 계약 v5 §G26 — 늦춘 확인 간격
                        // 계약 v5 §G26 개정(2026-10-01): 마지막 확인의 목록 — 가장 새 tm 이 last_tm 이고 그 뒤로 싣지 않았다(목록도 자라지 않음)
                        Map.entry("missing_list_tm", "202609290525"), Map.entry("missing_list_newer", "0")),
                // hot: 수집기가 쓰지 않는 필드 — 공개 status 의 active_providers 에 실리지 않는다(허용 목록, 리뷰 cto-2026-10 S13)
                "wakeline:active", Map.of("region", "adsb_lol", "global", "opensky", "hot", "adsb_fi"),
                AisStatus.KEY, Map.of("provider", "aisstream", "connected", "1", "state", "receiving", "updated_at", now.minusSeconds(3).toString(),
                        "last_msg_at", now.minusSeconds(1).toString(), "msgs_per_s", "12.5",
                        "last_gap_started_at", now.minusSeconds(900).toString(), "last_gap_ended_at", now.minusSeconds(840).toString(), "last_gap_reason", "reconnect"));
        when(hash.entries(anyString())).thenAnswer(inv -> h.getOrDefault(inv.<String>getArgument(0), Map.of()));
        StringRedisTemplate redis = new StringRedisTemplate() {
            @Override public <HK, HV> HashOperations<String, HK, HV> opsForHash() { return (HashOperations) hash; }
        };
        AisStatus ais = new AisStatus(k.ships);
        new AisStatusReader(redis, ais).refresh();
        DemandStats demand = new DemandStats();
        demand.update(new DemandStats.Counts(1, 1, 1, 1, 1, 1));
        EngineService engine = new EngineService(k.snapshots, k.sigmets, e -> { }, k.meters);
        Map<String, Object> st = new StatusService(k.snapshots, k.sigmets, k.radar, engine, redis, new RegionSettings(redis, null, null, k.props), demand, ais)
                .publicStatus();
        assertThat(((Map<?, ?>) st.get("sources")).get("ais")).as("sources.ais").isNotNull();
        assertThat(((Map<String, Object>) st.get("radar_kr")).keySet()).as("radar_kr").contains("available", "status", "latest_tm", "stations", "stations_ref", "partial", "missing");
        assertThat(((Map<?, ?>) st.get("demand")).get("adsb_fi_rps_1m")).as("demand.adsb_fi_rps_1m").isNotNull();
        return st;
    }

    static String type(String message) { return json.readTree(message).path("type").asString(); }

    // ---------------------------------------------------------------- 서버 메시지(실제 빌더)

    record Sample(String name, String message) {}

    /** 모든 세션이 받은 메시지 전부와 이름 붙인 표본. */
    record Run(List<String> all, List<Sample> samples) {}

    static AircraftState plane(String hex, String callsign, String reg, String typeCode, String cat, double lat, double lon, Integer alt, Double gs,
                               Double trk, Double vrate, boolean ground, String squawk, Instant seen, String provider, int quality) {
        return new AircraftState(hex, callsign, reg, typeCode, cat, lat, lon, alt, gs, trk, vrate, ground, squawk, seen, provider, seen.plusSeconds(2), quality, false);
    }

    static ShipState pos(String mmsi, double lat, double lon, Double sog, Double cog, Integer hdg, Integer nav, Integer rot, String src, Instant seen, String msgType, String cls) {
        return new ShipState(mmsi, lat, lon, sog, cog, hdg, nav, rot, src, seen, "aisstream", msgType, cls);
    }

    static void ships(WsTestKit k, List<ShipState> states, List<ShipStatic> statics, Instant t) {
        ShipStore.Change c = k.ships.apply(states, statics, t, "aisstream", System.currentTimeMillis());
        k.shipFanout.onShips(new IngestEvents.ShipsUpdated(t, "aisstream", states, statics, c.changed(), c.removed(), Receipt.NONE));
    }

    static String first(List<String> msgs, String type, Predicate<JsonNode> when) {
        for (String m : msgs) {
            JsonNode n = json.readTree(m);
            if (type.equals(n.path("type").asString()) && when.test(n)) return m;
        }
        throw new AssertionError("no '" + type + "' message matching the scenario");
    }

    static String first(List<String> msgs, String type) { return first(msgs, type, n -> true); }

    static Run runServerScenario() throws Exception {
        Instant now = Instant.now().truncatedTo(ChronoUnit.SECONDS);
        List<String> all = new ArrayList<>();
        List<Sample> samples = new ArrayList<>();
        try (WsTestKit k = new WsTestKit(json)) {
            // ---- 자료(합성): 관심 지역 2대(FULL 필드까지 · 지상 최소 필드) · 전세계 1대 · SIGMET 2(폴리곤 · 판정 제외) · 레이더 · 알림 2 · 선박 3(정적만 1)
            AircraftState full = plane("71c0a1", "SYN081", "HL0001", "B77W", "A5", 37.4602, 126.4407, 35000, 470.0, 82.5, -640.0, false, "1234",
                    now.minusSeconds(3), "adsb_lol", 0);
            AircraftState ground = plane("71c0a2", null, null, null, null, 37.4581, 126.4452, null, null, null, null, true, null, now.minusSeconds(5), "adsb_lol", 1);
            AircraftState far = plane("a0b1c2", "SYN736", null, null, null, 50.1234567, 8.7654321, 36000, 451.3, 270.4, 0.0, false, null,
                    now.minusSeconds(20), "opensky", 0);
            k.publish("region", now.minusSeconds(2), full, ground);
            k.publish("global", now.minusSeconds(10), far);

            GeometryFactory gf = new GeometryFactory();
            Polygon poly = gf.createPolygon(new Coordinate[]{new Coordinate(126, 35), new Coordinate(128, 35), new Coordinate(128, 37.25),
                    new Coordinate(126, 37.25), new Coordinate(126, 35)});
            SigmetRecord ts = new SigmetRecord("RKRR:SYN-A1", "RKRR", "INCHEON FIR", "RKSI", "A1", "TS", "EMBD", 0, 38000,
                    now.minusSeconds(600), now.plusSeconds(7200), gf.createMultiPolygon(new Polygon[]{poly}), null, "NE", "20KT", "NC",
                    "RKRR SIGMET A1 VALID (synthetic)", "awc_isigmet", now.minusSeconds(60), SigmetRecord.BASE_JSON, SigmetRecord.TOP_JSON);
            SigmetRecord excluded = new SigmetRecord("RKRR:SYN-A2", "RKRR", null, null, "A2", "TURB", null, 0, null,
                    now.minusSeconds(600), now.plusSeconds(7200), null, "no_coordinates", null, null, null, "RAW (synthetic)", "awc_isigmet",
                    now.minusSeconds(60), SigmetRecord.BASE_ASSUMED_SURFACE, SigmetRecord.TOP_UNKNOWN);
            Map<String, SigmetRecord> byId = new LinkedHashMap<>();
            byId.put(ts.id(), ts);
            byId.put(excluded.id(), excluded);
            k.sigmets.replace(now.minusSeconds(60), "awc_isigmet", byId);

            k.radar.replace(new RadarStore.Frames("https://tilecache.rainviewer.com", 1_790_000_000L,
                    List.of(new RadarStore.Frame(1_789_999_400L, "/v2/radar/1789999400"), new RadarStore.Frame(1_790_000_000L, "/v2/radar/1790000000")),
                    now.minusSeconds(30), "rainviewer"));

            Alert observed = new Alert(1, "OBSERVED", "71c0a1", "SYN081", ts.id(), "RKRR", "TS", "EMBD", now.minusSeconds(120), null, null, null, null,
                    35000, Map.of("judged_at", now.minusSeconds(120).toString(), "rule", "observed_inside"), false);
            Alert predicted = new Alert(2, "PREDICTED", "71c0a2", null, ts.id(), "RKRR", "TS", "EMBD", now.minusSeconds(30), null, null, 300,
                    now.plusSeconds(270), null, Map.of("judged_at", now.minusSeconds(30).toString()), true);
            k.alerts.set(List.of(observed, predicted));

            ShipState s1 = pos("440000001", 35.1, 129.1, 12.3, 45.2, 44, 0, 3, "epfs", now.minusSeconds(8), "PositionReport", "A");
            ShipState s2 = pos("440000002", 35.25, 129.35, null, null, null, null, null, null, now.minusSeconds(20), "StandardClassBPositionReport", "B");
            ShipStatic st1 = new ShipStatic("440000001", "SYNTH ONE", "D7AB", 9321483, 70, 150, 30, 14, 16, 9.8, "KRPUS>JPTYO", 9, 29, 6, 30,
                    now.minusSeconds(600), "aisstream");
            ShipStatic st3 = new ShipStatic("440000003", "ONLY STATIC", null, null, 30, null, null, null, null, null, null, null, null, null, null,
                    now.minusSeconds(900), "aisstream");
            ships(k, List.of(s1, s2), List.of(st1, st3), now.minusSeconds(5));

            // 운영 StatusService(연결 없는 Redis — 오류는 삼킨다) · 등록 노선(가짜 Redis 의 합성 값)
            realStatus(k);
            Map<String, String> routeCache = new HashMap<>();
            routeCache.put("wakeline:route:SYN081", RouteInfoTest.found("SYN081").toString());
            k.hub.setRouteSource(RouteLookups.of(new RouteReader(routeCache::get, RouteInfoTest.JSON, new AtomicLong(1_000_000)::get)));
            // 한국 항만 입출항(ADR-022 개정): 색인에 수집기가 실제 전체 기록으로 만든 행(호출부호만 이 선박의 것으로) 21건 — 20건 + 잘림. 색인은 완전 · 새것
            PortCallFixtures.FakeSource index = new PortCallFixtures.FakeSource();
            index.coverage = PortCallFixtures.fullCoverage(java.time.LocalDate.parse("2026-08-20"), java.time.LocalDate.parse("2026-09-29"), PC_NOW.minusSeconds(600));
            index.rows.put("D7AB", java.util.Collections.nCopies(21, portCallRow("D7AB")));
            k.shipFanout.setPortCallSource(ShipLookups.portCalls(new PortCallReader(index, List::of, PC_NOW::toEpochMilli)));

            // ---- 세션 1: 줌 7 · 선박 켬 — 개별 선박, lite 인코딩
            FakeWsSession p = k.connect("s-points", "10.0.0.1");
            k.msg(p, "{\"type\":\"hello\",\"proto\":1,\"client\":\"web/0.4\"}");
            k.msg(p, "{\"type\":\"layers\",\"aircraft\":true,\"ships\":true}");
            k.msg(p, "{\"type\":\"subscribe\",\"bbox\":[124,33,132,39],\"zoom\":7,\"detail\":\"lite\"}");
            k.msg(p, "{\"type\":\"select\",\"hex\":\"71c0a1\"}");
            k.msg(p, "{\"type\":\"select_ship\",\"mmsi\":\"440000001\"}");
            k.msg(p, "{\"type\":\"select_ship\",\"mmsi\":\"440000003\"}");
            k.msg(p, "{\"type\":\"select_ship\",\"mmsi\":\"440000001\"}");
            // 이동(upsert) + 사라짐(remove) → diff seq 2
            k.publish("region", now.minusSeconds(1), plane("71c0a1", "SYN081", "HL0001", "B77W", "A5", 37.5102, 126.5407, 35100, 471.0, 83.0,
                    -512.0, false, "1234", now.minusSeconds(1), "adsb_lol", 0));
            // 선박 이동 + 뷰포트 밖으로 → ships_diff sseq 2(upsert · remove)
            ships(k, List.of(pos("440000001", 35.13, 129.12, 12.1, 44.8, 44, 0, 2, "epfs", now.minusSeconds(2), "PositionReport", "A"),
                    pos("440000002", 40.5, 129.35, 0.0, null, null, null, null, null, now.minusSeconds(3), "StandardClassBPositionReport", "B")), List.of(), now);
            // 알림 배치(진입 · 경보 종료)
            k.hub.onAlerts(new EngineEvents.AlertsChanged(List.of(
                    new AlertStateMachine.Event(AlertStateMachine.EventType.PREDICTION_UPDATED, predicted),
                    new AlertStateMachine.Event(AlertStateMachine.EventType.SIGMET_ENDED, observed.closed(now, Alert.CLOSE_SIGMET_ENDED,
                            Map.of("end_cause", AlertStateMachine.END_EXPIRED))))));
            k.hub.heartbeat();                                                   // ping + status
            k.msg(p, "{\"type\":\"ping\"}");                                     // pong
            k.msg(p, "{\"type\":\"subscribe\",\"bbox\":[124,33,132],\"zoom\":7}"); // error BAD_BBOX(구독은 그대로)
            k.msg(p, "{\"type\":\"select\",\"hex\":\"71c0a2\"}");                 // 사라진 항공기 → selected state null · route null

            // 수요(DemandService 가 계산해 우편함으로 보내는 그 메시지)
            WsSession ws = k.handler.session("s-points");
            long nowMs = System.currentTimeMillis();
            HotCell cell = new HotCell(36.0, 128.0, 250);
            Map<String, CollectorDemandStatus> st = Map.of(
                    "hot:" + cell.key(), new CollectorDemandStatus("active", 5, Instant.ofEpochMilli(nowMs - 2_000)),
                    "focus:71c0a1", new CollectorDemandStatus("active", 5, Instant.ofEpochMilli(nowMs - 1_000)));
            List<DemandService.Want> wants = List.of(
                    new DemandService.Want(ws, DemandService.Kind.NONE, null, null, 0),
                    new DemandService.Want(ws, DemandService.Kind.HOT, cell.key(), cell, 0),
                    new DemandService.Want(ws, DemandService.Kind.COVERED, null, null, 0),
                    new DemandService.Want(ws, DemandService.Kind.FOCUS, "71c0a1", null, nowMs - 90_000),
                    new DemandService.Want(ws, DemandService.Kind.FOCUS_CAPPED, "71c0a1", null, nowMs - 1_800_000));
            for (DemandService.Want w : wants) {
                ws.demandJson = k.hub.toJson(DemandService.message(w, false, Set.of(cell.key()), Set.of("71c0a1"), st, nowMs));
                k.hub.pushDemand(ws);
            }
            ws.demandJson = k.hub.toJson(DemandService.message(wants.get(1), true, Set.of(), Set.of(), st, nowMs)); // 세션 제한
            k.hub.pushDemand(ws);

            // ---- 세션 2: 줌 3 전세계 · 선박 켬 — world 인코딩, 줌 때문에 격자(2°)
            FakeWsSession g = k.connect("s-world", "10.0.0.2");
            k.msg(g, "{\"type\":\"hello\",\"proto\":1}");
            k.msg(g, "{\"type\":\"layers\",\"ships\":true}");
            k.msg(g, "{\"type\":\"subscribe\",\"bbox\":[-180,-85,180,85],\"zoom\":3}");

            all.addAll(p.sent);
            all.addAll(g.sent);
            List<String> pm = p.sent, gm = g.sent;
            samples.add(new Sample("welcome", first(pm, "welcome")));
            samples.add(new Sample("snapshot.lite", first(pm, "snapshot")));
            samples.add(new Sample("snapshot.world", first(gm, "snapshot")));
            samples.add(new Sample("diff", first(pm, "diff")));
            samples.add(new Sample("alerts", first(pm, "alerts")));
            samples.add(new Sample("alerts_batch", first(pm, "alerts_batch")));
            samples.add(new Sample("selected.route_found", first(pm, "selected", n -> n.path("state").isObject() && n.path("route").isObject())));
            samples.add(new Sample("selected.gone", first(pm, "selected", n -> n.path("state").isNull())));
            samples.add(new Sample("error.bad_bbox", first(pm, "error")));
            samples.add(new Sample("demand.none", first(pm, "demand", n -> n.path("hot").isNull() && n.path("focus").isNull())));
            samples.add(new Sample("demand.hot_active", first(pm, "demand", n -> "active".equals(n.path("hot").path("state").asString()))));
            samples.add(new Sample("demand.hot_limited", first(pm, "demand", n -> "limited".equals(n.path("hot").path("state").asString()))));
            samples.add(new Sample("demand.covered_by_region", first(pm, "demand", n -> "covered_by_region".equals(n.path("hot").path("state").asString()))));
            samples.add(new Sample("demand.focus_active", first(pm, "demand", n -> "active".equals(n.path("focus").path("state").asString()))));
            samples.add(new Sample("demand.focus_capped", first(pm, "demand", n -> "expired_session_cap".equals(n.path("focus").path("state").asString()))));
            samples.add(new Sample("sigmets", first(pm, "sigmets")));
            samples.add(new Sample("radar", first(pm, "radar")));
            samples.add(new Sample("status", first(pm, "status")));
            samples.add(new Sample("ping", first(pm, "ping")));
            samples.add(new Sample("pong", first(pm, "pong")));
            samples.add(new Sample("ships_snapshot", first(pm, "ships_snapshot")));
            samples.add(new Sample("ships_diff", first(pm, "ships_diff")));
            samples.add(new Sample("ships_grid", first(gm, "ships_grid")));
            samples.add(new Sample("ship_selected", first(pm, "ship_selected", n -> n.path("state").isObject())));
            samples.add(new Sample("ship_selected.static_only", first(pm, "ship_selected", n -> n.path("state").isNull())));
        }
        // ---- 세션 3(따로): 줌 5 에서 뷰포트 안 선박이 개별 표시 상한(1,500)을 넘음 → capped 격자(0.5°)
        try (WsTestKit k = new WsTestKit(json)) {
            List<ShipState> many = new ArrayList<>();
            for (int i = 0; i < ShipFanout.BAND_MAX_SHIPS + 1; i++)
                many.add(pos(String.valueOf(441_000_000 + i), 34.0 + (i % 40) * 0.02, 128.0 + (i / 40) * 0.02, 8.0, 90.0, null, 0, null, "epfs",
                        now.minusSeconds(10), "PositionReport", "A"));
            ships(k, many, List.of(), now.minusSeconds(5));
            realStatus(k);
            FakeWsSession d = k.connect("s-dense", "10.0.0.3");
            k.msg(d, "{\"type\":\"hello\",\"proto\":1}");
            k.msg(d, "{\"type\":\"layers\",\"aircraft\":false,\"ships\":true}");
            k.msg(d, "{\"type\":\"subscribe\",\"bbox\":[124,33,132,39],\"zoom\":5}");
            all.addAll(d.sent);
            samples.add(new Sample("ships_grid.capped", first(d.sent, "ships_grid", n -> n.path("capped").asBoolean(false))));
        }
        // ---- 세션 4(따로): 값이 채워진 status(수집기 · AIS · 기상청 레이더 해시가 있는 Redis) — 초기 세트의 status
        try (WsTestKit k = new WsTestKit(json)) {
            ships(k, List.of(pos("440000001", 35.1, 129.1, 12.3, 45.2, 44, 0, 3, "epfs", now.minusSeconds(8), "PositionReport", "A")), List.of(), now.minusSeconds(5));
            k.status.set(populatedStatus(k, now));
            FakeWsSession q = k.connect("s-status", "10.0.0.4");
            k.msg(q, "{\"type\":\"hello\",\"proto\":1}");
            k.msg(q, "{\"type\":\"subscribe\",\"bbox\":[124,33,132,39],\"zoom\":7}");
            all.addAll(q.sent);
            samples.add(new Sample("status.populated", first(q.sent, "status", n -> n.path("status").path("sources").has("ais"))));
        }
        // ---- 세션 5(따로): 한국 항만 입출항의 다른 상태(ADR-022 개정) — 색인을 읽지 못함 · 꺼짐(키 없음) · 기록 없음(완전 · 새 색인) ·
        //      빈 곳 있음(한 곳 빠짐 · 한 곳 채우는 중 · 한 곳 오래됨) · 호출부호를 아직 받지 않음(위치만 받은 선박) · 찾는 형식 밖 호출부호
        try (WsTestKit k = new WsTestKit(json)) {
            List<ShipStatic> stats = new ArrayList<>();
            for (String[] s : new String[][]{{"440000004", "D7AC"}, {"440000005", "D7AD"}, {"440000006", "D7AE"}, {"440000007", "D7AF"}, {"440000009", "AB"}})
                stats.add(new ShipStatic(s[0], "SYNTH " + s[1], s[1], null, 70, null, null, null, null, null, null, null, null, null, null,
                        now.minusSeconds(600), "aisstream"));
            ships(k, List.of(pos("440000008", 35.3, 129.3, 6.0, 180.0, null, 0, null, "epfs", now.minusSeconds(20), "PositionReport", "A")), stats,
                    now.minusSeconds(5));
            realStatus(k);
            java.time.LocalDate from = java.time.LocalDate.parse("2026-08-30"), to = java.time.LocalDate.parse("2026-09-29");
            PortCallFixtures.FakeSource full = new PortCallFixtures.FakeSource();
            full.coverage = PortCallFixtures.fullCoverage(from, to, PC_NOW.minusSeconds(600));
            PortCallFixtures.FakeSource gaps = new PortCallFixtures.FakeSource();
            List<dev.wakeline.portcalls.PortCallIndex.Coverage> partial = new ArrayList<>(PortCallFixtures.fullCoverage(from, to, PC_NOW.minusSeconds(600)));
            partial.removeIf(c -> c.portAuthority().equals("700"));
            partial.set(0, new dev.wakeline.portcalls.PortCallIndex.Coverage("020", java.time.LocalDate.parse("2026-09-12"), to, PC_NOW.minusSeconds(600)));
            partial.set(1, new dev.wakeline.portcalls.PortCallIndex.Coverage("030", from, java.time.LocalDate.parse("2026-09-28"), PC_NOW.minusSeconds(9_000)));
            partial.set(2, new dev.wakeline.portcalls.PortCallIndex.Coverage("200", from, to, PC_NOW.minusSeconds(600),
                    List.of(java.time.LocalDate.parse("2026-09-20"), java.time.LocalDate.parse("2026-09-27"))));
            gaps.coverage = partial;
            PortCallFixtures.FakeSource broken = new PortCallFixtures.FakeSource();
            broken.fail = new org.springframework.dao.QueryTimeoutException("statement timeout");
            PortCallReader ok = new PortCallReader(full, List::of, PC_NOW::toEpochMilli);
            PortCallReader incomplete = new PortCallReader(gaps, List::of, PC_NOW::toEpochMilli);
            PortCallReader error = new PortCallReader(broken, List::of, PC_NOW::toEpochMilli);
            PortCallReader off = new PortCallReader(full, () -> List.of("no_key", PC_NOW.minusSeconds(20).toString()), PC_NOW::toEpochMilli);
            // 운영처럼 저장 정적 보고도 읽는다 — 위치만 받은 선박(440000008)은 DB 에도 없다(static_source none)
            k.shipFanout.setStoredStaticSource(SelectionLookups.Source.memory(m -> StoredStaticReader.Lookup.NONE));
            k.shipFanout.setPortCallSource(SelectionLookups.Source.memory(st -> {
                String cs = st == null ? null : st.callSign();
                if ("D7AC".equals(cs)) return error.forStatic(st);
                if ("D7AD".equals(cs)) return off.forStatic(st);
                if ("D7AF".equals(cs)) return incomplete.forStatic(st);
                return ok.forStatic(st);
            }));
            FakeWsSession c = k.connect("s-portcalls", "10.0.0.5");
            k.msg(c, "{\"type\":\"hello\",\"proto\":1}");
            k.msg(c, "{\"type\":\"subscribe\",\"bbox\":[124,33,132,39],\"zoom\":7}");
            for (ShipStatic s : stats) k.msg(c, "{\"type\":\"select_ship\",\"mmsi\":\"" + s.mmsi() + "\"}");
            k.msg(c, "{\"type\":\"select_ship\",\"mmsi\":\"440000008\"}");
            all.addAll(c.sent);
            for (String st : List.of("error", "disabled", "none", "incomplete"))
                samples.add(new Sample("ship_selected.port_calls_" + st, first(c.sent, "ship_selected", n -> st.equals(n.path("port_calls").path("status").asString()))));
            for (String st : List.of("not_received", "unusable"))
                samples.add(new Sample("ship_selected.port_calls_no_call_sign_" + st,
                        first(c.sent, "ship_selected", n -> st.equals(n.path("port_calls").path("call_sign_state").asString()))));
        }
        // ---- 세션 6(따로): 메모리에 정적 정보가 없는 실시간 선박(api 재시작 뒤 — 계약 v5 §G17) — DB 의 마지막 저장 정적 보고(stored, 입출항은 그 호출부호로) ·
        //      DB 를 읽지 못함(stored_unavailable — static null, 입출항 no_call_sign) · DB 에도 없음(none)
        try (WsTestKit k = new WsTestKit(json)) {
            ships(k, List.of(pos("440000010", 35.1, 129.0, 14.2, 200.1, 199, 0, null, "epfs", now.minusSeconds(6), "PositionReport", "A"),
                    pos("440000011", 35.2, 129.1, 0.1, null, null, 5, null, "epfs", now.minusSeconds(9), "PositionReport", "A"),
                    pos("440000012", 35.3, 129.2, 9.0, 90.0, null, 0, null, "epfs", now.minusSeconds(4), "PositionReport", "A")), List.of(), now.minusSeconds(5));
            realStatus(k);
            ShipStatic kept = new ShipStatic("440000010", "SYNTH STORED", "D7AG", null, 60, null, null, null, null, null, "KRPUS", null, null, null, null,
                    now.minusSeconds(5 * 3600), "aisstream");
            k.shipFanout.setStoredStaticSource(ShipLookups.stored(new StoredStaticReader(m -> switch (m) {
                case "440000010" -> kept;
                case "440000011" -> throw new org.springframework.dao.QueryTimeoutException("statement timeout");
                default -> null;
            }, now::toEpochMilli, k.meters)));
            PortCallFixtures.FakeSource idx = new PortCallFixtures.FakeSource();
            idx.coverage = PortCallFixtures.fullCoverage(java.time.LocalDate.parse("2026-08-30"), java.time.LocalDate.parse("2026-09-29"), PC_NOW.minusSeconds(600));
            idx.rows.put("D7AG", List.of(portCallRow("D7AG")));
            k.shipFanout.setPortCallSource(ShipLookups.portCalls(new PortCallReader(idx, List::of, PC_NOW::toEpochMilli)));
            FakeWsSession c = k.connect("s-stored", "10.0.0.6");
            k.msg(c, "{\"type\":\"hello\",\"proto\":1}");
            k.msg(c, "{\"type\":\"subscribe\",\"bbox\":[124,33,132,39],\"zoom\":7}");
            for (String m : List.of("440000010", "440000011", "440000012")) k.msg(c, "{\"type\":\"select_ship\",\"mmsi\":\"" + m + "\"}");
            all.addAll(c.sent);
            for (String src : List.of("stored", "stored_unavailable", "none"))
                samples.add(new Sample("ship_selected.static_" + src, first(c.sent, "ship_selected", n -> src.equals(n.path("static_source").asString()))));
        }
        return new Run(all, samples);
    }

    @Test
    void everyServerMessageFromTheRealBuildersMatchesTheSchema_andAll17TypesAreCovered() throws Exception {
        Run run = runServerScenario();
        List<String> bad = new ArrayList<>();
        for (String m : run.all()) {
            List<String> v = WsSchemas.server(m);
            if (!v.isEmpty()) bad.add(type(m) + " → " + v + "\n    " + (m.length() > 600 ? m.substring(0, 600) + "…" : m));
        }
        assertThat(bad).as("server messages violating schemas/ws/server.v1.json").isEmpty();

        Set<String> sampled = new TreeSet<>();
        for (Sample s : run.samples()) sampled.add(type(s.message()));
        assertThat(sampled).as("fixture covers every server message type").containsExactlyInAnyOrderElementsOf(SERVER_TYPES);
        assertThat(oneOfTypes("server.v1.json")).as("schema oneOf branches").containsExactlyInAnyOrderElementsOf(SERVER_TYPES);

        // ships_grid 칸(계약 v5 §B2): 다섯 원소, 선종별 수 11개의 합 = 칸 수(스키마로는 합을 말할 수 없다)
        for (Sample s : run.samples()) {
            if (!"ships_grid".equals(type(s.message()))) continue;
            JsonNode cells = json.readTree(s.message()).path("cells");
            assertThat(cells.size()).as(s.name() + " cells").isPositive();
            for (JsonNode c : cells) {
                assertThat(c.size()).isEqualTo(5);
                int sum = 0;
                for (JsonNode n : c.get(4)) sum += n.asInt();
                assertThat(sum).as("per-category counts sum to the cell count " + c).isEqualTo(c.get(2).asInt());
            }
        }
        // ship_selected 의 정적 정보 출처(계약 v5 §G17): live · stored 는 static 이 있고, stored 의 static_updated_at = 저장 행의 updated_at = static.updated_at
        Set<String> sources = new TreeSet<>();
        for (String m : run.all()) {
            JsonNode n = json.readTree(m);
            if (!"ship_selected".equals(n.path("type").asString())) continue;
            String src = n.path("static_source").isNull() ? "null" : n.path("static_source").asString();
            sources.add(src);
            assertThat(n.path("static").isObject()).as("static present iff live|stored: " + m).isEqualTo(src.equals("live") || src.equals("stored"));
            if (src.equals("stored"))
                assertThat(n.path("static_updated_at").asString()).as("stored time = the row's updated_at").isEqualTo(n.path("static").path("updated_at").asString());
            else assertThat(n.path("static_updated_at").isNull()).as("time only for stored: " + m).isTrue();
        }
        assertThat(sources).as("every static source is sampled").contains("live", "stored", "none", "stored_unavailable");
        checkOrWriteFixture(run.samples(), clientSamples());
    }

    // ---------------------------------------------------------------- 클라이언트 메시지

    /** lib/ws.ts 가 보내는 모양 그대로(웹 시험이 실제로 보낸 메시지를 같은 스키마로 검사한다). */
    static List<Sample> clientSamples() {
        return List.of(
                new Sample("hello", "{\"type\":\"hello\",\"proto\":1,\"client\":\"web/0.4\"}"),
                new Sample("layers", "{\"type\":\"layers\",\"aircraft\":true,\"ships\":true}"),
                new Sample("subscribe", "{\"type\":\"subscribe\",\"bbox\":[124.5,33.25,131.75,38.9],\"zoom\":7,\"detail\":\"lite\"}"),
                new Sample("select", "{\"type\":\"select\",\"hex\":\"71c0a1\"}"),
                new Sample("select.clear", "{\"type\":\"select\",\"hex\":null}"),
                new Sample("select_ship", "{\"type\":\"select_ship\",\"mmsi\":\"440000001\"}"),
                new Sample("select_ship.clear", "{\"type\":\"select_ship\",\"mmsi\":null}"),
                new Sample("pause", "{\"type\":\"pause\"}"),
                new Sample("resume", "{\"type\":\"resume\"}"),
                new Sample("resync", "{\"type\":\"resync\"}"),
                new Sample("resync.alerts", "{\"type\":\"resync\",\"scope\":\"alerts\"}"),
                new Sample("resync.sigmets", "{\"type\":\"resync\",\"scope\":\"sigmets\"}"),
                new Sample("resync.radar", "{\"type\":\"resync\",\"scope\":\"radar\"}"),
                new Sample("ping", "{\"type\":\"ping\"}"),
                new Sample("pong", "{\"type\":\"pong\"}"));
    }

    @Test
    void clientSamplesMatchTheSchema_andTheRealHandlerAcceptsThemWithoutError() throws Exception {
        List<Sample> samples = clientSamples();
        Set<String> types = new LinkedHashSet<>();
        for (Sample s : samples) {
            assertThat(WsSchemas.client(s.message())).as(s.name()).isEmpty();
            types.add(type(s.message()));
        }
        assertThat(types).containsExactlyInAnyOrderElementsOf(CLIENT_TYPES);
        assertThat(oneOfTypes("client.v1.json")).as("schema oneOf branches").containsExactlyInAnyOrderElementsOf(CLIENT_TYPES);
        try (WsTestKit k = new WsTestKit(json)) {
            realStatus(k);
            FakeWsSession f = k.connect("c", "10.0.0.9");
            for (Sample s : samples) k.msg(f, s.message());
            assertThat(WsTestKit.types(f)).as("no error reply to a conforming client message").doesNotContain("error");
            assertThat(f.open).isTrue();
            for (String m : f.sent) assertThat(WsSchemas.server(m)).as(m).isEmpty();
        }
    }

    // ---------------------------------------------------------------- 스키마가 틀린 메시지를 거절하는가

    static String mutate(String message, java.util.function.Consumer<ObjectNode> f) {
        ObjectNode n = (ObjectNode) json.readTree(message);
        f.accept(n);
        return json.writeValueAsString(n);
    }

    @Test
    void schemaRejectsMalformedMessages() throws Exception {
        Run run = runServerScenario();
        Map<String, String> byName = new HashMap<>();
        for (Sample s : run.samples()) byName.put(s.name(), s.message());
        Map<String, String> bad = new LinkedHashMap<>();
        bad.put("unknown type", "{\"type\":\"surprise\"}");
        bad.put("no type", "{\"seq\":1}");
        bad.put("snapshot without seq", mutate(byName.get("snapshot.lite"), n -> n.remove("seq")));
        bad.put("snapshot seq 2", mutate(byName.get("snapshot.lite"), n -> n.put("seq", 2)));
        bad.put("diff seq string", mutate(byName.get("diff"), n -> n.put("seq", "3")));
        bad.put("diff upsert element with a bad hex", mutate(byName.get("diff"), n -> ((ObjectNode) ((ArrayNode) n.get("upsert")).get(0)).put("hex", "XYZ")));
        bad.put("diff upsert element with lat out of range", mutate(byName.get("diff"), n -> ((ObjectNode) ((ArrayNode) n.get("upsert")).get(0)).put("lat", 91)));
        bad.put("diff upsert element with a null key (server omits unknown values)",
                mutate(byName.get("diff"), n -> ((ObjectNode) ((ArrayNode) n.get("upsert")).get(0)).putNull("alt_ft")));
        bad.put("diff remove not hex", mutate(byName.get("diff"), n -> ((ArrayNode) n.get("remove")).add(42)));
        bad.put("ships_grid 4-element cell (pre-v5 server)", mutate(byName.get("ships_grid"), n -> ((ArrayNode) ((ArrayNode) n.get("cells")).get(0)).remove(4)));
        bad.put("ships_grid 10 category counts", mutate(byName.get("ships_grid"), n -> ((ArrayNode) ((ArrayNode) n.get("cells")).get(0).get(4)).remove(0)));
        bad.put("ships_grid unknown category", mutate(byName.get("ships_grid"), n -> ((ArrayNode) ((ArrayNode) n.get("cells")).get(0)).set(3, StringNode.valueOf("barge"))));
        bad.put("ships_grid zero count", mutate(byName.get("ships_grid"), n -> ((ArrayNode) ((ArrayNode) n.get("cells")).get(0)).set(2, JsonNodeFactory.instance.numberNode(0))));
        bad.put("ships_diff remove not mmsi", mutate(byName.get("ships_diff"), n -> ((ArrayNode) n.get("remove")).add("12345")));
        bad.put("ship_selected without destination_info key", mutate(byName.get("ship_selected"), n -> n.remove("destination_info")));
        bad.put("ship_selected without port_calls key", mutate(byName.get("ship_selected"), n -> n.remove("port_calls")));
        bad.put("ship_selected without static_source key", mutate(byName.get("ship_selected"), n -> n.remove("static_source")));
        bad.put("ship_selected without static_updated_at key", mutate(byName.get("ship_selected"), n -> n.remove("static_updated_at")));
        bad.put("static_source unknown value", mutate(byName.get("ship_selected"), n -> n.put("static_source", "guessed")));
        bad.put("static_source stored without its time", mutate(byName.get("ship_selected.static_stored"), n -> n.putNull("static_updated_at")));
        bad.put("static_source live with a stored time", mutate(byName.get("ship_selected"), n -> n.put("static_updated_at", "2026-09-29T08:00:00Z")));
        bad.put("static_source live without a static", mutate(byName.get("ship_selected.static_none"), n -> n.put("static_source", "live")));
        bad.put("static_source none with a static", mutate(byName.get("ship_selected"), n -> n.put("static_source", "none")));
        bad.put("static_source stored_unavailable with a static", mutate(byName.get("ship_selected.static_stored"), n -> n.put("static_source", "stored_unavailable")));
        bad.put("static_updated_at not a date-time", mutate(byName.get("ship_selected.static_stored"), n -> n.put("static_updated_at", "5 hours ago")));
        bad.put("port_calls unknown status", mutate(byName.get("ship_selected"), n -> ((ObjectNode) n.get("port_calls")).put("status", "guessing")));
        bad.put("port_calls raw error text", mutate(byName.get("ship_selected.port_calls_error"), n -> ((ObjectNode) n.get("port_calls")).put("error", "x")));
        bad.put("port_calls retired pending status", mutate(byName.get("ship_selected.port_calls_none"), n -> ((ObjectNode) n.get("port_calls")).put("status", "pending")));
        bad.put("port_calls unknown call_sign_state", mutate(byName.get("ship_selected.port_calls_no_call_sign_not_received"),
                n -> ((ObjectNode) n.get("port_calls")).put("call_sign_state", "absent")));
        bad.put("port_calls index gap unknown issue", mutate(byName.get("ship_selected.port_calls_incomplete"),
                n -> ((ArrayNode) ((ObjectNode) ((ArrayNode) n.get("port_calls").get("index").get("gaps")).get(0)).get("issues")).set(0, StringNode.valueOf("guessed"))));
        bad.put("port_calls index gap unindexed day not a date", mutate(byName.get("ship_selected.port_calls_incomplete"),
                n -> ((ArrayNode) ((ObjectNode) ((ArrayNode) n.get("port_calls").get("index").get("gaps")).get(2)).get("unindexed_days"))
                        .set(0, StringNode.valueOf("recently"))));
        bad.put("port_calls index other authority count", mutate(byName.get("ship_selected.port_calls_none"),
                n -> ((ObjectNode) n.get("port_calls").get("index")).put("authorities", 11)));
        bad.put("port_call without read_at", mutate(byName.get("ship_selected"),
                n -> ((ObjectNode) ((ArrayNode) n.get("port_calls").get("items")).get(0)).remove("read_at")));
        bad.put("port_call guessed revision", mutate(byName.get("ship_selected"),
                n -> ((ObjectNode) ((ArrayNode) n.get("port_calls").get("items")).get(0)).put("entry_revision", "추정")));
        bad.put("port_calls other window", mutate(byName.get("ship_selected"), n -> ((ObjectNode) n.get("port_calls")).put("window_days", 7)));

        bad.put("port_call guessed field", mutate(byName.get("ship_selected"),
                n -> ((ObjectNode) ((ArrayNode) n.get("port_calls").get("items")).get(0)).put("ship_type_guess", "KTX")));
        bad.put("selected without route key", mutate(byName.get("selected.route_found"), n -> n.remove("route")));
        bad.put("alerts element without evidence", mutate(byName.get("alerts"), n -> ((ObjectNode) ((ArrayNode) n.get("alerts")).get(0)).remove("evidence")));
        bad.put("alerts_batch unknown event", mutate(byName.get("alerts_batch"), n -> ((ObjectNode) ((ArrayNode) n.get("items")).get(0)).put("event", "MAYBE")));
        bad.put("demand unknown hot state", mutate(byName.get("demand.hot_active"), n -> ((ObjectNode) n.get("hot")).put("state", "guessing")));
        bad.put("status without engine", mutate(byName.get("status"), n -> ((ObjectNode) n.get("status")).remove("engine")));
        bad.put("sigmets feature without geometry member", mutate(byName.get("sigmets"),
                n -> ((ObjectNode) ((ArrayNode) n.get("collection").get("features")).get(0)).remove("geometry")));
        bad.put("welcome time not a date-time", mutate(byName.get("welcome"), n -> n.put("server_time", "yesterday")));
        bad.put("extra top-level key", mutate(byName.get("radar"), n -> n.put("surprise", 1)));
        for (var e : bad.entrySet()) assertThat(WsSchemas.server(e.getValue())).as(e.getKey()).isNotEmpty();

        Map<String, String> badClient = new LinkedHashMap<>();
        badClient.put("hello proto 2", "{\"type\":\"hello\",\"proto\":2}");
        badClient.put("subscribe bbox of 3", "{\"type\":\"subscribe\",\"bbox\":[1,2,3],\"zoom\":7}");
        badClient.put("subscribe lat out of range", "{\"type\":\"subscribe\",\"bbox\":[124,-95,132,39],\"zoom\":7}");
        badClient.put("subscribe detail unknown", "{\"type\":\"subscribe\",\"bbox\":[124,33,132,39],\"detail\":\"everything\"}");
        badClient.put("select hex too short", "{\"type\":\"select\",\"hex\":\"abc\"}");
        badClient.put("select_ship mmsi as number", "{\"type\":\"select_ship\",\"mmsi\":440000001}");
        badClient.put("layers string", "{\"type\":\"layers\",\"ships\":\"yes\"}");
        badClient.put("layers without a layer", "{\"type\":\"layers\"}");
        badClient.put("unknown client type", "{\"type\":\"subscribe_all\"}");
        badClient.put("resync unknown scope", "{\"type\":\"resync\",\"scope\":\"aircraft\"}");
        for (var e : badClient.entrySet()) assertThat(WsSchemas.client(e.getValue())).as(e.getKey()).isNotEmpty();
    }

    // ---------------------------------------------------------------- 스트림 스키마와 같은 필드 제약

    /** "type" 에서 null 을 빼고 설명을 지운 제약(스트림 스키마는 모든 키가 있고 모르면 null, WS 는 모르면 키를 뺀다). */
    static JsonNode constraint(JsonNode prop) {
        ObjectNode c = ((ObjectNode) prop).deepCopy();
        c.remove("description");
        c.remove("$comment");
        JsonNode t = c.get("type");
        if (t != null && t.isArray()) {
            List<String> ts = new ArrayList<>();
            for (JsonNode x : t) if (!"null".equals(x.asString())) ts.add(x.asString());
            if (ts.size() == 1) c.put("type", ts.getFirst());
            else { ArrayNode a = c.putArray("type"); ts.forEach(a::add); }
        }
        JsonNode en = c.get("enum");
        if (en != null) {
            ArrayNode a = JsonNodeFactory.instance.arrayNode();
            for (JsonNode x : en) if (!x.isNull()) a.add(x);
            c.set("enum", a);
        }
        return c;
    }

    @Test
    void aircraftAndShipFieldConstraintsMatchTheStreamSchemas() throws Exception {
        JsonNode defs = json.readTree(Files.readString(SCHEMA_DIR.resolve("server.v1.json"))).path("$defs");
        Map<String, List<String>> pairs = new LinkedHashMap<>();
        pairs.put("aircraft", List.of("aircraft_state.v1.json"));
        pairs.put("ship_lite", List.of("ship_state.v1.json", "ship_static.v1.json"));
        pairs.put("ship_state", List.of("ship_state.v1.json"));
        pairs.put("ship_static", List.of("ship_static.v1.json"));
        List<String> drift = new ArrayList<>();
        for (var e : pairs.entrySet()) {
            JsonNode ws = defs.path(e.getKey()).path("properties");
            assertThat(ws.isObject()).as("$defs/" + e.getKey()).isTrue();
            for (Iterator<Map.Entry<String, JsonNode>> it = ws.properties().iterator(); it.hasNext(); ) {
                Map.Entry<String, JsonNode> p = it.next();
                JsonNode stream = null;
                for (String f : e.getValue()) {
                    JsonNode s = json.readTree(Files.readString(STREAM_SCHEMA_DIR.resolve(f))).path("properties").get(p.getKey());
                    if (s != null) { stream = s; break; }
                }
                if (stream == null) continue; // WS 전용 필드
                if (!constraint(stream).equals(constraint(p.getValue())))
                    drift.add(e.getKey() + "." + p.getKey() + ": ws " + constraint(p.getValue()) + " ≠ stream " + constraint(stream));
            }
        }
        assertThat(drift).as("WS field constraints drifted from the stream schemas").isEmpty();
        // ships_grid 대표 분류·선종별 수의 순서(계약 v5 §B2) = 언어 간 벡터 = Java ShipCategory 선언 순서
        List<String> order = new ArrayList<>();
        json.readTree(Files.readString(STREAM_SCHEMA_DIR.resolve("vectors/ship-categories.v1.json"))).path("order").forEach(x -> order.add(x.asString()));
        List<String> enumOrder = new ArrayList<>();
        defs.path("ship_category").path("enum").forEach(x -> enumOrder.add(x.asString()));
        List<String> java = new ArrayList<>();
        for (dev.wakeline.domain.ShipCategory c : dev.wakeline.domain.ShipCategory.values()) java.add(c.key());
        assertThat(enumOrder).isEqualTo(order).isEqualTo(java);
    }

    /** schemas/ws/*.json 의 oneOf 가지가 가리키는 $defs 의 type 상수들. */
    static List<String> oneOfTypes(String file) throws Exception {
        JsonNode doc = json.readTree(Files.readString(SCHEMA_DIR.resolve(file)));
        List<String> out = new ArrayList<>();
        for (JsonNode b : doc.path("oneOf")) {
            String ref = b.path("$ref").asString();
            assertThat(ref).startsWith("#/$defs/");
            out.add(doc.path("$defs").path(ref.substring("#/$defs/".length())).path("properties").path("type").path("const").asString());
        }
        return out;
    }

    // ---------------------------------------------------------------- 웹 fixture

    static final Pattern ISO = Pattern.compile("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]+)?(Z|[+-][0-9]{2}:[0-9]{2})$");
    /**
     * 순서가 뜻이 없고 맵 순회에서 나오는 목록(Map.copyOf 등의 순회 순서는 JVM 실행마다 다르다) — 비교·기록 전에 정렬한다.
     * 알림 목록 · 배치 항목은 목록 순서 그대로라 정렬하지 않는다(배치는 순서가 뜻이 있다).
     */
    static final Set<String> UNORDERED = Set.of("aircraft", "upsert", "remove", "ships", "features");

    /** 정렬만(기록용): 순서 없는 목록을 원소의 JSON 문자열 순으로. */
    static JsonNode canonical(JsonNode n, boolean mask) {
        if (n.isObject()) {
            ObjectNode o = JsonNodeFactory.instance.objectNode();
            for (Map.Entry<String, JsonNode> e : n.properties()) {
                JsonNode v = canonical(e.getValue(), mask);
                if (mask && "lag_s".equals(e.getKey()) && v.isNumber()) v = JsonNodeFactory.instance.numberNode(0);
                if (UNORDERED.contains(e.getKey()) && v.isArray()) {
                    List<JsonNode> items = new ArrayList<>();
                    v.forEach(items::add);
                    items.sort(Comparator.comparing(JsonNode::toString));
                    ArrayNode a = JsonNodeFactory.instance.arrayNode();
                    items.forEach(a::add);
                    v = a;
                }
                o.set(e.getKey(), v);
            }
            return o;
        }
        if (n.isArray()) {
            ArrayNode a = JsonNodeFactory.instance.arrayNode();
            for (JsonNode x : n) a.add(canonical(x, mask));
            return a;
        }
        if (mask && n.isString() && ISO.matcher(n.asString()).matches()) return StringNode.valueOf("<date-time>");
        return n;
    }

    static ObjectNode fixture(List<Sample> serverSamples, List<Sample> clientSamples, boolean mask) {
        ObjectNode root = JsonNodeFactory.instance.objectNode();
        root.put("$comment", "계약 v5 §E1 · ADR-020: api 시험 WsSchemaContractTest 가 실제 빌더로 만들어 schemas/ws/server.v1.json · client.v1.json 으로 검증한 표본."
                + " 손으로 고치지 않는다 — 다시 만들기: " + REGENERATE + " (또는 make ws-samples). 웹 lib/ws-validate.ts 는 모든 server 표본을 받아야 한다.");
        root.put("schema_server", "schemas/ws/server.v1.json");
        root.put("schema_client", "schemas/ws/client.v1.json");
        for (String part : List.of("server", "client")) {
            ArrayNode arr = root.putArray(part);
            for (Sample s : "server".equals(part) ? serverSamples : clientSamples) {
                ObjectNode o = arr.addObject();
                o.put("name", s.name());
                o.set("message", canonical(json.readTree(s.message()), mask));
            }
        }
        return root;
    }

    static void checkOrWriteFixture(List<Sample> serverSamples, List<Sample> clientSamples) throws Exception {
        if (Boolean.getBoolean("wakeline.ws-samples.update")) {
            Files.createDirectories(SAMPLES.getParent());
            String out = json.writerWithDefaultPrettyPrinter().writeValueAsString(fixture(serverSamples, clientSamples, false)) + "\n";
            Files.writeString(SAMPLES, out, StandardCharsets.UTF_8);
            return;
        }
        assertThat(Files.exists(SAMPLES)).as(SAMPLES + " missing — run: " + REGENERATE).isTrue();
        JsonNode committed = json.readTree(Files.readString(SAMPLES));
        // 커밋된 표본도 지금 스키마를 만족해야 한다
        for (String part : List.of("server", "client"))
            for (JsonNode s : committed.path(part))
                assertThat("server".equals(part) ? WsSchemas.server(json.writeValueAsString(s.path("message")))
                        : WsSchemas.client(json.writeValueAsString(s.path("message"))))
                        .as("committed " + part + " sample " + s.path("name").asString()).isEmpty();
        // 표본별로 비교(시각·지연은 가리고, 순서 없는 목록은 정렬) — 다르면 표본 이름과 처음 다른 줄을 보인다
        ObjectNode expected = fixture(serverSamples, clientSamples, true);
        List<String> diffs = new ArrayList<>();
        for (String part : List.of("server", "client")) {
            List<String> want = new ArrayList<>(), got = new ArrayList<>();
            Map<String, JsonNode> wantBy = new LinkedHashMap<>(), gotBy = new LinkedHashMap<>();
            for (JsonNode s : expected.path(part)) { want.add(s.path("name").asString()); wantBy.put(s.path("name").asString(), s.path("message")); }
            for (JsonNode s : committed.path(part)) { got.add(s.path("name").asString()); gotBy.put(s.path("name").asString(), canonical(s.path("message"), true)); }
            if (!want.equals(got)) diffs.add(part + " sample names: builders " + want + " ≠ fixture " + got);
            for (var e : wantBy.entrySet()) {
                JsonNode c = gotBy.get(e.getKey());
                if (c == null || c.equals(e.getValue())) continue;
                String[] a = e.getValue().toPrettyString().split("\n"), b = c.toPrettyString().split("\n");
                int i = 0;
                while (i < Math.min(a.length, b.length) && a[i].equals(b[i])) i++;
                diffs.add(part + "/" + e.getKey() + " line " + (i + 1) + ": builders `" + (i < a.length ? a[i].strip() : "<end>")
                        + "` ≠ fixture `" + (i < b.length ? b[i].strip() : "<end>") + "`");
            }
        }
        assertThat(diffs).as("apps/web/tests/fixtures/ws-samples.v1.json is out of date with the WS builders — regenerate: " + REGENERATE).isEmpty();
    }
}
