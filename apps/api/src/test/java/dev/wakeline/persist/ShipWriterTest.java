package dev.wakeline.persist;

import dev.wakeline.domain.AisGap;
import dev.wakeline.domain.ShipState;
import dev.wakeline.domain.ShipStatic;
import dev.wakeline.ingest.IngestEvents;
import dev.wakeline.ingest.Receipt;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.springframework.boot.test.system.CapturedOutput;
import org.springframework.boot.test.system.OutputCaptureExtension;
import org.springframework.dao.DataAccessResourceFailureException;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.SoftAssertions.assertSoftly;

/** 선박 저장기(DB 없이): 60 s 창 줄이기·10분 last_seen, 정적 정보 중복 제거, 종료 뒤 행은 dropped, 재시도·영수증, 종료 flush(쓰는 스레드 하나), 공백은 순서 큐로. */
@ExtendWith(OutputCaptureExtension.class)
class ShipWriterTest {
    static final Instant T = Instant.now().truncatedTo(java.time.temporal.ChronoUnit.HOURS).minusSeconds(3600); // 창 경계(:00), 저장 범위 안

    static ShipState pos(String mmsi, Instant seen) {
        return new ShipState(mmsi, 35, 129, 10.0, 90.0, 90, 0, null, "epfs", seen, "aisstream", "PositionReport", "A");
    }

    static ShipStatic stat(String mmsi, Instant updated) {
        return new ShipStatic(mmsi, "N", null, null, 70, null, null, null, null, null, null, null, null, null, null, updated, "aisstream");
    }

    /** 쓰기를 기록하는(또는 실패하는) 저장소. */
    static class FakeRepo extends ShipRepository {
        final List<ShipState> positions = new CopyOnWriteArrayList<>();
        final List<ShipState> touched = new CopyOnWriteArrayList<>();
        final List<StaticRow> statics = new CopyOnWriteArrayList<>();
        final List<AisGap> gaps = new CopyOnWriteArrayList<>();
        volatile RuntimeException fail;
        final AtomicInteger attempts = new AtomicInteger();

        FakeRepo() { super(null, null); }

        /** 배치의 첫 쓰기(정적 정보)에서 실패한다 — DB 장애면 배치 전체가 실패하는 것과 같다. */
        @Override public void upsertStatics(List<StaticRow> rows) {
            attempts.incrementAndGet();
            if (fail != null) throw fail;
            statics.addAll(rows);
        }
        @Override public void writePositions(List<ShipState> rows) { positions.addAll(rows); }
        @Override public void touch(java.util.Collection<ShipState> rows) { touched.addAll(rows); }
        @Override public boolean insertGap(AisGap g) { gaps.add(g); return true; }
    }

    /**
     * 느린 DB 흉내: 첫 쓰기(워커가 꺼낸 배치)는 문이 열릴 때까지 막혔다가 커밋한다. 그 뒤 쓰기는 모두 실패한다(DB 가 죽었다) — 성공으로 바꿀 수 있다.
     * 쓰기(배치의 첫 문장)에 동시에 들어와 있는 스레드 수의 최댓값을 잰다.
     */
    static final class GateRepo extends FakeRepo {
        final CountDownLatch entered = new CountDownLatch(1);
        final CountDownLatch gate = new CountDownLatch(1);
        final CountDownLatch second = new CountDownLatch(1);
        final AtomicInteger calls = new AtomicInteger();
        final AtomicInteger active = new AtomicInteger();
        final AtomicInteger maxActive = new AtomicInteger();
        volatile boolean laterWritesFail = true;
        /** 첫 쓰기가 문이 열린 뒤 던질 것(예외 또는 오류 — 없으면 커밋). */
        volatile Throwable firstWriteFails;

        @Override public void upsertStatics(List<StaticRow> rows) {
            maxActive.accumulateAndGet(active.incrementAndGet(), Math::max);
            try {
                if (calls.incrementAndGet() == 1) {
                    entered.countDown();
                    try { gate.await(); } catch (InterruptedException e) { Thread.currentThread().interrupt(); }
                    if (firstWriteFails instanceof RuntimeException r) throw r;
                    if (firstWriteFails instanceof Error err) throw err;
                } else {
                    second.countDown();
                    if (laterWritesFail) throw new DataAccessResourceFailureException("db down");
                }
                statics.addAll(rows);
            } finally {
                active.decrementAndGet();
            }
        }
    }

