package dev.skywx.ws;

import dev.skywx.config.AppProperties;
import dev.skywx.config.WebSocketConfig;
import dev.skywx.engine.EngineService;
import dev.skywx.ingest.RadarStore;
import dev.skywx.ingest.SigmetStore;
import dev.skywx.ingest.SnapshotStore;
import dev.skywx.rest.StatusService;
import io.micrometer.core.instrument.MeterRegistry;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import org.apache.catalina.Context;
import org.apache.catalina.startup.Tomcat;
import org.apache.tomcat.websocket.server.WsSci;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.env.MapPropertySource;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.web.context.support.AnnotationConfigWebApplicationContext;
import org.springframework.web.servlet.DispatcherServlet;
import org.springframework.web.socket.adapter.NativeWebSocketSession;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.WebSocket;
import java.net.http.WebSocketHandshakeException;
import java.nio.file.Files;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * 실제 소켓(내장 Tomcat + Spring WebSocket 설정): 빈 연결(WsHub 생성자 선택·AppProperties 바인딩),
 * Origin 명시 허용 목록, Tomcat 세션별 블로킹 전송 한도(5 s), rate limit 종료 코드. DB·Redis 없이 돈다.
 */
class WsIntegrationTest {
    static Tomcat tomcat;
    static AnnotationConfigWebApplicationContext ctx;
    static int port;
    static final HttpClient http = HttpClient.newHttpClient();

    @Configuration
    @EnableConfigurationProperties(AppProperties.class)
    static class Beans {
        @Bean ObjectMapper objectMapper() { return WsTestKit.JSON; }
        @Bean MeterRegistry meterRegistry() { return new SimpleMeterRegistry(); }
        @Bean SnapshotStore snapshotStore() { return new SnapshotStore(); }
        @Bean SigmetStore sigmetStore() { return new SigmetStore(); }
        @Bean RadarStore radarStore() { return new RadarStore(); }
        @Bean EngineService engineService(SnapshotStore s, SigmetStore g, ApplicationEventPublisher p, MeterRegistry m) { return new EngineService(s, g, p, m); }
        /** 연결 팩토리 없는 템플릿 — StatusService 는 Redis 오류를 삼키고 "redis unavailable" 로 둔다. */
        @Bean StatusService statusService(SnapshotStore s, SigmetStore g, RadarStore r, EngineService e, AppProperties props) {
            return new StatusService(s, g, r, e, new StringRedisTemplate(), props);
        }
    }

    @BeforeAll
    static void start() throws Exception {
        ctx = new AnnotationConfigWebApplicationContext();
        ctx.getEnvironment().getPropertySources().addFirst(new MapPropertySource("test", Map.ofEntries(
                Map.entry("skywx.trusted-proxy", ""), Map.entry("skywx.region-center", "36.5,127.8"),
                Map.entry("skywx.region-radius-nm", "250"), Map.entry("skywx.public-rate-limit-per-min", "120"),
                Map.entry("skywx.ws-max-conn", "200"), Map.entry("skywx.ws-max-conn-per-ip", "5"),
                Map.entry("skywx.ws-diff-interval-s", "10"), Map.entry("skywx.ws-resync-interval-s", "30"),
                Map.entry("skywx.max-bbox-area-sqdeg", "2500"), Map.entry("skywx.fixture-mode", "0"),
                Map.entry("skywx.schemas-dir", "classpath:schemas"), Map.entry("skywx.track-retention-hours", "72"),
                Map.entry("skywx.summary-retention-days", "30"),
                // ws-resync-world-interval-s 는 비워 @DefaultValue(120) 를 확인한다. 목록은 SKYWX_ALLOWED_ORIGINS 처럼 쉼표 문자열.
                Map.entry("skywx.allowed-origins", "http://localhost:8700, http://127.0.0.1:8700/"))));
        ctx.register(Beans.class, WsHub.class, SkyWsHandler.class, WebSocketConfig.class);

        tomcat = new Tomcat();
        tomcat.setBaseDir(Files.createTempDirectory("skywx-ws-it").toString());
        tomcat.setPort(0);
        tomcat.getConnector();
        Context c = tomcat.addContext("", Files.createTempDirectory("skywx-ws-doc").toString());
        c.addServletContainerInitializer(new WsSci(), null);
        Tomcat.addServlet(c, "dispatcher", new DispatcherServlet(ctx)).setLoadOnStartup(1);
        c.addServletMappingDecoded("/", "dispatcher");
        tomcat.start();
        port = tomcat.getConnector().getLocalPort();
    }

