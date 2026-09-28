package dev.wakeline.it;

import dev.wakeline.DbTestSupport;
import org.junit.jupiter.api.BeforeEach;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import tools.jackson.databind.JsonNode;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.BooleanSupplier;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 전체 앱(@SpringBootTest, 실제 Tomcat 임의 포트)을 {@link ItStack}(PostGIS + ACL Redis) 위에 띄우는 통합 테스트 공통.
 * 모든 하위 클래스가 같은 설정이라 Spring 이 컨텍스트 1개를 캐시해 같이 쓴다(기동 1회).
 * <p>
 * 요청은 127.0.0.1 에서 오고 신뢰 프록시는 운영 edge 주소(10.77.0.10)다 — 테스트 클라이언트는 '신뢰하지 않는 원격'이다.
 * 공개 API 요청 제한(IP 당 분당 120)은 모든 테스트가 같은 IP 로 나눠 쓰므로 테스트마다 카운터(rl:*)를 비운다.
 * 준비 대기는 REST 가 아니라 빈·DB·Redis 를 직접 본다(대기 폴링이 요청 제한을 쓰지 않게).
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT, properties = {
        "management.server.port=0",
        "wakeline.trusted-proxy=" + IntegrationTest.TRUSTED_PROXY,
        "wakeline.public-rate-limit-per-min=120",
        "wakeline.allowed-origins=http://localhost:8700,http://127.0.0.1:8700",
        // 모든 통합 테스트 클라이언트는 같은 IP(127.0.0.1)에서 온다 — 수요 상한(핫 리전 6 셀) 검증에 세션 8개가 필요해 IP 당 상한만 넓힌다
        // (운영 기본 5. 상한 자체의 동작은 RateAndLimitTest·WsIntegrationTest 가 5 로 검증한다).
        "wakeline.ws-max-conn-per-ip=10",
        "wakeline.region-center=36.5,127.8",
        "wakeline.region-radius-nm=250",
        "wakeline.fixture-mode=0",
})
@AutoConfigureMockMvc
public abstract class IntegrationTest {
    static final String TRUSTED_PROXY = "10.77.0.10";
    static final String ORIGIN = "http://localhost:8700";
    static final HttpClient HTTP = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).followRedirects(HttpClient.Redirect.NEVER).build();

    @LocalServerPort
    protected int port;

    /** 앱과 같은 DML 전용 계정(wakeline_api) — 앱이 쓴 행을 읽는다. */
    @Autowired
    protected JdbcClient db;

    /** 관리자(postgres) — 권한 밖의 확인·정리에만. */
    static JdbcClient admin() {
        return JdbcClient.create(new org.springframework.jdbc.datasource.DriverManagerDataSource(
                DbTestSupport.jdbcUrl(ItStack.DB), "postgres", DbTestSupport.ROOT_PW));
    }

    @DynamicPropertySource
    static void stack(DynamicPropertyRegistry r) {
        ItStack.start();
        r.add("spring.datasource.url", () -> DbTestSupport.jdbcUrl(ItStack.DB));
        r.add("spring.datasource.username", () -> "wakeline_api");
        r.add("spring.datasource.password", () -> DbTestSupport.API_PW);
        r.add("spring.data.redis.host", ItStack::redisHost);
        r.add("spring.data.redis.port", ItStack::redisPort);
        r.add("spring.data.redis.username", () -> "wakeline_api");
        r.add("spring.data.redis.password", () -> ItStack.REDIS_API_PW);
    }

    @BeforeEach
    void clearRateLimits() {
        ItStack.deleteKeys("rl:*");
    }

    // ---------- HTTP ----------

    record Res(int status, Map<String, List<String>> headers, String body) {
        String header(String name) {
            for (var e : headers.entrySet()) if (e.getKey().equalsIgnoreCase(name)) return e.getValue().isEmpty() ? null : e.getValue().getFirst();
            return null;
        }

        List<String> headers(String name) {
            for (var e : headers.entrySet()) if (e.getKey().equalsIgnoreCase(name)) return e.getValue();
            return List.of();
        }

        JsonNode json() { return Streams.JSON.readTree(body); }
    }

    String url(String path) { return "http://127.0.0.1:" + port + path; }

    Res send(String method, String path, String body, Map<String, String> headers) {
        HttpRequest.Builder b = HttpRequest.newBuilder(URI.create(url(path))).timeout(Duration.ofSeconds(15));
        headers.forEach(b::header);
        b.method(method, body == null ? HttpRequest.BodyPublishers.noBody() : HttpRequest.BodyPublishers.ofString(body));
        try {
            HttpResponse<String> r = HTTP.send(b.build(), HttpResponse.BodyHandlers.ofString());
            return new Res(r.statusCode(), r.headers().map(), r.body());
        } catch (Exception e) {
            throw new IllegalStateException(method + " " + path + ": " + e, e);
        }
    }

    Res get(String path) { return send("GET", path, null, Map.of()); }

    Res get(String path, Map<String, String> headers) { return send("GET", path, null, headers); }

    static Map<String, String> headers(String... kv) {
        Map<String, String> m = new LinkedHashMap<>();
        for (int i = 0; i + 1 < kv.length; i += 2) m.put(kv[i], kv[i + 1]);
        return m;
    }

    /**
     * RFC 9457 problem+json 모양: type(URI) · title · status(= HTTP 상태) · detail · instance(= 요청 경로) + 확장 code · request_id(= X-Request-Id).
     * 스택·내부 메시지는 싣지 않는다.
     */
    static JsonNode assertProblem(Res r, int status, String code, String path) {
        assertThat(r.status()).as("status of %s", path).isEqualTo(status);
        assertThat(r.header("Content-Type")).as("content type").startsWith("application/problem+json");
        JsonNode p = r.json();
        assertThat(p.path("type").asString()).startsWith("https://wakeline.invalid/problems/");
        assertThat(URI.create(p.path("type").asString()).isAbsolute()).isTrue();
        assertThat(p.path("title").isString()).isTrue();
        assertThat(p.path("title").asString()).isNotBlank();
        assertThat(p.path("status").isIntegralNumber()).isTrue();
        assertThat(p.path("status").asInt()).isEqualTo(status);
        assertThat(p.path("detail").isString()).isTrue();
        assertThat(p.path("instance").asString()).isEqualTo(path);
        assertThat(p.path("code").asString()).isEqualTo(code);
        assertThat(p.path("request_id").asString()).isNotBlank().isEqualTo(r.header("X-Request-Id"));
        assertThat(r.body()).doesNotContain("Exception").doesNotContain("at dev.wakeline").doesNotContain("trace");
        return p;
    }

    // ---------- 대기 ----------

    static void await(String what, Duration timeout, BooleanSupplier cond) {
        awaitEvery(what, timeout, Duration.ofMillis(50), cond);
    }

    /** REST 를 부르는 조건은 간격을 넓혀(요청 제한을 쓰지 않게) — 준비 대기 자체는 빈·DB·Redis 로 한다. */
    static void awaitEvery(String what, Duration timeout, Duration every, BooleanSupplier cond) {
        long end = System.nanoTime() + timeout.toNanos();
        while (System.nanoTime() < end) {
            if (cond.getAsBoolean()) return;
            try { Thread.sleep(every.toMillis()); } catch (InterruptedException e) { Thread.currentThread().interrupt(); throw new AssertionError(e); }
        }
        if (!cond.getAsBoolean()) throw new AssertionError("timed out after " + timeout + " waiting for " + what);
    }

    /**
     * 분 단위 고정 창(요청 제한 키 rl:{bucket}:{ip}:{epoch/60})의 경계를 건너지 않게: 남은 시간이 minRemainingS 보다 짧으면 다음 분까지 기다린다.
     */
    static void awaitFreshMinuteWindow(int minRemainingS) {
        long ms = System.currentTimeMillis() % 60_000;
        if (60_000 - ms < minRemainingS * 1000L) {
            try { Thread.sleep(60_000 - ms + 200); } catch (InterruptedException e) { Thread.currentThread().interrupt(); }
        }
    }

    long count(String sql, Object... params) {
        var spec = db.sql(sql);
        for (int i = 0; i < params.length; i++) spec = spec.param(i + 1, params[i]);
        return spec.query(Long.class).single();
    }
}