    static double dropped(SimpleMeterRegistry meters) {
        return meters.find("wakeline_ship_rows_total").tag("result", "dropped").counter().count();
    }

    @Test void select_keepsFirstFixPerSixtySecondWindow_touchesEveryTenMinutes_dedupesStatics() {
        FakeRepo repo = new FakeRepo();
        ShipWriter w = new ShipWriter(repo, null, new SimpleMeterRegistry(), 1, 1);
        List<ShipWriter.Item> a = w.select(List.of(pos("440000001", T.plusSeconds(5)), pos("440000002", T.plusSeconds(59))),
                List.of(stat("440000001", T), stat("440000002", T)), T.plusSeconds(60));
        assertThat(a).hasSize(4);
        assertThat(a.stream().filter(i -> i instanceof ShipWriter.Pos p && p.touch()).count()).as("first sight touches ship.last_seen").isEqualTo(2);
        // 같은 창의 뒤 보고·더 이전 보고(백로그)는 버린다, 새 창은 받아들인다(10분 창 안이면 touch 없음)
        List<ShipWriter.Item> b = w.select(List.of(pos("440000001", T.plusSeconds(40)), pos("440000001", T.minusSeconds(30)), pos("440000002", T.plusSeconds(61))),
                List.of(stat("440000001", T)), T.plusSeconds(70));
        assertThat(b).hasSize(1);
        ShipWriter.Pos kept = (ShipWriter.Pos) b.getFirst();
        assertThat(kept.state().mmsi()).isEqualTo("440000002");
        assertThat(kept.touch()).isFalse();
        // 10분 창이 바뀌면 다시 touch, 새 정적 정보(updated_at 이 더 새것)는 다시 쓴다
        List<ShipWriter.Item> c = w.select(List.of(pos("440000002", T.plusSeconds(601))), List.of(stat("440000001", T.plusSeconds(300))), null);
        assertThat(c).hasSize(2);
        assertThat(c.stream().filter(i -> i instanceof ShipWriter.Pos p && p.touch()).count()).isEqualTo(1);
        ShipWriter.Stat s = (ShipWriter.Stat) c.getFirst();
        assertThat(s.receivedAt()).as("no envelope time → the static's own time").isEqualTo(T.plusSeconds(300));
    }

    /**
     * 관측 수신 격자(ADR-027 · 계약 v5 §G27)는 저장과 같은 표본을 센다: 이 저장기가 고른 위치(MMSI 별 60 s 창의 첫 보고)를 {@link IngestEvents.ShipsSampled}
     * 로 알린다 — 부트스트랩이 읽는 ship_position 과 실시간 셈이 같은 뜻이 되게. 정적 정보 · 버린 보고는 싣지 않는다. 고른 것이 없으면 알리지 않는다.
     */
    @Test void keptPositionsArePublishedAsSampled_theSameFirstFixPerWindowThatIsStored() {
        List<Object> events = new ArrayList<>();
        ShipWriter w = new ShipWriter(new FakeRepo(), null, new SimpleMeterRegistry(), 1, 1, events::add);
        w.onShips(new IngestEvents.ShipsUpdated(T, "aisstream", List.of(pos("440000001", T.plusSeconds(1)), pos("440000001", T.plusSeconds(30)),
                pos("440000001", T.plusSeconds(61)), pos("440000002", T.plusSeconds(2))), List.of(stat("440000001", T)), Set.of(), Set.of(), Receipt.NONE));
        assertThat(events).hasSize(1);
        IngestEvents.ShipsSampled s = (IngestEvents.ShipsSampled) events.getFirst();
        assertThat(s.positions()).extracting(ShipState::mmsi, ShipState::seenAt).containsExactly(
                org.assertj.core.groups.Tuple.tuple("440000001", T.plusSeconds(1)), org.assertj.core.groups.Tuple.tuple("440000001", T.plusSeconds(61)),
                org.assertj.core.groups.Tuple.tuple("440000002", T.plusSeconds(2)));
        // 같은 창의 재전달 · 정적 정보만 — 고른 위치가 없으면 알리지 않는다
        w.onShips(new IngestEvents.ShipsUpdated(T, "aisstream", List.of(pos("440000001", T.plusSeconds(62))), List.of(stat("440000003", T)), Set.of(), Set.of(),
                Receipt.NONE));
        assertThat(events).hasSize(1);
    }

