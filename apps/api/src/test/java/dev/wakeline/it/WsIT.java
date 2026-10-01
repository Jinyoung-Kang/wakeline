package dev.wakeline.it;

import dev.wakeline.aircraft.core.SnapshotStore;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIf;
import org.springframework.beans.factory.annotation.Autowired;
import tools.jackson.databind.JsonNode;

import java.net.URI;
import java.net.http.WebSocket;
import java.net.http.WebSocketHandshakeException;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * WebSocket 프로토콜 v1(계약 §1)을 전체 앱으로: 허용되지 않은 Origin → 핸드셰이크 403, hello 5 s 제한(1002),
 * subscribe → snapshot(seq=1) → 스트림 갱신마다 diff(seq 가 1씩 — 틈 없음), 제거, select → selected, 메시지 폭주 → 1008.
 * 스냅샷은 실제 Redis 스트림 발행(XADD) → 소비 → 이벤트 → 팬아웃 경로로 만든다.
 * 받은 메시지는 모두 schemas/ws/server.v1.json(계약 v5 §E1)으로 검증한다 — 운영 설정의 매퍼 · 실제 소켓으로 보낸 그대로.
 */
@EnabledIf("dev.wakeline.DbTestSupport#dockerAvailable")
class WsIT extends IntegrationTest {
    @Autowired SnapshotStore snapshots;
    @Autowired dev.wakeline.weather.core.SigmetStore sigmetStore;

    static final class Client implements WebSocket.Listener {
        final LinkedBlockingQueue<JsonNode> messages = new LinkedBlockingQueue<>();
        final CompletableFuture<Integer> closed = new CompletableFuture<>();
        final CompletableFuture<String> closeReason = new CompletableFuture<>();
        /** 계약 v5 §E1: 받은 메시지 중 schemas/ws/server.v1.json 을 만족하지 않은 것(type → 위반). */
        final List<String> schemaViolations = new CopyOnWriteArrayList<>();
        private final StringBuilder buf = new StringBuilder();
        WebSocket ws;

        @Override public CompletionStage<?> onText(WebSocket w, CharSequence data, boolean last) {
            buf.append(data);
            if (last) {
                String text = buf.toString();
                buf.setLength(0);
                JsonNode n = Streams.JSON.readTree(text);
                List<String> v = dev.wakeline.ws.WsSchemas.server(text);
                if (!v.isEmpty()) schemaViolations.add(n.path("type").asString() + " → " + v);
                messages.add(n);
            }
            w.request(1);
            return null;
        }

        @Override public CompletionStage<?> onClose(WebSocket w, int statusCode, String reason) {
            closed.complete(statusCode);
            closeReason.complete(reason);
            return null;
        }

        void send(String json) throws Exception { ws.sendText(json, true).get(5, TimeUnit.SECONDS); }

        /** 다음 type 메시지(그 사이의 다른 type 은 버린다). */
        JsonNode next(String type) throws InterruptedException { return next(type, Duration.ofSeconds(10)); }

        JsonNode next(String type, Duration timeout) throws InterruptedException {
            long end = System.nanoTime() + timeout.toNanos();
            java.util.Map<String, Integer> skipped = new java.util.TreeMap<>(); // 실패하면 그사이 무엇이 왔는지 보인다(예: diff 대신 snapshot · grid)
            while (System.nanoTime() < end) {
                JsonNode n = messages.poll(50, TimeUnit.MILLISECONDS);
                if (n == null) continue;
                if (type.equals(n.path("type").asString())) return n;
                skipped.merge(n.path("type").asString(), 1, Integer::sum);
            }
            throw new AssertionError("no '" + type + "' message within " + timeout + " — skipped meanwhile: " + skipped);
        }

        /** snapshot·diff 만 순서대로(시간 안에 온 것 전부). */
        List<JsonNode> aircraftMessages(Duration window) throws InterruptedException {
            List<JsonNode> out = new ArrayList<>();
            long end = System.nanoTime() + window.toNanos();
            while (System.nanoTime() < end) {
                JsonNode n = messages.poll(50, TimeUnit.MILLISECONDS);
                if (n == null) continue;
                String t = n.path("type").asString();
                if ("snapshot".equals(t) || "diff".equals(t)) out.add(n);
            }
            return out;
        }

        void close() {
            try { ws.sendClose(WebSocket.NORMAL_CLOSURE, "bye").get(5, TimeUnit.SECONDS); } catch (Exception e) { ws.abort(); }
        }
    }

    final List<Client> opened = new CopyOnWriteArrayList<>();

    /** 이 시험이 연 모든 연결이 받은 메시지는 WS 스키마를 만족해야 한다. */
    @AfterEach
    void everyReceivedMessageMatchesTheWsSchema() {
        for (Client c : opened) assertThat(c.schemaViolations).as("messages violating schemas/ws/server.v1.json").isEmpty();
    }

