package dev.wakeline.it;

import com.github.dockerjava.api.DockerClient;
import com.github.dockerjava.api.model.Container;
import com.github.dockerjava.api.model.ContainerPort;
import org.assertj.core.api.SoftAssertions;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIf;
import org.testcontainers.DockerClientFactory;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Redis 가 답하지 않는 동안(docker pause — TCP 는 열린 채 답이 없다) 요청이 Redis 명령 상한(3 s)을 되풀이해 기다리지 않는다(QA 2026-10 신뢰성
 * 개선 제안 3 · 4, ADR-032). QA 스택 증거(docs/qa/2026-10/findings/reliability.md): 멈춘 동안 모든 공개 REST 가 3.05–3.1 s(요청 제한기가 요청마다
 * Redis 를 기다림), /status 는 12 s(제한기 3 s + 상태의 Redis 조회 셋 × 3 s), /healthz 는 Redis 를 말하지 않았다.
 * <ul>
 *   <li>처음 무응답을 본 요청 하나(들)는 상한까지 기다린다 — 그 뒤 공개 요청 · /status 는 Redis 를 건너뛰어 곧바로 답한다(요청 제한은 api 메모리 안에서 같은 한도로).</li>
 *   <li>로그인(실패 시 닫힘)은 기다리지 않고 503 + Retry-After.</li>
 *   <li>/healthz 의 reasons 에 redis_unavailable(HTTP 200 그대로) — 다시 풀면 사라진다(뒤 확인이 Redis 의 답을 보면 차단기를 닫는다).</li>
 * </ul>
 */
@EnabledIf("dev.wakeline.DbTestSupport#dockerAvailable")
class RedisPausedIT extends IntegrationTest {
    static final String ORIGIN = "http://localhost:8700";
    static final HttpClient CLIENT = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).followRedirects(HttpClient.Redirect.NEVER).build();
    /** 차단기가 열린 뒤 요청 하나의 상한 — Redis 명령 상한(3 s)보다 한참 작다. */
    static final long FAST_MS = 1_000;

    private final Map<String, String> cookies = new LinkedHashMap<>();

    record Timed(int status, long ms, String body, HttpResponse<String> res) {}

    private Timed timed(String method, String path, String body, Map<String, String> headers) throws Exception {
        HttpRequest.Builder b = HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + path)).timeout(Duration.ofSeconds(40))
                .method(method, body == null ? HttpRequest.BodyPublishers.noBody() : HttpRequest.BodyPublishers.ofString(body));
        headers.forEach(b::header);
        if (!cookies.isEmpty()) {
            StringBuilder sb = new StringBuilder();
            cookies.forEach((k, v) -> sb.append(sb.isEmpty() ? "" : "; ").append(k).append('=').append(v));
            b.header("Cookie", sb.toString());
        }
        long t0 = System.nanoTime();
        HttpResponse<String> r = CLIENT.send(b.build(), HttpResponse.BodyHandlers.ofString());
        long ms = (System.nanoTime() - t0) / 1_000_000;
        for (String sc : r.headers().allValues("Set-Cookie")) {
            String nv = sc.split(";", 2)[0];
            int eq = nv.indexOf('=');
            cookies.put(nv.substring(0, eq).trim(), nv.substring(eq + 1).trim());
        }
        return new Timed(r.statusCode(), ms, r.body(), r);
    }

    private Timed timedGet(String path) throws Exception {
        return timed("GET", path, null, Map.of("Accept", "application/json, application/geo+json, application/problem+json"));
    }

    private static List<String> reasons(Timed healthz) {
        JsonNode n = JsonMapper.builder().build().readTree(healthz.body()).path("reasons");
        List<String> out = new ArrayList<>();
        n.forEach(x -> out.add(x.asString()));
        return out;
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
    void whileRedisDoesNotAnswerRequestsDoNotWaitForItAndHealthzSaysSo() throws Exception {
        timedGet("/api/v1/status"); // CSRF 쿠키(로그인 요청에 싣는다)
        String csrf = String.valueOf(cookies.get("WAKELINE_CSRF"));
        DockerClient docker = DockerClientFactory.instance().client();
        String id = redisContainerId();
        List<Timed> sigmets = new ArrayList<>();
        Timed first, status, login, healthz;
        docker.pauseContainerCmd(id).exec();
        try {
            first = timedGet("/api/v1/sigmets"); // 처음 무응답을 보는 요청 — 명령 상한까지 기다릴 수 있다
            for (int i = 0; i < 5; i++) sigmets.add(timedGet("/api/v1/sigmets"));
            status = timedGet("/api/v1/status");
            login = timed("POST", "/api/v1/ops/session", "{\"username\":\"it-redis-paused\",\"password\":\"not-checked-while-redis-is-down\"}",
                    Map.of("Content-Type", "application/json", "Accept", "application/json, application/problem+json", "Origin", ORIGIN,
                            "Sec-Fetch-Site", "same-origin", "X-CSRF-Token", csrf));
            healthz = timedGet("/healthz");
        } finally {
            docker.unpauseContainerCmd(id).exec();
        }
        System.out.printf("redis paused: first %d ms · public %s ms · /status %d ms · login %d %d ms · /healthz reasons %s%n", first.ms(),
                sigmets.stream().map(t -> String.valueOf(t.ms())).toList(), status.ms(), login.status(), login.ms(), reasons(healthz));
        SoftAssertions soft = new SoftAssertions();
        soft.assertThat(first.status()).as("first public request while Redis is paused (%d ms)", first.ms()).isEqualTo(200);
        for (Timed t : sigmets) {
            soft.assertThat(t.status()).isEqualTo(200);
            soft.assertThat(t.ms()).as("public request after the first no-answer — does not wait for Redis again").isLessThan(FAST_MS);
        }
        soft.assertThat(status.status()).isEqualTo(200);
        soft.assertThat(status.ms()).as("/status does not wait for its Redis reads (QA: 12 s)").isLessThan(FAST_MS);
        soft.assertThat(login.status()).as("login fails closed").isEqualTo(503);
        soft.assertThat(login.res().headers().firstValue("Retry-After")).isPresent();
        soft.assertThat(login.ms()).as("login answers 503 without waiting for Redis").isLessThan(FAST_MS);
        soft.assertThat(healthz.status()).as("/healthz stays 200 (edge healthcheck)").isEqualTo(200);
        soft.assertThat(reasons(healthz)).as("/healthz says Redis does not answer").contains("redis_unavailable");
        soft.assertAll();

        // 다시 풀면 뒤 확인이 Redis 의 답을 보고 차단기를 닫는다 — 다음 시험이 열린 차단기를 물려받지 않게 기다린다
        await("redis_unavailable cleared after unpause", Duration.ofSeconds(20), () -> {
            try { return !reasons(timedGet("/healthz")).contains("redis_unavailable"); } catch (Exception e) { return false; }
        });
    }
}
