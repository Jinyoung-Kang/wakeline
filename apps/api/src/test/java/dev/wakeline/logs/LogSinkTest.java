package dev.wakeline.logs;

import ch.qos.logback.classic.LoggerContext;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.slf4j.Logger;
import org.springframework.data.redis.connection.RedisStreamCommands;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Random;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import java.util.function.BooleanSupplier;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * 계약 v5 §C2(api 보내는 쪽): WARN·ERROR 만, 싱크 자신의 로그는 싣지 않음(재귀 금지), 같은 fp 는 10 s 에 1건(억제 수는 다음 항목에),
 * 대기열 500건·2 MiB(넘으면 오래된 것부터 버리고 센다), 50건 또는 1 s 마다 XADD, Redis 실패 시 대기열에 남기고 1 → 30 s 지수 백오프,
 * 자기 지표 wakeline_log_events_total{result=sent|dropped|suppressed}.
 * §G9: 뒤에 같은 fp 가 오지 않아도 창이 닫히면 마지막 억제 발생을 항목으로(suppressed = 나머지) — 언어 간 벡터
 * schemas/vectors/log-suppression.v1.json(pytest 도 같은 파일을 읽는다), 종료 때도, 지문 표에서 밀려난 억제 수는 dropped 로.
 */
class LogSinkTest {
    static final Path SUPPRESSION_VECTORS = Path.of("../../schemas/vectors/log-suppression.v1.json");
    static final JsonMapper M = JsonMapper.builder().build();
    final SimpleMeterRegistry meters = new SimpleMeterRegistry();
    final AtomicLong now = new AtomicLong(1_000_000);
    final List<String> written = Collections.synchronizedList(new ArrayList<>());
    /** XADD 한 스트림(written 과 같은 순서). */
    final List<LogStream> streams = Collections.synchronizedList(new ArrayList<>());
    final AtomicInteger failuresLeft = new AtomicInteger();
    /** 남아 있으면 XADD 가 Error 를 던진다(드라이버 버그 · 스택 넘침 흉내). */
    final AtomicInteger errorsLeft = new AtomicInteger();
    final LoggerContext logback = new LoggerContext();
    LogSink sink;

    { logback.setMDCAdapter(new ch.qos.logback.classic.util.LogbackMDCAdapter()); }

