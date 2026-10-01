package dev.wakeline.ws;

import dev.wakeline.platform.config.AppProperties;
import dev.wakeline.weather.core.EngineService;
import dev.wakeline.weather.core.RadarStore;
import dev.wakeline.weather.core.SigmetStore;
import dev.wakeline.aircraft.core.SnapshotStore;
import dev.wakeline.status.StatusService;
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
        @Bean dev.wakeline.ingest.ShipStore shipStore() { return new dev.wakeline.ingest.ShipStore(); }
        @Bean EngineService engineService(SnapshotStore s, SigmetStore g, ApplicationEventPublisher p, MeterRegistry m) { return new EngineService(s, g, p, m); }
        /** 연결 팩토리 없는 템플릿 — StatusService 는 Redis 오류를 삼키고 "redis unavailable" 로 둔다. */
        @Bean StatusService statusService(SnapshotStore s, SigmetStore g, RadarStore r, EngineService e, AppProperties props) {
            return new StatusService(s, g, r, e, new StringRedisTemplate(), props);
        }
        /** 노선 캐시(계약 v4 §A)도 연결 없는 템플릿 — 읽기 실패는 route.status unavailable. */
        @Bean dev.wakeline.route.RouteReader routeReader(ObjectMapper json) { return new dev.wakeline.route.RouteReader(new StringRedisTemplate(), json); }
        /** 한국 항만 입출항 색인(ADR-022 개정)은 DB 가 없는 구성 — 읽기 실패는 port_calls.status error, heartbeat 는 연결 없는 템플릿(오류는 삼킨다). */
        @Bean dev.wakeline.portcalls.PortCallReader portCallReader(MeterRegistry m) {
            dev.wakeline.portcalls.PortCallReader.Source none = new dev.wakeline.portcalls.PortCallReader.Source() {
                @Override public java.util.List<dev.wakeline.portcalls.PortCallIndex.Coverage> coverage() {
                    throw new org.springframework.dao.DataAccessResourceFailureException("no database in this test");
                }
                @Override public java.util.List<dev.wakeline.portcalls.PortCallIndex.Row> byCallSign(String cs, java.time.LocalDate f, java.time.LocalDate t, int n) {
                    throw new org.springframework.dao.DataAccessResourceFailureException("no database in this test");
                }
            };
            return new dev.wakeline.portcalls.PortCallReader(none, new StringRedisTemplate(), m);
        }
        /** 선택 조회 전용 읽기 풀(계약 v5 §G18)도 DB 가 없는 구성 — 연결은 첫 사용 때 맺는다(이 시험의 읽는 쪽은 풀을 쓰지 않는다 — 크기 · 마감만). */
        @Bean dev.wakeline.platform.data.ReadPool readPool(MeterRegistry m) {
            return new dev.wakeline.platform.data.ReadPool("jdbc:postgresql://127.0.0.1:1/none", "none", "", 1, 250, m);
        }
        /** 저장 정적 보고(계약 v5 §G17)도 DB 가 없는 구성 — 메모리에 정적 정보가 없는 선박은 static_source stored_unavailable. */
        @Bean dev.wakeline.persist.StoredStaticReader storedStaticReader(MeterRegistry m) {
            return new dev.wakeline.persist.StoredStaticReader(mmsi -> {
                throw new org.springframework.dao.DataAccessResourceFailureException("no database in this test");
            }, System::currentTimeMillis, m);
        }
    }

    @BeforeAll
    static void start() throws Exception {
        ctx = new AnnotationConfigWebApplicationContext();
        ctx.getEnvironment().getPropertySources().addFirst(new MapPropertySource("test", Map.ofEntries(
                Map.entry("wakeline.trusted-proxy", ""), Map.entry("wakeline.region-center", "36.5,127.8"),
                Map.entry("wakeline.region-radius-nm", "250"), Map.entry("wakeline.public-rate-limit-per-min", "120"),
                Map.entry("wakeline.ws-max-conn", "200"), Map.entry("wakeline.ws-max-conn-per-ip", "5"),
                Map.entry("wakeline.ws-diff-interval-s", "10"), Map.entry("wakeline.ws-resync-interval-s", "30"),
                Map.entry("wakeline.max-bbox-area-sqdeg", "2500"), Map.entry("wakeline.fixture-mode", "0"),
                Map.entry("wakeline.schemas-dir", "classpath:schemas"), Map.entry("wakeline.track-retention-hours", "72"),
                Map.entry("wakeline.summary-retention-days", "30"),
                // 노선 조회의 답 마감(계약 v5 §G21) = Redis 명령 상한(RedisConfig.COMMAND_TIMEOUT). 운영(3s)과 다른 값으로 스프링 배선이 그 값을 쓰는지 본다
                Map.entry("spring.data.redis.timeout", "2500ms"),
                // ws-resync-world-interval-s 는 비워 @DefaultValue(120) 를 확인한다. 목록은 WAKELINE_ALLOWED_ORIGINS 처럼 쉼표 문자열.
                Map.entry("wakeline.allowed-origins", "http://localhost:8700, http://127.0.0.1:8700/"))));
        ctx.register(Beans.class, WsHub.class, ShipFanout.class, WakelineWsHandler.class, WebSocketConfig.class);

        tomcat = new Tomcat();
        tomcat.setBaseDir(Files.createTempDirectory("wakeline-ws-it").toString());
        tomcat.setPort(0);
        tomcat.getConnector();
        Context c = tomcat.addContext("", Files.createTempDirectory("wakeline-ws-doc").toString());
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

        WsSession s = ctx.getBean(WakelineWsHandler.class).session(welcome.path("session_id").asString());
        assertThat(s).isNotNull();
        var nativeSession = ((NativeWebSocketSession) s.raw()).getNativeSession(jakarta.websocket.Session.class);
        assertThat(nativeSession.getUserProperties().get(WakelineWsHandler.TOMCAT_BLOCKING_SEND_TIMEOUT)).isEqualTo(5000L);
        ws.sendClose(WebSocket.NORMAL_CLOSURE, "bye").get(5, TimeUnit.SECONDS);
    }

    /**
     * 리뷰(2026-09-30 · lane-route #5): 스프링이 만든 허브의 노선 답 마감은 spring.data.redis.timeout(RedisConfig.COMMAND_TIMEOUT)에서 온다 — 운영 값(3 s)과
     * 다른 2,500 ms 로 확인한다(상수로 바꾸면 실패한다). 노선 조회 실행기도 운영 것(대기열 길이 지표가 있는 고정 크기 실행기)이다.
     */
    @Test void theSpringWiredHub_takesTheRouteDeadlineFromTheRedisCommandTimeoutProperty() {
        WsHub hub = ctx.getBean(WsHub.class);
        assertThat(hub.routeLookups().deadlineMs()).isEqualTo(2_500);
        assertThat(hub.routeLookups().enabled()).isTrue();
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
            Map<String, dev.wakeline.aircraft.core.AircraftState> m = new java.util.HashMap<>();
            for (int i = 0; i < 20_000; i++) {   // 전세계 2만 대 ≈ 2 MB/스냅샷 — 소켓 버퍼를 금방 채운다
                String hex = String.format("%06x", i);
                m.put(hex, WsTestKit.ac(hex, -80 + (i % 160) + round * 0.01, -170 + (i / 160) * 2.5, 30000, t, "opensky"));
            }
            m.put("aaa001", WsTestKit.ac("aaa001", 36 + round * 0.01, 127, 30000, t, "adsb_lol")); // 건강한 세션의 bbox 안
            var snap = new dev.wakeline.aircraft.core.Snapshot(store.nextVersion(), "global", "opensky", t.plusSeconds(round + 1), t, "-", Map.copyOf(m));
            var prev = store.replace(snap);
            long p0 = System.nanoTime();
            hub.onSnapshot(new dev.wakeline.aircraft.core.AircraftEvents.SnapshotUpdated(prev, snap));
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