    Client open(String origin) throws Exception {
        Client c = new Client();
        opened.add(c);
        WebSocket.Builder b = HTTP.newWebSocketBuilder();
        if (origin != null) b.header("Origin", origin);
        c.ws = b.buildAsync(URI.create("ws://127.0.0.1:" + port + "/ws/v1"), c).get(5, TimeUnit.SECONDS);
        return c;
    }

    /** 관심 지역 스냅샷 1건 발행(수집기처럼) 후 적용될 때까지 기다린다. */
    Instant publishRegion(List<java.util.Map<String, Object>> states) {
        Instant f = Streams.nextFetchedAt();
        java.util.List<java.util.Map<String, Object>> withFetched = new ArrayList<>();
        for (var s : states) { var m = new java.util.LinkedHashMap<>(s); m.put("fetched_at", f.toString()); withFetched.add(m); }
        Streams.xadd(Streams.AIRCRAFT, Streams.aircraft("region", f, withFetched));
        await("region snapshot " + f, Duration.ofSeconds(10), () -> snapshots.region().fetchedAt().equals(f));
        return f;
    }

    @Test
    void foreignOriginIsRejectedAtTheHandshake() {
        assertThatThrownBy(() -> open("http://rebind.attacker.example:8700"))
                .isInstanceOf(ExecutionException.class)
                .cause().isInstanceOf(WebSocketHandshakeException.class)
                .satisfies(e -> assertThat(((WebSocketHandshakeException) e).getResponse().statusCode()).isEqualTo(403));
        // Host 와 같은 Origin 도 목록에 없으면 거절(DNS rebinding — Spring 의 same-origin 예외를 쓰지 않는다)
        assertThatThrownBy(() -> open("http://127.0.0.1:" + port)).isInstanceOf(ExecutionException.class);
    }

    @Test
    void helloMustArriveWithinFiveSeconds() throws Exception {
        long t0 = System.nanoTime();
        Client c = open(ORIGIN);
        int code = c.closed.get(10, TimeUnit.SECONDS);
        long ms = (System.nanoTime() - t0) / 1_000_000;
        assertThat(code).isEqualTo(1002);
        assertThat(c.closeReason.get()).isEqualTo("hello timeout");
        assertThat(ms).as("closed after ~5 s").isBetween(4_500L, 8_000L);
    }

    @Test
    void subscribeGetsSnapshotSeq1ThenContiguousDiffsForEachStreamUpdate() throws Exception {
        String hex = "a1c001";
        // SIGMET 세트(판정 제외 1건 포함 — 먼 곳이라 이 테스트의 항공기와 무관)
        Instant fs = Streams.nextFetchedAt();
        var excluded = Streams.sigmet("RKRR:IT-WS-X:" + fs.toEpochMilli(), 0, 0, 1, 1, 0, 30000, fs);
        excluded.put("geometry", null);
        excluded.put("excluded_reason", "no_coordinates");
        Streams.xadd(Streams.SIGMET, Streams.sigmets(fs, List.of(Streams.sigmet("RKRR:IT-WS:" + fs.toEpochMilli(), 100, 10, 101, 11, 0, 30000, fs), excluded)));
        await("sigmets", Duration.ofSeconds(10), () -> sigmetStore.state().fetchedAt().equals(fs));
        Instant seen = Instant.now().minusSeconds(1);
        publishRegion(List.of(Streams.state(hex, 35.50, 129.00, 31000, seen, seen)));

        Client c = open(ORIGIN);
        try {
            c.send("{\"type\":\"hello\",\"proto\":1}");
            JsonNode welcome = c.next("welcome");
            assertThat(welcome.path("limits").path("hello_timeout_s").asInt()).isEqualTo(5);
            assertThat(welcome.path("limits").path("max_client_messages").asInt()).isEqualTo(20);
            c.send("{\"type\":\"subscribe\",\"bbox\":[124,33,132,39],\"zoom\":7}");
            JsonNode snap = c.next("snapshot");
            assertThat(snap.path("seq").asInt()).isEqualTo(1);
            assertThat(snap.path("sources").path("region").path("provider").asString()).isEqualTo("fixture");
            assertThat(snap.path("sources").has("global")).isTrue();
            JsonNode mine = null;
            for (JsonNode a : snap.path("aircraft")) if (hex.equals(a.path("hex").asString())) mine = a;
            assertThat(mine).as("aircraft in the snapshot").isNotNull();
            assertThat(Instant.parse(mine.path("seen_at").asString())).isEqualTo(seen);
            assertThat(mine.has("estimated")).isFalse();
            assertThat(c.next("alerts").has("version")).isTrue();
            JsonNode sg = c.next("sigmets");
            assertThat(sg.path("collection").path("features").size()).isEqualTo(2);
            for (JsonNode f : sg.path("collection").path("features"))
                assertThat(f.has("geometry")).as("RFC 7946: geometry member present (null when excluded)").isTrue();

            // 3번 이동 → diff 3개, 그다음 사라짐 → remove
            for (int i = 1; i <= 3; i++) {
                Instant s = Instant.now().minusMillis(500);
                publishRegion(List.of(Streams.state(hex, 35.50 + 0.05 * i, 129.00, 31000, s, s)));
            }
            publishRegion(List.of(Streams.state("a1c0ff", 34.0, 126.0, 20000, Instant.now(), Instant.now())));

            List<JsonNode> msgs = c.aircraftMessages(Duration.ofSeconds(3));
            int lastSeq = 1;
            int diffsWithHex = 0;
            boolean removed = false;
            for (JsonNode m : msgs) {
                if ("snapshot".equals(m.path("type").asString())) { assertThat(m.path("seq").asInt()).isEqualTo(1); lastSeq = 1; continue; }
                assertThat(m.path("seq").asInt()).as("diff seq contiguous").isEqualTo(lastSeq + 1);
                lastSeq = m.path("seq").asInt();
                assertThat(m.path("upsert").size() + m.path("remove").size()).as("no empty diffs").isPositive();
                for (JsonNode u : m.path("upsert")) if (hex.equals(u.path("hex").asString())) diffsWithHex++;
                for (JsonNode r : m.path("remove")) if (hex.equals(r.asString())) removed = true;
            }
            assertThat(diffsWithHex).as("one upsert per movement").isEqualTo(3);
            assertThat(removed).as("aircraft gone from the merged snapshot is removed").isTrue();
            assertThat(lastSeq).isGreaterThanOrEqualTo(5);

            // 클라이언트 resync → 바로 새 스냅샷(seq 1 부터 다시)
            c.send("{\"type\":\"resync\"}");
            assertThat(c.next("snapshot").path("seq").asInt()).isEqualTo(1);

            // select → selected(full 인코딩 + 예측 가능 여부)
            c.send("{\"type\":\"select\",\"hex\":\"a1c0ff\"}");
            JsonNode sel = c.next("selected");
            assertThat(sel.path("hex").asString()).isEqualTo("a1c0ff");
            assertThat(sel.path("state").path("registration").asString()).isEqualTo("HL0FF");
            assertThat(sel.path("prediction").has("available")).isTrue();
        } finally {
            c.close();
        }
    }

