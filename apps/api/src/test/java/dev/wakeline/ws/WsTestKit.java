package dev.wakeline.ws;

import com.fasterxml.jackson.annotation.JsonInclude;
import dev.wakeline.aircraft.core.AircraftEvents;
import dev.wakeline.aircraft.core.AircraftState;
import dev.wakeline.aircraft.core.Snapshot;
import dev.wakeline.aircraft.core.SnapshotStore;
import dev.wakeline.weather.core.Alert;
import dev.wakeline.weather.core.PredictionAvailability;
import dev.wakeline.weather.core.RadarStore;
import dev.wakeline.ingest.ShipStore;
import dev.wakeline.weather.core.SigmetStore;
import dev.wakeline.platform.config.AppProperties;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import org.springframework.web.socket.TextMessage;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.PropertyNamingStrategies;
import tools.jackson.databind.json.JsonMapper;

import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.Executor;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Function;

/** WS 테스트 공통: 운영과 같은 JSON 설정(snake_case · non_null), 실제 스토어, 주입 가능한 실행기. */
final class WsTestKit implements AutoCloseable {
    static final ObjectMapper JSON = JsonMapper.builder()
            .propertyNamingStrategy(PropertyNamingStrategies.SNAKE_CASE)
            .changeDefaultPropertyInclusion(i -> i.withValueInclusion(JsonInclude.Include.NON_NULL))
            .build();

    final SnapshotStore snapshots = new SnapshotStore();
    final ShipStore ships = new ShipStore();
    final SigmetStore sigmets = new SigmetStore();
    final RadarStore radar = new RadarStore();
    final AtomicReference<List<Alert>> alerts = new AtomicReference<>(List.of());
    final AtomicReference<Map<String, Object>> status = new AtomicReference<>(Map.of("server_time", "t"));
    Function<AircraftState, PredictionAvailability> prediction =
            a -> a == null ? new PredictionAvailability(false, null) : PredictionAvailability.AVAILABLE;
    final ScheduledExecutorService timer = Executors.newSingleThreadScheduledExecutor();
    final SimpleMeterRegistry meters = new SimpleMeterRegistry();
    final WsHub hub;
    final ShipFanout shipFanout;
    final WakelineWsHandler handler;
    /** 선박 팬아웃의 시계(ms) — 테스트가 움직인다(주기 스냅샷 60 s). */
    final java.util.concurrent.atomic.AtomicLong shipClock = new java.util.concurrent.atomic.AtomicLong(System.currentTimeMillis());
    final AppProperties props;

    WsTestKit() { this(Runnable::run, 5_000, 200, 5); }

    /** 다른 직렬화 설정으로(WS 스키마 계약 시험은 운영과 같은 매퍼 — null 인 맵 값도 뺀다 — 를 넣는다). */
    WsTestKit(ObjectMapper json) { this(Runnable::run, 5_000, 200, 5, json); }

    WsTestKit(Executor pool, long helloTimeoutMs, int maxConn, int maxPerIp) { this(pool, helloTimeoutMs, maxConn, maxPerIp, JSON); }

    WsTestKit(Executor pool, long helloTimeoutMs, int maxConn, int maxPerIp, ObjectMapper json) {
        props = props(maxConn, maxPerIp);
        hub = new WsHub(json, props, snapshots, sigmets, radar, status::get, alerts::get, a -> prediction.apply(a),
                meters, pool, timer, helloTimeoutMs);
        shipFanout = new ShipFanout(hub, ships, meters, null, shipClock::get); // timer 없음: 이벤트마다 바로 팬아웃
        handler = new WakelineWsHandler(hub, props, json, snapshots, shipFanout);
    }

    static AppProperties props(int maxConn, int maxPerIp) {
        return new AppProperties("", "36.5,127.8", 250, 120, maxConn, maxPerIp, 10, 30, 2500, 0, "classpath:schemas", 72, 30,
                120, List.of("http://localhost:8700", "http://127.0.0.1:8700"), List.of());
    }

