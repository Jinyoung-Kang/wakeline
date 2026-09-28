package dev.wakeline.logs;

import ch.qos.logback.classic.LoggerContext;
import dev.wakeline.config.AppProperties;
import dev.wakeline.config.ProblemAdvice;
import dev.wakeline.config.RateLimiter;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

import java.time.Instant;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicBoolean;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * 계약 v5 §C6: 브라우저 오류 공개 수집 POST /api/v1/client-errors — 본문 {message ≤ 2000, stack ≤ 8000, path ≤ 300(쿼리 제거), component ≤ 200 | null, ts ISO},
 * IP당 분당 10 · 전체 분당 120(rl:cerr:*), 8 KiB 넘으면 413, 형식 오류 400(JSON 이 아닌 Content-Type 은 415 — §G3), 성공 204. 항목은 service "web-client" · level ERROR · untrusted,
 * User-Agent 앞 200자는 context. 가림을 거친 뒤 싣는다.
 */
class ClientErrorControllerTest {
    static final JsonMapper M = JsonMapper.builder().build();
    static final AppProperties PROPS = new AppProperties("", "36.5,127.8", 250, 120, 200, 5, 10, 30, 2500, 0, "classpath:schemas", 72, 30,
            120, List.of("http://localhost:8700"));
    static final Instant NOW = Instant.parse("2026-09-29T03:04:05.678Z");

    /** 메모리 요청 제한기(키 → 수). redisDown 이면 hitStrict 가 실패한다(Redis 장애). */
    static final class MemLimiter extends RateLimiter {
        final Map<String, Long> counts = new HashMap<>();
        final AtomicBoolean redisDown = new AtomicBoolean();

        MemLimiter() { super(null); }

        @Override
        public long[] hitStrict(String bucket, String ip, int windowS) {
            if (redisDown.get()) throw new IllegalStateException("redis down");
            return new long[]{counts.merge("rl:" + bucket + ":" + ip, 1L, Long::sum), 42};
        }

        @Override
        public long[] hit(String bucket, String ip, int windowS) { return hitStrict(bucket, ip, windowS); }
    }

    final List<String> written = new ArrayList<>();
    /** XADD 한 스트림(written 과 같은 순서). */
    final List<LogStream> streams = new ArrayList<>();
    final MemLimiter limiter = new MemLimiter();
    LogSink sink;
    MockMvc mvc;

    @BeforeEach
    void setUp() { build(true); }

    void build(boolean enabled) {
        LoggerContext ctx = new LoggerContext();
        sink = new LogSink((stream, json) -> { streams.add(stream); written.add(json); }, new SimpleMeterRegistry(), enabled, System::currentTimeMillis, ctx,
                60_000, 1000, 30_000);
        mvc = MockMvcBuilders.standaloneSetup(new ClientErrorController(sink, limiter, PROPS, () -> NOW))
                .setControllerAdvice(new ProblemAdvice()).build();
    }

    static String body(String message, String stack, String path, String component, String ts) {
        var n = M.createObjectNode();
        if (message != null) n.put("message", message);
        if (stack != null) n.put("stack", stack);
        if (path != null) n.put("path", path);
        if (component != null) n.put("component", component);
        if (ts != null) n.put("ts", ts);
        return M.writeValueAsString(n);
    }

    static MockHttpServletRequestBuilder report(String body, String ip) {
        return post("/api/v1/client-errors").contentType("application/json").content(body).header("User-Agent", "Mozilla/5.0 (Test) " + "U".repeat(300))
                .with(r -> { r.setRemoteAddr(ip); return r; });
    }

    JsonNode lastQueued() {
        sink.flushOnce();
        assertThat(written).isNotEmpty();
        return M.readTree(written.getLast());
    }

