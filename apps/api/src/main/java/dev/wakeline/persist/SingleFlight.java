package dev.wakeline.persist;

import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executor;
import java.util.concurrent.RejectedExecutionException;
import java.util.function.Supplier;

/**
 * 같은 키의 동시 읽기를 하나로(계약 v5 §G18 · ADR-025): 그 키를 이미 읽는 중이면 그 읽기의 future 를 함께 쓴다. 기다리는 쪽은 스레드를 잡지 않는다 —
 * future 에 이어 붙이므로(join 으로 기다리지 않는다) 같은 선박을 고른 세션이 여럿이어도, 한 세션이 같은 물음을 되풀이해도 읽기와 스레드는 하나다.
 * <ul>
 *   <li>읽기는 주어진 실행기에서 돈다(바로 실행하는 실행기면 부른 스레드에서 — 그때 같은 키를 동시에 부른 쪽은 future 를 join 으로 기다린다).</li>
 *   <li>진행 중 표시는 읽기가 끝나면(정상 · 예외) 결과를 알리기 전에 지운다 — 결과는 읽는 쪽의 캐시가 맡는다.</li>
 *   <li>실행기가 거절하면(대기열 가득 · 종료) 표시를 지우고 {@link RejectedExecutionException} 으로 끝난 future 를 준다 — 기억하지 않는다(다음 물음이
 *       다시 올린다). 부르는 쪽이 '읽지 못함' 으로 답하고 센다.</li>
 *   <li>실행기가 받아 둔 읽기를 돌리지 않고 버리면(shutdownNow 가 돌려준 대기열) 실행기 주인이 {@link #abandon} 으로 넘긴다 — 거절과 같게 끝내고 표시를
 *       지운다(리뷰 2026-09-30: 그러지 않으면 그 future 가 끝나지 않아 표시가 남고, 같은 키에 붙는 쪽이 영영 기다린다).</li>
 * </ul>
 */
public final class SingleFlight<K, V> {
    /** 읽기 하나의 결과와, 이미 진행 중인 읽기에 붙었는가(읽는 쪽의 지표 — 붙었으면 DB 를 읽지 않았다). */
    public record Flight<V>(CompletableFuture<V> result, boolean joined) {}

    private final ConcurrentHashMap<K, CompletableFuture<V>> inflight = new ConcurrentHashMap<>();

    /** 이 키를 읽는 중이면 그 읽기, 아니면 read 를 executor 에서 새로 돌린다. 던지지 않는다(거절 · 읽기의 예외는 future 로). */
    public Flight<V> run(K key, Supplier<V> read, Executor executor) {
        CompletableFuture<V> mine = new CompletableFuture<>();
        CompletableFuture<V> running = inflight.putIfAbsent(key, mine);
        if (running != null) return new Flight<>(running, true);
        try {
            executor.execute(new Read<>(inflight, key, read, mine));
        } catch (RejectedExecutionException e) {
            inflight.remove(key, mine);
            mine.completeExceptionally(e);
        }
        return new Flight<>(mine, false);
    }

    /**
     * 실행기가 돌리지 않고 버린 작업(ExecutorService.shutdownNow 가 돌려준 목록의 하나)을 넘긴다: SingleFlight 의 읽기면 {@link RejectedExecutionException}
     * 으로 끝내고 진행 중 표시를 지운다(그 future 에 붙은 쪽이 곧바로 끝난다 — 부르는 쪽은 거절처럼 '읽지 못함' 으로 답한다). 다른 작업이면 false.
     */
    public static boolean abandon(Runnable discarded) {
        if (!(discarded instanceof Read<?, ?> r)) return false;
        r.abandon();
        return true;
    }

    /** 실행기에 올린 읽기 하나 — 돌면 결과(또는 예외)로, 버려지면({@link #abandon}) 거절로 끝나고, 어느 쪽이든 먼저 표시를 지운다. */
    private static final class Read<K, V> implements Runnable {
        private final ConcurrentHashMap<K, CompletableFuture<V>> inflight;
        private final K key;
        private final Supplier<V> read;
        private final CompletableFuture<V> mine;

        Read(ConcurrentHashMap<K, CompletableFuture<V>> inflight, K key, Supplier<V> read, CompletableFuture<V> mine) {
            this.inflight = inflight;
            this.key = key;
            this.read = read;
            this.mine = mine;
        }

        @Override
        public void run() {
            V v;
            try {
                v = read.get();
            } catch (Throwable e) {
                inflight.remove(key, mine);
                mine.completeExceptionally(e);
                if (e instanceof Error err) throw err;
                return;
            }
            inflight.remove(key, mine);
            mine.complete(v);
        }

        void abandon() {
            inflight.remove(key, mine);
            mine.completeExceptionally(new RejectedExecutionException("the executor shut down before this read started"));
        }
    }

    /** 진행 중인 읽기 수(시험 · 진단). */
    public int size() { return inflight.size(); }
}