    @AfterAll
    static void stop() throws Exception {
        if (ctx != null) ctx.close();
        if (tomcat != null) { tomcat.stop(); tomcat.destroy(); }
    }

    /** 받은 텍스트 메시지와 종료 코드를 큐에 모은다. */
    static class Client implements WebSocket.Listener {
        final LinkedBlockingQueue<JsonNode> messages = new LinkedBlockingQueue<>();
        final CompletableFuture<Integer> closed = new CompletableFuture<>();
        final CompletableFuture<String> closeReason = new CompletableFuture<>();
        private final StringBuilder buf = new StringBuilder();

        @Override public CompletionStage<?> onText(WebSocket ws, CharSequence data, boolean last) {
            buf.append(data);
            if (last) { messages.add(WsTestKit.parse(buf.toString())); buf.setLength(0); }
            ws.request(1);
            return null;
        }

        @Override public CompletionStage<?> onClose(WebSocket ws, int statusCode, String reason) {
            closed.complete(statusCode);
            closeReason.complete(reason);
            return null;
        }

        JsonNode next(String type) throws InterruptedException {
            long end = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
            while (System.nanoTime() < end) {
                JsonNode n = messages.poll(100, TimeUnit.MILLISECONDS);
                if (n != null && type.equals(n.path("type").asString())) return n;
            }
            throw new AssertionError("no " + type + " message");
        }
    }

    static WebSocket open(Client c, String origin) throws Exception {
        WebSocket.Builder b = http.newWebSocketBuilder();
        if (origin != null) b.header("Origin", origin);
        return b.buildAsync(URI.create("ws://127.0.0.1:" + port + "/ws/v1"), c).get(5, TimeUnit.SECONDS);
    }

    @Test void allowedOrigin_fullProtocolRoundTrip_andTomcatSendTimeoutApplied() throws Exception {
        Client c = new Client();
        WebSocket ws = open(c, "http://localhost:8700");
        ws.sendText("{\"type\":\"hello\",\"proto\":1}", true).get(5, TimeUnit.SECONDS);
        JsonNode welcome = c.next("welcome");
        assertThat(welcome.path("limits").path("resync_world_interval_s").asInt()).isEqualTo(120); // @DefaultValue 바인딩
        ws.sendText("{\"type\":\"subscribe\",\"bbox\":[124,33,132,39],\"zoom\":7}", true).get(5, TimeUnit.SECONDS);
        JsonNode snap = c.next("snapshot");
        assertThat(snap.path("seq").asInt()).isEqualTo(1);
        assertThat(snap.path("sources").has("region")).isTrue();
        assertThat(c.next("alerts").path("version").asLong()).isZero();
        c.next("status");

        WsSession s = ctx.getBean(SkyWsHandler.class).session(welcome.path("session_id").asString());
        assertThat(s).isNotNull();
        var nativeSession = ((NativeWebSocketSession) s.raw()).getNativeSession(jakarta.websocket.Session.class);
        assertThat(nativeSession.getUserProperties().get(SkyWsHandler.TOMCAT_BLOCKING_SEND_TIMEOUT)).isEqualTo(5000L);
        ws.sendClose(WebSocket.NORMAL_CLOSURE, "bye").get(5, TimeUnit.SECONDS);
    }

    @Test void foreignOrigin_isRejectedAtHandshake() {
        assertThatThrownBy(() -> open(new Client(), "http://rebind.attacker.example:8700"))
                .isInstanceOf(ExecutionException.class)
                .cause().isInstanceOf(WebSocketHandshakeException.class)
                .satisfies(e -> assertThat(((WebSocketHandshakeException) e).getResponse().statusCode()).isEqualTo(403));
    }

    @Test void noOriginHeader_nonBrowserClient_isAllowed() throws Exception {
        Client c = new Client();
        WebSocket ws = open(c, null);
        ws.sendText("{\"type\":\"hello\",\"proto\":1}", true).get(5, TimeUnit.SECONDS);
        c.next("welcome");
        ws.sendClose(WebSocket.NORMAL_CLOSURE, "bye").get(5, TimeUnit.SECONDS);
    }

