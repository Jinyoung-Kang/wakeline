package dev.wakeline.ws;

import dev.wakeline.domain.AircraftState;
import dev.wakeline.domain.Bbox;
import dev.wakeline.domain.ShipStatic;
import dev.wakeline.engine.PredictionAvailability;
import dev.wakeline.ingest.ShipStore;
import dev.wakeline.portcalls.PortCallsInfo;
import dev.wakeline.route.RouteInfo;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;

import java.io.IOException;
import java.time.Instant;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.Executor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * 세션 상태.
 * - 수신(핸들러) 쪽: hello·구독(sub)·일시정지·선택 hex·rate limit — volatile.
 * - 전송 쪽: 모든 전송과 '이 세션에 무엇을 보냈는가'(sent·seq·알림/SIGMET 버전 …)는 세션 우편함(SerialOutbox) 안에서만 다룬다.
 *   우편함은 한 번에 하나만 실행하므로 이 필드들은 잠금 없이 일관되고, 전송도 항상 한 스레드뿐이다(JSR-356 세션은 동시 전송 불가).
 * - 작업 종류별 단일 비행(Job): 같은 종류가 이미 대기 중이면 또 넣지 않는다. 작업은 실행 시점의 최신 상태로 계산하므로
 *   건너뛴 이벤트가 사라지지 않는다(diff 는 '마지막으로 보낸 상태' 기준). 느린 세션도 대기열이 종류 수 이상 자라지 않는다.
 */
public final class WsSession {
    /** 블로킹 전송 한도(설계 5.1). Tomcat 세션 속성으로 걸어 한 번의 전송이 이보다 오래 막히면 IOException → 연결 종료. */
    public static final int SEND_TIME_LIMIT_MS = 5000;
    /** 클라이언트 메시지 한도: RATE_WINDOW 동안 RATE_MAX 개(계약 §1). */
    public static final int RATE_MAX = 20;
    public static final int RATE_WINDOW_S = 10;

    enum Job { INITIAL, FANOUT, ALERTS, SIGMETS, RADAR, HEARTBEAT, SELECTED, DEMAND, SHIPS, SHIP_SELECTED }

    /** 이 세션에 마지막으로 보낸 선박 표현: 없음 · 개별 선박(ships_snapshot/diff) · 격자(ships_grid, 줌 또는 선박 수 때문). */
    enum ShipsMode { OFF, POINTS, GRID }

    /** 마지막으로 보낸 ship_selected(선박이 같은 객체이고 정적 정보 · 그 출처 · 입출항이 같은 값이면 다시 보내지 않는다). */
    record ShipSelectedSent(String mmsi, ShipStore.Ship ship, ShipStatic stat, String staticSource, PortCallsInfo portCalls) {}

    /** 구독 한 벌(bbox·줌·상세도)을 한 번에 바꾼다 — 필드별로 따로 읽어 섞이는 일이 없게. */
    record Sub(Bbox bbox, int zoom, String detail) {
        /** 줌 ≤ 5: world 인코딩·120 s 재동기 */
        boolean world() { return zoom <= 5; }
        WsMessages.Encoding encoding() { return WsMessages.encodingFor(detail, world()); }
    }

    /** 마지막으로 보낸 "selected" — 바뀐 경우에만 다시 보낸다(노선 상태가 바뀌어도 — 예: 조회 중 → 찾음). */
    record SelectedSent(String hex, AircraftState state, PredictionAvailability prediction, RouteInfo route) {}

    final String id;
    final String ip;
    private final WebSocketSession raw;
    private final SerialOutbox outbox;
    private final AtomicBoolean[] scheduled = new AtomicBoolean[Job.values().length];
    final SlidingWindowLimiter inbound;
    final Instant openedAt = Instant.now();
    private final AtomicBoolean closing = new AtomicBoolean();

