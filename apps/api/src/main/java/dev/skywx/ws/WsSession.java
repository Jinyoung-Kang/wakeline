package dev.skywx.ws;

import dev.skywx.domain.AircraftState;
import dev.skywx.domain.Bbox;
import dev.skywx.engine.PredictionAvailability;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;

import java.io.IOException;
import java.time.Instant;
import java.util.HashMap;
import java.util.Map;
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

    enum Job { INITIAL, FANOUT, ALERTS, SIGMETS, RADAR, HEARTBEAT, SELECTED }

    /** 구독 한 벌(bbox·줌·상세도)을 한 번에 바꾼다 — 필드별로 따로 읽어 섞이는 일이 없게. */
    record Sub(Bbox bbox, int zoom, String detail) {
        /** 줌 ≤ 5: world 인코딩·120 s 재동기 */
        boolean world() { return zoom <= 5; }
        WsMessages.Encoding encoding() { return WsMessages.encodingFor(detail, world()); }
    }

    /** 마지막으로 보낸 "selected" — 바뀐 경우에만 다시 보낸다. */
    record SelectedSent(String hex, AircraftState state, PredictionAvailability prediction) {}

    final String id;
    final String ip;
    private final WebSocketSession raw;
    private final SerialOutbox outbox;
    private final AtomicBoolean[] scheduled = new AtomicBoolean[Job.values().length];
    final TokenBucket inbound;
    final Instant openedAt = Instant.now();
    private final AtomicBoolean closing = new AtomicBoolean();

    // ---- 수신 쪽(핸들러·허브 이벤트 스레드) ----
    volatile boolean hello;
    volatile boolean paused;
    volatile Sub sub;
    volatile String selectedHex;
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

    WsSession(WebSocketSession raw, String ip, Executor executor) {
        this.id = raw.getId();
        this.ip = ip;
        this.raw = raw;
        this.outbox = new SerialOutbox(executor);
        this.inbound = new TokenBucket(RATE_MAX, TimeUnit.SECONDS.toNanos(RATE_WINDOW_S), System.nanoTime());
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
        if (!outbox.offer(() -> { f.set(false); task.run(); })) { f.set(false); return false; }
        return true;
    }

    boolean isScheduled(Job job) { return scheduled[job.ordinal()].get(); }

    /** 제어 응답(welcome·pong·error) — 개수는 수신 rate limit 이 묶는다. */
    boolean post(Runnable task) { return outbox.offer(task); }

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
