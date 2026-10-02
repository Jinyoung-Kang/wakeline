package dev.wakeline.platform.data;

import dev.wakeline.platform.support.Receipt;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;

/** 영수증을 지키는 배치 큐: 순서·배치 단위 해제, 넘침(오래된 것부터 버림 + 끝난 메시지 해제), 표식 상한, 종료 flush 의 부분 해제. */
class ReceiptBatchQueueTest {

    static final class Acked {
        final AtomicInteger n = new AtomicInteger();
        Receipt receipt() { return new Receipt(n::incrementAndGet); }
    }

    static void releaseProducer(Receipt... rs) { for (Receipt r : rs) r.release(); } // 소비자 자신의 보유

    @Test void receiptIsReleasedOnlyAfterAllRowsOfThatMessageResolved() throws Exception {
        ReceiptBatchQueue<Integer> q = new ReceiptBatchQueue<>(100, 10, 3);
        Acked a = new Acked(), b = new Acked();
        Receipt ra = a.receipt(), rb = b.receipt();
        q.add(List.of(1, 2), ra);
        q.add(List.of(3, 4, 5), rb);
        releaseProducer(ra, rb);
        assertThat(a.n.get() + b.n.get()).isZero();
        var b1 = q.next(0);
        assertThat(b1.items()).containsExactly(1, 2, 3);
        q.resolved();
        assertThat(a.n.get()).as("rows 1-2 done").isEqualTo(1);
        assertThat(b.n.get()).as("row 4-5 still queued").isZero();
        var b2 = q.next(0);
        assertThat(b2.items()).containsExactly(4, 5);
        assertThat(q.pendingMarks()).isEqualTo(1);
        q.resolved();
        assertThat(b.n.get()).isEqualTo(1);
        assertThat(q.next(1)).isNull();
        assertThat(q.size()).isZero();
    }

    @Test void emptyAddHoldsNothing_andUntrackedReceiptsAreIgnored() {
        ReceiptBatchQueue<Integer> q = new ReceiptBatchQueue<>(10, 10, 10);
        Acked a = new Acked();
        Receipt r = a.receipt();
        assertThat(q.add(List.of(), r)).isEqualTo(new ReceiptBatchQueue.Added(0, 0));
        r.release();
        assertThat(a.n.get()).as("nothing to persist → acked right away").isEqualTo(1);
        q.add(List.of(1), Receipt.NONE);
        assertThat(q.pendingMarks()).isZero();
    }

    @Test void overflowDropsOldestAndReleasesMessagesWhoseRowsAreAllGone() {
        ReceiptBatchQueue<Integer> q = new ReceiptBatchQueue<>(3, 10, 10);
        Acked a = new Acked(), b = new Acked();
        Receipt ra = a.receipt(), rb = b.receipt();
        q.add(List.of(1, 2), ra);
        ReceiptBatchQueue.Added added = q.add(List.of(3, 4, 5), rb);
        releaseProducer(ra, rb);
        assertThat(added.dropped()).isEqualTo(2);
        assertThat(a.n.get()).as("both rows of A were dropped — counted, then acknowledged").isEqualTo(1);
        assertThat(b.n.get()).isZero();
        assertThat(q.size()).isEqualTo(3);
    }

    @Test void marksAboveTheCapAreForced() {
        ReceiptBatchQueue<Integer> q = new ReceiptBatchQueue<>(100, 2, 10);
        Acked a = new Acked();
        Receipt r1 = a.receipt(), r2 = a.receipt(), r3 = a.receipt();
        q.add(List.of(1), r1);
        q.add(List.of(2), r2);
        ReceiptBatchQueue.Added x = q.add(List.of(3), r3);
        releaseProducer(r1, r2, r3);
        assertThat(x.forced()).isEqualTo(1);
        assertThat(a.n.get()).isEqualTo(1);
        assertThat(q.pendingMarks()).isEqualTo(2);
    }