    // ---- 수신 쪽(핸들러·허브 이벤트 스레드) ----
    volatile boolean hello;
    volatile boolean paused;
    volatile Sub sub;
    volatile String selectedHex;
    /**
     * 이 hex 를 (다시) 선택한 시각(epoch ms) — 집중 추적 30분 상한과 demand.focus.since 의 기준(ADR-013). 같은 hex 를 다시 선택해도
     * 새로 시작한다("다시 선택하면 이어진다"). 핸들러는 이 값을 먼저 쓰고 selectedHex 를 쓴다(수요 스레드가 hex 를 읽은 뒤 이 값을 읽으면
     * 적어도 그 선택의 시각을 본다).
     */
    volatile long selectedAtMs;
    /** 치명적 프로토콜 오류로 닫는 중 — 이후 수신 메시지는 무시한다. */
    volatile boolean inboundBlocked;
    /** 답 없는 ping 수(heartbeat 가 올리고 pong 이 0 으로) */
    final AtomicInteger missedPongs = new AtomicInteger();
    /** 다음 팬아웃에서 항공기 전체 스냅샷(seq=1)을 보낸다. */
    volatile boolean needsResync = true;
    /** 다음 팬아웃에서 전체 초기 세트(스냅샷·알림·SIGMET·레이더·status)를 보낸다 — 백프레셔로 메시지를 잃었을 때. */
    final AtomicBoolean stateResync = new AtomicBoolean();
    /** 다음 초기 전송을 강제(알림·레이더를 버전과 무관하게) — resume·백프레셔 재동기. */
    final AtomicBoolean initialForce = new AtomicBoolean();
    /**
     * 켜진 레이어(계약 v2 §B3 {type:"layers"}). 기본: 항공기 켬 · 선박 끔. 항공기를 끈 세션에는 항공기 snapshot/diff 를 보내지 않고 핫 리전 수요도
     * 내지 않는다(선택 항공기의 selected·집중 추적은 명시적 선택이라 그대로). 선박은 켠 세션에만 보낸다.
     */
    volatile boolean layerAircraft = true;
    volatile boolean layerShips;
    /** 선택 선박 MMSI(9자리) 또는 null. */
    volatile String selectedMmsi;
    /** 다음 선박 작업은 버전과 무관하게 전체(스냅샷·격자)를 보낸다 — 구독·레이어·resync·resume·백프레셔. */
    final AtomicBoolean shipsForce = new AtomicBoolean();
    /** 다음 ship_selected 는 바뀌지 않았어도 보낸다 — select_ship·resume. */
    final AtomicBoolean shipSelectedForce = new AtomicBoolean();
    /**
     * 다음 알림 · SIGMET · 레이더 작업은 버전과 무관하게 전체 목록을 보낸다 — 클라이언트 {type:"resync", scope}(계약 v5 §E2: 웹이 형식 오류 ·
     * 처리 예외로 그 메시지를 버렸다). 핸들러가 올리고 우편함이 보낼 때 내린다.
     */
    final AtomicBoolean alertsForce = new AtomicBoolean();
    final AtomicBoolean sigmetsForce = new AtomicBoolean();
    final AtomicBoolean radarForce = new AtomicBoolean();

    // ---- 수요(DemandService 스레드가 쓴다) ----
    /** 이 세션의 최신 demand 메시지(JSON) — 우편함의 DEMAND 작업·초기 세트가 보낸다. 아직 계산 전이면 null. */
    volatile String demandJson;
    /** 수요 스레드 전용: 마지막으로 전송을 예약한 demand JSON 과 그 시각(바뀌었거나 30 s 가 지나면 다시 보낸다). */
    String demandQueuedJson;
    long demandQueuedAtMs;
    /** 수요 스레드 전용: 이 세션이 지금 임대에 올린 수요(직전 임대, 없으면 null) — 새 키가 세션 제한에 걸리면 이것을 유지한다(계약 v3 §C). */
    DemandService.Held demandHeld;
    /** 수요 스레드 전용: 새로 올린 집중 추적 hex · 핫 셀(각각 60 s 창에 6개까지). */
    final SlidingWindowLimiter newFocusKeys = new SlidingWindowLimiter(DemandService.SESSION_NEW_KEYS_MAX,
            TimeUnit.MILLISECONDS.toNanos(DemandService.SESSION_NEW_KEYS_WINDOW_MS));
    final SlidingWindowLimiter newHotKeys = new SlidingWindowLimiter(DemandService.SESSION_NEW_KEYS_MAX,
            TimeUnit.MILLISECONDS.toNanos(DemandService.SESSION_NEW_KEYS_WINDOW_MS));

