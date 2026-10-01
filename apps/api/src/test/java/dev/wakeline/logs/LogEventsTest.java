package dev.wakeline.logs;

import ch.qos.logback.classic.Level;
import ch.qos.logback.classic.LoggerContext;
import ch.qos.logback.classic.spi.LoggingEvent;
import ch.qos.logback.classic.spi.ThrowableProxyUtil;
import dev.wakeline.platform.support.LogMasker;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Instant;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 계약 v5 §C1·§C2(api 보내는 쪽의 항목 만들기): 지문(fp) = SHA-256(서비스·로거·예외 종류·메시지 틀) 앞 16자리, 필드 상한(스키마)과
 * 직렬화 8 KiB 상한(stack → exception.message → message 순으로 잘라 '…(잘림 N자)'), 결과는 schemas/log_event.v1.json 을 만족한다.
 */
class LogEventsTest {
    static final JsonMapper M = JsonMapper.builder().build();
    static final LogEventSchema SCHEMA = new LogEventSchema();
    static final Instant T = Instant.parse("2026-09-29T01:02:03Z");
    static final Pattern MARK = Pattern.compile("…\\(잘림 (\\d+)자\\)$");

    @AfterEach
    void clearSecrets() { LogMasker.clearSecrets(); }

    static LogEvents.Draft draft(String message, LogEvents.Ex ex) {
        return new LogEvents.Draft(T, "api", "api-host:1", "ERROR", "dev.wakeline.ingest.StreamConsumer", "stream-consumer", message, ex,
                null, Map.of(), false);
    }

    static JsonNode json(String s) { return M.readTree(s); }

    static int cp(String s) { return s.codePointCount(0, s.length()); }

    @Test
    void messageTemplateReplacesNumbersHexAndQuotedStrings() {
        assertThat(LogEvents.template("took 123 ms for 42 aircraft")).isEqualTo("took # ms for # aircraft");
        assertThat(LogEvents.template("request 0199a3b4c5d6e7f8 failed")).isEqualTo("request # failed");
        assertThat(LogEvents.template("unknown key \"abc 123\" in 'x y'")).isEqualTo("unknown key '…' in '…'");
        assertThat(LogEvents.template("at 0x1f2e3d4c5b")).isEqualTo("at #x#");
        assertThat(LogEvents.template("no numbers")).isEqualTo("no numbers");
    }

    @Test
    void fingerprintIsSha256PrefixOfServiceLoggerTypeAndTemplate() throws Exception {
        String fp = LogEvents.fingerprint("api", "dev.wakeline.X", "java.io.IOException", "timeout after 3000 ms");
        byte[] d = MessageDigest.getInstance("SHA-256")
                .digest("api\ndev.wakeline.X\njava.io.IOException\ntimeout after # ms".getBytes(StandardCharsets.UTF_8));
        assertThat(fp).isEqualTo(HexFormat.of().formatHex(d).substring(0, 16)).matches("[0-9a-f]{16}");
        // 숫자만 다른 메시지는 같은 묶음, 서비스·로거·예외 종류가 다르면 다른 묶음
        assertThat(LogEvents.fingerprint("api", "dev.wakeline.X", "java.io.IOException", "timeout after 15 ms")).isEqualTo(fp);
        assertThat(LogEvents.fingerprint("collector", "dev.wakeline.X", "java.io.IOException", "timeout after 15 ms")).isNotEqualTo(fp);
        assertThat(LogEvents.fingerprint("api", "dev.wakeline.Y", "java.io.IOException", "timeout after 15 ms")).isNotEqualTo(fp);
        assertThat(LogEvents.fingerprint("api", "dev.wakeline.X", null, "timeout after 15 ms")).isNotEqualTo(fp)
                .isEqualTo(LogEvents.fingerprint("api", "dev.wakeline.X", "", "timeout after 1 ms"));
    }

    @Test
    void serializedEventMatchesTheSchemaWithMillisecondUtcTime() {
        var ex = new LogEvents.Ex("java.lang.IllegalStateException", "boom", "java.lang.IllegalStateException: boom\n\tat x.Y.z(Y.java:1)");
        Map<String, Object> ctx = new LinkedHashMap<>();
        ctx.put("job", "retention");
        var d = new LogEvents.Draft(T, "api", "api-host:1", "WARN", "dev.wakeline.persist.MaintenanceJobs", null, "failed 3 times", ex,
                "0199a3b4c5d6e7f8a9b0c1d2", ctx, false);
        String s = LogEvents.serialize(d, "0123456789abcdef", 4);
        assertThat(SCHEMA.validate(s)).as(s).isNull();
        JsonNode n = json(s);
        assertThat(n.path("v").asInt()).isEqualTo(1);
        assertThat(n.path("ts").asString()).isEqualTo("2026-09-29T01:02:03.000Z");
        assertThat(n.path("service").asString()).isEqualTo("api");
        assertThat(n.path("level").asString()).isEqualTo("WARN");
        assertThat(n.has("thread") && n.get("thread").isNull()).isTrue();
        assertThat(n.path("exception").path("type").asString()).isEqualTo("java.lang.IllegalStateException");
        assertThat(n.path("fp").asString()).isEqualTo("0123456789abcdef");
        assertThat(n.path("request_id").asString()).isEqualTo("0199a3b4c5d6e7f8a9b0c1d2");
        assertThat(n.path("context").path("job").asString()).isEqualTo("retention");
        assertThat(n.path("suppressed").asInt()).isEqualTo(4);
        assertThat(n.has("untrusted")).as("untrusted only on web-client").isFalse();

        // 예외 없는 WARN 은 exception null
        String noEx = LogEvents.serialize(draft("plain warning", null), "0123456789abcdef", 0);
        assertThat(SCHEMA.validate(noEx)).isNull();
        assertThat(json(noEx).get("exception").isNull()).isTrue();
    }

