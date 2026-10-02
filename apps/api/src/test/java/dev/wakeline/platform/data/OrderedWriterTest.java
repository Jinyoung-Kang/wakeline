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

    // ---------- 넘침 · 종료 비우기 · 종료 중 실패(QA 2026-10 보고 §7-5 '시험 공백 — 위험 경로') ----------

    /** 소비자 흉내: 메시지마다 영수증 하나(소비자 자신의 보유 1), 모두 풀리면 ACK 를 센다. */
    static final class Msg {
        final AtomicInteger acked = new AtomicInteger();
        final dev.wakeline.platform.support.Receipt receipt = new dev.wakeline.platform.support.Receipt(acked::incrementAndGet);
        /** 소비자가 handle 끝에서 자기 보유를 놓는다. */
        void consumerDone() { receipt.release(); }
    }

    /** 큐(50,000)가 가득 차면 새 작업은 버리고 센다 — 되살릴 방법이 없으므로 그 메시지의 영수증은 놓는다(ACK — PEL 이 끝없이 자라지 않게). */
    @Test
    void aFullQueueDropsTheNewTaskCountsItAndReleasesItsReceipt() {
        OrderedWriter w = new OrderedWriter(meters, 1, 2); // 워커를 시작하지 않는다 — 큐가 찬다
        for (int i = 0; i < OrderedWriter.QUEUE_MAX; i++) assertThat(w.submit(OrderedWriter.task("alert", () -> { }))).isTrue();
        Msg m = new Msg();
        assertThat(w.submit(OrderedWriter.task("sigmet_set", () -> { }, m.receipt.hold()))).isFalse();
        m.consumerDone();
        assertThat(m.acked.get()).as("넘쳐 버린 작업의 메시지는 ACK").isEqualTo(1);
        assertThat(count("sigmet_set", "dropped")).isEqualTo(1.0);
        assertThat(w.pending()).isEqualTo(OrderedWriter.QUEUE_MAX);
    }

    /**
     * 종료: 소비가 멈춘 뒤 큐에 남은 작업을 차례로 한 번씩 시도한다. 쓴 작업의 영수증은 놓고(ACK), 실패한 작업은 dropped 로 세되 영수증을 쥔 채 둔다 — 그 메시지는
     * PEL 에 남아 다음 기동에서 다시 처리된다. 실패 뒤의 작업도 계속 시도한다(설계 — 클래스 설명 '한 번씩'): 영수증이 있는 작업(SIGMET 세트 · AIS 공백)은 다시
     * 처리될 때 수신 시각 단조 가드(SigmetRepository.lastSetAt · 기동 부트스트랩)와 멱등 쓰기가 흡수하고, 알림은 기동 때 앞 실행의 열린 알림을 닫는다(alert_reconcile).
     */
    @Test
    void stopDrainsTheQueueInOrderReleasingWrittenTasksAndKeepingFailedOnesPending() throws Exception {
        OrderedWriter w = new OrderedWriter(meters, 5, 20);
        List<String> ran = Collections.synchronizedList(new ArrayList<>());
        java.util.concurrent.CountDownLatch blocking = new java.util.concurrent.CountDownLatch(1), entered = new java.util.concurrent.CountDownLatch(1);
        w.submit(OrderedWriter.task("alert", () -> {
            entered.countDown();
            try { blocking.await(); } catch (InterruptedException e) { Thread.currentThread().interrupt(); }
            ran.add("blocker");
        }));
        w.start();
        entered.await();
        Msg m1 = new Msg(), m2 = new Msg(), m3 = new Msg();
        w.submit(OrderedWriter.task("sigmet_set", () -> ran.add("t1"), m1.receipt.hold()));
        w.submit(OrderedWriter.task("sigmet_set", () -> { ran.add("t2"); throw new CannotGetJdbcConnectionException("pool timeout", new SQLTransientConnectionException("x")); }, m2.receipt.hold()));
        w.submit(OrderedWriter.task("sigmet_set", () -> ran.add("t3"), m3.receipt.hold()));
        for (Msg m : List.of(m1, m2, m3)) m.consumerDone();
        Thread stopper = Thread.ofVirtual().start(w::stop); // 쓰는 중인 작업이 끝나기를 기다린다
        Thread.sleep(50);
        blocking.countDown();
        stopper.join(5_000);
        assertThat(ran).containsExactly("blocker", "t1", "t2", "t3");
        assertThat(m1.acked.get() + m3.acked.get()).as("쓴 작업의 메시지는 ACK").isEqualTo(2);
        assertThat(m2.acked.get()).as("못 쓴 작업의 메시지는 PEL 에 남는다(다음 기동에서 다시)").isZero();
        assertThat(m2.receipt.holds()).isEqualTo(1);
        assertThat(count("sigmet_set", "ok")).isEqualTo(2.0);
        assertThat(count("sigmet_set", "dropped")).isEqualTo(1.0);
        assertThat(w.submit(OrderedWriter.task("alert", () -> ran.add("late")))).as("종료 뒤 제출은 받지 않는다").isFalse();
    }

    /**
     * 종료 비우기는 마감(6 s — compose 유예 30 s 안) 뒤에는 작업을 시작하지 않는다 — 남은 것은 dropped, 영수증은 쥔 채(다음 기동에서 다시).
     * 워커가 첫 작업을 종료 전에 잡았든(그러면 비우기는 둘째부터) 아니든, 느린 작업(120 ms) 하나가 마감(50 ms)을 넘기므로 마지막 작업은 돌지 않는다.
     */
    @Test
    void theShutdownDrainStartsNoTaskAfterItsDeadline() {
        OrderedWriter w = new OrderedWriter(meters, 1, 2);
        w.drainDeadlineMs = 50;
        List<String> ran = Collections.synchronizedList(new ArrayList<>());
        Msg last = new Msg();
        for (String name : List.of("slow1", "slow2"))
            w.submit(OrderedWriter.task("alert", () -> {
                ran.add(name);
                try { Thread.sleep(120); } catch (InterruptedException e) { Thread.currentThread().interrupt(); }
            }));
        w.submit(OrderedWriter.task("sigmet_set", () -> ran.add("last"), last.receipt.hold()));
        last.consumerDone();
        w.start();
        w.stop();
        assertThat(ran).doesNotContain("last").isNotEmpty();
        assertThat(last.acked.get()).isZero();
        assertThat(last.receipt.holds()).isEqualTo(1);
        assertThat(count("sigmet_set", "dropped")).isEqualTo(1.0);
    }

    /** 종료 중 재시도: 쓰는 중이던 작업이 일시 장애로 쉬다가 종료가 오면 한 번 더 시도하고, 실패하면 재시도하지 않고 dropped — 영수증은 쥔 채(PEL). */
    @Test
    void aTaskStillFailingWhenStopComesIsDroppedButItsMessageStaysPending() throws Exception {
        OrderedWriter w = new OrderedWriter(meters, 50, 100);
        AtomicInteger attempts = new AtomicInteger();
        Msg m = new Msg();
        w.submit(OrderedWriter.task("ais_gap", () -> {
            attempts.incrementAndGet();
            throw new CannotGetJdbcConnectionException("pool timeout", new SQLTransientConnectionException("x"));
        }, m.receipt.hold()));
        m.consumerDone();
        w.start();
        await(() -> attempts.get() >= 2);
        w.stop();
        int after = attempts.get();
        Thread.sleep(200);
        assertThat(attempts.get()).as("멈춘 뒤에는 다시 시도하지 않는다").isEqualTo(after);
        assertThat(count("ais_gap", "dropped")).isEqualTo(1.0);
        assertThat(m.acked.get()).isZero();
        assertThat(m.receipt.holds()).isEqualTo(1);
    }
}