    @Test
    void validReportIsQueuedAsUntrustedWebClientError() throws Exception {
        LogMasker.registerSecrets("session-secret-xyz");
        try {
            mvc.perform(report(body("TypeError: x is undefined ?apikey=ABC", "at f (app.js:1:2)\nsession-secret-xyz", "/logs?rid=abc#frag",
                    "MapView token=abc123", "2026-09-29T03:04:00.123Z"), "203.0.113.7")).andExpect(status().isNoContent());
        } finally {
            LogMasker.clearSecrets();
        }
        JsonNode e = lastQueued();
        // 계약 v5 §G2: 브라우저 오류는 따로 자르는 스트림 wakeline:logs:client 로(서버 오류를 밀어내지 못하게)
        assertThat(streams).containsExactly(LogStream.CLIENT);
        assertThat(new LogEventSchema().validate(written.getLast())).isNull();
        assertThat(e.path("service").asString()).isEqualTo("web-client");
        assertThat(e.path("level").asString()).isEqualTo("ERROR");
        assertThat(e.path("untrusted").asBoolean()).isTrue();
        assertThat(e.path("ts").asString()).as("server receive time").isEqualTo("2026-09-29T03:04:05.678Z");
        assertThat(e.path("logger").asString()).as("component is masked too").isEqualTo("MapView token=***");
        assertThat(e.path("message").asString()).isEqualTo("TypeError: x is undefined ?apikey=***");
        assertThat(e.path("exception").path("stack").asString()).isEqualTo("at f (app.js:1:2)\n***");
        // 예외 종류는 브라우저가 보내지 않는다 — 모르는 값은 빈 글(출처는 service · untrusted 가 이미 말한다)
        assertThat(e.path("exception").path("type").asString()).isEmpty();
        assertThat(e.path("request_id").isNull()).isTrue();
        JsonNode ctx = e.path("context");
        assertThat(ctx.path("path").asString()).as("query and fragment removed").isEqualTo("/logs");
        assertThat(ctx.path("client_ts").asString()).isEqualTo("2026-09-29T03:04:00.123Z");
        assertThat(ctx.path("user_agent").asString()).startsWith("Mozilla/5.0 (Test) ").hasSize(200);
        assertThat(ctx.has("ip")).as("client IP is not stored").isFalse();
    }

    @Test
    void withoutStackOrComponent_exceptionIsNullAndLoggerIsBrowser() throws Exception {
        mvc.perform(report(body("boom", null, "/", null, "2026-09-29T03:04:00Z"), "203.0.113.8")).andExpect(status().isNoContent());
        JsonNode e = lastQueued();
        assertThat(e.get("exception").isNull()).isTrue();
        assertThat(e.path("logger").asString()).isEqualTo("browser");
    }

    @Test
    void malformedBodiesAre400() throws Exception {
        String ok = "2026-09-29T03:04:00Z";
        for (String b : List.of("not json", "[]", body(null, null, "/", null, ok), body("", null, "/", null, ok),
                body("m".repeat(2001), null, "/", null, ok), body("m", "s".repeat(8001), "/", null, ok), body("m", null, null, null, ok),
                body("m", null, "/" + "p".repeat(300), null, ok), body("m", null, "https://x.test/a", null, ok),
                body("m", null, "/", "c".repeat(201), ok), body("m", null, "/", null, null), body("m", null, "/", null, "yesterday"),
                "{\"message\":1,\"path\":\"/\",\"ts\":\"" + ok + "\"}"))
            mvc.perform(report(b, "203.0.113." + (100 + limiter.counts.size()))).andExpect(status().isBadRequest())
                    .andExpect(content().contentTypeCompatibleWith("application/problem+json"));
        assertThat(sink.queued()).isZero();
    }

    @Test
    void bodyOver8KiBIs413() throws Exception {
        String big = body("m".repeat(2000), "s".repeat(8000), "/", null, "2026-09-29T03:04:00Z"); // 필드 상한 안이지만 합쳐 8 KiB 초과
        assertThat(big.length()).isGreaterThan(8 * 1024);
        mvc.perform(report(big, "203.0.113.10")).andExpect(status().is(413))
                .andExpect(jsonPath("$.code").value("TOO_LARGE"));
        assertThat(sink.queued()).isZero();
    }