    /**
     * 리뷰 2026-09-30 밤: 고른 위치를 알린 <b>뒤에</b> 큐에 넣는다 — 알림을 받은 관측 수신 격자가 본 행은 그 뒤에 저장되므로, 부트스트랩이 이미 읽은 시의 늦은
     * 보고를 두 번 세지 않고 실시간으로 셀 수 있다. 큐 번호(넣은 · 끝난)는 격자가 밀린 행이 저장되기를 기다릴 때 쓴다.
     */
    @Test void theSampleIsPublishedBeforeItsRowsAreQueued_andTheQueueSaysWhatIsSettled() throws Exception {
        long[] queuedAtEvent = {-1};
        ShipWriter[] w = new ShipWriter[1];
        w[0] = new ShipWriter(new FakeRepo(), null, new SimpleMeterRegistry(), 1, 1, e -> queuedAtEvent[0] = w[0].enqueuedSeq());
        w[0].start();
        try {
            w[0].onShips(new IngestEvents.ShipsUpdated(T, "aisstream", List.of(pos("440000001", T.plusSeconds(1)), pos("440000002", T.plusSeconds(2))), List.of(),
                    Set.of(), Set.of(), Receipt.NONE));
            assertThat(queuedAtEvent[0]).as("nothing queued yet when the sample is published").isZero();
            assertThat(w[0].enqueuedSeq()).isEqualTo(2);
            long until = System.nanoTime() + java.time.Duration.ofSeconds(5).toNanos();
            while (w[0].settledSeq() < 2 && System.nanoTime() < until) Thread.sleep(10);
            assertThat(w[0].settledSeq()).isEqualTo(2);
        } finally {
            w[0].stop();
        }
    }

    /** 계약 v5 §G19: 받은 필드를 싣지 않은 정적 정보(이전 수집기 — 값이 있는 필드만 덮는다)는 센다 — 배포 전환이 끝났는지 지표로 보인다. */
    @Test void staticsWithoutReceivedFieldsAreCounted() {
        SimpleMeterRegistry meters = new SimpleMeterRegistry();
        ShipWriter w = new ShipWriter(new FakeRepo(), null, meters, 1, 1);
        ShipStatic withFields = new ShipStatic("440000011", "N", null, null, null, null, null, null, null, null, null, null, null, null, null, T,
                "aisstream", java.util.Set.of("name"));
        w.select(List.of(), List.of(stat("440000010", T), withFields), T);
        assertThat(meters.counter("wakeline_ship_static_unknown_fields_total").count()).isEqualTo(1.0);
    }

    @Test void reportsOutsideTheStoredRangeAreSkippedAndCounted() {
        SimpleMeterRegistry meters = new SimpleMeterRegistry();
        ShipWriter w = new ShipWriter(new FakeRepo(), null, meters, 1, 1);
        Instant now = Instant.now();
        List<ShipWriter.Item> out = w.select(List.of(pos("440000001", now.minusSeconds(2 * 86_400)), pos("440000002", now.plusSeconds(3600)),
                pos("440000003", now.minusSeconds(30))), List.of(), now);
        assertThat(out).hasSize(1);
        assertThat(meters.find("wakeline_ship_rows_total").tag("result", "out_of_range").counter().count()).isEqualTo(2);
    }

