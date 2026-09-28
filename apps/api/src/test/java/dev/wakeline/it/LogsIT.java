package dev.wakeline.it;

import dev.wakeline.logs.LogEvents;
import dev.wakeline.logs.LogSink;
import dev.wakeline.ops.OpsUserService;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIf;
import org.slf4j.LoggerFactory;
import org.slf4j.MDC;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.data.redis.connection.stream.MapRecord;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.scheduling.annotation.ScheduledAnnotationBeanPostProcessor;
import tools.jackson.databind.JsonNode;

import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ThreadLocalRandom;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 계약 v5 §C(api 부분) 끝에서 끝까지 — 실제 앱 · ACL Redis(wakeline_api):
 * <ul>
 *   <li>§C2: 앱의 WARN(요청 MDC 포함)이 logback 싱크를 거쳐 wakeline:logs 에 실리고(설정 비밀값 가림), 자기 지표가 pipeline 에 보인다.
 *       @Scheduled 작업 안의 WARN 은 context.job 에 작업 이름이 있다. XADD 는 MAXLEN ~ 3000.</li>
 *   <li>§C4: 운영 조회 — 익명 404, 목록 · 필터 · fp 묶음 · 항목 하나 · 스키마에 맞지 않는 항목은 invalid.</li>
 *   <li>§C6: 브라우저 오류 공개 수집 — 204 → untrusted web-client 항목, 새 제한 키 rl:cerr:*, IP당 분당 10 초과 429, JSON 이 아니면 415(§G3).</li>
 * </ul>
 * 수집기 모양의 항목은 관리 사용자로 XADD 한다 — 수집기 ACL 에 ~wakeline:logs 를 더하는 것은 infra 레인(§C3)이다.
 */
@EnabledIf("dev.wakeline.DbTestSupport#dockerAvailable")
class LogsIT extends IntegrationTest {
    static final String PW = "logs-horse-battery-staple";

    @Autowired OpsUserService users;
    @Autowired ScheduledAnnotationBeanPostProcessor scheduling;

    OpsBrowser login() { return OpsBrowser.login(this, users, "it-logs", PW); }

    static String enc(String s) { return URLEncoder.encode(s, StandardCharsets.UTF_8); }

    static String randomFp() {
        byte[] b = new byte[8];
        ThreadLocalRandom.current().nextBytes(b);
        return HexFormat.of().formatHex(b);
    }

    /** 수집기가 싣는 모양의 항목(스키마 v1). */
    static String collectorEntry(String fp, String message, int suppressed) {
        var d = new LogEvents.Draft(Instant.now(), "collector", "collector-1:7", "ERROR", "wakeline_collector.jobs.region", "MainThread",
                message, new LogEvents.Ex("httpx.ReadTimeout", "timed out", "Traceback (most recent call last):\n  ..."), null,
                Map.of("job", "region"), false);
        return LogEvents.serialize(d, fp, suppressed);
    }

    static String xadd(String e) {
        return ItStack.admin().opsForStream().add(MapRecord.create(LogSink.STREAM, Map.of("e", e))).getValue();
    }

    @Test
    void opsLogEndpointsAreHiddenFromAnonymousUsers() {
        assertProblem(get("/api/v1/ops/logs"), 404, "NOT_FOUND", "/api/v1/ops/logs");
        assertProblem(get("/api/v1/ops/logs/groups"), 404, "NOT_FOUND", "/api/v1/ops/logs/groups");
        assertProblem(get("/api/v1/ops/logs/1-0"), 404, "NOT_FOUND", "/api/v1/ops/logs/1-0");
    }

