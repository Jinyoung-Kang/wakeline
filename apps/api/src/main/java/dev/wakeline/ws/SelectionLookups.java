package dev.wakeline.ws;

import dev.wakeline.persist.SingleFlight;
import io.micrometer.core.instrument.Counter;
import io.micrometer.core.instrument.MeterRegistry;
import io.micrometer.core.instrument.Timer;

import java.time.Duration;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;
import java.util.concurrent.Executor;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.function.BiFunction;
import java.util.function.BooleanSupplier;
import java.util.function.Function;
import java.util.function.Supplier;

/**
 * 선택 조회의 공통 틀(계약 v5 §G18 · §G21 · ADR-025) — 세션 우편함(SerialOutbox — 한 번에 하나)이 기다리면 안 되는 읽기를 우편함 밖 작은 실행기에서
 * 돌리고, 답은 늦어도 마감에 준다. 조회 종류마다 하나씩 둔다 — 선택 선박의 DB 읽기({@link ShipLookups} — 저장 정적 보고 · 입출항)와 선택 항공기 노선의
 * Redis 읽기({@link RouteLookups}). 종류마다 실행기 · 지표를 따로 가진다(격벽: Redis 가 느려도 DB 조회 스레드를 잡지 않고, 그 반대도 같다).
 * <ul>
 *   <li>{@link #begin} → 부르는 쪽이 {@link Reads} 로 읽기 사슬을 만든다 → {@link #flight}. 돌려주는 {@link Flight} 는 둘로 나뉜다: answer = 답(늘 정상으로
 *       끝나고 늦어도 마감 — 그때까지 끝나지 않았으면 부르는 쪽이 준 '읽지 못함' 값), settled = 읽기가 모두 끝남(마감과 무관 — 마감 뒤에도 읽기는 돌아
 *       읽는 쪽의 캐시를 채운다).</li>
 *   <li>읽기는 after(세션의 앞 조회의 settled — 없거나 끝났으면 곧바로)가 끝난 뒤 시작한다 — 한 세션이 실행기에 두는 작업은 늘 하나 이하. 마감은 물음 때부터
 *       센다(앞 조회를 기다린 시간 포함). 올리기 직전마다 wanted 를 묻고 false 면 그 읽기를 하지 않는다(outcome=skipped).</li>
 *   <li>실행기(운영 {@link #boundedExecutor}): 작은 고정 스레드 · 대기열 {@link #queueFor}(WS 연결 상한 이상 — 세션마다 작업 하나 이하라 연결 상한까지의 세션이
 *       모두 읽어도 넘치지 않는다) · 가득 차면 거절. 거절(곧바로 던짐 · RejectedExecutionException 으로 끝난 future)은 rejected, 읽는 쪽의 그 밖의 예외는
 *       error 로 세고 읽지 못함으로 답한다 — 조용히 버리지 않는다.</li>
 *   <li>세션 쪽 세대(한 세션의 조회 하나 — 결과가 와도 이 객체가 세션의 지금 조회이고 물음이 같을 때만 쓴다)는 {@link Pending}.</li>
 *   <li>지표(kind = ship · route): wakeline_ws_{kind}_lookups_total{outcome=ok|deadline|rejected|error|skipped} · wakeline_ws_{kind}_lookup_seconds(물음 → 답) ·
 *       wakeline_ws_{kind}_lookup_queue(대기열 길이) · wakeline_ws_{kind}_lookup_dropped_total(선택 · 물음이 바뀌었거나 세션이 닫혀 답을 보내지 않은 조회).</li>
 * </ul>
 */
final class SelectionLookups implements AutoCloseable {
    /** 조회 실행기 대기열의 기본 · 최소 길이(WS 연결 상한이 더 크면 그 값 — {@link #queueFor}). */
    static final int DEFAULT_QUEUE = 256;
    private static final CompletableFuture<Void> NOW = CompletableFuture.completedFuture(null);

    /**
     * 조회 하나(키 → 값): 캐시에서 바로(I/O 없음 — 읽어야 하면 null) 또는 executor 에서 읽기(같은 키의 동시 읽기는 하나 — 운영 읽는 쪽의 SingleFlight).
     * load 는 실행기가 거절하면 곧바로 던지거나 RejectedExecutionException 으로 끝난 future 를 준다 — 둘 다 '거절' 로 센다.
     */
    interface Source<K, V> {
        V cached(K key);

        CompletableFuture<V> load(K key, Executor executor);

