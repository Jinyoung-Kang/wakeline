package dev.wakeline.qa;

import com.github.dockerjava.api.DockerClient;
import com.github.dockerjava.api.model.Container;
import com.github.dockerjava.api.model.ContainerPort;
import dev.wakeline.it.IntegrationTest;
import dev.wakeline.it.ItStack;
import dev.wakeline.ops.OpsUserService;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIf;
import org.springframework.beans.factory.annotation.Autowired;
import org.testcontainers.DockerClientFactory;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * QA-102 재현: Redis 가 멈춘(또는 끊긴) 동안 세션 쿠키(WAKELINE_SESSION, Path=/api)를 실은 요청은 공개 경로까지 500 이 된다 — 계약 §2 는 Redis 장애를
 * 503 + Retry-After 로 답한다(쿠키 없는 같은 요청은 200 · 로그인은 503 + Retry-After 10). Spring Session 이 세션을 읽다 낸 RedisSystemException 이
 * 필터(OpsSessionLifetimeFilter · RateLimitFilter 뒤 보안 필터)에서 그대로 올라가 Tomcat 이 ERROR 스택 세 줄을 남긴다.
 * 로그인한 운영자의 브라우저는 /api 요청마다 이 쿠키를 보내므로 Redis 장애 동안 상황판의 REST(상태 · SIGMET · 이력)가 모두 실패한다.
 * 스택 B 증거: docs/qa/2026-10/evidence/reliability/sweeps/ops-redis-down-cases.json · ops-redis-paused-cases.json.
 */
@EnabledIf("dev.wakeline.DbTestSupport#dockerAvailable")
class Qa102RedisDownSessionCookieIT extends IntegrationTest {
    static final String USER = "it-qa102";
    static final String PW = "qa102-horse-battery-staple";
    static final String ORIGIN = "http://localhost:8700";
    static final HttpClient CLIENT = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).followRedirects(HttpClient.Redirect.NEVER).build();

    @Autowired OpsUserService users;

    private final Map<String, String> cookies = new LinkedHashMap<>();

    private HttpResponse<String> send(String method, String path, String body, Map<String, String> headers) throws Exception {
        HttpRequest.Builder b = HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + path)).timeout(Duration.ofSeconds(40))
                .method(method, body == null ? HttpRequest.BodyPublishers.noBody() : HttpRequest.BodyPublishers.ofString(body));
        headers.forEach(b::header);
        if (!cookies.isEmpty()) {
            StringBuilder sb = new StringBuilder();
            cookies.forEach((k, v) -> sb.append(sb.isEmpty() ? "" : "; ").append(k).append('=').append(v));
            b.header("Cookie", sb.toString());
        }
        HttpResponse<String> r = CLIENT.send(b.build(), HttpResponse.BodyHandlers.ofString());
        for (String sc : r.headers().allValues("Set-Cookie")) {
            String nv = sc.split(";", 2)[0];
            int eq = nv.indexOf('=');
            cookies.put(nv.substring(0, eq).trim(), nv.substring(eq + 1).trim());
        }
        return r;
    }

    private static String redisContainerId() {
        DockerClient docker = DockerClientFactory.instance().client();
        int mapped = ItStack.redisPort();
        for (Container c : docker.listContainersCmd().exec())
            for (ContainerPort p : c.getPorts())
                if (p.getPublicPort() != null && p.getPublicPort() == mapped) return c.getId();
        throw new IllegalStateException("redis test container not found on port " + mapped);
    }

    @Test
    void requestsCarryingTheOpsSessionCookieAnswer503WithRetryAfterWhileRedisIsDown() throws Exception {
        users.upsert(USER, PW);
        send("GET", "/api/v1/status", null, Map.of()); // CSRF 쿠키
        HttpResponse<String> login = send("POST", "/api/v1/ops/session", "{\"username\":\"" + USER + "\",\"password\":\"" + PW + "\"}",
                Map.of("Content-Type", "application/json", "Origin", ORIGIN, "Sec-Fetch-Site", "same-origin",
                        "X-CSRF-Token", String.valueOf(cookies.get("WAKELINE_CSRF"))));
        assertThat(login.statusCode()).isEqualTo(200);
        assertThat(cookies).containsKey("WAKELINE_SESSION");

        DockerClient docker = DockerClientFactory.instance().client();
        String id = redisContainerId();
        Map<String, String> seen = new LinkedHashMap<>();
        docker.pauseContainerCmd(id).exec();
        try {
            for (String path : List.of("/api/v1/status", "/api/v1/ops/settings")) {
                HttpResponse<String> r = send("GET", path, null, Map.of("Accept", "application/json, application/problem+json"));
                seen.put(path, r.statusCode() + " retry-after=" + r.headers().firstValue("Retry-After").orElse("-"));
            }
        } finally {
            docker.unpauseContainerCmd(id).exec();
        }
        assertThat(seen).as("Redis 가 멈춘 동안 세션 쿠키를 실은 요청 — 503 + Retry-After 여야 한다(500 아님)")
                .allSatisfy((path, v) -> assertThat(v).startsWith("503 retry-after=").doesNotEndWith("=-"));
    }
}
