package dev.wakeline.platform.data;

import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.CannotGetJdbcConnectionException;

import java.sql.SQLTransientConnectionException;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * ADR-032 개정(QA 2026-10 개선 제안 5): 백오프로 쉬는 저장기는 DB 가 '답하지 않음 → 답함'으로 바뀌면 곧바로 깬다. DB 가 내내 답하는 일시 오류(잠금 대기 등)는
 * 깨우지 않는다(뜨거운 재시도 고리 방지). 확인은 쉬는 동안에만, 동시에 하나.
 */
class DbRecoveryTest {
    final SimpleMeterRegistry meters = new SimpleMeterRegistry();
    final AtomicBoolean dbDown = new AtomicBoolean(true);
    final AtomicInteger probes = new AtomicInteger();
    final DbRecovery recovery = new DbRecovery(() -> {
        probes.incrementAndGet();
        if (dbDown.get()) throw new CannotGetJdbcConnectionException("pool timeout", new SQLTransientConnectionException("down"));
    }, 50, r -> Thread.ofVirtual().start(r), meters);

    @Test
    void aWriterInBackoffWakesSoonAfterTheDatabaseAnswersAgain() throws Exception {
        Thread.ofVirtual().start(() -> {
            try { Thread.sleep(300); } catch (InterruptedException e) { return; }
            dbDown.set(false);
        });
        long t0 = System.currentTimeMillis();
        assertThat(recovery.pause(10_000, () -> true)).as("woke early").isTrue();
        long took = System.currentTimeMillis() - t0;
        assertThat(took).as("about 300 ms down + one probe interval, not the 10 s backoff").isBetween(250L, 2_000L);
        assertThat(meters.get("wakeline_db_recovery_total").counter().count()).isEqualTo(1.0);
    }

    @Test
    void whenTheDatabaseKeepsAnsweringTheBackoffIsKept() {
        dbDown.set(false); // 잠금 대기 한도 같은 일시 오류 — 확인(SELECT 1)은 늘 성공한다
        long t0 = System.currentTimeMillis();
        assertThat(recovery.pause(400, () -> true)).isFalse();
        assertThat(System.currentTimeMillis() - t0).as("slept the whole backoff").isGreaterThanOrEqualTo(400);
        assertThat(recovery.pause(200, () -> true)).as("still no transition").isFalse();
        assertThat(meters.get("wakeline_db_recovery_total").counter().count()).isZero();
    }

    @Test
    void probesOnlyWhileAWriterRestsAndOneAtATime() throws Exception {
        List<Long> starts = Collections.synchronizedList(new ArrayList<>());
        AtomicInteger inFlight = new AtomicInteger(), maxInFlight = new AtomicInteger();
        DbRecovery slow = new DbRecovery(() -> {
            starts.add(System.currentTimeMillis());
            maxInFlight.accumulateAndGet(inFlight.incrementAndGet(), Math::max);
            try { Thread.sleep(150); } catch (InterruptedException e) { Thread.currentThread().interrupt(); }
            inFlight.decrementAndGet();
            throw new CannotGetJdbcConnectionException("still down");
        }, 50, r -> Thread.ofVirtual().start(r), meters);
        Thread[] writers = new Thread[3];
        for (int i = 0; i < writers.length; i++) writers[i] = Thread.ofVirtual().start(() -> slow.pause(600, () -> true));
        for (Thread w : writers) w.join();
        int during = starts.size();
        assertThat(maxInFlight.get()).as("one probe at a time, shared by the resting writers").isEqualTo(1);
        assertThat(during).isBetween(2, 6);
        Thread.sleep(400);
        assertThat(starts).as("no probes while nobody rests").hasSize(during);
    }

    @Test
    void stopsRestingWhenTheWriterStops() {
        AtomicBoolean running = new AtomicBoolean(true);
        Thread.ofVirtual().start(() -> {
            try { Thread.sleep(100); } catch (InterruptedException e) { return; }
            running.set(false);
        });
        long t0 = System.currentTimeMillis();
        assertThat(recovery.pause(10_000, running::get)).isFalse();
        assertThat(System.currentTimeMillis() - t0).isLessThan(2_000);
    }

    @Test
    void theOrderedWriterRetriesSoonAfterRecoveryInsteadOfSleepingOutItsBackoff() throws Exception {
        OrderedWriter w = new OrderedWriter(meters, 10_000, 10_000, recovery);
        AtomicInteger attempts = new AtomicInteger();
        AtomicBoolean written = new AtomicBoolean();
        w.submit(OrderedWriter.task("alert", () -> {
            attempts.incrementAndGet();
            if (dbDown.get()) throw new CannotGetJdbcConnectionException("pool timeout", new SQLTransientConnectionException("x"));
            written.set(true);
        }));
        w.start();
        long deadline = System.currentTimeMillis() + 5_000;
        while (attempts.get() < 1 && System.currentTimeMillis() < deadline) Thread.sleep(5);
        Thread.sleep(200); // 쉬는 중(백오프 10 s)
        dbDown.set(false);
        long t0 = System.currentTimeMillis();
        while (!written.get() && System.currentTimeMillis() - t0 < 5_000) Thread.sleep(5);
        long took = System.currentTimeMillis() - t0;
        w.stop();
        assertThat(written.get()).isTrue();
        assertThat(took).as("written soon after the database answers, not after the 10 s backoff").isLessThan(2_000);
        assertThat(attempts.get()).isEqualTo(2);
    }
}