    @Test
    void fieldsAreCutToTheSchemaLimitsWithAVisibleMarker() {
        var ex = new LogEvents.Ex("T".repeat(300), "m".repeat(2500), "s".repeat(15_000));
        Map<String, Object> ctx = new LinkedHashMap<>();
        for (int i = 0; i < 25; i++) ctx.put("k" + i, "v".repeat(250));
        var d = new LogEvents.Draft(T, "api", "h".repeat(80), "ERROR", "L".repeat(300), "t".repeat(150), "x".repeat(5000), ex, null, ctx, false);
        // 8 KiB 상한 전의 필드 상한만 본다
        JsonNode n = json(LogEvents.toJson(LogEvents.limitFields(d), "0123456789abcdef", 0));
        assertThat(cp(n.path("message").asString())).isEqualTo(4000);
        assertCut(n.path("message").asString(), 5000);
        assertThat(cp(n.path("exception").path("message").asString())).isEqualTo(2000);
        assertCut(n.path("exception").path("message").asString(), 2500);
        assertThat(cp(n.path("exception").path("stack").asString())).isEqualTo(12000);
        assertCut(n.path("exception").path("stack").asString(), 15_000);
        assertThat(cp(n.path("exception").path("type").asString())).isLessThanOrEqualTo(200);
        assertThat(cp(n.path("logger").asString())).isLessThanOrEqualTo(200);
        assertThat(cp(n.path("thread").asString())).isLessThanOrEqualTo(100);
        assertThat(cp(n.path("instance").asString())).isLessThanOrEqualTo(64);
        assertThat(n.path("context").size()).isEqualTo(20);
        for (var e : n.path("context").properties()) assertThat(cp(e.getValue().asString())).isLessThanOrEqualTo(200);
    }

    @Test
    void serializedSizeIsCappedAt8KiB_cuttingStackFirst() {
        var ex = new LogEvents.Ex("java.io.IOException", "short", "s".repeat(15_000));
        String s = LogEvents.serialize(draft("m".repeat(1000), ex), "0123456789abcdef", 0);
        assertThat(s.getBytes(StandardCharsets.UTF_8).length).isLessThanOrEqualTo(LogEvents.MAX_BYTES);
        assertThat(SCHEMA.validate(s)).isNull();
        JsonNode n = json(s);
        assertThat(n.path("message").asString()).isEqualTo("m".repeat(1000));          // 스택을 줄이는 것으로 충분 — 메시지는 그대로
        assertThat(n.path("exception").path("message").asString()).isEqualTo("short");
        assertCut(n.path("exception").path("stack").asString(), 15_000);
        // 거의 꽉 채운다(너무 많이 자르지 않는다)
        assertThat(s.getBytes(StandardCharsets.UTF_8).length).isGreaterThan(LogEvents.MAX_BYTES - 64);
    }

    @Test
    void whenTheStackIsNotEnough_exceptionMessageThenMessageAreCut() {
        // 한글 3바이트 × 4000 = 12,000 바이트 메시지 — 스택·예외 메시지를 다 비워도 넘친다 → 메시지까지 자른다
        var ex = new LogEvents.Ex("java.io.IOException", "예".repeat(2000), "스".repeat(3000));
        String s = LogEvents.serialize(draft("가".repeat(4000), ex), "0123456789abcdef", 0);
        assertThat(s.getBytes(StandardCharsets.UTF_8).length).isLessThanOrEqualTo(LogEvents.MAX_BYTES);
        assertThat(SCHEMA.validate(s)).isNull();
        JsonNode n = json(s);
        assertCut(n.path("exception").path("stack").asString(), 3000);
        assertCut(n.path("exception").path("message").asString(), 2000);
        assertCut(n.path("message").asString(), 4000);
        assertThat(n.path("exception").path("stack").asString()).startsWith("…(잘림 3000자)"); // 스택은 모두 잘렸다
    }

