package dev.wakeline.logs;

import ch.qos.logback.classic.LoggerContext;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.slf4j.Logger;
import org.springframework.data.redis.connection.RedisStreamCommands;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

import java.time.Duration;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import java.util.function.BooleanSupplier;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 계약 v5 §C2(api 보내는 쪽): WARN·ERROR 만, 싱크 자신의 로그는 싣지 않음(재귀 금지), 같은 fp 는 10 s 에 1건(억제 수는 다음 항목에),
 * 대기열 500건·2 MiB(넘으면 오래된 것부터 버리고 센다), 50건 또는 1 s 마다 XADD, Redis 실패 시 대기열에 남기고 1 → 30 s 지수 백오프,
 * 자기 지표 wakeline_log_events_total{result=sent|dropped|suppressed}.
 */
class LogSinkTest {
    static final JsonMapper M = JsonMapper.builder().build();
    final SimpleMeterRegistry meters = new SimpleMeterRegistry();
    final AtomicLong now = new AtomicLong(1_000_000);
    final List<String> written = Collections.synchronizedList(new ArrayList<>());
    final AtomicInteger failuresLeft = new AtomicInteger();
    final LoggerContext logback = new LoggerContext();
    LogSink sink;

    { logback.setMDCAdapter(new ch.qos.logback.classic.util.LogbackMDCAdapter()); }

    /** 가짜 XADD: failuresLeft 가 남아 있으면 실패(Redis 장애 흉내). */
    void xadd(String json) {
        if (failuresLeft.get() > 0 && failuresLeft.getAndDecrement() > 0) throw new IllegalStateException("redis down");
        written.add(json);
    }

    LogSink sink(boolean enabled, long flushMs, long backoffStartMs, long backoffMaxMs) {
        sink = new LogSink(this::xadd, meters, enabled, now::get, logback, flushMs, backoffStartMs, backoffMaxMs);
        return sink;
    }

    @AfterEach
    void stop() { if (sink != null && sink.isRunning()) sink.stop(); }

    double counter(String result) { return meters.counter("wakeline_log_events_total", "result", result).count(); }

    static String entry(int i) { return "{\"i\":" + i + "}"; }

    static void await(String what, BooleanSupplier cond) {
        long end = System.nanoTime() + Duration.ofSeconds(5).toNanos();
        while (System.nanoTime() < end) {
            if (cond.getAsBoolean()) return;
            try { Thread.sleep(10); } catch (InterruptedException e) { Thread.currentThread().interrupt(); return; }
        }
        throw new AssertionError("timed out waiting for " + what);
    }

    @Test
    void queueKeepsAtMost500EntriesDroppingTheOldest() {
        LogSink s = sink(true, 1000, 1000, 30_000);
        for (int i = 0; i < 510; i++) s.enqueue(entry(i));
        assertThat(s.queued()).isEqualTo(500);
        assertThat(counter("dropped")).isEqualTo(10);
        assertThat(s.peekOldest()).isEqualTo(entry(10));
    }

    @Test
    void queueKeepsAtMost2MiB() {
        LogSink s = sink(true, 1000, 1000, 30_000);
        String big = "{\"x\":\"" + "a".repeat(8 * 1024 - 10) + "\"}";      // 8 KiB 한 건
        for (int i = 0; i < 300; i++) s.enqueue(big);
        assertThat(s.queuedBytes()).isLessThanOrEqualTo(LogSink.QUEUE_MAX_BYTES);
        assertThat(s.queued()).isEqualTo((int) (LogSink.QUEUE_MAX_BYTES / big.length()));
        assertThat(counter("dropped")).isEqualTo(300 - s.queued());
    }