    @Test void shutdownFlushReleasesOnlyUpToWhatWasWritten() {
        ReceiptBatchQueue<Integer> q = new ReceiptBatchQueue<>(100, 10, 2);
        Acked a = new Acked(), b = new Acked();
        Receipt ra = a.receipt(), rb = b.receipt();
        q.add(List.of(1, 2), ra);
        q.add(List.of(3, 4), rb);
        releaseProducer(ra, rb);
        var first = q.poll();
        assertThat(first.items()).containsExactly(1, 2);
        q.releaseUpTo(first.lastSeq());
        assertThat(a.n.get()).isEqualTo(1);
        assertThat(q.poll().items()).containsExactly(3, 4); // 이 배치는 쓰지 못했다고 치면 B 는 ACK 되지 않는다
        assertThat(b.n.get()).isZero();
        assertThat(q.poll()).isNull();
    }

    /**
     * 조사 2026-10-01(종료 F3): 종료 flush 가 꺼낸 배치는 쓰기 전에는 '끝난' 행이 아니다. 예전 poll 은 '큐를 떠난 마지막 번호'를 옮겨서, 그 뒤 진행 중
     * 배치가 끝나면(resolved — 늦게 커밋한 워커) flush 가 꺼내기만 하고 쓰지 못한 배치의 영수증까지 놓았다 → XACK · 행은 없음(조용한 손실).
     */
    @Test void aBatchPolledByTheShutdownFlushIsNotReleasedWhenTheOutstandingBatchResolves() throws Exception {
        ReceiptBatchQueue<Integer> q = new ReceiptBatchQueue<>(100, 10, 2);
        Acked a = new Acked(), b = new Acked();
        Receipt ra = a.receipt(), rb = b.receipt();
        q.add(List.of(1, 2), ra);
        q.add(List.of(3, 4), rb);
        releaseProducer(ra, rb);
        assertThat(q.next(0).items()).containsExactly(1, 2); // 워커가 쓰는 중
        var polled = q.poll();                               // 종료 flush 가 꺼냈다(아직 쓰지 않음)
        assertThat(polled.items()).containsExactly(3, 4);
        q.resolved();                                        // 워커의 쓰기가 커밋됐다
        assertThat(a.n.get()).isEqualTo(1);
        assertThat(b.n.get()).as("rows 3-4 were polled by the flush but never written").isZero();
        assertThat(q.settledUpTo()).as("only the committed rows are settled").isEqualTo(2);
        q.releaseUpTo(polled.lastSeq());                     // flush 가 쓴 뒤에야
        assertThat(b.n.get()).isEqualTo(1);
        assertThat(q.settledUpTo()).isEqualTo(4);
    }

    /** ADR-032 writer_backlog: 아직 쓰지 못한 행 중 가장 오래된 것 — 진행 중(재시도 중) 배치의 첫 행, 없으면 큐의 맨 앞. */
    @Test void oldestPendingIsTheInFlightBatchsFirstRowThenTheQueueHead() throws Exception {
        ReceiptBatchQueue<Integer> q = new ReceiptBatchQueue<>(100, 10, 2);
        assertThat(q.oldestPendingAtMs()).isEqualTo(-1);
        long before = System.currentTimeMillis();
        q.add(List.of(1, 2), Receipt.NONE);
        long t1 = q.oldestPendingAtMs();
        assertThat(t1).isBetween(before, System.currentTimeMillis());
        Thread.sleep(5);
        q.add(List.of(3), Receipt.NONE);
        assertThat(q.next(0).items()).containsExactly(1, 2);
        assertThat(q.oldestPendingAtMs()).as("진행 중 배치(DB 가 답하지 않으면 재시도로 머문다)의 첫 행").isEqualTo(t1);
        q.resolved();
        long t2 = q.oldestPendingAtMs();
        assertThat(t2).as("남은 행(3)이 들어온 시각").isGreaterThan(t1);
        q.next(0);
        q.resolved();
        assertThat(q.oldestPendingAtMs()).isEqualTo(-1);
    }
}