    @Test
    void appWarningIsShippedMaskedWithItsRequestId_andCounted() {
        OpsBrowser b = login();
        long sentBefore = b.get("/api/v1/ops/pipeline").json().path("api").path("log_sent").asLong();
        String marker = "probe" + UUID.randomUUID().toString().replace("-", "");
        String rid = "it" + UUID.randomUUID().toString().replace("-", "");
        MDC.put("request_id", rid);
        try {
            // 설정 비밀값(spring.data.redis.password)과 모양(password=)이 모두 가려져야 한다
            LoggerFactory.getLogger(LogsIT.class).warn("log pipeline {} password={} redis said {}", marker, "hunter2", ItStack.REDIS_API_PW);
        } finally {
            MDC.remove("request_id");
        }
        AtomicReference<JsonNode> found = new AtomicReference<>();
        await("the warning in GET /api/v1/ops/logs", Duration.ofSeconds(15), () -> {
            JsonNode items = b.get("/api/v1/ops/logs?q=" + enc(marker)).json().path("items");
            if (items.isEmpty()) return false;
            found.set(items.get(0));
            return true;
        });
        JsonNode e = found.get();
        assertThat(e.path("id").asString()).matches("\\d+-\\d+");
        assertThat(e.path("service").asString()).isEqualTo("api");
        assertThat(e.path("level").asString()).isEqualTo("WARN");
        assertThat(e.path("logger").asString()).isEqualTo(LogsIT.class.getName());
        assertThat(e.path("request_id").asString()).isEqualTo(rid);
        assertThat(e.path("message").asString()).contains(marker).contains("password=***").doesNotContain("hunter2")
                .doesNotContain(ItStack.REDIS_API_PW);
        assertThat(e.path("exception").isNull()).isTrue();
        assertThat(e.path("fp").asString()).matches("[0-9a-f]{16}");
        // 같은 요청 id 로 찾기
        assertThat(b.get("/api/v1/ops/logs?rid=" + rid).json().path("items").get(0).path("id").asString()).isEqualTo(e.path("id").asString());
        // 원본 스트림에도 가린 값만 있다
        List<MapRecord<String, Object, Object>> raw = ItStack.admin().opsForStream().range(LogSink.STREAM,
                org.springframework.data.domain.Range.closed(e.path("id").asString(), e.path("id").asString()));
        assertThat(String.valueOf(raw.getFirst().getValue().get("e"))).doesNotContain(ItStack.REDIS_API_PW).doesNotContain("hunter2");
        // 자기 지표(wakeline_log_events_total{result="sent"}) → pipeline
        assertThat(b.get("/api/v1/ops/pipeline").json().path("api").path("log_sent").asLong()).isGreaterThan(sentBefore);
    }

    /** 시험용 예약 작업: 처음 한 번만 경고를 남긴다. */
    static final class ProbeJob {
        final String marker;
        final AtomicBoolean done = new AtomicBoolean();

        ProbeJob(String marker) { this.marker = marker; }

        @Scheduled(fixedDelay = 3_600_000)
        public void warnOnce() {
            if (done.compareAndSet(false, true)) LoggerFactory.getLogger(ProbeJob.class).warn("scheduled probe {} could not finish", marker);
        }
    }

    /**
     * §C2 "context 는 스레드 이름 외에 작업 이름 등": 예약 작업은 스케줄러 풀(sched-*)에서 돌아 스레드 이름으로는 어느 작업인지 모른다 —
     * @Scheduled 메서드 안의 WARN 은 context.job = 클래스.메서드. 앱의 @Scheduled 처리기 · 스케줄러 · 관측 레지스트리를 그대로 거친다.
     */
    @Test
    void aWarningInsideAScheduledJobCarriesTheJobName() {
        OpsBrowser b = login();
        String marker = "sched" + UUID.randomUUID().toString().replace("-", "");
        ProbeJob job = new ProbeJob(marker);
        scheduling.postProcessAfterInitialization(job, "logsItProbeJob"); // 앱의 @Scheduled 작업처럼 등록 — 곧바로 한 번 돈다
        try {
            AtomicReference<JsonNode> found = new AtomicReference<>();
            await("the scheduled job's warning in GET /api/v1/ops/logs", Duration.ofSeconds(15), () -> {
                JsonNode items = b.get("/api/v1/ops/logs?service=api&q=" + enc(marker)).json().path("items");
                if (items.isEmpty()) return false;
                found.set(items.get(0));
                return true;
            });
            JsonNode e = found.get();
            assertThat(e.path("context").path("job").asString()).isEqualTo("ProbeJob.warnOnce");
            assertThat(e.path("thread").asString()).startsWith("sched-");
            assertThat(e.path("request_id").isNull()).isTrue();
        } finally {
            scheduling.postProcessBeforeDestruction(job, "logsItProbeJob");
        }
        // 작업 밖의 경고에는 job 이 없다(스케줄러 스레드의 MDC 를 작업이 끝나면 되돌린다)
        String outside = "nojob" + UUID.randomUUID().toString().replace("-", "");
        LoggerFactory.getLogger(LogsIT.class).warn("outside any job {}", outside);
        AtomicReference<JsonNode> plain = new AtomicReference<>();
        await("the plain warning", Duration.ofSeconds(15), () -> {
            JsonNode items = b.get("/api/v1/ops/logs?q=" + enc(outside)).json().path("items");
            if (items.isEmpty()) return false;
            plain.set(items.get(0));
            return true;
        });
        assertThat(plain.get().path("context").has("job")).isFalse();
    }

