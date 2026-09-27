package dev.wakeline.persist;

import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import org.junit.jupiter.api.Test;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.jdbc.CannotGetJdbcConnectionException;

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

    @Test
    void transientClassification() {
        assertThat(OrderedWriter.isTransient(new CannotGetJdbcConnectionException("x"))).isTrue();
        assertThat(OrderedWriter.isTransient(new RuntimeException(new SQLException("conn", "08006")))).isTrue();
        assertThat(OrderedWriter.isTransient(new RuntimeException(new SQLException("deadlock", "40P01")))).isTrue();
        assertThat(OrderedWriter.isTransient(new DataIntegrityViolationException("fk", new SQLException("fk", "23503")))).isFalse();
        assertThat(TrackWriter.isPermanent(new RuntimeException(new SQLException("no partition", "23514")))).isTrue();
        assertThat(TrackWriter.isPermanent(new RuntimeException(new SQLException("cannot affect row a second time", "21000")))).isTrue();
        assertThat(TrackWriter.isPermanent(new CannotGetJdbcConnectionException("x"))).isFalse();
    }
}