    @Test void writesInOrder_retriesTransientFailures_andReleasesReceiptsAfterCommit() throws Exception {
        FakeRepo repo = new FakeRepo();
        ShipWriter w = new ShipWriter(repo, null, new SimpleMeterRegistry(), 5, 20);
        w.start();
        try {
            repo.fail = new org.springframework.dao.DataAccessResourceFailureException("db down");
            AtomicInteger acked = new AtomicInteger();
            Receipt r = new Receipt(acked::incrementAndGet);
            w.onShips(new IngestEvents.ShipsUpdated(T, "aisstream", List.of(pos("440000001", T), pos("440000002", T)), List.of(stat("440000001", T)),
                    Set.of(), Set.of(), r));
            r.release();
            long end = System.currentTimeMillis() + 5_000;
            while (repo.attempts.get() < 2 && System.currentTimeMillis() < end) Thread.sleep(5);
            assertThat(acked.get()).as("not durable yet — no ACK").isZero();
            repo.fail = null;
            while (acked.get() == 0 && System.currentTimeMillis() < end) Thread.sleep(5);
            assertThat(acked.get()).isEqualTo(1);
            assertThat(repo.positions).hasSize(2);
            assertThat(repo.statics).hasSize(1);
            assertThat(repo.touched).hasSize(2);
            // 만료·부트스트랩 이벤트(보고 없음)는 저장하지 않는다
            w.onShips(IngestEvents.ShipsUpdated.liveOnly(Set.of("440000001"), Set.of()));
            assertThat(w.queued()).isZero();
        } finally {
            w.stop();
        }
        // 종료 뒤 온 행은 쓸 스레드가 없다 — dropped
        w.enqueue(List.of(new ShipWriter.Pos(pos("440000009", T), false)), Receipt.NONE);
        assertThat(w.queued()).isZero();
    }

    /**
     * 영구 오류는 3회 뒤 버리고 ACK — 23(파티션 없음) · 21000(한 문장이 같은 행을 두 번 upsert, 리뷰 #9: 예전에는 일시 장애로 보고 같은 배치를
     * 끝없이 다시 시도해 선박 저장 전체가 멈췄다). pgjdbc 는 BatchUpdateException 에 SQLState 를 싣고 Spring 이 그것을 감싼다.
     */
    @Test void permanentFailure_dropsTheBatchAfterThreeAttempts_andAcks() throws Exception {
        for (RuntimeException failure : List.of(
                new org.springframework.dao.DataIntegrityViolationException("x", new java.sql.SQLException("no partition", "23514")),
                new org.springframework.jdbc.BadSqlGrammarException("batch", "INSERT INTO ship ...", new java.sql.BatchUpdateException(
                        "ON CONFLICT DO UPDATE command cannot affect row a second time", "21000", 0, new int[0])))) {
            FakeRepo repo = new FakeRepo();
            ShipWriter w = new ShipWriter(repo, null, new SimpleMeterRegistry(), 1, 2);
            repo.fail = failure;
            w.start();
            try {
                AtomicInteger acked = new AtomicInteger();
                Receipt r = new Receipt(acked::incrementAndGet);
                w.enqueue(List.of(new ShipWriter.Pos(pos("440000001", T), true)), r);
                r.release();
                long end = System.currentTimeMillis() + 5_000;
                while (acked.get() == 0 && System.currentTimeMillis() < end) Thread.sleep(5);
                assertThat(acked.get()).as(failure.toString()).isEqualTo(1);
                assertThat(repo.attempts.get()).isEqualTo(ShipWriter.PERMANENT_ATTEMPTS);
            } finally {
                w.stop();
            }
        }
    }

    @Test void shutdownFlushWritesWhatIsLeft() {
        FakeRepo repo = new FakeRepo();
        ShipWriter w = new ShipWriter(repo, null, new SimpleMeterRegistry(), 1, 1);
        // 워커 없이(시작 전 큐에 넣을 수 없으므로 running 만 켠 상태를 흉내): start 후 즉시 stop 경로로 flush 확인
        w.start();
        List<ShipWriter.Item> items = new ArrayList<>();
        for (int i = 0; i < 5; i++) items.add(new ShipWriter.Pos(pos(String.format("4400000%02d", i), T), false));
        AtomicInteger acked = new AtomicInteger();
        Receipt r = new Receipt(acked::incrementAndGet);
        w.enqueue(items, r);
        r.release();
        w.stop();
        assertThat(repo.positions).hasSize(5);
        assertThat(acked.get()).isEqualTo(1);
        assertThat(w.pendingMarks()).isZero();
    }

