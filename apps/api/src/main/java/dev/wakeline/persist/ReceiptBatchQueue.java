package dev.wakeline.persist;

import dev.wakeline.ingest.Receipt;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Collection;
import java.util.List;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.locks.Condition;
import java.util.concurrent.locks.ReentrantLock;

/**
 * 영수증(API-CONC-8)을 지키는 상한 있는 배치 큐 — TrackWriter 와 같은 규칙을 일반화했다(선박 저장기가 쓴다).
 * <ul>
 *   <li>생산자(스트림 소비 스레드)는 {@link #add} 만 하고 기다리지 않는다. 상한을 넘으면 가장 오래된 행부터 버린다(호출자가 센다).</li>
 *   <li>행은 들어온 순서 번호를 갖고 번호 순서대로 큐를 떠난다(배치로 가져가거나 넘쳐 버려짐). 메시지마다 그 메시지의 마지막 행 번호에 표식을 달고,
 *       '여기까지의 행은 모두 끝났다'(진행 중 배치의 첫 번호 − 1, 없으면 떠난 마지막 번호)에 든 표식의 영수증을 놓는다 → 그 메시지 XACK.</li>
 *   <li>풀리지 않은 표식이 maxMarks 를 넘으면(저장이 오래 막힘 — 스트림 보존보다 오래된 메시지) 가장 오래된 것부터 놓는다(호출자가 센다).</li>
 *   <li>영수증 release 는 항상 잠금 밖에서 한다(release 가 ACK 대기열에 넣는 콜백을 부른다).</li>
 * </ul>
 * 소비자(쓰기 스레드)는 한 번에 한 배치만 진행한다: {@link #next} → 쓰기 → {@link #resolved}(커밋 또는 영구 실패).
 */
final class ReceiptBatchQueue<T> {
    record Batch<T>(long firstSeq, long lastSeq, List<T> items) {}

    /** add 한 번의 결과: 넘쳐 버린 행 수 · 상한으로 먼저 놓은 영수증 수. */
    record Added(int dropped, int forced) {}

    private record Row<T>(long seq, T item) {}

    private record Mark(long seq, Receipt receipt) {}

    private final int max;
    private final int maxMarks;
    private final int batch;
    private final ReentrantLock lock = new ReentrantLock();
    private final Condition notEmpty = lock.newCondition();
    private final ArrayDeque<Row<T>> queue = new ArrayDeque<>();
    private final ArrayDeque<Mark> marks = new ArrayDeque<>();
    private long nextSeq = 1;
    /** 큐를 떠난 마지막 행 번호. */
    private long left;
    /** 진행 중 배치의 첫 번호(없으면 0). */
    private long outstandingFrom;

    ReceiptBatchQueue(int max, int maxMarks, int batch) {
        this.max = max;
        this.maxMarks = maxMarks;
        this.batch = batch;
    }

    /** 행을 넣고 영수증이 있으면 이 메시지의 마지막 행에 표식을 단다(빈 목록은 아무것도 하지 않는다 — 영수증을 잡지 않는다). */
    Added add(Collection<T> items, Receipt receipt) {
        if (items.isEmpty()) return new Added(0, 0);
        List<Receipt> done = null;
        int dropped = 0, forced = 0;
        lock.lock();
        try {
            for (T it : items) {
                if (queue.size() >= max) {
                    left = Math.max(left, queue.pollFirst().seq());
                    dropped++;
                }
                queue.addLast(new Row<>(nextSeq++, it));
            }
            if (receipt.tracked()) {
                receipt.hold();
                marks.addLast(new Mark(nextSeq - 1, receipt));
            }
            if (dropped > 0) done = takeResolved();
            while (marks.size() > maxMarks) {
                if (done == null) done = new ArrayList<>();
                done.add(marks.pollFirst().receipt());
                forced++;
            }
            notEmpty.signal();
        } finally {
            lock.unlock();
        }
        if (done != null) done.forEach(Receipt::release);
        return new Added(dropped, forced);
    }

    /** 넣은 마지막 행 번호(없으면 0). */
    long lastAddedSeq() {
        lock.lock();
        try {
            return nextSeq - 1;
        } finally {
            lock.unlock();
        }
    }