    @Test
    void clientMessageFloodClosesWith1008RateLimit() throws Exception {
        Client c = open("http://127.0.0.1:8700");
        c.send("{\"type\":\"hello\",\"proto\":1}");
        c.next("welcome");
        for (int i = 0; i < 30 && !c.closed.isDone(); i++) {
            try { c.send("{\"type\":\"pong\"}"); } catch (ExecutionException e) { break; }
        }
        assertThat(c.closed.get(5, TimeUnit.SECONDS)).isEqualTo(1008);
        assertThat(c.closeReason.get()).isEqualTo("rate limit");
    }

    @Test
    void firstMessageMustBeHello() throws Exception {
        Client c = open(ORIGIN);
        c.send("{\"type\":\"subscribe\",\"bbox\":[124,33,132,39],\"zoom\":7}");
        assertThat(c.closed.get(5, TimeUnit.SECONDS)).isEqualTo(1002);
    }

    /**
     * 특성 시험(리뷰 cto-2026-10 api §5.4-5): REST /api/v1/status(meta 제외)와 WS status 메시지의 status 는 같은 맵이다 — 둘 다 같은 3 s 캐시(R-53)에서
     * 나온다. 상태 서비스 · 캐시를 옮겨도(패키지 정리) 두 출구가 갈라지지 않게 고정한다. 캐시가 그사이 바뀌면(server_time 이 다름) 다시 잰다.
     */
    @Test
    void restStatusAndTheWsStatusMessageCarryTheSameMap() throws Exception {
        for (int attempt = 1; attempt <= 3; attempt++) {
            Client c = open(ORIGIN);
            JsonNode ws;
            try {
                c.send("{\"type\":\"hello\",\"proto\":1}");
                c.next("welcome");
                c.send("{\"type\":\"subscribe\",\"bbox\":[124,33,132,39],\"zoom\":7}");
                ws = c.next("status").path("status");
            } finally {
                c.close();
            }
            Res r = get("/api/v1/status");
            assertThat(r.status()).isEqualTo(200);
            var rest = (tools.jackson.databind.node.ObjectNode) r.json();
            assertThat(rest.remove("meta")).as("REST adds meta").isNotNull();
            if (!rest.path("server_time").equals(ws.path("server_time"))) continue; // 3 s 캐시가 그사이 새로 찼다 — 다시
            assertThat(ws.isObject()).isTrue();
            assertThat(rest).isEqualTo(ws);
            return;
        }
        throw new AssertionError("the status cache refreshed between the WS and the REST read three times in a row");
    }
}