    @Test
    void sameFingerprintIsSentOncePer10sAndTheNextEntryCarriesTheSuppressedCount() {
        LogSink s = sink(true, 1000, 1000, 30_000);
        List<Integer> sup = new ArrayList<>();
        LogSink.Body body = (fp, n) -> { sup.add(n); return "{\"fp\":\"" + fp + "\",\"suppressed\":" + n + "}"; };
        assertThat(s.submit("api", "L", null, "timeout after 3000 ms", body)).isEqualTo(LogSink.Offer.QUEUED);
        now.addAndGet(1_000);
        assertThat(s.submit("api", "L", null, "timeout after 15 ms", body)).isEqualTo(LogSink.Offer.SUPPRESSED); // 숫자만 다름 = 같은 fp
        now.addAndGet(8_000);
        assertThat(s.submit("api", "L", null, "timeout after 7 ms", body)).isEqualTo(LogSink.Offer.SUPPRESSED);
        assertThat(s.submit("api", "Other", null, "timeout after 7 ms", body)).isEqualTo(LogSink.Offer.QUEUED); // 다른 로거 = 다른 fp
        now.addAndGet(1_000); // 첫 전송 뒤 10 s
        assertThat(s.submit("api", "L", null, "timeout after 1 ms", body)).isEqualTo(LogSink.Offer.QUEUED);
        assertThat(sup).containsExactly(0, 0, 2);
        assertThat(counter("suppressed")).isEqualTo(2);
        assertThat(s.queued()).isEqualTo(3);
    }

    @Test
    void flushesAsSoonAs50EntriesAreWaiting_withoutWaitingForTheInterval() {
        LogSink s = sink(true, 60_000, 1000, 30_000); // 주기를 길게 — 50건 조건만으로 보내는지 본다
        s.start();
        for (int i = 0; i < 49; i++) s.enqueue(entry(i));
        sleep(200);
        assertThat(written).isEmpty();
        s.enqueue(entry(49));
        await("50 entries written", () -> written.size() == 50);
        assertThat(written.getFirst()).isEqualTo(entry(0));
        assertThat(counter("sent")).isEqualTo(50);
    }

    @Test
    void flushesAFewEntriesOnTheInterval() {
        LogSink s = sink(true, 100, 1000, 30_000);
        s.start();
        s.enqueue(entry(1));
        await("interval flush", () -> written.size() == 1);
    }

    @Test
    void redisFailureKeepsEntriesQueuedAndRetriesWithBackoff_inOrder_withoutLoss() {
        LogSink s = sink(true, 20, 20, 200);
        failuresLeft.set(3);
        s.start();
        for (int i = 0; i < 5; i++) s.enqueue(entry(i));
        await("all written after recovery", () -> written.size() == 5);
        assertThat(written).containsExactly(entry(0), entry(1), entry(2), entry(3), entry(4));
        assertThat(counter("dropped")).isZero();
        assertThat(counter("sent")).isEqualTo(5);
    }

    @Test
    void backoffDoublesFrom1sUpTo30s() {
        long b = LogSink.BACKOFF_START_MS;
        List<Long> seq = new ArrayList<>();
        for (int i = 0; i < 7; i++) { seq.add(b); b = LogSink.nextBackoff(b, LogSink.BACKOFF_MAX_MS); }
        assertThat(seq).containsExactly(1_000L, 2_000L, 4_000L, 8_000L, 16_000L, 30_000L, 30_000L);
    }

    @Test
    void appenderTakesOnlyWarnAndErrorAndNeverTheSinksOwnLogs() {
        LogSink s = sink(true, 60_000, 1000, 30_000);
        s.attach();
        Logger app = logback.getLogger("dev.wakeline.ingest.StreamConsumer");
        Logger own = logback.getLogger("dev.wakeline.logs.LogSink");
        app.info("info is not shipped");
        app.debug("debug neither");
        app.warn("slow batch took {} ms", 1500);
        app.error("failed", new IllegalStateException("password=hunter2"));
        own.error("sink failure is stdout only");
        assertThat(s.queued()).isEqualTo(2);
        JsonNode warn = M.readTree(s.peekOldest());
        assertThat(warn.path("level").asString()).isEqualTo("WARN");
        assertThat(warn.path("message").asString()).isEqualTo("slow batch took 1500 ms");
        assertThat(warn.path("service").asString()).isEqualTo("api");
        s.detach();
        app.error("after detach");
        assertThat(s.queued()).isEqualTo(2);
    }