    /**
     * PersistDbTest(항적)와 같은 경우의 선박 판: 종료 때 DB 가 죽어 있으면 어느 메시지도 ACK 하지 않고(다음 기동에서 PEL 로 다시 온다),
     * 못 쓴 행을 dropped 로 세며, WARN 은 그 메시지들이 남아 있다고 말한다 — 이 경우 그 말이 사실이다(영수증이 잡혀 있다).
     */
    @Test void dbDeadAtStop_nothingIsAcked_theRowsAreCountedDropped_andTheWarnSaysTheirMessagesStayPending(CapturedOutput out) throws Exception {
        FakeRepo repo = new FakeRepo();
        repo.fail = new DataAccessResourceFailureException("db down");
        SimpleMeterRegistry meters = new SimpleMeterRegistry();
        ShipWriter w = new ShipWriter(repo, null, meters, 20, 40);
        w.start();
        AtomicInteger acked = new AtomicInteger();
        Receipt r = new Receipt(acked::incrementAndGet);
        List<ShipWriter.Item> items = new ArrayList<>();
        for (int i = 0; i < 3; i++) items.add(new ShipWriter.Pos(pos(String.format("4400001%02d", i), T), false));
        w.enqueue(items, r);
        r.release(); // 소비자 자신의 보유
        long end = System.currentTimeMillis() + 5_000;
        while (repo.attempts.get() < 1 && System.currentTimeMillis() < end) Thread.sleep(5);
        w.stop();
        assertThat(acked.get()).isZero();
        assertThat(w.pendingMarks()).isEqualTo(1);
        assertThat(dropped(meters)).isEqualTo(3.0);
        assertThat(repo.positions).isEmpty();
        assertThat(out.getAll()).contains("ship flush on shutdown: 0 rows written, 3 rows not written (their stream messages stay pending and are re-processed on restart)");
    }

    /**
     * 조사 2026-10-01(종료 F3): 워커의 쓰기가 느린 채로 stop 이 오면 — 예전에는 2 s 기다린 뒤 워커가 아직 쓰는 동안 다른 스레드가 flush 했다(같은 배치를
     * 두 스레드가 동시에 씀 — '쓰는 스레드는 하나' 불변식 위반). 그리고 flush 가 꺼내기만 하고 못 쓴 배치 B 의 영수증을 워커의 늦은 커밋이 놓았다(XACK ·
     * 행 없음). 이제 종료 flush 도 워커가 한다: 겹치는 쓰기가 없고, 쓰지 못한 B 는 ACK 되지 않는다.
     */
    @Test void stopWhileTheWorkersWriteIsSlow_onlyTheWorkerWrites_andAnUnwrittenBatchKeepsItsReceipt(CapturedOutput out) throws Exception {
        GateRepo repo = new GateRepo();
        SimpleMeterRegistry meters = new SimpleMeterRegistry();
        ShipWriter w = new ShipWriter(repo, null, meters, 5, 10);
        w.start();
        AtomicInteger ackA = new AtomicInteger(), ackB = new AtomicInteger();
        Receipt ra = new Receipt(ackA::incrementAndGet), rb = new Receipt(ackB::incrementAndGet);
        w.enqueue(List.of(new ShipWriter.Pos(pos("440000001", T), false)), ra);
        ra.release();
        assertThat(repo.entered.await(5, TimeUnit.SECONDS)).as("the worker is writing batch A").isTrue();
        w.enqueue(List.of(new ShipWriter.Pos(pos("440000002", T), false)), rb);
        rb.release();
        Thread stopper = Thread.ofVirtual().start(w::stop);
        boolean overlapped = repo.second.await(3, TimeUnit.SECONDS); // 예전 코드: 2 s 뒤 flush 가 A 를 다시 쓰기 시작한다
        repo.gate.countDown();                                        // A 가 커밋된다 — 그 뒤 DB 는 죽어 있다(B 는 못 쓴다)
        stopper.join(15_000);
        assertSoftly(s -> {
            s.assertThat(stopper.isAlive()).isFalse();
            s.assertThat(overlapped).as("a second write started while the worker's write was still in flight").isFalse();
            s.assertThat(repo.maxActive.get()).as("threads writing at the same time").isEqualTo(1);
            s.assertThat(ackA.get()).as("A was committed").isEqualTo(1);
            s.assertThat(ackB.get()).as("B was never written — its message must not be acknowledged").isZero();
            s.assertThat(w.pendingMarks()).isEqualTo(1);
            s.assertThat(dropped(meters)).as("only B's row is lost at shutdown").isEqualTo(1.0);
            s.assertThat(out.getAll()).contains("ship flush on shutdown: 0 rows written, 1 rows not written");
        });
    }