    // ---- 전송 쪽(우편함 안에서만) ----
    /** 이 세션에 마지막으로 보낸 상태(hex → state). diff 기준. */
    final Map<String, AircraftState> sent = new HashMap<>();
    /** 마지막으로 보낸 snapshot/diff 의 seq(스냅샷 = 1). 0 = 아직 스냅샷 없음. */
    int seq;
    Instant lastFullAt = Instant.EPOCH;
    /** 이 세션이 반영한 알림 버전(-1 = 전체 목록을 아직 못 받음). */
    long alertsV = -1;
    /** 이 세션이 받은 SIGMET 목록 버전(-1 = 없음). */
    long sigmetsV = -1;
    /** 이 세션이 받은 레이더 프레임 목록(동일성 비교). */
    Object radarSent;
    SelectedSent selectedSent;
    // ---- 선박 전송 상태(우편함 안에서만) ----
    ShipsMode shipsMode = ShipsMode.OFF;
    /** 마지막으로 보낸 선박(mmsi → 보낸 객체). ships_diff 기준. */
    final Map<String, ShipStore.Ship> shipsSent = new HashMap<>();
    /** 마지막으로 보낸 ships_snapshot/diff 의 sseq(스냅샷 = 1). 0 = 아직 스냅샷 없음. */
    int sseq;
    long shipsLastFullMs;
    /** 마지막으로 보낸 선박 목록의 ShipStore 버전(같으면 diff 를 계산하지 않는다). */
    long shipsSentVersion = -1;
    /** 마지막으로 보낸 격자의 키(버전·칸 크기·bbox·capped) — 같으면 다시 보내지 않는다. */
    String shipsGridKey;
    /** 마지막 격자가 선박 수 때문이었다(capped) — 줌 4~6 에서 1,200 척 이하가 되어야 개별로 돌아온다(계약 v4 §C). */
    boolean shipsDense;
    ShipSelectedSent shipSelectedSent;
    /**
     * 선택 선박 조회(우편함 밖 — 계약 v5 §G18, ShipFanout). 이 객체가 지금 세대다 — 결과가 와도 이 객체이고 물음이 같을 때만 쓴다. 답이 와도 그 읽기가
     * 끝날 때까지 남는다(같은 물음은 새 읽기를 올리지 않는다). null = 없음.
     */
    ShipFanout.PendingLookup shipLookup;
    /** 이 세션의 마지막 조회의 읽기가 끝남(ShipLookups.Flight.settled) — 다음 조회의 읽기는 이것 뒤에 시작한다(세션마다 조회 실행기 작업 하나 이하). */
    CompletableFuture<Void> shipLookupTail;
    /** 다음 ship_selected 는 바뀌지 않았어도 보낸다 — shipSelectedForce(select_ship · resume)를 조회가 끝날 때까지 들고 있는다. */
    boolean shipSelectedForcePending;

    /** 우편함 작업 실패 알림(R-73) — 허브가 wakeline_ws_task_errors_total{job} 로 세고 1분에 한 번 WARN 을 남긴다. */
    @FunctionalInterface
    interface TaskErrors {
        void failed(WsSession s, String job, RuntimeException e);
    }

    /** 제어 응답(welcome·pong·error) 작업의 지표 이름. */
    static final String REPLY_JOB = "REPLY";

    private final TaskErrors taskErrors;

    WsSession(WebSocketSession raw, String ip, Executor executor, TaskErrors taskErrors) {
        this.id = raw.getId();
        this.ip = ip;
        this.raw = raw;
        this.taskErrors = taskErrors;
        this.outbox = new SerialOutbox(executor);
        this.inbound = new SlidingWindowLimiter(RATE_MAX, TimeUnit.SECONDS.toNanos(RATE_WINDOW_S));
        for (int i = 0; i < scheduled.length; i++) scheduled[i] = new AtomicBoolean();
    }