        static <K, V> Source<K, V> of(Function<K, V> cached, BiFunction<K, Executor, CompletableFuture<V>> load) {
            return new Source<>() {
                @Override public V cached(K key) { return cached.apply(key); }
                @Override public CompletableFuture<V> load(K key, Executor executor) { return load.apply(key, executor); }
            };
        }

        /** 막히는 읽기(시험의 가짜 저장소): executor 에서 돌린다 — 같은 키 합치기 없음. */
        static <K, V> Source<K, V> blocking(Function<K, V> cached, Function<K, V> load) {
            return of(cached, (k, ex) -> CompletableFuture.supplyAsync(() -> load.apply(k), ex));
        }

        /** 메모리 값(I/O 없음 — 시험의 가짜): 늘 곧바로 답한다. */
        static <K, V> Source<K, V> memory(Function<K, V> f) { return of(f, (k, ex) -> CompletableFuture.completedFuture(f.apply(k))); }
    }

    /**
     * 조회 하나의 진행. answer = 답(읽은 값 또는 마감의 읽지 못함 — 늘 정상으로 끝난다). settled = 이 조회의 읽기가 모두 끝남(정상 · 실패 · 건너뜀 — 마감과 무관).
     * 읽기가 마감 안에 끝나면 settled 가 answer 보다 먼저 끝난다(받는 쪽이 답을 볼 때 이미 끝났음을 안다).
     */
    record Flight<R>(CompletableFuture<R> answer, CompletableFuture<Void> settled) {}

    /**
     * 세션의 조회 하나(세대 — 우편함만 세션의 조회 필드를 바꾼다). result · settled 는 조회 · 마감 스레드가 쓴다 — 우편함은 이 객체가 세션의 지금 조회이고 물음이
     * 같을 때만 읽는다. 앞 세대의 결과는 제 객체에 남아 읽히지 않는다(늦게 온 결과 버리기). 답(result)이 와도 읽기가 끝날 때(settled)까지 세션의 조회로
     * 남는다 — 그동안 같은 물음은 새 읽기를 올리지 않는다.
     */
    static final class Pending<Q, R> {
        final Q question;
        /** 답: 읽은 값 또는 마감의 읽지 못함. */
        volatile R result;
        /** 이 조회의 읽기가 모두 끝났다(마감과 무관). */
        volatile boolean settled;
        /** 우편함이 버렸다(선택 · 물음이 바뀜 · 해제) — 아직 올리지 않은 읽기는 하지 않고, 결과가 와도 다시 계산을 예약하지 않는다. */
        volatile boolean superseded;
        /** 우편함만: 이 조회가 세션의 조회인 동안 그 답을 보냈다(버릴 때 '답을 보내지 않은 조회' 로 세지 않는다). */
        boolean answered;

        Pending(Q question) { this.question = question; }

        /** 읽기를 올리기 직전에 묻는다: 우편함이 버리지 않았고 세션이 닫히지 않았다. */
        boolean wanted(WsSession s) { return !superseded && !s.isClosing(); }

        /**
         * 조회의 답 · 끝남을 따라간다(조회 · 마감 스레드에서 불린다). 답이 오면 recheck(우편함에 다시 계산을 예약 — 합쳐졌거나 닫혔으면 false)를 부르고, 세션이
         * 닫혀 예약하지 못했으면 dropped 로 센다. 마감에 답한 뒤 끝난 읽기는 recheck 를 한 번 더 부른다 — 캐시에 든 실제 값을 곧바로 보내게. 버린 조회는
         * 부르지 않는다(이미 셌다).
         */
        void follow(Flight<R> f, WsSession s, BooleanSupplier recheck, Runnable dropped) {
            f.settled().thenRun(() -> {
                settled = true;
                if (result != null && !superseded) recheck.getAsBoolean(); // 마감 안에 끝났으면 아래 답이 예약한다
            });
            f.answer().thenAccept(r -> {
                result = r;
                if (superseded) return;
                if (!recheck.getAsBoolean() && s.isClosing()) dropped.run();
            });
        }

        /** 우편함: 이 조회를 버린다(결과가 와도 쓰지 않고, 아직 올리지 않은 읽기는 하지 않는다). 답을 보내지 않았으면 센다. */
        void supersede(Runnable dropped) {
            superseded = true;
            if (!answered) dropped.run();
        }
    }

    /** 대기열 길이: WS 연결 상한 이상(세션마다 작업 하나 이하 — {@link #begin} 의 after), 적어도 {@value #DEFAULT_QUEUE}. */
    static int queueFor(int wsMaxConn) { return Math.max(DEFAULT_QUEUE, wsMaxConn); }