    @Test
    void listFiltersGroupsAndOneEntry_skippingInvalidEntries() {
        OpsBrowser b = login();
        String fp = randomFp();
        String older = xadd(collectorEntry(fp, "provider adsb_fi timed out after 10 s", 0));
        xadd("{\"not\":\"a log event\"}");
        String newer = xadd(collectorEntry(fp, "provider adsb_fi timed out after 12 s", 3));

        JsonNode page = b.get("/api/v1/ops/logs?service=collector&fp=" + fp).json();
        assertThat(page.path("items")).hasSize(2);
        assertThat(page.path("items").get(0).path("id").asString()).isEqualTo(newer);
        assertThat(page.path("items").get(1).path("id").asString()).isEqualTo(older);
        assertThat(page.path("invalid").asInt()).isGreaterThanOrEqualTo(1);
        assertThat(page.has("next_cursor") && page.get("next_cursor").isNull()).isTrue();
        assertThat(page.path("scan_truncated").asBoolean()).isFalse();
        assertThat(page.path("scanned").asInt()).isGreaterThanOrEqualTo(3);

        // 쪽 나누기: limit 1 → next_cursor 로 이어 읽기
        JsonNode p1 = b.get("/api/v1/ops/logs?fp=" + fp + "&limit=1").json();
        assertThat(p1.path("items").get(0).path("id").asString()).isEqualTo(newer);
        JsonNode p2 = b.get("/api/v1/ops/logs?fp=" + fp + "&limit=1&cursor=" + p1.path("next_cursor").asString()).json();
        assertThat(p2.path("items").get(0).path("id").asString()).isEqualTo(older);

        JsonNode groups = b.get("/api/v1/ops/logs/groups?service=collector").json();
        JsonNode g = null;
        for (JsonNode x : groups.path("groups")) if (fp.equals(x.path("fp").asString())) g = x;
        assertThat(g).as("group for " + fp).isNotNull();
        assertThat(g.path("count").asLong()).isEqualTo(2);
        assertThat(g.path("suppressed").asLong()).isEqualTo(3);
        assertThat(g.path("service").asString()).isEqualTo("collector");
        assertThat(g.path("exception_type").asString()).isEqualTo("httpx.ReadTimeout");
        assertThat(g.path("sample_message").asString()).isEqualTo("provider adsb_fi timed out after 12 s");
        assertThat(g.path("last_id").asString()).isEqualTo(newer);
        assertThat(Instant.parse(g.path("first_at").asString())).isBeforeOrEqualTo(Instant.parse(g.path("last_at").asString()));

        JsonNode one = b.get("/api/v1/ops/logs/" + older).json();
        assertThat(one.path("id").asString()).isEqualTo(older);
        assertThat(one.path("context").path("job").asString()).isEqualTo("region");
        assertProblem(b.get("/api/v1/ops/logs/1-0"), 404, "NOT_FOUND", "/api/v1/ops/logs/1-0");
        assertProblem(b.get("/api/v1/ops/logs?service=nope"), 400, "BAD_SERVICE", "/api/v1/ops/logs");
    }

