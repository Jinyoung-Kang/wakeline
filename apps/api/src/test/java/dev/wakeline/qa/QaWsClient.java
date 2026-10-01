package dev.wakeline.qa;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.WebSocket;
import java.time.Duration;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.TimeUnit;

/** QA 재현 시험용 WS 클라이언트(실제 Tomcat 의 /ws/v1 에 붙는다) — 받은 텍스트 메시지와 닫힘 코드를 모은다. */
final class QaWsClient implements WebSocket.Listener, AutoCloseable {
    static final HttpClient HTTP = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build();
    final List<String> messages = new CopyOnWriteArrayList<>();
    final CompletableFuture<Integer> closed = new CompletableFuture<>();
    private final StringBuilder part = new StringBuilder();
    WebSocket ws;

    static QaWsClient connect(int port, String origin) throws Exception {
        QaWsClient c = new QaWsClient();
        c.ws = HTTP.newWebSocketBuilder().header("Origin", origin).buildAsync(URI.create("ws://127.0.0.1:" + port + "/ws/v1"), c).get(5, TimeUnit.SECONDS);
        return c;
    }

    void send(String text) throws Exception {
        ws.sendText(text, true).get(5, TimeUnit.SECONDS);
    }

    /** type 이 같은 메시지가 올 때까지(또는 닫힘 · 시간 초과) 기다린다. */
    boolean await(String type, long ms) throws InterruptedException {
        long end = System.currentTimeMillis() + ms;
        while (System.currentTimeMillis() < end) {
            if (messages.stream().anyMatch(m -> m.startsWith("{\"type\":\"" + type + "\""))) return true;
            if (closed.isDone()) return false;
            Thread.sleep(20);
        }
        return false;
    }

    Integer closeCode(long ms) {
        try {
            return closed.get(ms, TimeUnit.MILLISECONDS);
        } catch (Exception e) {
            return null;
        }
    }

    @Override public CompletionStage<?> onText(WebSocket w, CharSequence data, boolean last) {
        part.append(data);
        if (last) {
            messages.add(part.toString());
            part.setLength(0);
        }
        w.request(1);
        return null;
    }

    @Override public CompletionStage<?> onClose(WebSocket w, int statusCode, String reason) {
        closed.complete(statusCode);
        return null;
    }

    @Override public void onError(WebSocket w, Throwable error) {
        closed.complete(-1);
    }

    @Override public void close() {
        try {
            if (!closed.isDone()) ws.sendClose(WebSocket.NORMAL_CLOSURE, "").get(2, TimeUnit.SECONDS);
        } catch (Exception ignored) {
            ws.abort();
        }
    }
}
