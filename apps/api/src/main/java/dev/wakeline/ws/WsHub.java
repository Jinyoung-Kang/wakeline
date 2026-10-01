package dev.wakeline.ws;

import dev.wakeline.aircraft.web.AircraftJson;
import dev.wakeline.platform.config.AppProperties;
import dev.wakeline.platform.config.RedisConfig;
import dev.wakeline.domain.AircraftState;
import dev.wakeline.domain.Alert;
import dev.wakeline.geo.Bbox;
import dev.wakeline.domain.SigmetRecord;
import dev.wakeline.engine.AlertStateMachine;
import dev.wakeline.engine.EngineEvents;
import dev.wakeline.engine.EngineService;
import dev.wakeline.engine.PredictionAvailability;
import dev.wakeline.ingest.IngestEvents;
import dev.wakeline.ingest.RadarStore;
import dev.wakeline.ingest.SigmetStore;
import dev.wakeline.ingest.SnapshotStore;
import dev.wakeline.weather.web.SigmetGeoJson;
import dev.wakeline.status.StatusService;
import dev.wakeline.route.RouteInfo;
import dev.wakeline.route.RouteReader;
import io.micrometer.core.instrument.Counter;
import io.micrometer.core.instrument.MeterRegistry;
import io.micrometer.core.instrument.Timer;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.SmartLifecycle;
import org.springframework.context.annotation.Profile;
import org.springframework.context.event.EventListener;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
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
 *       다시 계산해도 Redis 조회는 콜사인당 5 s 에 한 번이다. 노선 상태가 바뀌면(조회 중 → 찾음) 상태가 그대로여도 다시 보낸다.
 *       Redis 읽기는 우편함 밖(계약 v5 §G21 · ADR-025 개정 — {@link RouteLookups}): 우편함은 캐시만 보고, 읽어야 하면 조회 실행기에 맡긴 뒤 selected 를 곧바로
 *       pending("노선 조회 중" — 이 세션에 이미 보낸 같은 물음의 값이 있으면 그 값)으로 보낸다. 답이 오면(늦어도 Redis 명령 상한 3 s — 설정값, 읽지 못하면
 *       unavailable) SELECTED_ROUTE 작업이 다시 계산해 바뀌었으면 보낸다. 그동안 그 세션의 pong · diff · heartbeat 는 노선 읽기를 기다리지 않는다.
 *       select 마다 답은 하나(먼저 도는 작업이 — {@link WsSession.Selection#claimAnswer}), 그 밖에는 이 세션에 마지막으로 보낸 selected 와 글자까지 같으면 보내지
 *       않는다(사용자 보고 2026-09-30 — 같은 pending 두 번).</li>
 *   <li>수요 스코프(hot·focus, 계약 v2 §A3) 메시지는 바뀐 항공기의 이전·현재 위치를 감싸는 범위와 겹치는 세션에만 팬아웃한다 — 전체 팬아웃은
 *       region(10 s)·global 이 계속 한다. focus 관측이 오면 그 hex 를 선택한 세션의 selected 를 다시 계산한다(≈ 5 s — 캐시가 지났으면 노선도 다시 묻는다).
 *       보이는 값이 바뀌었으면 보낸다 — 같은 관측 · 보이는 값이 같은 관측은 두 번 보내지 않는다(웹 "노선 조회 중" 설명의 근거 —
 *       apps/web/tests/route-pending.test.ts 가 이 문장을 대조한다).</li>
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
    /** 알림 배치 이력(세션이 놓친 배치를 순서대로 다시 보낼 수 있는 범위). 넘으면 전체 목록. */
    static final int ALERT_BATCH_HISTORY = 64;
    /** ping 뒤 pong 이 없는 heartbeat 가 이 수를 넘으면 닫는다 — 연속 2회 무응답(설계 9.5). */
    static final int MAX_MISSED_PONGS = 2;
    /** 시험 생성자의 노선 조회 마감(바로 실행하는 실행기라 쓰이지 않는다 — 운영은 spring.data.redis.timeout). */
    static final long DIRECT_LOOKUP_DEADLINE_MS = 3_000;
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
    private final MeterRegistry meters;
    /** 우편함 작업 예외(R-73): 작업 종류별 계수기와 마지막 WARN 시각(종류별 1분에 한 번). */
    private final Map<String, Counter> taskErrors = new ConcurrentHashMap<>();
    private final Map<String, Long> taskErrorLoggedMs = new ConcurrentHashMap<>();
    static final long TASK_ERROR_LOG_INTERVAL_MS = 60_000;

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
    /** 마지막으로 직렬화한 status 메시지 — 같은 상태 맵(StatusService 의 3 s 공유 캐시 · 같은 인스턴스)이면 다시 직렬화하지 않는다. */
    private record StatusPayload(Map<String, Object> status, String json) {}
    private final Object sigmetsBuildLock = new Object();
    private final AtomicReference<SigmetPayload> sigmetsCache = new AtomicReference<>();
    private final AtomicReference<RadarPayload> radarCache = new AtomicReference<>();
    private volatile StatusPayload statusCache;

    /**
     * 운영: 노선 조회는 {@link #useRouteReader} — 답의 마감 = Redis 명령 상한. 기본 연결(RedisConfig)의 Lettuce 명령 상한 · REST 노선 기다림(RouteReader)과 같은
     * 설정 식 {@link RedisConfig#COMMAND_TIMEOUT}(spring.data.redis.timeout, 없으면 3s — 설정값) · 같은 해석. 해석할 수 없거나 0 이하면 기동하지 않는다.
     */
    @Autowired
    public WsHub(ObjectMapper json, AppProperties props, SnapshotStore snapshots, SigmetStore sigmets, RadarStore radar,
                 StatusService status, EngineService engine, MeterRegistry meters, RouteReader routes,
                 @Value(RedisConfig.COMMAND_TIMEOUT) String redisCommandTimeout) {
        this(json, props, snapshots, sigmets, radar, status::cachedPublicStatusOrNull, () -> engine.activeAlerts(null), engine::predictionAvailability,
                meters, Executors.newVirtualThreadPerTaskExecutor(),
                Executors.newSingleThreadScheduledExecutor(Thread.ofPlatform().daemon().name("ws-timer").factory()), HELLO_TIMEOUT_MS);
        useRouteReader(routes, RedisConfig.commandTimeout(redisCommandTimeout));
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
        this.routeLookups = new RouteLookups(Runnable::run, DIRECT_LOOKUP_DEADLINE_MS, meters);
        this.fragments = new AircraftJsonCache(json, meters);
        this.meters = meters;
        meters.gauge("wakeline_ws_sessions", sessions, Map::size);
        this.dropped = Counter.builder("wakeline_ws_dropped_total").description("열린 세션에 보내지 못한 메시지").register(meters);
        this.coalesced = Counter.builder("wakeline_ws_coalesced_total").description("이전 팬아웃이 대기 중이라 합친 요청").register(meters);
        this.rateLimited = Counter.builder("wakeline_ws_rate_limited_total").description("수신 rate limit 초과로 닫은 세션").register(meters);
        this.rejected = Counter.builder("wakeline_ws_rejected_total").description("연결 상한으로 거절한 연결").register(meters);
        this.fanoutTimer = Timer.builder("wakeline_ws_fanout_seconds").description("세션 하나의 팬아웃 작업 시간")
                .publishPercentiles(0.5, 0.95).register(meters);
        for (WsSession.Job j : WsSession.Job.values()) taskErrorCounter(j.name()); // 0 부터 보이게 미리 등록한다
        taskErrorCounter(WsSession.REPLY_JOB);
    }

    private Counter taskErrorCounter(String job) {
        return taskErrors.computeIfAbsent(job.toLowerCase(java.util.Locale.ROOT), tag -> Counter.builder("wakeline_ws_task_errors_total").tag("job", tag)
                .description("예외로 끝난 WS 우편함 작업(그 세션은 다음 팬아웃에서 전체 재동기)").register(meters));
    }

    /**
     * 우편함 작업 예외(R-73): 세고, 종류별로 1분에 한 번만 WARN(스택 포함) — 같은 결함이 팬아웃마다 반복돼도 로그가 넘치지 않는다.
     * 세션의 재동기 표시는 {@link WsSession} 이 이미 했다.
     */
    void taskFailed(WsSession s, String job, RuntimeException e) {
        taskErrorCounter(job).increment();
        String tag = job.toLowerCase(java.util.Locale.ROOT);
        long now = System.currentTimeMillis();
        Long last = taskErrorLoggedMs.get(tag);
        if (last == null || now - last >= TASK_ERROR_LOG_INTERVAL_MS) {
            taskErrorLoggedMs.put(tag, now);
            log.warn("ws {} task failed (session {}) — the session resyncs on its next fanout; repeats within 1 min are only counted: {}",
                    tag, s.id, e.toString(), e);
        }
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
        routeLookups.close();
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
    WsSession newSession(WebSocketSession raw, String ip) { return new WsSession(raw, ip, pool, this::taskFailed); }

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

    // ---- 등록 노선(RouteReader — 우편함 밖 조회, 계약 v5 §G21) ----
    /** 선택 항공기 노선 조회(Redis — 우편함 밖). 시험은 바로 실행하는 것을 쓰거나 바꿔 넣는다({@link #useRouteLookups}). */
    private volatile RouteLookups routeLookups;

    /**
     * 노선 조회가 답하는 물음: 선택 항공기(hex)와 그 상태의 콜사인(정규화한 값 — 조회 키). 둘 중 하나가 바뀌면(다른 항공기 선택 · 콜사인 바뀜) 진행 중인
     * 조회의 답은 쓰지 않는다(세대 확인 — {@link SelectionLookups.Pending}).
     */
    record RouteQuestion(String hex, String callsign) {}

    /** 조회 묶음을 바꾼다(운영 생성자 · 시험 — 출처는 바꾼 뒤에 넣는다). 이전 것의 실행기는 닫는다. */
    void useRouteLookups(RouteLookups l) {
        RouteLookups old = routeLookups;
        routeLookups = l;
        if (old != null) old.close();
    }

    RouteLookups routeLookups() { return routeLookups; }

    /** selected 의 route 출처(운영: {@link RouteLookups#of} — RouteReader 의 캐시 · 읽기). 테스트는 가짜를 넣는다 — null 이면 route 는 null. */
    void setRouteSource(SelectionLookups.Source<String, RouteInfo> s) { routeLookups.setSource(s); }

    /**
     * 운영 배선(운영 생성자): 노선 조회 실행기 스레드 {@value RouteLookups#THREADS}(고른 값 — 잰 값 아님) · 대기열 = WS 연결 상한 이상(세션마다 작업 하나
     * 이하 — 넘치지 않는다), 답의 마감 = Redis 명령 상한(한 번의 GET 이 서버를 기다리는 상한 — 운영 application.yml 3 s).
     */
    void useRouteReader(RouteReader routes, Duration redisCommandTimeout) {
        long deadlineMs = RouteLookups.deadlineMs(redisCommandTimeout);
        useRouteLookups(new RouteLookups(RouteLookups.boundedExecutor(RouteLookups.THREADS, SelectionLookups.queueFor(props.wsMaxConn())), deadlineMs, meters));
        setRouteSource(RouteLookups.of(routes));
    }

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

    /**
     * 클라이언트 resync scope(계약 v5 §E2): 그 목록 하나만 버전과 무관하게 전체로 다시 보낸다 — 웹이 형식 오류 · 처리 예외로 알림 · SIGMET · 레이더
     * 메시지를 버렸을 때(알림 배치는 증분이라 다음 배치로 바로잡히지 않고, SIGMET 은 버전이 바뀔 때만 온다). 항공기 · 선박은 보내지 않는다.
     * 일시정지 중이면 작업이 아무것도 보내지 않고 표시만 남는다 — resume 의 전체 초기 세트가 보낸다.
     */
    void resyncAlerts(WsSession s) {
        s.alertsForce.set(true);
        s.schedule(WsSession.Job.ALERTS, () -> runAlerts(s));
    }

    void resyncSigmets(WsSession s) {
        s.sigmetsForce.set(true);
        s.schedule(WsSession.Job.SIGMETS, () -> runSigmets(s));
    }

    void resyncRadar(WsSession s) {
        s.radarForce.set(true);
        s.schedule(WsSession.Job.RADAR, () -> runRadar(s, false));
    }

    /** 모든 구독 세션에 팬아웃(병합 뷰가 스트림 이벤트 없이 바뀌었을 때 — 예: 선택 해제로 focus 관측이 빠짐). */
    void fanoutAll() {
        for (WsSession s : sessions.values()) if (s.subscribed()) requestFanout(s);
    }

    void requestSelected(WsSession s) {
        s.schedule(WsSession.Job.SELECTED, () -> runSelected(s));
    }

    /**
     * selected 를 언제 보내는가: 늘(초기 세트의 force — resume · 재동기) · 바뀌었을 때(팬아웃 · 노선 답 · 초기 세트) · 새 관측이면(focus 관측 · select 작업 —
     * 이미 보낸 바로 그 상태 객체는 다시 보내지 않는다. select 작업은 합쳐진 focus 관측을 대신할 수 있어 이 규칙이다). select 의 답은 따로
     * ({@link WsSession.Selection#claimAnswer} — 어느 작업이든 먼저 도는 것이 한 번), 그 밖에는 이 세션에 마지막으로 보낸 selected 와 글자까지 같으면 보내지 않는다.
     */
    enum Resend { ALWAYS, CHANGED, NEW_OBSERVATION }

    // ---- 이벤트(스트림 소비·엔진 스레드 — 예약만 하고 돌아간다) ----

    /** 엔진(EngineService#onSnapshot — HIGHEST_PRECEDENCE)이 그 스냅샷의 판정 주기를 끝낸 뒤에 팬아웃 · selected 를 예약한다(명시 — 예전에는 클래스 스캔 순서였다, ListenerWiringIT). */
    @EventListener
    @Order(Ordered.LOWEST_PRECEDENCE)
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
            String sel = s.selectedHex();
            if (focus && sel != null && e.current().states().containsKey(sel)) s.schedule(WsSession.Job.SELECTED, () -> runSelectedObservation(s));
        }
    }

    /** 항공기 팬아웃이 필요한 세션인가: 항공기 레이어를 켰거나 선택 항공기가 있다(선택은 레이어와 무관한 명시적 선택). */
    static boolean wantsAircraft(WsSession s) { return s.layerAircraft || s.selection != null || s.selectedSent != null; }

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
        boolean sigmetsForced = s.sigmetsForce.getAndSet(false);
        if (sigmetsForced || s.sigmetsV != sp.version()) {
            if (!send(s, sp.json())) return;
            s.sigmetsV = sp.version();
        }
        RadarPayload rp = radarPayload();
        boolean radarForced = s.radarForce.getAndSet(false);
        if (force || radarForced || s.radarSent != rp.frames()) {
            if (!send(s, rp.json())) return;
            s.radarSent = rp.frames();
        }
        String st = statusJson();
        if (st != null && !send(s, st)) return;
        String dj = s.demandJson; // 수요 상태(계산된 적이 있으면) — resume·백프레셔 재동기 뒤에도 화면이 추적 상태를 잃지 않게
        if (dj != null && !send(s, dj)) return;
        if (s.selection != null) sendSelected(s, view.states(), force ? Resend.ALWAYS : Resend.CHANGED);
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
            if (s.selection != null || s.selectedSent != null) sendSelected(s, view.states(), Resend.CHANGED);
        } finally {
            fanoutTimer.record(Duration.ofNanos(System.nanoTime() - t0));
        }
    }

    private void runAlerts(WsSession s) {
        if (!s.ready() || !s.subscribed()) return;
        if (s.alertsForce.get()) { // 클라이언트가 목록을 잃었다(resync scope) — 배치가 아니라 전체 목록
            sendAlertsFull(s);
            return;
        }
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
        boolean forced = s.sigmetsForce.getAndSet(false);
        SigmetPayload p = sigmetsPayload();
        if (!forced && s.sigmetsV == p.version()) return;
        if (send(s, p.json())) s.sigmetsV = p.version();
    }

    private void runRadar(WsSession s, boolean force) {
        if (!s.ready() || !s.subscribed()) return;
        boolean forced = s.radarForce.getAndSet(false) || force;
        RadarPayload p = radarPayload();
        if (!forced && s.radarSent == p.frames()) return;
        if (send(s, p.json())) s.radarSent = p.frames();
    }

    /**
     * select 를 받았다: 답은 {@link WsSession.Selection#claimAnswer} 가 보장한다 — 앞선 작업(초기 세트 · 팬아웃)이 이미 답했으면 여기서는 바뀐 것만(같은 pending 을 두 번
     * 보내지 않는다 — 사용자 보고 2026-09-30). 같은 종류라 합쳐진 focus 관측을 대신할 수 있어 새 관측이면 보낸다.
     */
    private void runSelected(WsSession s) {
        if (!s.ready() || !s.hello) return;
        sendSelected(s, snapshots.merged(), Resend.NEW_OBSERVATION);
    }

    /**
     * focus 관측이 왔다(계약 v2 §A3: 집중 추적 갱신마다 selected). 이미 이 세션에 보낸 바로 그 상태 객체면(팬아웃이 먼저 보냄) 다시 보내지 않는다.
     */
    private void runSelectedObservation(WsSession s) {
        if (!s.ready() || !s.hello || s.selection == null) return;
        sendSelected(s, snapshots.merged(), Resend.NEW_OBSERVATION);
    }

    /** 노선 조회의 답이 왔거나 마감 뒤에 그 읽기가 끝났다(SELECTED_ROUTE): 다시 계산해 바뀌었으면 보낸다. 선택이 바뀌었으면 그 조회는 여기서 버려진다. */
    private void runSelectedRoute(WsSession s) {
        if (!s.ready() || !s.hello) return;
        sendSelected(s, snapshots.merged(), Resend.CHANGED);
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
        AircraftJson.Encoding enc = sub.encoding();
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
        String msg = toJson(new WsMessages.SnapshotMsg("snapshot", 1, version(view), now, AircraftJson.sources(view, now),
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
        s.alertsForce.set(false); // 이 뒤에 온 resync scope 는 다음 작업이 한 번 더 보낸다(이 목록보다 새것)
        Payload p = alertsFullPayload();
        if (!send(s, p.json())) return false;
        s.alertsV = p.version();
        return true;
    }

    /**
     * "selected": 선택 항공기의 FULL 상태(범위 밖이어도) + 예측 가능 여부 + 등록 노선. 보내는 때:
     * <ul>
     *   <li>select 의 답({@link WsSession.Selection#claimAnswer}): select 뒤 selected 를 처음 계산하는 작업이 — 어느 작업이든 — 같은 내용이어도 한 번 보낸다.
     *       hex 와 답 차례는 한 객체라 한 번 읽는다 — 새 hex 를 본 작업은 그 select 의 차례도 보고, 예전 select 를 읽은 작업은 새 select 의 차례를 가져가지
     *       못한다(리뷰 2026-09-30: 따로 쓴 두 필드 사이에 돈 작업이 같은 pending 을 한 번 더 보냈다).</li>
     *   <li>ALWAYS(초기 세트의 force — resume · 재동기): 늘.</li>
     *   <li>그 밖: 바뀌었을 때만(NEW_OBSERVATION 은 새 관측이면). 그리고 이 세션에 마지막으로 보낸 selected 와 글자까지 같으면 보내지 않는다 — 클라이언트가
     *       볼 것이 없다(사용자 보고 2026-09-30: select 가 우편함에서 초기 세트 · 팬아웃 뒤에 서면 그 작업이 먼저 pending 을 보내고 SELECTED 작업이 같은
     *       pending 을 또 보냈다. 같은 보고를 새 객체로 실어 온 focus 관측도 같다). 노선 상태(found · unavailable) · 상태 · 예측이 하나라도 바뀌면 글자가
     *       달라 그대로 나간다.</li>
     * </ul>
     */
    private void sendSelected(WsSession s, Map<String, AircraftState> states, Resend when) {
        WsSession.Selection sel = s.selection; // 한 번 읽는다 — hex 와 답 차례가 같은 select 의 것이다(WsSession.Selection)
        if (sel == null) {
            s.selectedSent = null;
            dropRouteLookup(s);
            return;
        }
        String hex = sel.hex;
        boolean force = sel.claimAnswer() | when == Resend.ALWAYS; // | — ALWAYS 로 보내도 이 select 의 답 차례를 가져간다
        AircraftState a = states.get(hex);
        PredictionAvailability p = prediction.apply(a);
        RouteInfo r = selectedRoute(s, hex, a);
        WsSession.SelectedSent prev = s.selectedSent;
        if (!force && prev != null && hex.equals(prev.hex()) && Objects.equals(prev.prediction(), p) && Objects.equals(prev.route(), r)
                && (when == Resend.NEW_OBSERVATION ? prev.state() == a && a != null : sameSelected(prev.state(), a))) return;
        String state = a == null ? null : fragments.get(a, AircraftJson.Encoding.FULL);
        String msg = toJson(new WsMessages.SelectedMsg("selected", hex, state, p, r));
        if (!force && prev != null && msg.equals(prev.json())) return; // 보이는 것이 모두 같다 — 같은 내용을 두 번 보내지 않는다
        if (send(s, msg)) s.selectedSent = new WsSession.SelectedSent(hex, a, p, r, msg);
    }

    /**
     * selected 의 route(우편함 — I/O 없음, 계약 v5 §G21). 상태가 없으면 null(콜사인을 모른다), 콜사인이 형식 밖이면 no_callsign(묻지 않는다). 캐시
     * (RouteReader — 콜사인별 5 s)에 있으면 그 값. 없으면 세션의 조회(같은 물음)의 답(읽은 값 · 마감의 unavailable), 그것도 아직이면 — 조회가 없으면 맡기고
     * (세션의 앞 조회가 끝난 뒤 읽는다) — 지금은 {@link #interimRoute} 로 답한다. 답이 오면 SELECTED_ROUTE 작업이 다시 부른다. 읽기가 끝난 조회는 내려놓는다
     * (다음 다시 계산은 캐시로, 캐시가 지나면 새로 읽는다). 물음이 바뀌면 진행 중인 조회의 답은 쓰지 않는다.
     */
    private RouteInfo selectedRoute(WsSession s, String hex, AircraftState a) {
        RouteLookups l = routeLookups;
        if (a == null || !l.enabled()) {
            dropRouteLookup(s);
            return null;
        }
        String cs = RouteReader.normalizeCallsign(a.callsign());
        if (cs == null) {
            dropRouteLookup(s);
            return RouteInfo.noCallsign();
        }
        RouteQuestion q = new RouteQuestion(hex, cs);
        SelectionLookups.Pending<RouteQuestion, RouteInfo> p = s.routeLookup;
        if (p != null && !p.question.equals(q)) { // 다른 물음 — 그 답은 쓰지 않는다(그 읽기가 끝나야 이 세션의 다음 읽기가 시작한다)
            dropRouteLookup(s);
            p = null;
        }
        RouteInfo r = l.cached(cs);                 // 캐시(I/O 없음) — 끝난 읽기의 값은 여기에 있다
        if (r == null && p != null) r = p.result;   // 이 물음의 답(읽은 값 · 마감의 unavailable)
        if (r == null) return p == null ? startRouteLookup(s, l, q) : interimRoute(s, q);
        if (p != null) {
            p.answered = true;
            if (p.settled) s.routeLookup = null;    // 읽기가 끝났다 — 다음 다시 계산은 캐시로
        }
        return r;
    }

    private RouteInfo startRouteLookup(WsSession s, RouteLookups l, RouteQuestion q) {
        SelectionLookups.Pending<RouteQuestion, RouteInfo> mine = new SelectionLookups.Pending<>(q);
        SelectionLookups.Flight<RouteInfo> f = l.load(q.callsign(), s.routeLookupTail, () -> mine.wanted(s));
        if (f.answer().isDone()) { // 바로 실행하는 실행기(시험) · 거절 — 읽기도 이미 끝났다(settled 가 답보다 먼저)
            s.routeLookupTail = null;
            return f.answer().join();
        }
        s.routeLookup = mine;
        s.routeLookupTail = f.settled();
        // 답이 오면(늦어도 마감) · 마감 뒤에 읽기가 끝나면 다시 계산한다(세션이 닫혀 예약하지 못한 답은 센다)
        mine.follow(f, s, () -> s.schedule(WsSession.Job.SELECTED_ROUTE, () -> runSelectedRoute(s)), l::dropped);
        return interimRoute(s, q);
    }

    /**
     * 답을 기다리는 동안의 route: 이 세션에 이미 보낸 같은 물음(같은 항공기 · 같은 콜사인)의 노선이면 그 값 — 캐시(5 s)가 지나 다시 읽는 중이다(화면이 보던
     * 값을 그대로 두고, 바뀌었으면 답이 올 때 보낸다 — 5 s 마다 "조회 중" 으로 깜박이지 않는다). 처음 묻는 것이면 pending("노선 조회 중" — 계약 v4 §A 의 값,
     * 이제 'api 가 수집기의 결과를 읽는 중' 도 포함한다 — §G21).
     */
    private static RouteInfo interimRoute(WsSession s, RouteQuestion q) {
        WsSession.SelectedSent prev = s.selectedSent;
        RouteInfo shown = prev == null || !q.hex().equals(prev.hex()) ? null : prev.route();
        return shown != null && q.callsign().equals(shown.callsign()) ? shown : RouteInfo.pending(q.callsign());
    }

    /** 세션의 노선 조회를 버린다(결과가 와도 쓰지 않고, 아직 올리지 않은 읽기는 하지 않는다). 답을 보내지 않은 조회만 센다. */
    private void dropRouteLookup(WsSession s) {
        SelectionLookups.Pending<RouteQuestion, RouteInfo> p = s.routeLookup;
        if (p == null) return;
        s.routeLookup = null;
        p.supersede(routeLookups::dropped);
    }

    /** 새 보고(seen_at)나 표시 값 변화가 없으면 같은 것으로 본다. */
    static boolean sameSelected(AircraftState x, AircraftState y) {
        if (x == y) return true;
        if (x == null || y == null) return false;
        return !DiffCalculator.changed(x, y) && Objects.equals(x.seenAt(), y.seenAt());
    }

    private String jsonArray(List<AircraftState> list, AircraftJson.Encoding enc) {
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

    /**
     * status 메시지 — 상태 맵은 StatusService 의 3 s 공유 캐시(REST /status 와 같은 값, R-53)에서 오고, 같은 맵이면 직렬화한 String 을 모든 세션이
     * 나눠 쓴다. 조회 실패 시 이전 값(없으면 null).
     */
    String statusJson() {
        StatusPayload c = statusCache;
        try {
            Map<String, Object> st = statusSource.get();
            if (st == null) return c == null ? null : c.json();
            if (c != null && c.status() == st) return c.json();
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("type", "status");
            m.put("status", st);
            StatusPayload fresh = new StatusPayload(st, toJson(m));
            statusCache = fresh;
            return fresh.json();
        } catch (RuntimeException e) {
            log.debug("ws status unavailable: {}", e.toString());
            return c == null ? null : c.json();
        }
    }
}
