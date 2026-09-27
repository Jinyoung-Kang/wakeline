package dev.skywx.ws;

import dev.skywx.config.AppProperties;
import dev.skywx.domain.AircraftState;
import dev.skywx.domain.Alert;
import dev.skywx.engine.AlertStateMachine;
import dev.skywx.engine.EngineEvents;
import dev.skywx.ingest.IngestEvents;
import dev.skywx.ingest.RadarStore;
import dev.skywx.ingest.SigmetStore;
import dev.skywx.ingest.Snapshot;
import dev.skywx.ingest.SnapshotStore;
import dev.skywx.rest.SigmetGeoJson;
import dev.skywx.rest.StatusService;
import io.micrometer.core.instrument.Counter;
import io.micrometer.core.instrument.MeterRegistry;
import io.micrometer.core.instrument.Timer;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.context.event.EventListener;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.CloseStatus;
import tools.jackson.databind.ObjectMapper;

import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * 팬아웃 허브. 스냅샷 갱신 → 구독 세션마다 bbox 필터 → diff → 전송. 30 s 마다 전체 스냅샷(재동기), 30 s 마다 status·ping.
 * 세션별 diff 는 가상 스레드에서 병렬로 계산·전송한다(세션 상태는 세션 단위로만 접근).
 */
@org.springframework.context.annotation.Profile("!cli")
@Component
public class WsHub {
    private static final Logger log = LoggerFactory.getLogger(WsHub.class);
    private final Map<String, WsSession> sessions = new ConcurrentHashMap<>();
    private final ObjectMapper json;
    private final AppProperties props;
    private final SnapshotStore snapshots;
    private final SigmetStore sigmets;
    private final RadarStore radar;
    private final StatusService status;
    private final ExecutorService pool = Executors.newVirtualThreadPerTaskExecutor();
    private final Counter dropped;
    private final Timer fanoutTimer;

    public WsHub(ObjectMapper json, AppProperties props, SnapshotStore snapshots, SigmetStore sigmets, RadarStore radar,
                 StatusService status, MeterRegistry meters) {
        this.json = json;
        this.props = props;
        this.snapshots = snapshots;
        this.sigmets = sigmets;
        this.radar = radar;
        this.status = status;
        meters.gauge("skywx_ws_sessions", sessions, Map::size);
        this.dropped = Counter.builder("skywx_ws_dropped_total").register(meters);
        this.fanoutTimer = Timer.builder("skywx_ws_fanout_seconds").publishPercentiles(0.5, 0.95).register(meters);
    }

    // ---- 세션 관리 ----
    void add(WsSession s) { sessions.put(s.id, s); }
    void remove(String id) { sessions.remove(id); }
    int count() { return sessions.size(); }
    long countByIp(String ip) { return sessions.values().stream().filter(s -> s.ip.equals(ip)).count(); }
    Collection<WsSession> all() { return sessions.values(); }

    String toJson(Object o) { return json.writeValueAsString(o); }

    // ---- 구독 직후: 스냅샷 + 현재 SIGMET/레이더/알림 ----
    void sendInitial(WsSession s, List<Alert> alerts) {
        pool.submit(() -> {
            sendFull(s);
            sendSigmets(s, sigmets.state());
            sendRadar(s, radar.frames());
            s.sendOrDrop(toJson(Map.of("type", "alerts", "alerts", alerts)));
            sendStatus(s);
        });
    }

    // ---- 이벤트 ----
    @EventListener
    public void onSnapshot(IngestEvents.SnapshotUpdated e) {
        boolean global = "global".equals(e.current().scope());
        long t0 = System.nanoTime();
        List<java.util.concurrent.Future<?>> fs = new ArrayList<>();
        for (WsSession s : sessions.values()) {
            if (!s.subscribed()) continue;
            if (global && !s.world) continue;
            fs.add(pool.submit(() -> fanoutOne(s, e.current().version())));
        }
        for (var f : fs) { try { f.get(); } catch (Exception ex) { log.debug("fanout task failed: {}", ex.toString()); } }
        fanoutTimer.record(Duration.ofNanos(System.nanoTime() - t0));
    }

    @EventListener
    public void onSigmets(IngestEvents.SigmetsUpdated e) {
        for (WsSession s : sessions.values()) if (s.subscribed()) pool.submit(() -> sendSigmets(s, e.state()));
    }

    @EventListener
    public void onRadar(IngestEvents.RadarUpdated e) {
        for (WsSession s : sessions.values()) if (s.subscribed()) pool.submit(() -> sendRadar(s, e.frames()));
    }

