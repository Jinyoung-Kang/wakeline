package dev.wakeline.persist;

import dev.wakeline.ingest.Receipt;
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
}