    @Test void messageFlood_closes1008RateLimit() throws Exception {
        Client c = new Client();
        WebSocket ws = open(c, "http://127.0.0.1:8700");
        ws.sendText("{\"type\":\"hello\",\"proto\":1}", true).get(5, TimeUnit.SECONDS);
        c.next("welcome");
        for (int i = 0; i < 25 && !c.closed.isDone(); i++) {
            try { ws.sendText("{\"type\":\"pong\"}", true).get(5, TimeUnit.SECONDS); } catch (ExecutionException e) { break; }
        }
        assertThat(c.closed.get(5, TimeUnit.SECONDS)).isEqualTo(1008);
        assertThat(c.closeReason.get()).isEqualTo("rate limit");
    }
    /**
     * REL-2 실제 소켓 재현: 읽지 않는 클라이언트(수신 요청 0)에게 수 MB 스냅샷을 밀어 넣어도
     * 스트림 소비 스레드(onSnapshot)는 바로 돌아오고, 다른 세션은 계속 받고, 막힌 세션은 Tomcat 전송 한도(5 s)로 닫힌다.
     */
    @Test void nonReadingClient_doesNotBlockIngest_andIsClosedBySendTimeout() throws Exception {
        WsHub hub = ctx.getBean(WsHub.class);
        SnapshotStore store = ctx.getBean(SnapshotStore.class);
        int base = hub.count();
        Client healthy = new Client();
        WebSocket hws = open(healthy, "http://localhost:8700");
        hws.sendText("{\"type\":\"hello\",\"proto\":1}", true).get(5, TimeUnit.SECONDS);
        hws.sendText("{\"type\":\"subscribe\",\"bbox\":[124,33,132,39],\"zoom\":7}", true).get(5, TimeUnit.SECONDS);
        healthy.next("snapshot");

        Client stalled = new Client() {
            @Override public void onOpen(WebSocket ws) { /* request() 를 부르지 않는다 — 아무것도 읽지 않음 */ }
        };
        WebSocket sws = open(stalled, "http://localhost:8700");
        sws.sendText("{\"type\":\"hello\",\"proto\":1}", true).get(5, TimeUnit.SECONDS);
        sws.sendText("{\"type\":\"subscribe\",\"bbox\":[-180,-90,180,90],\"zoom\":3}", true).get(5, TimeUnit.SECONDS);
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
        while (hub.count() < base + 2 && System.nanoTime() < deadline) Thread.sleep(10);
        assertThat(hub.count()).isEqualTo(base + 2);

        java.time.Instant t = java.time.Instant.now();
        long maxPublishMs = 0;
        long closedAtMs = -1;
        long startMs = System.currentTimeMillis();
        for (int round = 0; round < 60 && closedAtMs < 0; round++) {
            Map<String, dev.skywx.domain.AircraftState> m = new java.util.HashMap<>();
            for (int i = 0; i < 20_000; i++) {   // 전세계 2만 대 ≈ 2 MB/스냅샷 — 소켓 버퍼를 금방 채운다
                String hex = String.format("%06x", i);
                m.put(hex, WsTestKit.ac(hex, -80 + (i % 160) + round * 0.01, -170 + (i / 160) * 2.5, 30000, t, "opensky"));
            }
            m.put("aaa001", WsTestKit.ac("aaa001", 36 + round * 0.01, 127, 30000, t, "adsb_lol")); // 건강한 세션의 bbox 안
            var snap = new dev.skywx.ingest.Snapshot(store.nextVersion(), "global", "opensky", t.plusSeconds(round + 1), t, "-", Map.copyOf(m));
            var prev = store.replace(snap);
            long p0 = System.nanoTime();
            hub.onSnapshot(new dev.skywx.ingest.IngestEvents.SnapshotUpdated(prev, snap));
            maxPublishMs = Math.max(maxPublishMs, (System.nanoTime() - p0) / 1_000_000);
            if (round > 0) healthy.next("diff"); // 다른 세션은 계속 받는다
            if (hub.count() == base + 1) closedAtMs = System.currentTimeMillis() - startMs;
            Thread.sleep(250);
        }
        System.out.printf("REL-2 real socket: max onSnapshot %d ms, stalled session closed after %d ms%n", maxPublishMs, closedAtMs);
        assertThat(maxPublishMs).as("onSnapshot never waits for a send").isLessThan(200);
        assertThat(closedAtMs).as("stalled session closed by the 5 s send limit").isBetween(0L, 14_000L);
        hws.sendClose(WebSocket.NORMAL_CLOSURE, "bye").get(5, TimeUnit.SECONDS);
        sws.abort();
    }
}
