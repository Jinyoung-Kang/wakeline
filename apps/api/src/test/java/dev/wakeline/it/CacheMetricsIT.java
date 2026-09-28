package dev.wakeline.it;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIf;

import java.net.URI;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * R-53: 캐시가 효과가 있는지 볼 수 있게 적중·실패 지표(wakeline_cache_requests_total{cache, result})를 내고, REST /status 는 WS 와 같은 3 s
 * status 캐시를 쓴다(이전: 요청마다 Redis 해시를 여러 번 읽었다).
 */
@EnabledIf("dev.wakeline.DbTestSupport#dockerAvailable")
class CacheMetricsIT extends IntegrationTest {
    @org.springframework.boot.test.web.server.LocalManagementPort int managementPort;

    String prometheus() throws Exception {
        return HTTP.send(HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + managementPort + "/actuator/prometheus")).build(),
                HttpResponse.BodyHandlers.ofString()).body();
    }

    @Test
    void restStatusSharesTheThreeSecondStatusCacheAndCachesReportHitsAndMisses() throws Exception {
        // 두 요청이 같은 3 s 창에 들어오게(경계 직후면 다음 창을 기다린다)
        String first = get("/api/v1/status").json().path("server_time").asString();
        String second = get("/api/v1/status").json().path("server_time").asString();
        if (!first.equals(second)) { // 첫 요청이 창의 끝이었다 — 새 창에서 다시
            first = get("/api/v1/status").json().path("server_time").asString();
            second = get("/api/v1/status").json().path("server_time").asString();
        }
        assertThat(second).as("the same cached status within 3 s").isEqualTo(first);

        String prom = prometheus();
        for (String cache : new String[]{"status", "aircraft_json", "route"}) {
            assertThat(prom).as(cache).contains("wakeline_cache_requests_total{cache=\"" + cache + "\",result=\"hit\"}")
                    .contains("wakeline_cache_requests_total{cache=\"" + cache + "\",result=\"miss\"}");
        }
    }
}
