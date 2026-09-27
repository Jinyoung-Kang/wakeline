package dev.skywx.ws;

import dev.skywx.domain.AircraftState;
import dev.skywx.domain.Bbox;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;
import org.springframework.web.socket.handler.ConcurrentWebSocketSessionDecorator;

import java.io.IOException;
import java.time.Instant;
import java.util.HashMap;
import java.util.Map;

/**
 * 세션 상태: 구독(bbox·zoom·detail), 마지막으로 보낸 상태(diff 계산용), 백프레셔 플래그.
 * 전송은 ConcurrentWebSocketSessionDecorator(5 s · 256 KB)로 직렬화한다 — JSR-356 세션은 동시 전송을 허용하지 않는다.
 */
public final class WsSession {
    public static final int SEND_TIME_LIMIT_MS = 5000;
    public static final int SEND_BUFFER_LIMIT = 256 * 1024;

    final String id;
    final String ip;
    final ConcurrentWebSocketSessionDecorator out;
    volatile boolean hello;
    volatile boolean paused;
    volatile Bbox bbox;
    volatile int zoom;
    volatile String detail = "lite";
    /** 줌 ≤ 5: 저해상 인코딩(소수 2자리·필드 6개). 전세계 스냅샷은 줌과 무관하게 항상 합쳐 보낸다. */
    volatile boolean world;
    volatile String selectedHex;
    volatile boolean needsResync = true;
    volatile Instant lastFullAt = Instant.EPOCH;
    volatile long lastSentVersion;
    volatile int missedPongs;
    volatile int overflowStrikes;
    final Instant openedAt = Instant.now();
    /** 이 세션에 마지막으로 보낸 상태(hex → state). 엔진 스레드에서만 접근. */
    final Map<String, AircraftState> sent = new HashMap<>();

    WsSession(WebSocketSession raw, String ip) {
        this.id = raw.getId();
        this.ip = ip;
        this.out = new ConcurrentWebSocketSessionDecorator(raw, SEND_TIME_LIMIT_MS, SEND_BUFFER_LIMIT,
                ConcurrentWebSocketSessionDecorator.OverflowStrategy.DROP);
    }

    boolean subscribed() { return hello && bbox != null && !paused; }

    /** 백프레셔: 버퍼가 절반 넘게 찼으면 이번 diff 를 버리고 재동기 플래그. 두 번 연속이면 1008 로 종료. */
    boolean sendOrDrop(String json) {
        if (!out.isOpen()) return false;
        if (out.getBufferSize() > SEND_BUFFER_LIMIT / 2) {
            needsResync = true;
            if (++overflowStrikes >= 2) {
                close(CloseStatus.POLICY_VIOLATION.withReason("slow consumer"));
                return false;
            }
            return false;
        }
        overflowStrikes = 0;
        try {
            out.sendMessage(new TextMessage(json));
            return true;
        } catch (IOException | IllegalStateException e) {
            close(CloseStatus.SESSION_NOT_RELIABLE);
            return false;
        }
    }

    void close(CloseStatus status) {
        try { out.close(status); } catch (IOException ignored) { }
    }
}