    @Test
    void browserErrorsAreAcceptedAsUntrustedAndRateLimitedPerIp() {
        awaitFreshMinuteWindow(20);
        OpsBrowser ops = login();
        String marker = "cerr" + UUID.randomUUID().toString().replace("-", "");
        String body = "{\"message\":\"TypeError: " + marker + " is undefined\",\"stack\":\"at f (app.js:1:2)\",\"path\":\"/map?x=1\","
                + "\"component\":\"MapView\",\"ts\":\"2026-09-29T03:04:00.123Z\"}";
        Res r = send("POST", "/api/v1/client-errors", body, headers("Content-Type", "application/json", "User-Agent", "ItBrowser/1.0"));
        assertThat(r.status()).as(r.body()).isEqualTo(204);
        assertThat(ItStack.admin().keys("rl:cerr:*")).as("new limiter keys rl:cerr:{ip|all}:{minute}")
                .anyMatch(k -> k.startsWith("rl:cerr:127.0.0.1:")).anyMatch(k -> k.startsWith("rl:cerr:all:"));

        AtomicReference<JsonNode> found = new AtomicReference<>();
        await("the browser error in GET /api/v1/ops/logs", Duration.ofSeconds(15), () -> {
            JsonNode items = ops.get("/api/v1/ops/logs?service=web-client&q=" + enc(marker)).json().path("items");
            if (items.isEmpty()) return false;
            found.set(items.get(0));
            return true;
        });
        JsonNode e = found.get();
        assertThat(e.path("untrusted").asBoolean()).isTrue();
        assertThat(e.path("level").asString()).isEqualTo("ERROR");
        assertThat(e.path("logger").asString()).isEqualTo("MapView");
        assertThat(e.path("context").path("path").asString()).isEqualTo("/map");
        assertThat(e.path("context").path("user_agent").asString()).isEqualTo("ItBrowser/1.0");
        assertThat(e.path("context").path("client_ts").asString()).isEqualTo("2026-09-29T03:04:00.123Z");

        // 형식 오류 400 · 너무 큼 413
        assertProblem(send("POST", "/api/v1/client-errors", "{\"message\":\"x\"}", headers("Content-Type", "application/json")),
                400, "BAD_CLIENT_ERROR", "/api/v1/client-errors");
        String big = "{\"message\":\"" + "m".repeat(9000) + "\",\"path\":\"/\",\"ts\":\"2026-09-29T03:04:00Z\"}";
        assertProblem(send("POST", "/api/v1/client-errors", big, headers("Content-Type", "application/json")), 413, "TOO_LARGE", "/api/v1/client-errors");
        // §G3: JSON 이 아닌 Content-Type 은 415(로그인과 같은 관례) — 처리기 앞에서 거절하므로 요청 제한 수를 쓰지 않는다
        Res notJson = send("POST", "/api/v1/client-errors", body, headers("Content-Type", "text/plain"));
        assertProblem(notJson, 415, "UNSUPPORTED_MEDIA_TYPE", "/api/v1/client-errors");
        assertThat(notJson.header("Accept")).contains("application/json");
        // 지금까지 3건(415 는 세지 않는다) — 10건까지는 받고 11번째는 429
        for (int i = 3; i < 10; i++)
            assertThat(send("POST", "/api/v1/client-errors", body, headers("Content-Type", "application/json")).status()).isEqualTo(204);
        Res limited = send("POST", "/api/v1/client-errors", body, headers("Content-Type", "application/json"));
        assertProblem(limited, 429, "RATE_LIMITED", "/api/v1/client-errors");
        assertThat(limited.header("Retry-After")).isNotBlank();
    }

    @Test
    void xaddTrimsTheStreamToAbout3000Entries() {
        var writer = LogSink.redisWriter(ItStack.apiUser()); // api 와 같은 ACL 사용자 · 같은 XADD 옵션
        String e = collectorEntry(randomFp(), "trim probe", 0);
        try {
            for (int i = 0; i < 3_300; i++) writer.xadd(e);
            Long len = ItStack.admin().opsForStream().size(LogSink.STREAM);
            // MAXLEN ~ 3000: 근사 트림은 내부 노드(기본 100 항목) 단위로 자른다 — 3000 이상, 3000 + 노드 하나 이하
            assertThat(len).isBetween(3_000L, 3_100L);
        } finally {
            ItStack.admin().delete(LogSink.STREAM); // 다른 조회 시험이 3,000건 훑기 상한에 걸리지 않게
        }
    }
}