    @EventListener
    public void onAlerts(EngineEvents.AlertsChanged e) {
        List<Map<String, Object>> msgs = new ArrayList<>(e.events().size());
        for (AlertStateMachine.Event ev : e.events()) msgs.add(Map.of("type", "alert", "event", ev.type().name(), "alert", ev.alert()));
        String payload = toJson(Map.of("type", "alerts_batch", "items", msgs));
        for (WsSession s : sessions.values()) if (s.subscribed()) pool.submit(() -> s.sendOrDrop(payload));
    }

    @Scheduled(fixedDelay = 30_000)
    public void heartbeat() {
        String ping = toJson(new WsMessages.Simple("ping"));
        for (WsSession s : sessions.values()) {
            if (!s.hello) {
                if (Duration.between(s.openedAt, Instant.now()).getSeconds() > 5) s.close(CloseStatus.PROTOCOL_ERROR.withReason("hello timeout"));
                continue;
            }
            if (++s.missedPongs > 2) { s.close(CloseStatus.SESSION_NOT_RELIABLE.withReason("pong timeout")); continue; }
            pool.submit(() -> { s.sendOrDrop(ping); if (s.subscribed()) sendStatus(s); });
        }
    }

    // ---- 전송 ----
    private void fanoutOne(WsSession s, long version) {
        Instant now = Instant.now();
        boolean needFull = s.needsResync || Duration.between(s.lastFullAt, now).getSeconds() >= props.wsResyncIntervalS();
        if (needFull) { sendFull(s); return; }
        var diff = synchronizedDiff(s);
        if (diff == null || diff.isEmpty()) { s.lastSentVersion = version; return; }
        List<Map<String, Object>> up = new ArrayList<>(diff.upsert().size());
        for (AircraftState a : diff.upsert()) up.add(WsMessages.encode(a, s.detail, s.world));
        String msg = toJson(new WsMessages.DiffMsg("diff", version, now, up, diff.remove()));
        if (!s.sendOrDrop(msg)) dropped.increment(); else s.lastSentVersion = version;
    }

    private DiffCalculator.Diff synchronizedDiff(WsSession s) {
        synchronized (s.sent) { return DiffCalculator.compute(s.sent, visible(s), s.bbox); }
    }

    /** 뷰포트에 보이는 상태: 관심 지역 스냅샷 + (world 뷰면) 전세계 스냅샷 중 지역에 없는 것. */
    private Iterable<AircraftState> visible(WsSession s) {
        Snapshot region = snapshots.region();
        if (!s.world) return region.states().values();
        Map<String, AircraftState> merged = new LinkedHashMap<>(snapshots.global().states());
        merged.putAll(region.states());
        return merged.values();
    }

    void sendFull(WsSession s) {
        if (s.bbox == null) return;
        Instant now = Instant.now();
        Snapshot region = snapshots.region();
        List<Map<String, Object>> list = new ArrayList<>();
        synchronized (s.sent) {
            s.sent.clear();
            for (AircraftState a : visible(s)) {
                if (!s.bbox.contains(a.lat(), a.lon())) continue;
                s.sent.put(a.hex(), a);
                list.add(WsMessages.encode(a, s.detail, s.world));
            }
        }
        var msg = new WsMessages.SnapshotMsg("snapshot", snapshots.version(), now, s.world ? "world" : "region", region.provider(),
                region.fetchedAt(), region.lagSeconds(now), region.stale(now, 60), sigmets.state().version(), list);
        if (s.sendOrDrop(toJson(msg))) { s.lastFullAt = now; s.needsResync = false; s.lastSentVersion = snapshots.version(); }
    }

    private void sendSigmets(WsSession s, SigmetStore.State st) {
        s.sendOrDrop(toJson(Map.of("type", "sigmets", "v", st.version(), "fetched_at", st.fetchedAt(), "provider", st.provider(),
                "collection", SigmetGeoJson.collection(st.byId().values(), Instant.now(), true))));
    }

    private void sendRadar(WsSession s, RadarStore.Frames f) {
        s.sendOrDrop(toJson(Map.of("type", "radar", "host", f.host(), "generated", f.generated(), "past", f.past(),
                "fetched_at", f.fetchedAt(), "provider", f.provider())));
    }

    private void sendStatus(WsSession s) {
        s.sendOrDrop(toJson(Map.of("type", "status", "status", status.publicStatus())));
    }
}
