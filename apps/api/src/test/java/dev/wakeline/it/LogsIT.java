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
import org.springframework.data.redis.connection.stream.RecordId;
import org.springframework.data.redis.connection.stream.StreamRecords;
import org.springframework.data.redis.core.RedisCallback;
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
import java.util.concurrent.TimeUnit;
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
 *   <li>§G2: 브라우저 오류는 wakeline:logs:client(MAXLEN ~ 1000)에 — 1,100건이 실려도 서버 로그(wakeline:logs)는 한 건도 밀려나지 않고,
 *       조회는 두 스트림을 합쳐(stream 표시) 보이며 항목 하나는 server → client 순으로 찾는다.</li>
 *   <li>§G9: 같은 경고가 10 s 안에 두 번 나고 끊겨도 두 번째는 창이 닫힐 때 실린다 — 묶음은 항목 2 · 억제 합 0.</li>
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
        String id = ItStack.admin().opsForStream().add(MapRecord.create(LogSink.STREAM, Map.of("e", e))).getValue();
        nextRedisMillisecond();
        return id;
    }

    static long redisNowMs() {
        return ItStack.admin().execute((RedisCallback<Long>) c -> c.serverCommands().time(TimeUnit.MILLISECONDS));
    }

    /**
     * 조회의 첫 쪽은 Redis TIME 앞 밀리초까지다(§G2 — 두 스트림의 한 시점, LogReader.snapshotLanes). 방금 실은 항목이 같은 밀리초의 조회에서
     * 빠지지 않게(다음 새로 고침에 보이는 것이 정상 동작) Redis 시계가 지금 밀리초를 지날 때까지 기다린다 — 1 ms 안팎.
     */
    static void nextRedisMillisecond() {
        long t = redisNowMs();
        long deadline = System.nanoTime() + 2_000_000_000L;
        while (redisNowMs() <= t) assertThat(System.nanoTime()).as("redis clock stuck at " + t).isLessThan(deadline);
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

    /** 지문의 메시지 틀이 바꾸지 않는 표식(16진 · 숫자 없이 g–z 글자만) — 이 시험만의 지문이 된다. */
    static String letters(int n) {
        StringBuilder b = new StringBuilder(n);
        for (int i = 0; i < n; i++) b.append((char) ('g' + ThreadLocalRandom.current().nextInt(20)));
        return b.toString();
    }

    /**
     * 계약 v5 §G9(문제 재현): 같은 경고가 10 s 창 안에 두 번 나고 다시 오지 않으면, 전에는 두 번째가 프로세스 메모리의 억제 수로만 남아
     * /logs 묶음이 "항목 1 · 억제 합 0" 이었다. 이제 창이 닫힌 뒤 보내는 스레드의 주기에 두 번째 발생이 제 항목으로 실린다
     * (그 발생의 메시지 · 요청 id · ts, suppressed 0) — 항목 수 + 억제 합 = 발생 수.
     */
    @Test
    void aWarningRepeatedInsideTheWindowIsSentWhenTheWindowCloses() throws InterruptedException {
        OpsBrowser b = login();
        String marker = letters(16);
        org.slf4j.Logger lg = LoggerFactory.getLogger(LogsIT.class);
        Instant before = Instant.now();
        MDC.put("request_id", "itfirst" + letters(12));
        try {
            lg.warn("trailing probe {} attempt {}", marker, 1);
            MDC.put("request_id", "itsecond" + letters(12));
            lg.warn("trailing probe {} attempt {}", marker, 2); // 숫자는 메시지 틀에서 # — 같은 지문, 창 안이라 억제
        } finally {
            MDC.remove("request_id");
        }
        String q = "/api/v1/ops/logs?service=api&q=" + enc(marker);
        AtomicReference<JsonNode> seen = new AtomicReference<>();
        await("the first occurrence", Duration.ofSeconds(15), () -> {
            seen.set(b.get(q).json().path("items"));
            return !seen.get().isEmpty();
        });
        if (Duration.between(before, Instant.now()).toSeconds() < 9)
            assertThat(seen.get()).as("the second occurrence is held back while the window is open").hasSize(1);
        // 창(10 s)이 닫히고 다음 주기(1 s)까지 — 천천히 묻는다
        JsonNode items = null;
        long end = System.nanoTime() + Duration.ofSeconds(30).toNanos();
        while (System.nanoTime() < end) {
            items = b.get(q).json().path("items");
            if (items.size() >= 2) break;
            Thread.sleep(500);
        }
        assertThat(items).as("both occurrences in /ops/logs").hasSize(2);
        JsonNode second = items.get(0), first = items.get(1);
        assertThat(first.path("message").asString()).isEqualTo("trailing probe " + marker + " attempt 1");
        assertThat(second.path("message").asString()).isEqualTo("trailing probe " + marker + " attempt 2");
        assertThat(second.path("request_id").asString()).startsWith("itsecond");
        assertThat(second.path("fp").asString()).isEqualTo(first.path("fp").asString());
        assertThat(first.path("suppressed").asLong()).isZero();
        assertThat(second.path("suppressed").asLong()).isZero();
        Instant t1 = Instant.parse(first.path("ts").asString()), t2 = Instant.parse(second.path("ts").asString());
        assertThat(t1).isAfterOrEqualTo(before.truncatedTo(java.time.temporal.ChronoUnit.MILLIS));
        assertThat(t2).isAfterOrEqualTo(t1).isBefore(t1.plusSeconds(10)); // 발생 때의 시각(실린 시각이 아니다)

        JsonNode g = null;
        for (JsonNode x : b.get("/api/v1/ops/logs/groups?service=api").json().path("groups"))
            if (first.path("fp").asString().equals(x.path("fp").asString())) g = x;
        assertThat(g).as("group of the probe").isNotNull();
        assertThat(g.path("count").asLong()).isEqualTo(2);
        assertThat(g.path("suppressed").asLong()).isZero();
        assertThat(g.path("last_at").asString()).isEqualTo(second.path("ts").asString());
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
        assertThat(e.path("stream").asString()).as("§G2 browser error stream").isEqualTo("client");
        String cid = e.path("id").asString();
        assertThat(ItStack.admin().opsForStream().range(LogSink.CLIENT_STREAM, org.springframework.data.domain.Range.closed(cid, cid))).hasSize(1);
        assertThat(ItStack.admin().opsForStream().range(LogSink.STREAM, org.springframework.data.domain.Range.closed(cid, cid)))
                .as("not in the server log stream").isEmpty();
        assertThat(ops.get("/api/v1/ops/logs/" + cid).json().path("message").asString()).contains(marker);
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

    /**
     * 계약 v5 §G2 의 목적: 누구나 보낼 수 있는 브라우저 오류가 1,100건 실려도(한 IP 는 분당 10 · 전체 분당 120 — 전체 한도로 약 9분) 서버 로그는
     * 한 건도 밀려나지 않는다. 한 스트림(MAXLEN ~ 3000)이던 때는 같은 양이 서버 오류를 그만큼 밀어냈다. 브라우저 오류 스트림은 1,000 근처로 잘린다.
     * api 와 같은 ACL 사용자 · 같은 XADD 옵션(LogSink.redisWriter)으로 싣는다 — api 의 ~wakeline:* 가 새 스트림도 덮는지까지.
     */
    @Test
    void a1100EntryBrowserFloodDoesNotEvictServerEntries() {
        OpsBrowser b = login();
        var writer = LogSink.redisWriter(ItStack.apiUser());
        String fp = randomFp();
        List<String> serverIds = new java.util.ArrayList<>();
        for (int i = 0; i < 30; i++) serverIds.add(xadd(collectorEntry(fp, "server error before the flood " + i, 0)));
        long serverLen = ItStack.admin().opsForStream().size(LogSink.STREAM);
        String flood = LogEvents.serialize(new LogEvents.Draft(Instant.now(), "web-client", "api-it:1", "ERROR", "browser", null,
                "TypeError: flood", null, null, Map.of("path", "/"), true), randomFp(), 0);
        try {
            for (int i = 0; i < 1_100; i++) writer.xadd(dev.wakeline.logs.LogStream.CLIENT, flood);
            nextRedisMillisecond();
            Long clientLen = ItStack.admin().opsForStream().size(LogSink.CLIENT_STREAM);
            // MAXLEN ~ 1000: 근사 트림은 내부 노드(기본 100 항목) 단위 — 1000 이상, 1000 + 노드 하나 이하
            assertThat(clientLen).isBetween(1_000L, 1_100L);
            assertThat(ItStack.admin().opsForStream().size(LogSink.STREAM)).as("the server stream did not move").isEqualTo(serverLen);
            for (String id : serverIds)
                assertThat(ItStack.admin().opsForStream().range(LogSink.STREAM, org.springframework.data.domain.Range.closed(id, id))).as(id).hasSize(1);
            // 조회: 가장 최근은 브라우저 오류(stream client), 서버 항목은 한 번 훑기로 모두(훑기 상한 = 스트림마다 MAXLEN + 노드 하나의 합)
            JsonNode top = b.get("/api/v1/ops/logs?limit=1").json();
            assertThat(top.path("items").get(0).path("stream").asString()).isEqualTo("client");
            assertThat(top.path("next_cursor").asString()).startsWith("client:");
            JsonNode mine = b.get("/api/v1/ops/logs?fp=" + fp + "&limit=200").json();
            assertThat(mine.path("items")).hasSize(30);
            assertThat(mine.path("scan_truncated").asBoolean()).isFalse();
            for (JsonNode it : mine.path("items")) assertThat(it.path("stream").asString()).isEqualTo("server");
            assertThat(mine.path("items").get(0).path("id").asString()).isEqualTo(serverIds.getLast());
            // 이어 읽기: 브라우저 오류 쪽에서 끊긴 커서로도 서버 항목에 닿는다
            JsonNode next = b.get("/api/v1/ops/logs?limit=200&cursor=" + enc(top.path("next_cursor").asString())).json();
            assertThat(next.path("items")).hasSize(200);
            // 묶음도 두 스트림: 서버 fp 묶음 30건 · 브라우저 오류 묶음(1,000 근처)
            JsonNode groups = b.get("/api/v1/ops/logs/groups").json();
            JsonNode g = null, web = null;
            for (JsonNode x : groups.path("groups")) {
                if (fp.equals(x.path("fp").asString())) g = x;
                if ("web-client".equals(x.path("service").asString()) && "TypeError: flood".equals(x.path("sample_message").asString())) web = x;
            }
            assertThat(g).isNotNull();
            assertThat(g.path("count").asLong()).isEqualTo(30);
            assertThat(g.path("last_stream").asString()).isEqualTo("server");
            assertThat(web).isNotNull();
            assertThat(web.path("count").asLong()).isEqualTo(clientLen);
            assertThat(web.path("last_stream").asString()).isEqualTo("client");
            // 항목 하나: 서버 스트림에 없는 id 는 브라우저 오류 스트림에서
            String clientId = top.path("items").get(0).path("id").asString();
            assertThat(b.get("/api/v1/ops/logs/" + clientId).json().path("stream").asString()).isEqualTo("client");
            assertProblem(b.get("/api/v1/ops/logs/" + clientId + "?stream=server"), 404, "NOT_FOUND", "/api/v1/ops/logs/" + clientId);
        } finally {
            ItStack.admin().delete(LogSink.CLIENT_STREAM); // 다른 조회 시험의 훑기 상한에 걸리지 않게
        }
    }

    /**
     * §G2 첫 쪽은 두 스트림의 한 시점 — Redis TIME 앞 밀리초까지(LogReader.snapshotLanes, api ACL 사용자가 TIME 을 부른다). 전제인 실제 Redis 의
     * id 규칙까지: id 를 지정해 시계보다 앞선 항목을 실으면 뒤이은 자동 id 도 그 ms 를 이어 쓴다. 여유(60 s) 안이면 시계가 지날 때까지 첫 쪽에서
     * 빠졌다가 보이고, 그보다 앞서면 자르지 않고 곧바로 보인다 — 시계가 뒤로 간 동안 새 오류를 숨기지 않는다.
     */
    @Test
    void theFirstPageIsCutAtTheRedisClockUnlessStreamIdsRunFarAhead() {
        OpsBrowser b = login();
        String fp = randomFp();
        String q = "/api/v1/ops/logs?fp=" + fp;
        try {
            String near = (redisNowMs() + 2_000) + "-0";
            ItStack.admin().opsForStream().add(StreamRecords.newRecord().in(LogSink.STREAM).withId(RecordId.of(near))
                    .ofMap(Map.of("e", collectorEntry(fp, "two seconds ahead of the redis clock", 0))));
            assertThat(b.get(q).json().path("items")).as("cut at the redis time until the clock passes it").isEmpty();
            await("the entry once the redis clock passes it", Duration.ofSeconds(15), () -> b.get(q).json().path("items").size() == 1);

            String far = (redisNowMs() + 3_600_000) + "-0";
            ItStack.admin().opsForStream().add(StreamRecords.newRecord().in(LogSink.STREAM).withId(RecordId.of(far))
                    .ofMap(Map.of("e", collectorEntry(fp, "an hour ahead of the redis clock", 0))));
            String after = xadd(collectorEntry(fp, "auto id after it", 0));
            assertThat(after).as("redis keeps the last id's ms while the clock is behind").isEqualTo(far.substring(0, far.indexOf('-')) + "-1");
            JsonNode page = b.get(q).json();
            assertThat(page.path("items")).extracting(n -> n.path("id").asString()).containsExactly(after, far, near);
            JsonNode groups = b.get("/api/v1/ops/logs/groups?service=collector").json();
            JsonNode g = null;
            for (JsonNode x : groups.path("groups")) if (fp.equals(x.path("fp").asString())) g = x;
            assertThat(g).isNotNull();
            assertThat(g.path("count").asLong()).isEqualTo(3);
        } finally {
            ItStack.admin().delete(LogSink.STREAM); // 앞선 마지막 id 를 지운다 — 뒤 시험의 자동 id 가 시계를 따르게
        }
    }

    /**
     * §G2: 한 번 훑기는 두 스트림 전체를 본다 — 근사 트림(MAXLEN ~)이 남기는 만큼까지. 작은 항목이면 Redis 내부 노드가 100 항목으로 차서 한 스트림이
     * MAXLEN + 99 건까지 남는다(여기서 3,300 · 1,150 건을 실으면 약 3,000 · 1,050 — 합이 4,000 을 넘는다). 항목은 스키마에 맞지 않는 짧은 값이라
     * invalid 로 세지만 훑은 수에는 든다. 실제 로그 항목(수백 바이트 이상)은 노드가 4 KiB(stream-node-max-bytes)에서 닫혀 넘치는 수가 더 적다.
     */
    @Test
    void bothStreamsAtTheirApproximateTrimLimitFitInOneScan() {
        OpsBrowser b = login();
        var writer = LogSink.redisWriter(ItStack.apiUser());
        try {
            ItStack.admin().delete(List.of(LogSink.STREAM, LogSink.CLIENT_STREAM));
            for (int i = 0; i < 3_300; i++) writer.xadd(dev.wakeline.logs.LogStream.SERVER, "x");
            for (int i = 0; i < 1_150; i++) writer.xadd(dev.wakeline.logs.LogStream.CLIENT, "x");
            nextRedisMillisecond();
            long serverLen = ItStack.admin().opsForStream().size(LogSink.STREAM), clientLen = ItStack.admin().opsForStream().size(LogSink.CLIENT_STREAM);
            assertThat(serverLen).isBetween(3_000L, 3_099L);
            assertThat(clientLen).isBetween(1_000L, 1_099L);
            assertThat(serverLen + clientLen).as("both streams past their MAXLEN at once").isGreaterThan(4_000L);
            JsonNode groups = b.get("/api/v1/ops/logs/groups").json();
            assertThat(groups.path("scan_truncated").asBoolean()).isFalse();
            assertThat(groups.path("scanned").asLong()).isGreaterThanOrEqualTo(serverLen + clientLen); // 그사이 앱 경고가 실렸으면 그만큼 더
            JsonNode list = b.get("/api/v1/ops/logs?service=ais").json(); // 아무것도 맞지 않는다 — 끝까지 훑는다
            assertThat(list.path("scan_truncated").asBoolean()).isFalse();
            assertThat(list.path("next_cursor").isNull()).isTrue();
        } finally {
            ItStack.admin().delete(List.of(LogSink.STREAM, LogSink.CLIENT_STREAM));
        }
    }

    @Test
    void xaddTrimsTheStreamToAbout3000Entries() {
        var writer = LogSink.redisWriter(ItStack.apiUser()); // api 와 같은 ACL 사용자 · 같은 XADD 옵션
        String e = collectorEntry(randomFp(), "trim probe", 0);
        try {
            for (int i = 0; i < 3_300; i++) writer.xadd(dev.wakeline.logs.LogStream.SERVER, e);
            Long len = ItStack.admin().opsForStream().size(LogSink.STREAM);
            // MAXLEN ~ 3000: 근사 트림은 내부 노드(기본 100 항목) 단위로 자른다 — 3000 이상, 3000 + 노드 하나 이하
            assertThat(len).isBetween(3_000L, 3_100L);
        } finally {
            ItStack.admin().delete(LogSink.STREAM); // 다른 조회 시험이 훑기 상한에 걸리지 않게
        }
    }
}