    /**
     * 계약 v5 §G3: JSON 이 아닌 Content-Type(없는 것 포함)은 415 — 로그인(@RequestBody)과 같은 관례: code UNSUPPORTED_MEDIA_TYPE,
     * Accept 헤더로 받는 형식을 알린다. 본문 형식 오류는 그대로 400 BAD_CLIENT_ERROR(malformedBodiesAre400). 요청 제한 수도 쓰지 않는다.
     */
    @Test
    void nonJsonContentTypeIs415LikeTheLogin_malformedJsonStays400() throws Exception {
        String ok = body("m", null, "/", null, "2026-09-29T03:04:00Z");
        for (String type : List.of("text/plain", "application/x-www-form-urlencoded", "application/xml", "multipart/form-data; boundary=x"))
            mvc.perform(post("/api/v1/client-errors").contentType(type).content(ok)).andExpect(status().isUnsupportedMediaType())
                    .andExpect(content().contentTypeCompatibleWith("application/problem+json"))
                    .andExpect(jsonPath("$.code").value("UNSUPPORTED_MEDIA_TYPE"))
                    .andExpect(header().string("Accept", org.hamcrest.Matchers.containsString("application/json")));
        mvc.perform(post("/api/v1/client-errors").content(ok)).andExpect(status().isUnsupportedMediaType()); // Content-Type 없음
        assertThat(limiter.counts).as("415 before the rate limiter").isEmpty();
        // JSON 이면(문자 집합 인자 포함) 본문을 읽는다 — 형식 오류는 400
        mvc.perform(post("/api/v1/client-errors").contentType("application/json; charset=utf-8").content("not json")
                .with(r -> { r.setRemoteAddr("203.0.113.11"); return r; })).andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.code").value("BAD_CLIENT_ERROR"));
        mvc.perform(post("/api/v1/client-errors").contentType("application/json; charset=utf-8").content(ok)
                .with(r -> { r.setRemoteAddr("203.0.113.11"); return r; })).andExpect(status().isNoContent());
        assertThat(sink.queued()).isEqualTo(1);
    }

    @Test
    void perIpLimitIs10PerMinute_andGlobalLimitIs120() throws Exception {
        String b = body("boom", null, "/", null, "2026-09-29T03:04:00Z");
        for (int i = 0; i < 10; i++) mvc.perform(report(b, "198.51.100.1")).andExpect(status().isNoContent());
        mvc.perform(report(b, "198.51.100.1")).andExpect(status().isTooManyRequests()).andExpect(header().string("Retry-After", "42"))
                .andExpect(jsonPath("$.code").value("RATE_LIMITED"));
        assertThat(limiter.counts).containsEntry("rl:cerr:198.51.100.1", 11L);
        // 한 IP 가 막힌 뒤의 요청은 전체 한도를 쓰지 않는다
        assertThat(limiter.counts).containsEntry("rl:cerr:all", 10L);
        limiter.counts.put("rl:cerr:all", 120L);
        mvc.perform(report(b, "198.51.100.2")).andExpect(status().isTooManyRequests());
    }

    @Test
    void whenTheLimiterCannotReachRedisTheReportIsRefused_503() throws Exception {
        limiter.redisDown.set(true);
        mvc.perform(report(body("boom", null, "/", null, "2026-09-29T03:04:00Z"), "198.51.100.3")).andExpect(status().isServiceUnavailable())
                .andExpect(jsonPath("$.code").value("UNAVAILABLE"));
        assertThat(sink.queued()).isZero();
    }

    @Test
    void disabledSinkRefuses_503() throws Exception {
        build(false);
        mvc.perform(report(body("boom", null, "/", null, "2026-09-29T03:04:00Z"), "198.51.100.4")).andExpect(status().isServiceUnavailable())
                .andExpect(jsonPath("$.code").value("LOG_SINK_DISABLED"));
    }

    @Test
    void repeatedSameErrorIsSuppressedButStill204() throws Exception {
        String b = body("boom 1", null, "/", "MapView", "2026-09-29T03:04:00Z");
        mvc.perform(report(b, "198.51.100.5")).andExpect(status().isNoContent());
        mvc.perform(report(body("boom 2", null, "/", "MapView", "2026-09-29T03:04:00Z"), "198.51.100.5")).andExpect(status().isNoContent());
        assertThat(sink.queued()).isEqualTo(1);
    }
}