    /**
     * 운영 실행기: 데몬 스레드 threads 개(이름 {@code name}N — 저장소를 기다린다) · 대기열 queue · 넘치면 거절(부르는 쪽이 읽지 못함으로 답한다).
     * 쉬는 스레드는 60 s 뒤 끝난다.
     */
    static ThreadPoolExecutor boundedExecutor(String name, int threads, int queue) {
        ThreadPoolExecutor ex = new ThreadPoolExecutor(threads, threads, 60, TimeUnit.SECONDS, new ArrayBlockingQueue<>(queue),
                Thread.ofPlatform().daemon().name(name, 1).factory(), new ThreadPoolExecutor.AbortPolicy());
        ex.allowCoreThreadTimeOut(true);
        return ex;
    }

    /** 조회 하나의 읽기 도우미({@link #begin} 이 만든다): 차례(turn) · 실행기 · wanted 확인 · 읽기 올리기와 그 표시(여러 스레드가 차례로 쓴다). */
    final class Reads {
        private final long t0 = System.nanoTime();
        private final CompletableFuture<Void> turn;
        private final BooleanSupplier wanted;
        private volatile boolean refused;
        private volatile boolean failed;
        private volatile boolean skipped;

        private Reads(CompletableFuture<Void> turn, BooleanSupplier wanted) {
            this.turn = turn;
            this.wanted = wanted;
        }

        /** 세션의 앞 조회가 끝남(정상 · 예외 무관) — 읽기 사슬은 이것 뒤에 잇는다. */
        CompletableFuture<Void> turn() { return turn; }

        Executor executor() { return executor; }

        /** 읽기를 올려도 되는가(세션이 아직 이 물음을 원한다). 아니면 건너뜀으로 표시한다 — 부르는 쪽은 읽지 않고 '읽지 못함' 값으로 끝낸다. */
        boolean wanted() {
            if (wanted.getAsBoolean()) return true;
            skipped = true;
            return false;
        }

        /**
         * 읽기 하나를 올린다. 거절(곧바로 던짐 · RejectedExecutionException 으로 끝남 — 대기열 가득 · 종료)은 refused, 그 밖의 예외는 failed 로 표시하고
         * null 로 끝낸다(부르는 쪽이 '읽지 못함' 값으로 바꾼다). 예외로 끝나지 않는다.
         */
        <V> CompletableFuture<V> read(Supplier<CompletableFuture<V>> start) {
            CompletableFuture<V> f;
            try {
                f = start.get();
            } catch (RuntimeException e) {
                f = CompletableFuture.failedFuture(e);
            }
            return f.handle((v, e) -> {
                if (e == null) return v;
                Throwable cause = e instanceof CompletionException && e.getCause() != null ? e.getCause() : e;
                if (cause instanceof RejectedExecutionException) refused = true;
                else failed = true;
                return null;
            });
        }
    }

    private final Executor executor;
    private final long deadlineMs;
    private final Executor deadlines;
    private final Counter ok;
    private final Counter late;
    private final Counter rejected;
    private final Counter failed;
    private final Counter skipped;
    private final Counter dropped;
    private final Timer latency;

    /**
     * @param kind       지표 이름의 종류(ship · route — wakeline_ws_{kind}_lookup…)
     * @param subject    지표 설명의 대상(예: "선택 선박 조회")
     * @param executor   읽기를 돌릴 실행기(운영 {@link #boundedExecutor} — 시험은 바로 실행 · 가상 스레드)
     * @param deadlineMs 물음 → 답의 상한(종류마다 설정값에서 — ShipLookups · RouteLookups 가 밝힌다)
     */
    SelectionLookups(String kind, String subject, Executor executor, long deadlineMs, MeterRegistry meters) {
        this.executor = executor;
        this.deadlineMs = deadlineMs;
        // 마감 처리는 JDK 의 지연 스레드에서 바로(답 하나를 채우고 우편함에 예약만 한다 — 공용 풀을 쓰지 않는다)
        this.deadlines = CompletableFuture.delayedExecutor(deadlineMs, TimeUnit.MILLISECONDS, Runnable::run);
        String total = "wakeline_ws_" + kind + "_lookups_total";
        this.ok = outcome(meters, total, "ok", "모든 읽기가 마감 안에 끝난 조회");
        this.late = outcome(meters, total, "deadline", "마감까지 끝나지 않아 남은 부분을 읽지 못함으로 답한 조회(읽기는 계속돼 캐시를 채운다)");
        this.rejected = outcome(meters, total, "rejected", "조회 실행기 대기열이 가득 차 읽지 않고 읽지 못함으로 답한 조회");
        this.failed = outcome(meters, total, "error", "읽는 쪽이 예외로 끝나 읽지 못함으로 답한 조회(읽는 쪽은 예외를 삼킨다 — 결함 신호)");
        this.skipped = outcome(meters, total, "skipped", "세션의 앞 읽기를 기다리는 동안 선택이 바뀌어 읽지 않고 끝낸 조회");
        this.dropped = Counter.builder("wakeline_ws_" + kind + "_lookup_dropped_total")
                .description("선택 · 물음이 바뀌었거나 세션이 닫혀 답을 보내지 않은 " + subject).register(meters);
        this.latency = Timer.builder("wakeline_ws_" + kind + "_lookup_seconds").description(subject + "의 물음 → 답(마감 포함)")
                .publishPercentiles(0.5, 0.95).register(meters);
        if (executor instanceof ThreadPoolExecutor tpe)
            meters.gauge("wakeline_ws_" + kind + "_lookup_queue", tpe, e -> e.getQueue().size());
    }

