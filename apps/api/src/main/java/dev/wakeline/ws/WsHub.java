package dev.wakeline.ws;

import dev.wakeline.config.AppProperties;
import dev.wakeline.domain.AircraftState;
import dev.wakeline.domain.Alert;
import dev.wakeline.domain.Bbox;
import dev.wakeline.domain.SigmetRecord;
import dev.wakeline.engine.AlertStateMachine;
import dev.wakeline.engine.EngineEvents;
import dev.wakeline.engine.EngineService;
import dev.wakeline.engine.PredictionAvailability;
import dev.wakeline.ingest.IngestEvents;
import dev.wakeline.ingest.RadarStore;
import dev.wakeline.ingest.SigmetStore;
import dev.wakeline.ingest.Snapshot;
import dev.wakeline.ingest.SnapshotStore;
import dev.wakeline.rest.SigmetGeoJson;
import dev.wakeline.rest.StatusService;
import dev.wakeline.route.RouteInfo;
import dev.wakeline.route.RouteReader;
import io.micrometer.core.instrument.Counter;
import io.micrometer.core.instrument.MeterRegistry;
import io.micrometer.core.instrument.Timer;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.context.SmartLifecycle;
import org.springframework.context.annotation.Profile;
import org.springframework.context.event.EventListener;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.WebSocketSession;
import tools.jackson.databind.ObjectMapper;

import java.time.Duration;
import java.time.Instant;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executor;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Function;
import java.util.function.Supplier;

/**
 * 팬아웃 허브(계약서 §1).
 * <ul>
 *   <li>이벤트 스레드(스트림 소비·엔진)는 세션 우편함에 작업을 <b>예약만</b> 하고 돌아간다 — 느린 클라이언트가 수집·엔진·다른 세션을 막지 않는다(REL-2/PERF-3).</li>
 *   <li>세션마다 작업 종류별 단일 비행: 이전 팬아웃이 아직 대기 중이면 새로 넣지 않고 합친다. 작업은 실행 시점의 최신 병합 뷰를
 *       '이 세션에 마지막으로 보낸 상태' 와 비교하므로 건너뛴 버전의 변화도 빠지지 않는다.</li>
 *   <li>seq: 스냅샷마다 1, 실제로 보낸 diff 마다 +1(빈 diff 는 보내지 않는다) — 틈이 없다(PERF-2/COR-6).</li>
 *   <li>항공기 JSON 조각·SIGMET·알림·레이더·status 페이로드는 버전마다 한 번만 직렬화해 모든 세션이 같은 String 을 쓴다(PERF-8/PERF-9/SEC-2).</li>
 *   <li>알림은 버전(배치마다 +1)을 달고, 세션마다 반영한 버전을 기억해 빠진 배치를 순서대로(없으면 전체 목록) 보낸다 — 일시정지·백프레셔 뒤에도 어긋나지 않는다(COR-7/GAP-3).</li>
 *   <li>selected 에는 선택 항공기의 등록 노선(route, 계약 v4 §A)을 싣는다 — 콜사인별 5 s 캐시({@link RouteReader})라 팬아웃·focus 관측마다
 *       다시 읽어도 Redis 조회는 콜사인당 5 s 에 한 번이다. 노선 상태가 바뀌면(조회 중 → 찾음) 상태가 그대로여도 다시 보낸다.</li>
 *   <li>수요 스코프(hot·focus, 계약 v2 §A3) 메시지는 바뀐 항공기의 이전·현재 위치를 감싸는 범위와 겹치는 세션에만 팬아웃한다 — 전체 팬아웃은
 *       region(10 s)·global 이 계속 한다. focus 관측이 오면 그 hex 를 선택한 세션에 selected 를 보낸다(≈ 5 s, 같은 관측을 두 번 보내지 않는다).</li>
 *   <li>수요(demand) 메시지는 DemandService 가 계산해 {@link #pushDemand} 로 예약한다. 구독·선택·일시정지·연결 종료는 {@link #demandChanged} 로 알린다.</li>
 *   <li>레이어(계약 v2 §B3): 항공기를 끈 세션에는 항공기 snapshot/diff 를 보내지 않는다(다시 켜면 seq 1 스냅샷부터). 선박 메시지는 {@link ShipFanout} 이
 *       같은 우편함에서 보낸다 — 초기 세트(구독·resume·백프레셔)의 끝에서 {@link #setShipsHook 선박 훅}을 불러 선박 전체를 이어서 보낸다.</li>
 * </ul>
 */