    @Test
    void emptyStackIsFineAndControlCharactersAreEscaped() {
        String s = LogEvents.serialize(draft("line1\nline2\t\u0001", new LogEvents.Ex("E", null, "")), "0123456789abcdef", 0);
        assertThat(SCHEMA.validate(s)).isNull();
        assertThat(json(s).path("message").asString()).isEqualTo("line1\nline2\t\u0001");
        assertThat(json(s).path("exception").get("message").isNull()).isTrue();
    }

    @Test
    void logbackEventIsMaskedAndCarriesRequestIdAndMdcContext() {
        LogMasker.registerSecrets("db-password-value");
        var ctx = new LoggerContext();
        var logger = ctx.getLogger("dev.wakeline.aircraft.data.TrackWriter");
        var cause = new java.sql.SQLException("auth failed for db-password-value");
        var top = new IllegalStateException("connect redis://u:pw123@redis:6379 failed", cause);
        var e = new LoggingEvent("fqcn", logger, Level.ERROR, "batch failed password={} after {} ms", top, new Object[]{"hunter2", 1500});
        e.setInstant(T);
        e.setThreadName("track-writer");
        e.setMDCPropertyMap(Map.of("request_id", "0199a3b4c5d6e7f8a9b0c1d2", "job", "flush"));
        LogEvents.Draft d = LogEvents.fromLogback(e, "api-host:1");
        assertThat(d.message()).isEqualTo("batch failed password=*** after 1500 ms");
        assertThat(d.level()).isEqualTo("ERROR");
        assertThat(d.thread()).isEqualTo("track-writer");
        assertThat(d.requestId()).isEqualTo("0199a3b4c5d6e7f8a9b0c1d2");
        assertThat(d.context()).containsEntry("job", "flush").doesNotContainKey("request_id");
        assertThat(d.exception().type()).isEqualTo("java.lang.IllegalStateException");
        assertThat(d.exception().message()).isEqualTo("connect redis://u:***@redis:6379 failed");
        assertThat(d.exception().stack()).contains("Caused by: java.sql.SQLException: auth failed for ***")
                .doesNotContain("db-password-value").doesNotContain("pw123");
        String s = LogEvents.serialize(d, LogEvents.fingerprint("api", d.logger(), d.exception().type(), d.message()), 0);
        assertThat(SCHEMA.validate(s)).isNull();

        // 형식이 맞지 않는 요청 id(주입 시도)는 싣지 않는다
        var bad = new LoggingEvent("fqcn", logger, Level.ERROR, "x", null, null);
        bad.setInstant(T);
        bad.setMDCPropertyMap(Map.of("request_id", "bad id\nX"));
        assertThat(LogEvents.fromLogback(bad, "api-host:1").requestId()).isNull();
        // WARN · 예외 없음 → exception null
        var w = new LoggingEvent("fqcn", logger, Level.WARN, "slow", null, null);
        w.setInstant(T);
        w.setMDCPropertyMap(Map.of());
        assertThat(LogEvents.fromLogback(w, "api-host:1").exception()).isNull();
    }

    /**
     * 계약 v5 §C1: 잘림 표시의 N 은 잘라 낸 글자 수 그대로다 — 가림이 따로 자르지 않는다. 예전에는 가린 뒤 100,000자에서 먼저 잘라
     * 그보다 긴 메시지·스택(깊은 재귀의 StackOverflowError 스택은 1,024줄 ≈ 100,000자)의 N 이 실제보다 작았다.
     */
    @Test
    void cutMarkerCountsEveryCutCharacter_evenForTextLongerThan100000() {
        var logger = new LoggerContext().getLogger("dev.wakeline.X");
        var top = new IllegalStateException("e".repeat(150_000));
        var e = new LoggingEvent("fqcn", logger, Level.ERROR, "m".repeat(150_000), top, null);
        e.setInstant(T);
        e.setMDCPropertyMap(Map.of("job", "j".repeat(150_000)));
        LogEvents.Draft d = LogEvents.fromLogback(e, "api-host:1");
        int stack = cp(ThrowableProxyUtil.asString(e.getThrowableProxy()));
        assertThat(stack).isGreaterThan(150_000);
        JsonNode n = json(LogEvents.serialize(d, "0123456789abcdef", 0));
        assertCut(n.path("message").asString(), 150_000);
        assertCut(n.path("exception").path("message").asString(), 150_000);
        assertCut(n.path("exception").path("stack").asString(), stack);
        assertCut(n.path("context").path("job").asString(), 150_000);
    }

    static void assertCut(String s, int originalLen) {
        Matcher m = MARK.matcher(s);
        assertThat(m.find()).as("truncation marker at the end of «…%s»", s.substring(Math.max(0, s.length() - 30))).isTrue();
        int kept = cp(s.substring(0, m.start()));
        assertThat(kept + Integer.parseInt(m.group(1))).as("kept + cut = original").isEqualTo(originalLen);
    }
}