    /**
     * 쓰기 하나가 stop 의 기다림 상한보다 오래 걸리면 stop 은 그렇다고 WARN 하고 돌아간다(lifecycle 단계 한도 안). 워커는 마감이 지난 뒤에는 새 배치를
     * 쓰기 시작하지 않는다 — 늦게 끝난 쓰기(A)만 커밋되고 B 는 쓰지 않은 채 ACK 하지 않는다. 결과는 워커가 스스로 남긴다.
     */
    @Test void aWriteThatOutlastsTheStopWait_theWorkerStartsNoNewWriteAfterTheDeadline(CapturedOutput out) throws Exception {
        GateRepo repo = new GateRepo();
        repo.laterWritesFail = false; // DB 는 살아 있다 — 늦었을 뿐
        SimpleMeterRegistry meters = new SimpleMeterRegistry();
        ShipWriter w = new ShipWriter(repo, null, meters, 5, 10);
        w.stopWaitMs = 1_200;
        w.start();
        AtomicInteger ackA = new AtomicInteger(), ackB = new AtomicInteger();
        Receipt ra = new Receipt(ackA::incrementAndGet), rb = new Receipt(ackB::incrementAndGet);
        w.enqueue(List.of(new ShipWriter.Pos(pos("440000001", T), false)), ra);
        ra.release();
        assertThat(repo.entered.await(5, TimeUnit.SECONDS)).isTrue();
        w.enqueue(List.of(new ShipWriter.Pos(pos("440000002", T), false)), rb);
        rb.release();
        long t0 = System.nanoTime();
        w.stop();
        long waitedMs = (System.nanoTime() - t0) / 1_000_000;
        assertThat(waitedMs).isBetween(1_100L, 5_000L);
        assertThat(out.getAll()).contains("ship writer still busy 1200 ms after stop");
        repo.gate.countDown();
        long end = System.currentTimeMillis() + 5_000;
        while (!out.getAll().contains("ship flush on shutdown") && System.currentTimeMillis() < end) Thread.sleep(10);
        assertThat(ackA.get()).isEqualTo(1);
        assertThat(ackB.get()).isZero();
        assertThat(repo.calls.get()).as("no write started after the deadline").isEqualTo(1);
        assertThat(out.getAll()).contains("ship flush on shutdown: 0 rows written, 1 rows not written");
    }

    /**
     * 리뷰 2026-10-01: stop 이 요청된 뒤 진행 중 쓰기가 실패하면 워커는 기다리지 않고 곧바로 종료 flush 로 간다 — 예전 WARN 은 그래도 'retry in 2000 ms'
     * 라고 했다(2026-09-30 17:58:51 호스트 종료 로그의 그 줄 — 일어나지 않는 기다림). 이제 WARN 은 실제로 일어나는 일을 말한다.
     */
    @Test void aWriteThatFailsAfterStopWasRequested_theWarnSaysTheShutdownFlushTriesIt_notARetryDelay(CapturedOutput out) throws Exception {
        GateRepo repo = new GateRepo();
        repo.firstWriteFails = new DataAccessResourceFailureException("db restarting");
        repo.laterWritesFail = false;
        ShipWriter w = new ShipWriter(repo, null, new SimpleMeterRegistry(), 2_000, 30_000);
        w.start();
        AtomicInteger ackA = new AtomicInteger();
        Receipt ra = new Receipt(ackA::incrementAndGet);
        w.enqueue(List.of(new ShipWriter.Pos(pos("440000001", T), false)), ra);
        ra.release();
        assertThat(repo.entered.await(5, TimeUnit.SECONDS)).as("the worker is writing batch A").isTrue();
        CountDownLatch stopped = new CountDownLatch(1);
        w.stop(stopped::countDown); // stop 요청은 이 스레드에서 바로 — 워커는 아직 A 를 쓰는 중
        repo.gate.countDown();      // 그 뒤 A 가 실패한다
        assertThat(stopped.await(10, TimeUnit.SECONDS)).isTrue();
        assertThat(out.getAll()).contains("ship batch (1 rows) failed while stopping — the shutdown flush tries it once more before its deadline (queue 0): "
                + "org.springframework.dao.DataAccessResourceFailureException: db restarting").doesNotContain("retry in");
        assertThat(out.getAll()).contains("ship flush on shutdown: 1 rows written");
        assertThat(ackA.get()).isEqualTo(1);
        assertThat(repo.calls.get()).as("the failed write and the flush's one retry").isEqualTo(2);
    }