@Profile("!cli & !migrate")
@Component
public class WsHub implements SmartLifecycle {
    private static final Logger log = LoggerFactory.getLogger(WsHub.class);
    /** hello 는 연결 후 이 시간 안에 와야 한다(설계 9.5 · 계약 §1). */
    public static final long HELLO_TIMEOUT_MS = 5_000;
    /** status 페이로드(Redis 3회 조회) 공유 캐시 수명 */
    static final long STATUS_TTL_MS = 3_000;
    /** 알림 배치 이력(세션이 놓친 배치를 순서대로 다시 보낼 수 있는 범위). 넘으면 전체 목록. */
    static final int ALERT_BATCH_HISTORY = 64;
    /** 피드 stale 기준(계약 §1): 지역 60 s · 전세계 300 s */
    static final int REGION_STALE_S = 60;
    static final int GLOBAL_STALE_S = 300;
    /** ping 뒤 pong 이 없는 heartbeat 가 이 수를 넘으면 닫는다 — 연속 2회 무응답(설계 9.5). */
    static final int MAX_MISSED_PONGS = 2;
    private static final String PING = "{\"type\":\"ping\"}";

    private final Map<String, WsSession> sessions = new ConcurrentHashMap<>();
    private final ObjectMapper json;
    private final AppProperties props;
    private final SnapshotStore snapshots;
    private final SigmetStore sigmets;
    private final RadarStore radar;
    private final Supplier<Map<String, Object>> statusSource;
    private final Supplier<List<Alert>> activeAlerts;
    private final Function<AircraftState, PredictionAvailability> prediction;
    private final Executor pool;
    private final ScheduledExecutorService timer;
    private final long helloTimeoutMs;
    private final AircraftJsonCache fragments;
    private final Counter dropped;
    private final Counter coalesced;
    private final Counter rateLimited;
    private final Counter rejected;
    private final Timer fanoutTimer;

    // ---- 알림 버전(배치마다 +1). 쓰기는 alertsLock 안에서만. ----
    record Batch(long version, String json) {}
    record Payload(long version, String json) {}
    private final Object alertsLock = new Object();
    private volatile long alertsVersion;
    private final ArrayDeque<Batch> batches = new ArrayDeque<>();
    private final Object alertsBuildLock = new Object();
    private final AtomicReference<Payload> alertsFull = new AtomicReference<>();

    // ---- SIGMET·레이더·status 공유 페이로드 ----
    record SigmetPayload(SigmetStore.State state, long version, String json, long validUntilMs) {}
    record RadarPayload(RadarStore.Frames frames, String json) {}
    private record StatusPayload(long atMs, String json) {}
    private final Object sigmetsBuildLock = new Object();
    private final AtomicReference<SigmetPayload> sigmetsCache = new AtomicReference<>();
    private final AtomicReference<RadarPayload> radarCache = new AtomicReference<>();
    private final Object statusLock = new Object();
    private volatile StatusPayload statusCache;

    @Autowired
    public WsHub(ObjectMapper json, AppProperties props, SnapshotStore snapshots, SigmetStore sigmets, RadarStore radar,
                 StatusService status, EngineService engine, MeterRegistry meters, RouteReader routes) {
        this(json, props, snapshots, sigmets, radar, status::publicStatus, () -> engine.activeAlerts(null), engine::predictionAvailability,
                meters, Executors.newVirtualThreadPerTaskExecutor(),
                Executors.newSingleThreadScheduledExecutor(Thread.ofPlatform().daemon().name("ws-timer").factory()), HELLO_TIMEOUT_MS);
        setRouteSource(routes::forAircraft);
    }

    /** 테스트용: 실행기·타이머·데이터 출처를 주입한다. */
    WsHub(ObjectMapper json, AppProperties props, SnapshotStore snapshots, SigmetStore sigmets, RadarStore radar,
          Supplier<Map<String, Object>> statusSource, Supplier<List<Alert>> activeAlerts,
          Function<AircraftState, PredictionAvailability> prediction, MeterRegistry meters,
          Executor pool, ScheduledExecutorService timer, long helloTimeoutMs) {
        this.json = json;
        this.props = props;
        this.snapshots = snapshots;
        this.sigmets = sigmets;
        this.radar = radar;
        this.statusSource = statusSource;
        this.activeAlerts = activeAlerts;
        this.prediction = prediction;
        this.pool = pool;
        this.timer = timer;
        this.helloTimeoutMs = helloTimeoutMs;
        this.fragments = new AircraftJsonCache(json);
        meters.gauge("wakeline_ws_sessions", sessions, Map::size);
        this.dropped = Counter.builder("wakeline_ws_dropped_total").description("열린 세션에 보내지 못한 메시지").register(meters);
        this.coalesced = Counter.builder("wakeline_ws_coalesced_total").description("이전 팬아웃이 대기 중이라 합친 요청").register(meters);
        this.rateLimited = Counter.builder("wakeline_ws_rate_limited_total").description("수신 rate limit 초과로 닫은 세션").register(meters);
        this.rejected = Counter.builder("wakeline_ws_rejected_total").description("연결 상한으로 거절한 연결").register(meters);
        this.fanoutTimer = Timer.builder("wakeline_ws_fanout_seconds").description("세션 하나의 팬아웃 작업 시간")
                .publishPercentiles(0.5, 0.95).register(meters);
    }