    @Test
    void entriesFromTheFlusherThreadAreNotShipped() throws Exception {
        LogSink s = sink(true, 20, 1000, 30_000);
        s.attach();
        Logger lettuce = logback.getLogger("io.lettuce.core.protocol.ConnectionWatchdog");
        // 싱크 스레드에서 난 로그(예: XADD 중 Redis 클라이언트 경고)는 다시 싣지 않는다
        Thread t = Thread.ofVirtual().unstarted(() -> lettuce.warn("Cannot reconnect"));
        s.flusherForTest(t);
        t.start();
        t.join();
        assertThat(s.queued()).isZero();
        lettuce.warn("Cannot reconnect");
        assertThat(s.queued()).isEqualTo(1);
    }

    /** logback 이 다시 초기화되면(설정 다시 읽기 · reset) 루트 로거의 어펜더가 모두 떨어지고 멈춘다 — 보내는 루프가 다음 주기에 다시 붙인다. */
    @Test
    void theFlusherReattachesTheAppenderAfterLogbackIsReset() {
        LogSink s = sink(true, 20, 1000, 30_000);
        s.start();
        assertThat(s.isAttached()).isTrue();
        logback.reset();
        assertThat(s.isAttached()).as("reset detaches and stops every appender").isFalse();
        await("the flusher loop re-attaches the appender", s::isAttached);
        logback.getLogger("dev.wakeline.ingest.StreamConsumer").warn("after logback reset {}", 7);
        await("the warning written after the reset", () -> written.stream().anyMatch(j -> j.contains("after logback reset 7")));
    }

    @Test
    void disabledSinkQueuesNothingAndDoesNotAttach() {
        LogSink s = sink(false, 1000, 1000, 30_000);
        s.start();
        assertThat(s.isAttached()).isFalse();
        assertThat(s.submit("web-client", "browser", null, "x", (fp, n) -> "{}")).isEqualTo(LogSink.Offer.DISABLED);
        assertThat(s.queued()).isZero();
    }

    @Test
    void stopTriesOnceMoreThenCountsWhatIsLeftAsDropped_andDetaches() {
        LogSink s = sink(true, 60_000, 60_000, 60_000);
        s.start();
        assertThat(s.isAttached()).isTrue();
        failuresLeft.set(1_000);
        for (int i = 0; i < 3; i++) s.enqueue(entry(i));
        s.stop();
        assertThat(s.isAttached()).isFalse();
        assertThat(s.queued()).isZero();
        assertThat(counter("dropped")).isEqualTo(3);
        assertThat(written).isEmpty();
    }

    @Test
    void stopFlushesWhatIsQueuedWhenRedisIsUp() {
        LogSink s = sink(true, 60_000, 60_000, 60_000);
        s.start();
        for (int i = 0; i < 3; i++) s.enqueue(entry(i));
        s.stop();
        assertThat(written).hasSize(3);
        assertThat(counter("dropped")).isZero();
    }

    /** XADD wakeline:logs MAXLEN ~ 3000 — 근사 트림(정확한 트림은 XADD 마다 노드를 다시 쓴다). 실제 트림 결과는 LogsIT. */
    @Test
    void xaddTrimsToMaxlen3000Approximately() {
        var trim = LogSink.XADD_OPTIONS.getTrimOptions();
        assertThat(trim.getTrimStrategy()).isInstanceOfSatisfying(RedisStreamCommands.MaxLenTrimStrategy.class,
                m -> assertThat(m.threshold()).isEqualTo(3_000));
        assertThat(trim.getTrimOperator()).isEqualTo(RedisStreamCommands.TrimOperator.APPROXIMATE);
    }

    @Test
    void instanceIsHostAndPidWithinTheSchemaLimit() {
        LogSink s = sink(true, 1000, 1000, 30_000);
        assertThat(s.instance()).matches(".+:\\d+").hasSizeLessThanOrEqualTo(64);
    }

    static void sleep(long ms) {
        try { Thread.sleep(ms); } catch (InterruptedException e) { Thread.currentThread().interrupt(); }
    }
}