    /**
     * 리뷰 2026-10-01: 워커가 예외가 아닌 오류(Error — OOM · StackOverflowError 등)로 죽어도 종료는 조용하지 않다. 예전에는 stop 이 죽은 스레드의 join 을
     * 곧바로 끝내고 flush 도, WARN 도, dropped 도 없었다(종료 flush 가 워커에게로 옮겨 간 뒤). 이제 워커가 죽을 때 ERROR 한 줄, stop 은 — 쓰는 스레드가
     * 이제 자기뿐이므로 — 남은 행을 직접 쓴다.
     */
    @Test void aWorkerKilledByAnError_logsIt_andStopStillFlushesTheQueuedRows(CapturedOutput out) throws Exception {
        GateRepo repo = new GateRepo();
        repo.firstWriteFails = new StackOverflowError("test: the worker dies");
        repo.laterWritesFail = false;
        repo.gate.countDown();
        SimpleMeterRegistry meters = new SimpleMeterRegistry();
        ShipWriter w = new ShipWriter(repo, null, meters, 5, 10);
        w.start();
        AtomicInteger ackA = new AtomicInteger(), ackB = new AtomicInteger();
        Receipt ra = new Receipt(ackA::incrementAndGet), rb = new Receipt(ackB::incrementAndGet);
        w.enqueue(List.of(new ShipWriter.Pos(pos("440000001", T), false)), ra);
        ra.release();
        long end = System.currentTimeMillis() + 5_000;
        while (!out.getAll().contains("ship writer thread died") && System.currentTimeMillis() < end) Thread.sleep(5);
        assertThat(out.getAll()).contains("ship writer thread died (java.lang.StackOverflowError: test: the worker dies)");
        w.enqueue(List.of(new ShipWriter.Pos(pos("440000002", T), false)), rb); // 죽은 뒤에 온 행도 영수증을 잡고 기다린다
        rb.release();
        w.stop();
        assertSoftly(s -> {
            s.assertThat(repo.positions).extracting(ShipState::mmsi).containsExactly("440000001", "440000002");
            s.assertThat(ackA.get()).isEqualTo(1);
            s.assertThat(ackB.get()).isEqualTo(1);
            s.assertThat(w.pendingMarks()).isZero();
            s.assertThat(out.getAll()).contains("ship flush on shutdown: 2 rows written");
        });
    }

    @Test void gapsGoThroughTheOrderedWriterWithTheReceipt() {
        FakeRepo repo = new FakeRepo();
        OrderedWriter ordered = new OrderedWriter(new SimpleMeterRegistry(), 1, 1);
        ShipWriter w = new ShipWriter(repo, ordered, new SimpleMeterRegistry(), 1, 1);
        AtomicInteger acked = new AtomicInteger();
        Receipt r = new Receipt(acked::incrementAndGet);
        w.onGap(new IngestEvents.AisGapReceived(new AisGap(T, T.plusSeconds(60), "server closed (1006)", "aisstream"), r));
        r.release();
        assertThat(acked.get()).isZero();
        assertThat(ordered.drainNow()).isEqualTo(1);
        assertThat(repo.gaps).hasSize(1);
        assertThat(acked.get()).isEqualTo(1);
    }
}