    /** 이 번호까지의 행은 모두 끝났다(진행 중 배치의 첫 번호 − 1, 없으면 떠난 마지막 번호 — 영수증을 놓는 기준과 같다). */
    long settledUpTo() {
        lock.lock();
        try {
            return outstandingFrom > 0 ? outstandingFrom - 1 : left;
        } finally {
            lock.unlock();
        }
    }

    /** 잠금 안에서: 모든 행이 끝난 표식의 영수증을 꺼낸다. */
    private List<Receipt> takeResolved() {
        long upTo = outstandingFrom > 0 ? outstandingFrom - 1 : left;
        List<Receipt> out = new ArrayList<>();
        while (!marks.isEmpty() && marks.peekFirst().seq() <= upTo) out.add(marks.pollFirst().receipt());
        return out;
    }

    /** 쓰기 스레드: 최대 waitMs 기다려 한 배치를 꺼내 진행 중으로 표시한다. 없으면 null. */
    Batch<T> next(long waitMs) throws InterruptedException {
        lock.lock();
        try {
            if (queue.isEmpty() && waitMs > 0) notEmpty.await(waitMs, TimeUnit.MILLISECONDS);
            Batch<T> b = take(true);
            if (b != null) outstandingFrom = b.firstSeq();
            return b;
        } finally {
            lock.unlock();
        }
    }

    /**
     * 종료 flush 용: 기다리지 않고 한 배치(진행 중 표시 없이 — 호출자가 쓴 뒤 {@link #releaseUpTo} 로 놓는다). 꺼낸 행은 아직 '끝난' 행이 아니다:
     * '큐를 떠난 마지막 번호'를 옮기지 않는다 — 옮기면 그 뒤의 {@link #resolved}(진행 중이던 배치의 늦은 커밋)가 쓰지 않은 이 배치의 영수증까지
     * 놓았다(조사 2026-10-01 종료 F3 — XACK 되고 행은 없다). TrackWriter.drainForFlush 와 같은 규칙.
     */
    Batch<T> poll() {
        lock.lock();
        try {
            return take(false);
        } finally {
            lock.unlock();
        }
    }

    /** 잠금 안에서: 한 배치를 꺼낸다. advanceLeft = 꺼낸 행을 '큐를 떠난' 것으로 친다(진행 중 배치로 가져갈 때만 — 끝나면 resolved 가 놓는다). */
    private Batch<T> take(boolean advanceLeft) {
        if (queue.isEmpty()) return null;
        List<T> rows = new ArrayList<>(Math.min(batch, queue.size()));
        long first = queue.peekFirst().seq(), last = first;
        while (rows.size() < batch && !queue.isEmpty()) {
            Row<T> r = queue.pollFirst();
            rows.add(r.item());
            last = r.seq();
        }
        if (advanceLeft) left = Math.max(left, last);
        return new Batch<>(first, last, rows);
    }

    /** 쓰기 스레드: 진행 중 배치가 끝났다(커밋 또는 영구 실패) — 끝난 표식의 영수증을 놓는다. */
    void resolved() {
        List<Receipt> done;
        lock.lock();
        try {
            outstandingFrom = 0;
            done = takeResolved();
        } finally {
            lock.unlock();
        }
        done.forEach(Receipt::release);
    }

    /**
     * 종료 flush: seq 까지의 행을 썼다 — 그 메시지 영수증만 놓는다(그 뒤는 ACK 하지 않아 다음 기동에서 다시 처리된다). flush 는 진행 중이던 배치부터
     * 번호 순서로 쓰므로 seq 까지가 '끝난' 행이 된다(진행 중 배치가 그 안에 들면 진행 중 표시도 지운다).
     */
    void releaseUpTo(long seq) {
        List<Receipt> done = new ArrayList<>();
        lock.lock();
        try {
            left = Math.max(left, seq);
            if (outstandingFrom > 0 && outstandingFrom <= seq) outstandingFrom = 0;
            while (!marks.isEmpty() && marks.peekFirst().seq() <= seq) done.add(marks.pollFirst().receipt());
        } finally {
            lock.unlock();
        }
        done.forEach(Receipt::release);
    }

    int size() {
        lock.lock();
        try { return queue.size(); } finally { lock.unlock(); }
    }

    int pendingMarks() {
        lock.lock();
        try { return marks.size(); } finally { lock.unlock(); }
    }
}