    // ---- 정상 종료(설계 5.3): SIGTERM → 모든 WS 에 going_away(1001) → 클라이언트는 지수 백오프로 재접속 ----
    private volatile boolean running;

    @Override public void start() { running = true; }
    @Override public boolean isRunning() { return running; }
    /** 웹 서버(Tomcat)보다 먼저 멈추도록 높은 phase — 연결이 살아 있을 때 1001 을 보낸다. */
    @Override public int getPhase() { return Integer.MAX_VALUE - 100; }

    @Override
    public void stop() {
        running = false;
        int n = 0;
        for (WsSession s : sessions.values()) { closeAsync(s, CloseStatus.GOING_AWAY.withReason("server shutting down")); n++; }
        sessions.clear();
        timer.shutdownNow();
        if (pool instanceof ExecutorService es) {
            es.shutdown();
            try {
                if (!es.awaitTermination(3, TimeUnit.SECONDS)) es.shutdownNow();
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
        }
        log.info("ws hub stopped: sent going_away to {} sessions", n);
    }

    // ---- 세션 관리 ----
    WsSession newSession(WebSocketSession raw, String ip) { return new WsSession(raw, ip, pool); }

    /** 등록 + 세션별 hello 타이머(정확히 helloTimeoutMs 뒤 1회, GAP-22). */
    void add(WsSession s) {
        sessions.put(s.id, s);
        try {
            timer.schedule(() -> {
                if (!s.hello) closeAsync(s, CloseStatus.PROTOCOL_ERROR.withReason("hello timeout"));
            }, helloTimeoutMs, TimeUnit.MILLISECONDS);
        } catch (RejectedExecutionException e) { // 종료 중
            closeAsync(s, CloseStatus.GOING_AWAY);
        }
    }

    void remove(WsSession s) {
        s.markClosed();
        if (sessions.remove(s.id, s)) demandChanged(); // 창을 닫으면 그 세션의 수요(임대)가 곧바로 빠진다
    }

    int count() { return sessions.size(); }

    /** 현재 세션들(약한 일관성 — 수요 계산용). */
    Collection<WsSession> sessionsView() { return sessions.values(); }

    // ---- 수요(DemandService) ----
    private volatile Runnable demandListener = () -> { };

    /** 수요가 바뀌었을 수 있다(구독·선택·일시정지·종료) — 수요 서비스가 1 s 로 모아 다시 계산한다. 바로 돌아온다. */
    void demandChanged() { demandListener.run(); }

    void setDemandListener(Runnable r) { demandListener = r == null ? () -> { } : r; }

    // ---- 등록 노선(RouteReader) ----
    private volatile Function<AircraftState, RouteInfo> routeSource = a -> null;

    /** selected 의 route 출처(운영: RouteReader). 테스트는 가짜를 넣는다 — 없으면 route 는 null. */
    void setRouteSource(Function<AircraftState, RouteInfo> f) { routeSource = f == null ? a -> null : f; }

    /** 상태의 노선(상태가 없으면 null — 콜사인을 모른다). */
    private RouteInfo route(AircraftState a) { return a == null ? null : routeSource.apply(a); }

    // ---- 선박(ShipFanout) ----
    private volatile java.util.function.Consumer<WsSession> shipsHook = s -> { };

    /** 초기 세트 끝에서 부를 선박 훅(우편함 안에서 불린다 — 훅은 선박 작업을 같은 우편함에 예약만 한다). */
    void setShipsHook(java.util.function.Consumer<WsSession> hook) { shipsHook = hook == null ? s -> { } : hook; }

    /** 세션의 최신 demand 메시지(s.demandJson)를 우편함 순서대로 보낸다(단일 비행 — 여러 번 불러도 최신 하나). */
    void pushDemand(WsSession s) {
        if (s.subscribed()) s.schedule(WsSession.Job.DEMAND, () -> runDemand(s));
    }

    String toJson(Object o) { return json.writeValueAsString(o); }

    /** 닫기를 가상 스레드에서(핸들러·타이머·이벤트 스레드를 막지 않는다). 한 번만. */
    void closeAsync(WsSession s, CloseStatus status) {
        if (!s.beginClose()) return;
        try {
            pool.execute(() -> s.closeNow(status));
        } catch (RejectedExecutionException e) {
            s.closeNow(status);
        }
    }

    void rateLimited(WsSession s) {
        rateLimited.increment();
        closeAsync(s, CloseStatus.POLICY_VIOLATION.withReason("rate limit"));
    }

    void rejected() { rejected.increment(); }

    /** 제어 응답(welcome·pong 등)을 우편함 순서대로 보낸다. */
    void reply(WsSession s, String payload) {
        s.post(() -> send(s, payload));
    }

    void error(WsSession s, String code, String detail) {
        reply(s, toJson(errorMsg(code, detail)));
    }

    /** 오류를 보낸 뒤 닫는다(순서 보장). 이후 수신은 무시. */
    void fatal(WsSession s, String code, String detail, CloseStatus status) {
        s.inboundBlocked = true;
        String payload = toJson(errorMsg(code, detail));
        CloseStatus st = status.withReason(code);
        if (!s.post(() -> { send(s, payload); s.closeNow(st); })) closeAsync(s, st);
    }

    private static WsMessages.ErrorMsg errorMsg(String code, String detail) {
        return new WsMessages.ErrorMsg("error", code, code.toLowerCase(java.util.Locale.ROOT).replace('_', ' '), detail);
    }

    // ---- 요청(핸들러) ----

    /**
     * 구독·resume·재동기 뒤의 초기 세트. 세션당 하나만 대기하고(연속 subscribe 는 합쳐져 마지막 bbox 가 이긴다), 작업이 실행될 때의 구독으로 만든다.
     * @param force 알림 전체 목록·레이더를 버전과 무관하게 다시 보낸다(resume·백프레셔)
     */
    void sendInitial(WsSession s, boolean force) {
        if (force) s.initialForce.set(true);
        if (!s.schedule(WsSession.Job.INITIAL, () -> runInitial(s))) coalesced.increment();
    }

    void requestFanout(WsSession s) {
        if (!s.schedule(WsSession.Job.FANOUT, () -> runFanout(s))) coalesced.increment();
    }

    /** 모든 구독 세션에 팬아웃(병합 뷰가 스트림 이벤트 없이 바뀌었을 때 — 예: 선택 해제로 focus 관측이 빠짐). */
    void fanoutAll() {
        for (WsSession s : sessions.values()) if (s.subscribed()) requestFanout(s);
    }

    void requestSelected(WsSession s) {
        s.schedule(WsSession.Job.SELECTED, () -> runSelected(s));
    }

    // ---- 이벤트(스트림 소비·엔진 스레드 — 예약만 하고 돌아간다) ----

    @EventListener
    public void onSnapshot(IngestEvents.SnapshotUpdated e) {
        String scope = e.current().scope();
        if (SnapshotStore.HOT.equals(scope) || SnapshotStore.FOCUS.equals(scope)) onDemandSnapshot(e, SnapshotStore.FOCUS.equals(scope));
        else for (WsSession s : sessions.values()) if (s.subscribed() && wantsAircraft(s)) requestFanout(s);
        try {
            pool.execute(() -> fragments.prune(snapshots.merged()));
        } catch (RejectedExecutionException ignored) { }
    }

    /**
     * hot·focus 메시지: 바뀐 항공기의 이전·현재 위치를 감싸는 범위와 겹치는 구독 세션만 팬아웃(diff 는 병합 뷰 기준이라 빠짐이 없다 —
     * 범위 밖 세션은 다음 region/global 팬아웃에서 같은 결과를 받는다). focus 는 그 hex 를 선택한 세션에 selected 를 따로 예약한다.
     */
    private void onDemandSnapshot(IngestEvents.SnapshotUpdated e, boolean focus) {
        Bbox area = envelope(e.previous().states().values(), e.current().states().values());
        for (WsSession s : sessions.values()) {
            if (!s.subscribed()) continue;
            WsSession.Sub sub = s.sub;
            if (area != null && sub != null && s.layerAircraft && sub.bbox().intersects(area)) requestFanout(s);
            String sel = s.selectedHex;
            if (focus && sel != null && e.current().states().containsKey(sel)) s.schedule(WsSession.Job.SELECTED, () -> runSelectedObservation(s));
        }
    }

    /** 항공기 팬아웃이 필요한 세션인가: 항공기 레이어를 켰거나 선택 항공기가 있다(선택은 레이어와 무관한 명시적 선택). */
    static boolean wantsAircraft(WsSession s) { return s.layerAircraft || s.selectedHex != null || s.selectedSent != null; }

    /** 위치들을 감싸는 bbox(없으면 null). */
    static Bbox envelope(Collection<AircraftState> a, Collection<AircraftState> b) {
        double lomin = Double.POSITIVE_INFINITY, lamin = Double.POSITIVE_INFINITY, lomax = Double.NEGATIVE_INFINITY, lamax = Double.NEGATIVE_INFINITY;
        int n = 0;
        for (Collection<AircraftState> c : List.of(a, b)) {
            for (AircraftState x : c) {
                lomin = Math.min(lomin, x.lon()); lomax = Math.max(lomax, x.lon());
                lamin = Math.min(lamin, x.lat()); lamax = Math.max(lamax, x.lat());
                n++;
            }
        }
        return n == 0 ? null : new Bbox(lomin, lamin, lomax, lamax);
    }

    @EventListener
    public void onSigmets(IngestEvents.SigmetsUpdated e) {
        pushSigmets();
    }

    /** 유효시간 만료로 활성 SIGMET 이 줄었을 때(새 수신 없이) — 버전이 올라 있으므로 모든 구독 세션에 다시 보낸다(REL-13). */
    @EventListener
    public void onSigmetsExpired(IngestEvents.SigmetsExpired e) {
        pushSigmets();
    }

    private void pushSigmets() {
        for (WsSession s : sessions.values()) if (s.subscribed()) s.schedule(WsSession.Job.SIGMETS, () -> runSigmets(s));
    }

    @EventListener
    public void onRadar(IngestEvents.RadarUpdated e) {
        for (WsSession s : sessions.values()) if (s.subscribed()) s.schedule(WsSession.Job.RADAR, () -> runRadar(s, false));
    }

    /**
     * 알림 배치. 엔진이 자기 잠금 안에서 동기 발행하므로(판정 주기와 activeAlerts 가 같은 잠금) 버전과 목록이 어긋나지 않는다.
     * 배치 JSON 은 한 번만 만들고, 세션별 전송은 우편함 작업이 한다.
     */
    @EventListener
    public void onAlerts(EngineEvents.AlertsChanged e) {
        List<WsMessages.AlertItem> items = new ArrayList<>(e.events().size());
        for (AlertStateMachine.Event ev : e.events()) items.add(new WsMessages.AlertItem(ev.type().name(), ev.alert()));
        synchronized (alertsLock) {
            long v = alertsVersion + 1;
            batches.addLast(new Batch(v, toJson(new WsMessages.AlertsBatchMsg("alerts_batch", v, items))));
            while (batches.size() > ALERT_BATCH_HISTORY) batches.removeFirst();
            alertsVersion = v;
        }
        for (WsSession s : sessions.values()) if (s.subscribed()) s.schedule(WsSession.Job.ALERTS, () -> runAlerts(s));
    }

    long alertsVersion() { return alertsVersion; }

    @Scheduled(fixedDelay = 30_000)
    public void heartbeat() {
        Instant now = Instant.now();
        for (WsSession s : sessions.values()) {
            if (s.isClosing()) continue;
            if (!s.hello) { // 세션 타이머가 닫는다 — 타이머가 거절된 경우의 보조
                if (Duration.between(s.openedAt, now).toMillis() > helloTimeoutMs) closeAsync(s, CloseStatus.PROTOCOL_ERROR.withReason("hello timeout"));
                continue;
            }
            if (s.missedPongs.incrementAndGet() > MAX_MISSED_PONGS) {
                closeAsync(s, CloseStatus.SESSION_NOT_RELIABLE.withReason("pong timeout"));
                continue;
            }
            s.schedule(WsSession.Job.HEARTBEAT, () -> runHeartbeat(s));
        }
    }

    // ---- 우편함 작업(세션당 한 번에 하나) ----

    private void runInitial(WsSession s) {
        if (!s.ready() || !s.subscribed()) return;
        boolean force = s.initialForce.getAndSet(false);
        force |= s.stateResync.getAndSet(false);
        long t0 = System.nanoTime();
        sendInitialSet(s, force);
        fanoutTimer.record(Duration.ofNanos(System.nanoTime() - t0));
    }

    /**
     * 스냅샷(항공기 레이어를 켰을 때) + 알림(버전이 다르거나 force) + SIGMET(받지 않은 v 만) + 레이더(바뀌었거나 force) + status + 수요
     * + 선택 항공기 + 선박(훅 — 같은 우편함에 이어서).
     */
    private void sendInitialSet(WsSession s, boolean force) {
        Instant now = Instant.now();
        SnapshotStore.View view = snapshots.view(now);
        if (s.layerAircraft) {
            if (!sendSnapshot(s, view, now)) return;
        } else { // 항공기를 끈 세션: 보낸 상태를 비워 다시 켤 때 스냅샷(seq 1)부터
            s.sent.clear();
            s.seq = 0;
            s.needsResync = true;
        }
        if (force || s.alertsV != alertsVersion) {
            if (!sendAlertsFull(s)) return;
        }
        SigmetPayload sp = sigmetsPayload();
        if (s.sigmetsV != sp.version()) {
            if (!send(s, sp.json())) return;
            s.sigmetsV = sp.version();
        }
        RadarPayload rp = radarPayload();
        if (force || s.radarSent != rp.frames()) {
            if (!send(s, rp.json())) return;
            s.radarSent = rp.frames();
        }
        String st = statusJson();
        if (st != null && !send(s, st)) return;
        String dj = s.demandJson; // 수요 상태(계산된 적이 있으면) — resume·백프레셔 재동기 뒤에도 화면이 추적 상태를 잃지 않게
        if (dj != null && !send(s, dj)) return;
        if (s.selectedHex != null) sendSelected(s, view.states(), force);
        shipsHook.accept(s);
    }

    private void runFanout(WsSession s) {
        if (!s.ready() || !s.subscribed()) return;
        if (s.isScheduled(WsSession.Job.INITIAL)) return; // 바로 뒤의 초기 세트가 최신 스냅샷을 보낸다
        long t0 = System.nanoTime();
        try {
            if (s.stateResync.getAndSet(false)) { // 백프레셔로 메시지를 잃었다 → 전체 초기 세트(계약 §1)
                sendInitialSet(s, true);
                return;
            }
            Instant now = Instant.now();
            SnapshotStore.View view = snapshots.view(now);
            WsSession.Sub sub = s.sub;
            int intervalS = sub.world() ? props.wsResyncWorldIntervalS() : props.wsResyncIntervalS();
            if (!s.layerAircraft) {
                // 항공기 레이어 꺼짐 — 항공기 목록은 보내지 않는다(선택 항공기만 아래에서)
            } else if (s.needsResync || s.seq == 0 || Duration.between(s.lastFullAt, now).getSeconds() >= intervalS) {
                sendSnapshot(s, view, now);
            } else {
                DiffCalculator.Diff d = DiffCalculator.compute(s.sent, view.states().values(), sub.bbox());
                if (!d.isEmpty()) {
                    int seq = s.seq + 1;
                    String msg = toJson(new WsMessages.DiffMsg("diff", seq, version(view), now, jsonArray(d.upsert(), sub.encoding()), d.remove()));
                    if (send(s, msg)) s.seq = seq;
                    else s.needsResync = true; // sent 는 이미 바뀌었다 → 다음에 스냅샷
                }
            }
            if (s.selectedHex != null || s.selectedSent != null) sendSelected(s, view.states(), false);
        } finally {
            fanoutTimer.record(Duration.ofNanos(System.nanoTime() - t0));
        }
    }

    private void runAlerts(WsSession s) {
        if (!s.ready() || !s.subscribed()) return;
        long cur = alertsVersion;
        if (s.alertsV >= cur) return;
        List<Batch> missing = s.alertsV < 0 ? null : batchesAfter(s.alertsV, cur);
        if (missing == null) { // 전체 목록을 받은 적 없거나 이력보다 뒤처짐
            sendAlertsFull(s);
            return;
        }
        for (Batch b : missing) {
            if (!send(s, b.json())) { s.stateResync.set(true); return; }
            s.alertsV = b.version();
        }
    }

    private void runSigmets(WsSession s) {
        if (!s.ready() || !s.subscribed()) return;
        SigmetPayload p = sigmetsPayload();
        if (s.sigmetsV == p.version()) return;
        if (send(s, p.json())) s.sigmetsV = p.version();
    }

    private void runRadar(WsSession s, boolean force) {
        if (!s.ready() || !s.subscribed()) return;
        RadarPayload p = radarPayload();
        if (!force && s.radarSent == p.frames()) return;
        if (send(s, p.json())) s.radarSent = p.frames();
    }

    private void runSelected(WsSession s) {
        if (!s.ready() || !s.hello) return;
        sendSelected(s, snapshots.merged(), true);
    }

    /**
     * focus 관측이 왔다(계약 v2 §A3: 집중 추적 갱신마다 selected). 이미 이 세션에 보낸 바로 그 상태 객체면(팬아웃이 먼저 보냄) 다시 보내지 않는다.
     */
    private void runSelectedObservation(WsSession s) {
        if (!s.ready() || !s.hello) return;
        String hex = s.selectedHex;
        if (hex == null) return;
        AircraftState a = snapshots.merged().get(hex);
        WsSession.SelectedSent prev = s.selectedSent;
        if (prev != null && hex.equals(prev.hex()) && prev.state() == a && a != null && Objects.equals(prev.prediction(), prediction.apply(a))
                && Objects.equals(prev.route(), route(a))) return;
        sendSelected(s, snapshots.merged(), true);
    }

    private void runDemand(WsSession s) {
        if (!s.ready() || !s.subscribed()) return;
        String j = s.demandJson;
        if (j != null) send(s, j);
    }

    private void runHeartbeat(WsSession s) {
        if (!s.ready()) return;
        if (!send(s, PING)) return;
        if (s.subscribed()) {
            String st = statusJson();
            if (st != null) send(s, st);
        }
    }

    // ---- 전송 도우미 ----

    boolean send(WsSession s, String payload) {
        if (!s.ready()) return false;
        if (s.sendNow(payload)) return true;
        dropped.increment();
        return false;
    }

    private boolean sendSnapshot(WsSession s, SnapshotStore.View view, Instant now) {
        WsSession.Sub sub = s.sub;
        WsMessages.Encoding enc = sub.encoding();
        StringBuilder arr = new StringBuilder(4096).append('[');
        boolean first = true;
        s.sent.clear();
        for (AircraftState a : view.states().values()) {
            if (!sub.bbox().contains(a.lat(), a.lon())) continue;
            s.sent.put(a.hex(), a);
            if (!first) arr.append(',');
            first = false;
            arr.append(fragments.get(a, enc));
        }
        arr.append(']');
        String msg = toJson(new WsMessages.SnapshotMsg("snapshot", 1, version(view), now, sources(view, now),
                sigmets.state().version(), arr.toString()));
        if (send(s, msg)) {
            s.seq = 1;
            s.lastFullAt = now;
            s.needsResync = false;
            return true;
        }
        s.needsResync = true;
        return false;
    }

    private boolean sendAlertsFull(WsSession s) {
        Payload p = alertsFullPayload();
        if (!send(s, p.json())) return false;
        s.alertsV = p.version();
        return true;
    }

    /** "selected": 선택 항공기의 FULL 상태(범위 밖이어도) + 예측 가능 여부 + 등록 노선. force 가 아니면 바뀐 경우에만. */
    private void sendSelected(WsSession s, Map<String, AircraftState> states, boolean force) {
        String hex = s.selectedHex;
        if (hex == null) { s.selectedSent = null; return; }
        AircraftState a = states.get(hex);
        PredictionAvailability p = prediction.apply(a);
        RouteInfo r = route(a);
        WsSession.SelectedSent prev = s.selectedSent;
        if (!force && prev != null && hex.equals(prev.hex()) && sameSelected(prev.state(), a) && Objects.equals(prev.prediction(), p)
                && Objects.equals(prev.route(), r)) return;
        String state = a == null ? null : fragments.get(a, WsMessages.Encoding.FULL);
        if (send(s, toJson(new WsMessages.SelectedMsg("selected", hex, state, p, r)))) s.selectedSent = new WsSession.SelectedSent(hex, a, p, r);
    }

    /** 새 보고(seen_at)나 표시 값 변화가 없으면 같은 것으로 본다. */
    static boolean sameSelected(AircraftState x, AircraftState y) {
        if (x == y) return true;
        if (x == null || y == null) return false;
        return !DiffCalculator.changed(x, y) && Objects.equals(x.seenAt(), y.seenAt());
    }

    private String jsonArray(List<AircraftState> list, WsMessages.Encoding enc) {
        StringBuilder sb = new StringBuilder(64 + list.size() * 160).append('[');
        for (int i = 0; i < list.size(); i++) {
            if (i > 0) sb.append(',');
            sb.append(fragments.get(list.get(i), enc));
        }
        return sb.append(']').toString();
    }

    /** 참고용 전역 버전 v(계약 §1) — 병합 뷰가 바뀔 때마다 오른다(region·global·hot·focus 어느 것이든). */
    static long version(SnapshotStore.View view) {
        return view.version();
    }

    /** 스냅샷 sources(계약 §1): 스코프별 provider·fetched_at·lag_s·stale. 전세계 피드가 한 번도 없으면 global = null. REST /aircraft meta 도 같은 모양을 쓴다. */
    public static WsMessages.Sources sources(SnapshotStore.View view, Instant now) {
        return new WsMessages.Sources(source(view.region(), now, REGION_STALE_S),
                hasFeed(view.global()) ? source(view.global(), now, GLOBAL_STALE_S) : null);
    }

    private static boolean hasFeed(Snapshot s) {
        return s.fetchedAt() != null && !Instant.EPOCH.equals(s.fetchedAt());
    }

    static WsMessages.Source source(Snapshot s, Instant now, int staleS) {
        boolean known = hasFeed(s);
        String provider = s.provider() == null || s.provider().isBlank() || "-".equals(s.provider()) ? null : s.provider();
        if (!known) return new WsMessages.Source(provider, null, null, true); // 수집 이력 없음 = 현재 아님
        double lag = (now.toEpochMilli() - s.fetchedAt().toEpochMilli()) / 1000.0;
        return new WsMessages.Source(provider, s.fetchedAt(), Math.round(lag * 10) / 10.0, lag > staleS);
    }

    // ---- 공유 페이로드(버전마다 한 번 직렬화) ----

    /**
     * 활성 알림 전체 목록과 그 버전. 목록 조회 전후 버전이 같으면 정확히 그 버전의 목록이다(배치 발행은 엔진 잠금 안이고,
     * activeAlerts 도 같은 잠금을 잡는다). 드물게 계속 어긋나면 조회 전 버전(하한)을 단다 — 클라이언트가 이후 배치를 다시 적용해도
     * 결과는 같다(배치는 hex·id 별 마지막 값 덮어쓰기/삭제).
     */
    Payload alertsFullPayload() {
        Payload c = alertsFull.get();
        if (c != null && c.version() == alertsVersion) return c;
        synchronized (alertsBuildLock) {
            for (int attempt = 0; ; attempt++) {
                long v1 = alertsVersion;
                c = alertsFull.get();
                if (c != null && c.version() == v1) return c;
                List<Alert> list = activeAlerts.get();
                long v2 = alertsVersion;
                if (v1 == v2 || attempt >= 2) {
                    Payload p = new Payload(v1, toJson(new WsMessages.AlertsMsg("alerts", v1, list)));
                    if (v1 == v2) alertsFull.set(p);
                    return p;
                }
            }
        }
    }

    /** from 다음부터 to 까지의 배치가 이력에 빠짐없이 있으면 그 목록, 아니면 null. */
    private List<Batch> batchesAfter(long from, long to) {
        synchronized (alertsLock) {
            List<Batch> out = new ArrayList<>();
            for (Batch b : batches) if (b.version() > from && b.version() <= to) out.add(b);
            if (out.size() != to - from || out.get(0).version() != from + 1) return null;
            return out;
        }
    }

    /**
     * SIGMET 목록 페이로드. SigmetStore 버전별로 한 번 만들고, 속성 중 시각에 따라 바뀌는 값(active·expiring_soon)이 바뀌는
     * 다음 경계(valid_from · valid_to − 30분 · valid_to)가 지나면 다시 만든다.
     * computed_at(WS-5): 그 시각 의존 값을 계산한 서버 시각. 이미 받은 세션에는 경계마다 다시 보내지 않으므로(목록 전체 ~120 KB 를 세션마다
     * 다시 보내지 않게) 클라이언트가 가진 active·expiring_soon 은 computed_at 기준 값이다 — 화면은 valid_from/valid_to 와 서버 시각으로
     * 직접 계산해야 하고, 이 필드는 서버 값이 언제 기준인지를 밝힌다.
     */
    SigmetPayload sigmetsPayload() {
        SigmetStore.State st = sigmets.state();
        long nowMs = System.currentTimeMillis();
        SigmetPayload c = sigmetsCache.get();
        if (c != null && c.state() == st && nowMs < c.validUntilMs()) return c;
        synchronized (sigmetsBuildLock) {
            c = sigmetsCache.get();
            if (c != null && c.state() == st && nowMs < c.validUntilMs()) return c;
            Instant now = Instant.ofEpochMilli(nowMs);
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("type", "sigmets");
            m.put("v", st.version());
            m.put("fetched_at", st.fetchedAt());
            m.put("provider", st.provider());
            m.put("computed_at", now);
            m.put("collection", SigmetGeoJson.collection(st.byId().values(), now, true));
            c = new SigmetPayload(st, st.version(), toJson(m), nextSigmetBoundary(st, nowMs));
            sigmetsCache.set(c);
            return c;
        }
    }

    static long nextSigmetBoundary(SigmetStore.State st, long nowMs) {
        long next = Long.MAX_VALUE;
        for (SigmetRecord r : st.byId().values()) {
            next = earliestAfter(next, r.validFrom(), nowMs);
            if (r.validTo() != null) {
                next = earliestAfter(next, r.validTo().minusSeconds(1800), nowMs);
                next = earliestAfter(next, r.validTo(), nowMs);
            }
        }
        return next;
    }

    private static long earliestAfter(long cur, Instant t, long nowMs) {
        if (t == null) return cur;
        long ms = t.toEpochMilli();
        return ms > nowMs && ms < cur ? ms : cur;
    }

    RadarPayload radarPayload() {
        RadarStore.Frames f = radar.frames();
        RadarPayload c = radarCache.get();
        if (c != null && c.frames() == f) return c;
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("type", "radar");
        m.put("host", f.host());
        m.put("generated", f.generated());
        m.put("past", f.past());
        m.put("fetched_at", f.fetchedAt());
        m.put("provider", f.provider());
        c = new RadarPayload(f, toJson(m));
        radarCache.set(c);
        return c;
    }

    /** status 페이로드(Redis 조회 3회) — STATUS_TTL_MS 동안 모든 세션이 공유한다. 조회 실패 시 이전 값(없으면 null). */
    String statusJson() {
        long now = System.currentTimeMillis();
        StatusPayload c = statusCache;
        if (c != null && now - c.atMs() < STATUS_TTL_MS) return c.json();
        synchronized (statusLock) {
            c = statusCache;
            if (c != null && now - c.atMs() < STATUS_TTL_MS) return c.json();
            try {
                Map<String, Object> m = new LinkedHashMap<>();
                m.put("type", "status");
                m.put("status", statusSource.get());
                String j = toJson(m);
                statusCache = new StatusPayload(System.currentTimeMillis(), j);
                return j;
            } catch (RuntimeException e) {
                log.debug("ws status unavailable: {}", e.toString());
                return c == null ? null : c.json();
            }
        }
    }
}
