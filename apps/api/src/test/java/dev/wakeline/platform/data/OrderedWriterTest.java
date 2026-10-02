package dev.wakeline.platform.data;

import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import org.junit.jupiter.api.Test;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.jdbc.CannotGetJdbcConnectionException;
import org.springframework.jdbc.UncategorizedSQLException;

import java.sql.SQLException;
import java.sql.SQLTransientConnectionException;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;

/** 순서 보장 쓰기 큐: 제출 순서대로, 일시 장애는 같은 작업을 재시도(뒤 작업이 앞지르지 않음), 영구 오류는 3회 후 버리고 센다. */
class OrderedWriterTest {
    final SimpleMeterRegistry meters = new SimpleMeterRegistry();

    double count(String kind, String result) { return meters.counter("wakeline_persist_tasks_total", "kind", kind, "result", result).count(); }

    static void await(java.util.function.BooleanSupplier cond) throws InterruptedException {
        long deadline = System.currentTimeMillis() + 5_000;
        while (!cond.getAsBoolean() && System.currentTimeMillis() < deadline) Thread.sleep(5);
        assertThat(cond.getAsBoolean()).isTrue();
    }

    @Test
    void runsTasksInSubmissionOrderEvenAcrossATransientOutage() throws Exception {
        OrderedWriter w = new OrderedWriter(meters, 5, 20);
        List<Integer> done = Collections.synchronizedList(new ArrayList<>());
        AtomicInteger outage = new AtomicInteger(3);
        w.submit(OrderedWriter.task("alert", () -> done.add(0)));
        w.submit(OrderedWriter.task("alert", () -> {  // INSERT 가 DB 장애로 3번 실패
            if (outage.getAndDecrement() > 0) throw new CannotGetJdbcConnectionException("pool timeout", new SQLTransientConnectionException("x"));
            done.add(1);
        }));
        for (int i = 2; i < 200; i++) { int n = i; w.submit(OrderedWriter.task("alert", () -> done.add(n))); } // 뒤따르는 UPDATE 들
        w.start();
        await(() -> done.size() == 200);
        w.stop();
        for (int i = 0; i < 200; i++) assertThat(done.get(i)).isEqualTo(i);
        assertThat(count("alert", "ok")).isEqualTo(200.0);
        assertThat(count("alert", "dropped")).isZero();
    }

    @Test
    void permanentErrorsAreRetriedThreeTimesThenDroppedAndCounted() throws Exception {
        OrderedWriter w = new OrderedWriter(meters, 1, 2);
        AtomicInteger attempts = new AtomicInteger();
        List<String> after = new ArrayList<>();
        w.submit(OrderedWriter.task("alert", () -> { attempts.incrementAndGet(); throw new DataIntegrityViolationException("fk"); }));
        w.submit(OrderedWriter.task("alert", () -> after.add("next")));
        w.start();
        await(() -> after.size() == 1);
        w.stop();
        assertThat(attempts.get()).isEqualTo(OrderedWriter.PERMANENT_ATTEMPTS);
        assertThat(count("alert", "failed")).isEqualTo(1.0);
    }

    @Test
    void stopDrainsWhatIsQueuedAndCountsLateSubmissions() {
        OrderedWriter w = new OrderedWriter(meters, 1, 2);
        List<Integer> done = new ArrayList<>();
        w.start();
        w.stop();
        for (int i = 0; i < 3; i++) { int n = i; w.submit(OrderedWriter.task("alert", () -> done.add(n))); }
        assertThat(done).isEmpty();
        assertThat(count("alert", "dropped")).isEqualTo(3.0); // 멈춘 뒤 들어온 것은 처리될 수 없다 — 조용히 잃지 않고 센다
    }

    /**
     * 조사 2026-10-01: 잠금 대기 한도(lock_timeout 5 s → SQLSTATE 55P03 lock_not_available)는 잠시 뒤 되는 일이다. Spring 의 기본 번역은 부류 55 를
     * 몰라 UncategorizedSQLException 으로 준다(DbTimeoutsIT 가 실제 DB 로 확인) — 예전에는 '영구 오류' 로 세어 3회 뒤 알림 · SIGMET 쓰기를 버리고 ACK 했다.
     * 이제 일시 장애처럼 같은 작업을 다시 시도한다(뒤 작업이 앞지르지 않는다).
     */
    @Test
    void aLockTimeoutIsRetriedLikeAnOutageNotDroppedAsPermanent() throws Exception {
        OrderedWriter w = new OrderedWriter(meters, 1, 2);
        AtomicInteger waits = new AtomicInteger(OrderedWriter.PERMANENT_ATTEMPTS + 2);
        List<String> done = Collections.synchronizedList(new ArrayList<>());
        w.submit(OrderedWriter.task("alert", () -> {
            if (waits.getAndDecrement() > 0)
                throw new UncategorizedSQLException("PreparedStatementCallback", "UPDATE alert_event ...", new SQLException("canceling statement due to lock timeout", "55P03"));
            done.add("first");
        }));
        w.submit(OrderedWriter.task("alert", () -> done.add("second")));
        w.start();
        await(() -> done.size() == 2);
        w.stop();
        assertThat(done).containsExactly("first", "second");
        assertThat(count("alert", "failed")).isZero();
        assertThat(count("alert", "ok")).isEqualTo(2.0);
    }

    /** ADR-032 writer_backlog: DB 가 답하지 않는 동안 재시도 중인 맨 앞 작업이 들어온 시각이 그대로 남는다(뒤 작업의 시각이 아니다) — 쓰면 -1. */
    @Test
    void oldestPendingIsTheTaskBeingRetriedWhileTheDbIsDown() throws Exception {
        OrderedWriter w = new OrderedWriter(meters, 5, 20);
        assertThat(w.oldestPendingAtMs()).isEqualTo(-1);
        java.util.concurrent.atomic.AtomicBoolean dbDown = new java.util.concurrent.atomic.AtomicBoolean(true);
        AtomicInteger attempts = new AtomicInteger();
        long before = System.currentTimeMillis();
        w.submit(OrderedWriter.task("alert", () -> {
            attempts.incrementAndGet();
            if (dbDown.get()) throw new CannotGetJdbcConnectionException("pool timeout", new SQLTransientConnectionException("x"));
        }));
        long at = w.oldestPendingAtMs();
        assertThat(at).isBetween(before, System.currentTimeMillis());
        Thread.sleep(5);
        w.submit(OrderedWriter.task("alert", () -> { }));
        w.start();
        await(() -> attempts.get() >= 3);
        assertThat(w.oldestPendingAtMs()).as("재시도 중인 맨 앞 작업").isEqualTo(at);
        assertThat(meters.get("wakeline_writer_oldest_pending_seconds").tag("writer", "ordered").gauge().value()).isGreaterThanOrEqualTo(0.0);
        dbDown.set(false);
        await(() -> w.oldestPendingAtMs() == -1);
        w.stop();
        assertThat(count("alert", "ok")).isEqualTo(2.0);
    }
}