    @Override public void close() { timer.shutdownNow(); }

    // ---- 데이터 ----
    static AircraftState ac(String hex, double lat, double lon, int alt, Instant seen, String provider) {
        return new AircraftState(hex, "CS" + hex.substring(0, 3), null, null, null, lat, lon, alt, 400.0, 90.0, 0.0, false, null,
                seen, provider, seen, 0, false);
    }

    /** 스냅샷을 교체하고 이벤트를 허브에 전달한다. */
    Snapshot publish(String scope, Instant fetchedAt, AircraftState... states) {
        Map<String, AircraftState> m = new LinkedHashMap<>();
        for (AircraftState a : states) m.put(a.hex(), a);
        Snapshot s = new Snapshot(snapshots.nextVersion(), scope, "global".equals(scope) ? "opensky" : "adsb_lol", fetchedAt, fetchedAt, "-", Map.copyOf(m));
        Snapshot prev = snapshots.replace(s);
        hub.onSnapshot(new AircraftEvents.SnapshotUpdated(prev, s));
        return s;
    }

    /** hot 셀 메시지를 반영하고 이벤트를 허브에 전달한다(받아들여지지 않으면 null). */
    Snapshot publishHot(String cell, Instant fetchedAt, AircraftState... states) {
        Map<String, AircraftState> m = new LinkedHashMap<>();
        for (AircraftState a : states) m.put(a.hex(), a);
        Snapshot s = new Snapshot(snapshots.nextVersion(), "hot", "adsb_fi", fetchedAt, fetchedAt, "-", Map.copyOf(m));
        Snapshot prev = snapshots.replaceHotIfNewer(cell, s);
        if (prev != null) hub.onSnapshot(new AircraftEvents.SnapshotUpdated(prev, s));
        return prev == null ? null : s;
    }

    /** focus 메시지를 반영하고 이벤트를 허브에 전달한다(받아들여지지 않으면 null). */
    Snapshot publishFocus(Instant fetchedAt, AircraftState... states) {
        Map<String, AircraftState> m = new LinkedHashMap<>();
        for (AircraftState a : states) m.put(a.hex(), a);
        Snapshot s = new Snapshot(snapshots.nextVersion(), "focus", "adsb_fi", fetchedAt, fetchedAt, "-", Map.copyOf(m));
        Snapshot prev = snapshots.applyFocus(s);
        if (prev != null) hub.onSnapshot(new AircraftEvents.SnapshotUpdated(prev, s));
        return prev == null ? null : s;
    }

    // ---- 세션 ----
    FakeWsSession connect(String id, String ip) throws Exception {
        FakeWsSession f = new FakeWsSession(id, ip);
        handler.afterConnectionEstablished(f);
        return f;
    }

    void msg(FakeWsSession f, String json) throws Exception {
        handler.handleMessage(f, new TextMessage(json));
    }

    /** hello + subscribe(한국 부근 bbox, zoom 7) */
    FakeWsSession subscribed(String id, String ip) throws Exception {
        FakeWsSession f = connect(id, ip);
        msg(f, "{\"type\":\"hello\",\"proto\":1}");
        msg(f, "{\"type\":\"subscribe\",\"bbox\":[124,33,132,39],\"zoom\":7}");
        return f;
    }

    static JsonNode parse(String s) { return JSON.readTree(s); }

    static List<JsonNode> ofType(FakeWsSession f, String type) {
        List<JsonNode> out = new ArrayList<>();
        for (String s : f.sent) {
            JsonNode n = parse(s);
            if (type.equals(n.path("type").asString())) out.add(n);
        }
        return out;
    }

    static List<String> types(FakeWsSession f) {
        List<String> out = new ArrayList<>();
        for (String s : f.sent) out.add(parse(s).path("type").asString());
        return out;
    }
}