    /** 가짜 XADD: failuresLeft 가 남아 있으면 실패(Redis 장애 흉내), errorsLeft 가 남아 있으면 Error. */
    void xadd(LogStream stream, String json) {
        if (failuresLeft.get() > 0 && failuresLeft.getAndDecrement() > 0) throw new IllegalStateException("redis down");
        if (errorsLeft.get() > 0 && errorsLeft.getAndDecrement() > 0) throw new StackOverflowError("simulated in XADD");
        streams.add(stream);
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

    // ---------------------------------------------------------------- §G9 뒤늦게 싣기

    /** 벡터 사례 하나를 새 싱크로: 단계마다 대기열에 넣은 항목([발생 번호, suppressed]) · 누계 · 억제 지표가 벡터와 같다. */
    void runSuppressionCase(JsonNode c) {
        SimpleMeterRegistry reg = new SimpleMeterRegistry();
        List<String> out = new ArrayList<>();
        AtomicLong clock = new AtomicLong(1_000_000);
        LogSink s = new LogSink((stream, json) -> out.add(json), reg, true, clock::get, logback, 60_000, 60_000, 60_000);
        String name = c.path("name").asString();
        long base = clock.get();
        int occurrences = 0, entries = 0;
        long suppressedSum = 0;
        for (JsonNode step : c.path("steps")) {
            long at = step.path("at_ms").asLong();
            String what = step.path("do").asString();
            clock.set(base + at);
            int before = out.size();
            switch (what) {
                case "occur" -> {
                    int i = occurrences++;
                    String label = step.has("fp") ? step.get("fp").asString() : "a";
                    // 숫자는 메시지 틀에서 # — 같은 라벨은 같은 지문, 항목 본문은 그 발생의 번호
                    s.submit("api", "vector", null, "vector " + label + " occurrence " + i, (fp, n) -> "{\"i\":" + i + ",\"n\":" + n + "}");
                    assertThat(s.flushOnce()).isTrue();
                }
                case "tick" -> {
                    s.flushTrailing();
                    assertThat(s.flushOnce()).isTrue();
                }
                case "close" -> s.stop();
                default -> throw new AssertionError("unknown step " + what);
            }
            List<List<Integer>> got = new ArrayList<>();
            for (String j : out.subList(before, out.size())) {
                JsonNode n = M.readTree(j);
                got.add(List.of(n.path("i").asInt(), n.path("n").asInt()));
            }
            List<List<Integer>> want = new ArrayList<>();
            for (JsonNode e : step.path("emit")) want.add(List.of(e.get(0).asInt(), e.get(1).asInt()));
            String where = name + " @" + at + " " + what;
            assertThat(got).as(where).isEqualTo(want);
            for (List<Integer> e : got) { entries++; suppressedSum += e.get(1); }
            assertThat(entries).as(where + " entries").isEqualTo(step.path("entries").asInt());
            assertThat(suppressedSum).as(where + " suppressed").isEqualTo(step.path("suppressed").asLong());
            // 억제 지표 = 만든 항목들의 suppressed 합(억제 중인 발생은 창이 닫혀 어느 항목에 실릴 때 센다)
            assertThat(reg.counter("wakeline_log_events_total", "result", "suppressed").count()).as(where + " counter").isEqualTo(suppressedSum);
        }
        assertThat(entries + suppressedSum).as(name + ": entries + suppressed == occurrences").isEqualTo(occurrences);
        assertThat(reg.counter("wakeline_log_events_total", "result", "sent").count()).as(name + " sent").isEqualTo(entries);
        assertThat(reg.counter("wakeline_log_events_total", "result", "dropped").count()).as(name + " dropped").isZero();
    }

    /** 계약 v5 §G9: 언어 간 억제 벡터 — collector·ais(logsink.py, pytest)와 같은 항목을 만든다. */
    @Test
    void crossLanguageSuppressionVectors() throws Exception {
        JsonNode doc = M.readTree(Files.readString(SUPPRESSION_VECTORS));
        assertThat(doc.path("version").asInt()).isEqualTo(1);
        assertThat(doc.path("window_ms").asLong()).isEqualTo(LogSink.SUPPRESS_WINDOW_MS);
        int n = 0;
        for (JsonNode c : doc.path("cases")) {
            n++;
            runSuppressionCase(c);
        }
        assertThat(n).as("vector cases").isGreaterThanOrEqualTo(8);
    }

    /**
     * 불변식: 한 지문의 어떤 발생 순서든, 모든 창이 닫히고 대기열을 보낸 뒤 항목 수 + suppressed 합 = 발생 수.
     * 항목은 발생 순서대로이고, 마지막 발생은 늘 제 항목으로 실린다(묶음의 last_at 이 마지막 발생의 시각).
     */
    @Test
    void entriesPlusSuppressedEqualsOccurrences_forRandomSequences() {
        Random rnd = new Random(20260929);
        for (int run = 0; run < 300; run++) {
            SimpleMeterRegistry reg = new SimpleMeterRegistry();
            List<String> out = new ArrayList<>();
            AtomicLong clock = new AtomicLong(1_000_000);
            LogSink s = new LogSink((stream, json) -> out.add(json), reg, true, clock::get, logback, 60_000, 60_000, 60_000);
            int occurrences = 1 + rnd.nextInt(60);
            long t = clock.get(), nextTick = t + rnd.nextInt(1000);
            for (int i = 0; i < occurrences; i++) {
                t += rnd.nextInt(rnd.nextBoolean() ? 1_500 : 14_000);
                for (; nextTick <= t; nextTick += LogSink.FLUSH_INTERVAL_MS) { clock.set(nextTick); s.flushTrailing(); }
                clock.set(t);
                int k = i;
                s.submit("api", "prop", null, "flaky upstream " + i, (fp, n) -> "{\"i\":" + k + ",\"n\":" + n + "}");
                assertThat(s.flushOnce()).isTrue();
            }
            // 마지막 창(마지막 발생 이전에 시작)이 닫힌 뒤의 주기까지
            for (long end = t + LogSink.SUPPRESS_WINDOW_MS + LogSink.FLUSH_INTERVAL_MS; nextTick <= end; nextTick += LogSink.FLUSH_INTERVAL_MS) {
                clock.set(nextTick);
                s.flushTrailing();
            }
            assertThat(s.flushOnce()).isTrue();
            long sum = 0;
            int prev = -1;
            for (String j : out) {
                JsonNode n = M.readTree(j);
                assertThat(n.path("i").asInt()).as("run " + run + ": entries in occurrence order").isGreaterThan(prev);
                prev = n.path("i").asInt();
                assertThat(n.path("n").asInt()).isNotNegative();
                sum += n.path("n").asInt();
            }
            assertThat(out.size() + sum).as("run " + run + ": entries + suppressed == occurrences").isEqualTo(occurrences);
            assertThat(prev).as("run " + run + ": the last occurrence is an entry").isEqualTo(occurrences - 1);
            assertThat(reg.counter("wakeline_log_events_total", "result", "suppressed").count()).isEqualTo(sum);
        }
    }

    /**
     * 뒤늦게 실은 항목은 마지막 억제 발생 그 자체다 — 보내는 스레드(다른 스레드)에서 만들어도 ts · 메시지 · 예외 · 스레드 · 요청 id(MDC)는
     * 그 발생이 났을 때의 것(logback 은 스레드 이름 · MDC 를 처음 물을 때 읽는다 — 나중에 다른 스레드에서 물으면 그 스레드의 것이 된다).
     */
    @Test
    void theTrailingEntryIsTheLastSuppressedOccurrence_withItsOwnTimeThreadAndRequestId() throws Exception {
        LogSink s = sink(true, 60_000, 60_000, 60_000);
        s.attach();
        Logger app = logback.getLogger("dev.wakeline.ingest.StreamConsumer");
        var mdc = logback.getMDCAdapter();
        mdc.put("request_id", "rid-first-000001");
        app.warn("upstream 503 after {} ms", 120, new IllegalStateException("first cause"));
        mdc.put("request_id", "rid-second-000002");
        long before = System.currentTimeMillis();
        app.warn("upstream 503 after {} ms", 250, new IllegalStateException("second cause"));
        long after = System.currentTimeMillis();
        mdc.remove("request_id");
        assertThat(s.queued()).isEqualTo(1);
        now.addAndGet(LogSink.SUPPRESS_WINDOW_MS);
        Thread other = Thread.ofPlatform().name("not-the-app-thread").start(s::flushTrailing);
        other.join();
        assertThat(s.flushOnce()).isTrue();
        assertThat(written).hasSize(2);
        JsonNode first = M.readTree(written.get(0)), last = M.readTree(written.get(1));
        assertThat(first.path("message").asString()).isEqualTo("upstream 503 after 120 ms");
        assertThat(last.path("fp").asString()).isEqualTo(first.path("fp").asString());
        assertThat(last.path("message").asString()).isEqualTo("upstream 503 after 250 ms");
        assertThat(last.path("exception").path("message").asString()).isEqualTo("second cause");
        assertThat(last.path("suppressed").asInt()).isZero();
        assertThat(last.path("request_id").asString()).isEqualTo("rid-second-000002");
        assertThat(last.path("thread").asString()).isEqualTo(Thread.currentThread().getName());
        assertThat(Instant.parse(last.path("ts").asString()).toEpochMilli()).isBetween(before, after);
    }

    /** 보내는 스레드가 제 주기(1 s)에 창이 닫혔는지 본다 — 새 스레드 없이. */
    @Test
    void theFlusherSendsAPendingOccurrenceOnItsOwnTickOnceTheWindowCloses() {
        LogSink s = sink(true, 20, 1000, 30_000);
        s.start();
        assertThat(s.submit("api", "L", null, "retry 1 failed", (fp, n) -> "{\"i\":1,\"n\":" + n + "}")).isEqualTo(LogSink.Offer.QUEUED);
        assertThat(s.submit("api", "L", null, "retry 2 failed", (fp, n) -> "{\"i\":2,\"n\":" + n + "}")).isEqualTo(LogSink.Offer.SUPPRESSED);
        await("the first entry", () -> written.size() == 1);
        sleep(150); // 주기가 여러 번 돌아도 창(10 s) 안에서는 싣지 않는다
        assertThat(written).hasSize(1);
        now.addAndGet(LogSink.SUPPRESS_WINDOW_MS);
        await("the trailing entry", () -> written.size() == 2);
        assertThat(written.get(1)).isEqualTo("{\"i\":2,\"n\":0}");
    }

    @Test
    void stopSendsPendingOccurrencesBeforeTheFinalDrain() {
        LogSink s = sink(true, 60_000, 60_000, 60_000);
        s.start();
        for (int i = 1; i <= 3; i++) {
            int k = i;
            s.submit("api", "L", null, "shutdown race " + i, (fp, n) -> "{\"i\":" + k + ",\"n\":" + n + "}");
        }
        s.stop();
        assertThat(written).containsExactly("{\"i\":1,\"n\":0}", "{\"i\":3,\"n\":1}");
        assertThat(counter("sent")).isEqualTo(2);
        assertThat(counter("suppressed")).isEqualTo(1);
        assertThat(counter("dropped")).isZero();
    }

    /** 종료 마감(STOP_FLUSH_MS)을 넘기면 남은 억제 발생은 만들지 않고 버린 것으로 센다(억제한 수까지). */
    @Test
    void pendingOccurrencesPastTheShutdownDeadlineAreCountedAsDropped() {
        LogSink s = sink(true, 60_000, 60_000, 60_000);
        for (int i = 0; i < 3; i++) s.submit("api", "L", null, "late " + i, (fp, n) -> entry(n));
        s.flushTrailing(true, System.nanoTime() - 1);
        assertThat(s.queued()).isEqualTo(1);
        assertThat(counter("dropped")).isEqualTo(2);
        assertThat(counter("suppressed")).isZero();
    }

    /** 뒤늦게 실을 항목을 만들지 못하면(직렬화 예외) 그 발생과 그것이 싣던 억제 수를 버린 것으로 센다 — 조용히 잃지 않는다. */
    @Test
    void aTrailingEntryThatCannotBeBuiltIsCountedAsDroppedWithWhatItCarried() {
        LogSink s = sink(true, 60_000, 60_000, 60_000);
        LogSink.Body broken = (fp, n) -> { throw new IllegalStateException("cannot serialize"); };
        assertThat(s.submit("api", "L", null, "x 0", (fp, n) -> entry(0))).isEqualTo(LogSink.Offer.QUEUED);
        assertThat(s.submit("api", "L", null, "x 1", broken)).isEqualTo(LogSink.Offer.SUPPRESSED);
        assertThat(s.submit("api", "L", null, "x 2", broken)).isEqualTo(LogSink.Offer.SUPPRESSED);
        now.addAndGet(LogSink.SUPPRESS_WINDOW_MS);
        s.flushTrailing();
        assertThat(s.queued()).isEqualTo(1);
        assertThat(counter("dropped")).isEqualTo(2);
    }

    /**
     * 뒤늦게 실을 항목의 body 가 Error(StackOverflowError · OutOfMemoryError 등)를 던져도 예외와 같다 — 그 발생과 싣던 억제 수를 dropped 로 세고,
     * 같은 주기에 창이 닫힌 다른 지문은 그대로 싣는다(submit 이 Error 도 잡는 것과 같은 이유 — body 는 이제 보내는 스레드 · 종료 스레드에서도 돈다).
     */
    @Test
    void anErrorWhileBuildingATrailingEntryIsCountedAsDropped_andTheOtherFingerprintsDueOnThatTickAreStillQueued() {
        LogSink s = sink(true, 60_000, 60_000, 60_000);
        LogSink.Body overflow = (fp, n) -> { throw new StackOverflowError("simulated"); };
        assertThat(s.submit("api", "L", null, "deep 0", (fp, n) -> entry(0))).isEqualTo(LogSink.Offer.QUEUED);
        assertThat(s.submit("api", "L", null, "deep 1", overflow)).isEqualTo(LogSink.Offer.SUPPRESSED);
        assertThat(s.submit("api", "L", null, "deep 2", overflow)).isEqualTo(LogSink.Offer.SUPPRESSED);
        assertThat(s.submit("api", "M", null, "other 0", (fp, n) -> "{\"m\":0}")).isEqualTo(LogSink.Offer.QUEUED);
        assertThat(s.submit("api", "M", null, "other 1", (fp, n) -> "{\"m\":1,\"n\":" + n + "}")).isEqualTo(LogSink.Offer.SUPPRESSED);
        assertThat(s.flushOnce()).isTrue();
        now.addAndGet(LogSink.SUPPRESS_WINDOW_MS);
        assertThat(s.flushTrailing()).isEqualTo(1);
        assertThat(s.flushOnce()).isTrue();
        assertThat(written).containsExactly(entry(0), "{\"m\":0}", "{\"m\":1,\"n\":0}");
        assertThat(counter("dropped")).isEqualTo(2);
        assertThat(counter("sent")).isEqualTo(3);
    }

    /** 보내는 스레드는 뒤늦게 실을 body 의 Error 에 죽지 않는다 — 그 발생을 dropped 로 센 뒤에도 다음 주기에 새 항목을 보낸다(isRunning 인데 아무것도 보내지 않는 일이 없다). */
    @Test
    void theFlusherKeepsSendingAfterAnErrorInATrailingBody() {
        LogSink s = sink(true, 20, 20, 20);
        s.start();
        s.submit("api", "L", null, "deep 0", (fp, n) -> entry(0));
        s.submit("api", "L", null, "deep 1", (fp, n) -> { throw new StackOverflowError("simulated"); });
        await("the first entry", () -> written.size() == 1);
        now.addAndGet(LogSink.SUPPRESS_WINDOW_MS);
        await("the failed trailing entry counted as dropped", () -> counter("dropped") == 1);
        s.submit("api", "N", null, "after the error", (fp, n) -> entry(9));
        await("an entry sent after the error", () -> written.size() == 2);
        assertThat(written).containsExactly(entry(0), entry(9));
    }

    /** 창을 연 항목을 만들지 못하면(직렬화 예외) 보낸 것이 없으니 창을 닫고, 싣던 억제 수는 다음 항목이 싣는다(collector·ais 와 같다). */
    @Test
    void anEntryThatCannotBeBuiltGivesItsSuppressedCountBack() {
        LogSink s = sink(true, 60_000, 60_000, 60_000);
        List<Integer> carried = new ArrayList<>();
        LogSink.Body body = (fp, n) -> { carried.add(n); return entry(n); };
        for (int i = 0; i < 4; i++) s.submit("api", "L", null, "x " + i, body); // 첫 건만 — 3건 억제
        now.addAndGet(LogSink.SUPPRESS_WINDOW_MS);
        assertThatThrownBy(() -> s.submit("api", "L", null, "x 4", (fp, n) -> { throw new IllegalStateException("cannot serialize"); }))
                .isInstanceOf(IllegalStateException.class);
        assertThat(counter("dropped")).isEqualTo(1);
        assertThat(s.submit("api", "L", null, "x 5", body)).as("the window stays closed").isEqualTo(LogSink.Offer.QUEUED);
        assertThat(carried).containsExactly(0, 3);
        assertThat(counter("suppressed")).isEqualTo(3);
    }

    /**
     * 지문 표 상한(SUPPRESS_TRACK_MAX): 억제 중인 발생이 없는 지문부터 잊는다 — 창 안이어도(그 지문의 다음 발생이 조금 일찍 실릴 뿐 잃는 것은 없다).
     * 억제 중인 발생이 있는 지문은 그대로 두었다가 창이 닫히면 싣는다.
     */
    @Test
    void theFingerprintTableForgetsFingerprintsWithoutPendingOccurrencesFirst() {
        LogSink s = sink(true, 60_000, 60_000, 60_000);
        assertThat(s.submit("api", "L", null, "kept", (fp, n) -> "{\"m\":\"kept\",\"n\":" + n + "}")).isEqualTo(LogSink.Offer.QUEUED);
        assertThat(s.submit("api", "L", null, "kept", (fp, n) -> "{\"m\":\"kept\",\"n\":" + n + "}")).isEqualTo(LogSink.Offer.SUPPRESSED);
        for (int i = 0; i < LogSink.SUPPRESS_TRACK_MAX; i++) { // 모두 창 안, 억제 중인 발생 없음
            now.incrementAndGet();
            assertThat(s.submit("api", "other.L" + i, null, "other", (fp, n) -> "{}")).isEqualTo(LogSink.Offer.QUEUED);
            if (s.queued() >= 400) assertThat(s.flushOnce()).isTrue();
        }
        assertThat(counter("dropped")).isZero();
        now.addAndGet(LogSink.SUPPRESS_WINDOW_MS);
        assertThat(s.flushTrailing()).isEqualTo(1);
        assertThat(s.flushOnce()).isTrue();
        assertThat(written).filteredOn(j -> j.contains("kept")).containsExactly("{\"m\":\"kept\",\"n\":0}", "{\"m\":\"kept\",\"n\":0}");
    }

    /** 모든 지문에 억제 중인 발생이 있을 때만 가장 오래전에 실은 지문을 잊는다 — 그 억제 중인 수는 버린 것으로 센다(조용히 잃지 않는다). */
    @Test
    void forgettingAFingerprintWithPendingOccurrencesCountsThemAsDropped() {
        LogSink s = sink(true, 60_000, 60_000, 60_000);
        List<Integer> carried = new ArrayList<>();
        LogSink.Body body = (fp, n) -> { carried.add(n); return entry(n); };
        assertThat(s.submit("api", "L", null, "evicted soon", body)).isEqualTo(LogSink.Offer.QUEUED);
        assertThat(s.submit("api", "L", null, "evicted soon", body)).isEqualTo(LogSink.Offer.SUPPRESSED);
        for (int i = 0; i < LogSink.SUPPRESS_TRACK_MAX; i++) { // 다른 지문도 모두 창 안에서 한 번씩 억제 중
            now.incrementAndGet();
            for (int k = 0; k < 2; k++) s.submit("api", "other.L" + i, null, "other", (fp, n) -> "{}");
            if (s.queued() >= 400) assertThat(s.flushOnce()).isTrue();
        }
        assertThat(counter("dropped")).isEqualTo(1);
        // 잊힌 지문은 처음 보는 것처럼 — 버린 것으로 센 억제 수를 다시 싣지 않는다
        assertThat(s.submit("api", "L", null, "evicted soon", body)).isEqualTo(LogSink.Offer.QUEUED);
        assertThat(carried).containsExactly(0, 0);
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

    /** XADD 가 Error 를 던져도(드라이버 버그 · 스택 넘침) 다른 실패와 같다 — 묶음을 순서대로 대기열에 되돌리고 백오프 뒤 다시 보낸다(잃지 않는다). 보내는 스레드는 산다. */
    @Test
    void anErrorFromXaddKeepsTheBatchQueuedAndTheFlusherAlive() {
        LogSink s = sink(true, 20, 20, 200);
        errorsLeft.set(1);
        s.start();
        for (int i = 0; i < 3; i++) s.enqueue(entry(i));
        await("all written after the error", () -> written.size() == 3);
        assertThat(written).containsExactly(entry(0), entry(1), entry(2));
        assertThat(counter("dropped")).isZero();
        assertThat(counter("sent")).isEqualTo(3);
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
        assertThat(LogStream.SERVER.xaddOptions()).isSameAs(LogSink.XADD_OPTIONS);
        assertThat(LogStream.SERVER.key()).isEqualTo("wakeline:logs");
    }

    /** 계약 v5 §G2: 브라우저 오류 스트림은 wakeline:logs:client MAXLEN ~ 1000 — 서버 로그 스트림(3,000)과 따로 자른다. */
    @Test
    void clientStreamTrimsToMaxlen1000Approximately() {
        assertThat(LogStream.CLIENT.key()).isEqualTo("wakeline:logs:client");
        var trim = LogStream.CLIENT.xaddOptions().getTrimOptions();
        assertThat(trim.getTrimStrategy()).isInstanceOfSatisfying(RedisStreamCommands.MaxLenTrimStrategy.class,
                m -> assertThat(m.threshold()).isEqualTo(1_000));
        assertThat(trim.getTrimOperator()).isEqualTo(RedisStreamCommands.TrimOperator.APPROXIMATE);
        assertThat(LogStream.values()).extracting(LogStream::label).containsExactly("server", "client");
    }

    /**
     * 계약 v5 §G2: 한 대기열 · 한 순서로 보내되 항목마다 제 스트림으로 — 브라우저 오류(CLIENT)는 wakeline:logs:client, 서버 로그는 wakeline:logs.
     * 실패하면 스트림을 기억한 채 되돌려 다시 보낸다.
     */
    @Test
    void eachEntryIsWrittenToItsOwnStream_alsoAfterARetry() {
        LogSink s = sink(true, 60_000, 60_000, 60_000);
        assertThat(s.submit(LogStream.SERVER, "api", "dev.wakeline.A", null, "server one", (fp, n) -> entry(1))).isEqualTo(LogSink.Offer.QUEUED);
        assertThat(s.submit(LogStream.CLIENT, "web-client", "browser", "", "client one", (fp, n) -> entry(2))).isEqualTo(LogSink.Offer.QUEUED);
        assertThat(s.submit("api", "dev.wakeline.B", null, "server two", (fp, n) -> entry(3))).as("default = server stream").isEqualTo(LogSink.Offer.QUEUED);
        failuresLeft.set(1);
        assertThat(s.flushOnce()).isFalse();
        assertThat(s.queued()).isEqualTo(3);
        assertThat(s.flushOnce()).isTrue();
        assertThat(written).containsExactly(entry(1), entry(2), entry(3));
        assertThat(streams).containsExactly(LogStream.SERVER, LogStream.CLIENT, LogStream.SERVER);
    }

    /** 억제 창의 시계는 단조 시계(System.nanoTime) — 벽시계가 뒤로 가도(NTP 보정 등) 창이 그만큼 길어지지 않는다(collector·ais 의 time.monotonic 과 같다). */
    @Test
    void theSuppressionWindowRunsOnAMonotonicClock() {
        long before = System.nanoTime() / 1_000_000;
        long t = LogSink.WINDOW_CLOCK.getAsLong();
        long after = System.nanoTime() / 1_000_000;
        assertThat(t).isBetween(before, after);
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
