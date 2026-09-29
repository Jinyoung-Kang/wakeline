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
            executor.execute(() -> {
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
            });
        } catch (RejectedExecutionException e) {
            inflight.remove(key, mine);
            mine.completeExceptionally(e);
        }
        return new Flight<>(mine, false);
    }

    /** 진행 중인 읽기 수(시험 · 진단). */
    public int size() { return inflight.size(); }
}