    /** 초기 세트·팬아웃·알림 등을 받을 상태인가(일시정지면 아님). */
    boolean subscribed() { return hello && sub != null && !paused && !closing.get(); }

    /** 전송 가능한가(닫는 중이 아니고 소켓이 열려 있음) — 직렬화 전에 확인한다(SEC-2). */
    boolean ready() { return !closing.get() && raw.isOpen(); }

    boolean isClosing() { return closing.get(); }

    /**
     * 종류별 단일 비행 예약. 같은 종류가 이미 대기 중이면 합친다(false). 대기 플래그는 작업 시작 때 내려서,
     * 실행 중에 들어온 요청은 하나 더 예약된다(최대 실행 1 + 대기 1).
     */
    boolean schedule(Job job, Runnable task) {
        AtomicBoolean f = scheduled[job.ordinal()];
        if (!f.compareAndSet(false, true)) return false;
        if (!outbox.offer(() -> { f.set(false); guarded(job.name(), task); })) { f.set(false); return false; }
        return true;
    }

    boolean isScheduled(Job job) { return scheduled[job.ordinal()].get(); }

    /** 제어 응답(welcome·pong·error) — 개수는 수신 rate limit 이 묶는다. */
    boolean post(Runnable task) { return outbox.offer(() -> guarded(REPLY_JOB, task)); }

    /**
     * 우편함 작업 실행(R-73). 예외면 이 세션의 전송 상태(sent·seq·버전)가 클라이언트가 실제로 받은 것보다 앞서 있을 수 있다 — 예: diff 계산이
     * sent 를 바꾼 뒤 직렬화·예측·노선 조회가 실패. 그래서 다음 팬아웃은 전체 초기 세트(스냅샷 seq 1·알림·레이더·status·선박)로, 항공기를 끈
     * 세션은 다음 선박 작업이 전체 선박으로 되돌리게 표시하고, 허브에 알려 센다. 여기서 곧바로 다시 예약하지 않는다(같은 결함이면 무한 반복).
     * 우편함은 다음 작업을 계속 처리한다.
     */
    private void guarded(String job, Runnable task) {
        try {
            task.run();
        } catch (RuntimeException e) {
            needsResync = true;
            stateResync.set(true);
            shipsForce.set(true);
            taskErrors.failed(this, job, e);
        }
    }

    /** 테스트용: 원본 세션 */
    WebSocketSession raw() { return raw; }

    /** 우편함이 비었고 실행 중인 작업도 없는가(테스트용) */
    boolean idle() { return !outbox.busy(); }

    /**
     * 즉시 전송(우편함 작업 안에서만 부른다). 실패하면 연결을 닫는다 — Tomcat 블로킹 전송 시간 초과(5 s)는 IOException 으로 온다.
     * @return 보냈으면 true
     */
    boolean sendNow(String json) {
        if (!ready()) return false;
        try {
            raw.sendMessage(new TextMessage(json));
            return true;
        } catch (IOException | IllegalStateException e) {
            closeNow(CloseStatus.SESSION_NOT_RELIABLE);
            return false;
        } catch (RuntimeException e) { // 세션 한도 초과 등 — 조용히 삼키지 않고 닫는다(REL-2)
            closeNow(CloseStatus.POLICY_VIOLATION.withReason("slow consumer"));
            return false;
        }
    }

    /** 닫기를 시작한다. 처음 부른 쪽만 true — 이후 우편함 작업은 아무것도 보내지 않는다. */
    boolean beginClose() {
        if (!closing.compareAndSet(false, true)) return false;
        outbox.close();
        return true;
    }

    /** 닫기(블로킹 가능 — 우편함 또는 가상 스레드에서 부른다). */
    void closeNow(CloseStatus status) {
        beginClose();
        try { raw.close(status); } catch (IOException | RuntimeException ignored) { }
    }

    /** 연결이 이미 닫혔다(afterConnectionClosed) — 대기 작업을 버린다. */
    void markClosed() { beginClose(); }
}
