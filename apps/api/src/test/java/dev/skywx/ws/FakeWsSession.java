package dev.skywx.ws;

import org.springframework.http.HttpHeaders;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketExtension;
import org.springframework.web.socket.WebSocketMessage;
import org.springframework.web.socket.WebSocketSession;

import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.URI;
import java.security.Principal;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

/** 테스트용 WebSocketSession: 보낸 텍스트를 기록하고, gate 가 있으면 전송을 막아 '읽지 않는 클라이언트' 를 흉내 낸다. */
final class FakeWsSession implements WebSocketSession {
    private final String id;
    private final Map<String, Object> attributes = new ConcurrentHashMap<>();
    final List<String> sent = new CopyOnWriteArrayList<>();
    volatile boolean open = true;
    volatile CloseStatus closedWith;
    volatile CountDownLatch gate;
    final AtomicInteger concurrentSends = new AtomicInteger();
    volatile int maxConcurrentSends;
    volatile int textLimit;

    FakeWsSession(String id, String ip) {
        this.id = id;
        attributes.put(SkyWsHandler.ATTR_IP, ip);
    }

    @Override public String getId() { return id; }
    @Override public URI getUri() { return URI.create("ws://localhost/ws/v1"); }
    @Override public HttpHeaders getHandshakeHeaders() { return new HttpHeaders(); }
    @Override public Map<String, Object> getAttributes() { return attributes; }
    @Override public Principal getPrincipal() { return null; }
    @Override public InetSocketAddress getLocalAddress() { return null; }
    @Override public InetSocketAddress getRemoteAddress() { return null; }
    @Override public String getAcceptedProtocol() { return null; }
    @Override public void setTextMessageSizeLimit(int messageSizeLimit) { textLimit = messageSizeLimit; }
    @Override public int getTextMessageSizeLimit() { return textLimit; }
    @Override public void setBinaryMessageSizeLimit(int messageSizeLimit) { }
    @Override public int getBinaryMessageSizeLimit() { return 0; }
    @Override public List<WebSocketExtension> getExtensions() { return List.of(); }

    @Override
    public void sendMessage(WebSocketMessage<?> message) throws IOException {
        if (!open) throw new IOException("closed");
        int c = concurrentSends.incrementAndGet();
        maxConcurrentSends = Math.max(maxConcurrentSends, c);
        try {
            CountDownLatch g = gate;
            if (g != null) {
                try {
                    if (!g.await(10, TimeUnit.SECONDS)) throw new IOException("send timeout");
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    throw new IOException("interrupted");
                }
            }
            sent.add(((TextMessage) message).getPayload());
        } finally {
            concurrentSends.decrementAndGet();
        }
    }

    @Override public boolean isOpen() { return open; }
    @Override public void close() { close(CloseStatus.NORMAL); }
    @Override public void close(CloseStatus status) {
        if (closedWith == null) closedWith = status;
        open = false;
    }

    /** 지금까지 보낸 메시지 중 type 이 같은 것(원문) */
    List<String> ofType(String type) {
        List<String> out = new ArrayList<>();
        for (String s : sent) if (s.startsWith("{\"type\":\"" + type + "\"")) out.add(s);
        return out;
    }

    void clear() { sent.clear(); }
}