    private static Counter outcome(MeterRegistry meters, String name, String outcome, String description) {
        return Counter.builder(name).tag("outcome", outcome).description(description).register(meters);
    }

    long deadlineMs() { return deadlineMs; }

    /** 답을 보내지 않은 조회(부르는 쪽 — 선택 · 물음이 바뀌었다, 세션이 닫혔다)를 센다. */
    void dropped() { dropped.increment(); }

    /** 조회 하나를 시작한다(부르는 쪽을 막지 않는다): 읽기 사슬은 {@link Reads#turn()} 뒤에 이어 만들고 {@link #flight} 로 마친다. */
    Reads begin(CompletableFuture<?> after, BooleanSupplier wanted) {
        CompletableFuture<Void> turn = after == null || after.isDone() ? NOW : after.handle((v, e) -> null);
        return new Reads(turn, wanted);
    }

    /**
     * 읽기 사슬(all — 예외로 끝나지 않게 {@link Reads#read} 로 만든다)을 답 · 끝남으로 나눈다. 답은 all 이 끝나면 그 값(null · 예외면 fallback), 늦어도
     * 물음 뒤 {@link #deadlineMs} 에 fallback. 결과 하나마다 outcome 하나와 지연 하나를 센다. 바로 실행하는 실행기면 돌아올 때 이미 끝나 있다.
     */
    <R> Flight<R> flight(Reads r, CompletableFuture<R> all, Supplier<R> fallback) {
        CompletableFuture<R> answer = new CompletableFuture<>();
        CompletableFuture<Void> settled = new CompletableFuture<>();
        all.whenComplete((v, e) -> {
            settled.complete(null); // 읽기가 모두 끝났다 — 답보다 먼저
            Counter outcome = e != null || r.failed ? failed : r.refused ? rejected : r.skipped ? skipped : ok;
            if (answer.complete(v != null ? v : fallback.get())) finish(outcome, r.t0);
        });
        if (!answer.isDone()) deadlines.execute(() -> {
            if (answer.complete(fallback.get())) finish(late, r.t0);
        });
        return new Flight<>(answer, settled);
    }

    private void finish(Counter outcome, long t0) {
        outcome.increment();
        latency.record(Duration.ofNanos(System.nanoTime() - t0));
    }

    /**
     * 실행기를 멈춘다(WsHub.stop · 조회 묶음 바꾸기). 도는 읽기에는 인터럽트를 보낸다(끝나면 읽는 쪽이 제 값 · 오류 값으로 끝낸다). 대기열에서 버린 읽기는 거절로 끝낸다
     * ({@link SingleFlight#abandon} — 리뷰 2026-09-30: 그러지 않으면 그 future 가 끝나지 않아 읽는 쪽의 진행 중 표시가 남고, 같은 키를 묻는 REST 가 끝나지 않는
     * future 에 붙었다). 운영의 읽는 쪽(RouteReader · StoredStaticReader · PortCallReader)은 모두 SingleFlight 로 올린다 — 그 밖의 작업(시험의
     * {@link Source#blocking})은 끝낼 수 없지만 그 조회의 답은 마감에 나간다.
     */
    @Override
    public void close() {
        if (executor instanceof ExecutorService es) for (Runnable discarded : es.shutdownNow()) SingleFlight.abandon(discarded);
    }
}
