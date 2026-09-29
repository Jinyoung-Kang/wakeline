package dev.wakeline.ws;

import dev.wakeline.domain.ShipStatic;
import dev.wakeline.persist.StoredStaticReader;
import dev.wakeline.portcalls.PortCallReader;
import dev.wakeline.portcalls.PortCallsInfo;
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
 * 선택 선박의 DB 조회를 세션 우편함 밖에서(계약 v5 §G18 · ADR-025) — ship_selected 의 static(메모리에 없을 때 저장 정적 보고 — §G17)과 port_calls
 * (입출항 색인 — ADR-022 개정). 우편함(SerialOutbox)은 세션 상태와 전송의 주인으로 남고, DB 를 기다리는 일은 여기서 한다 — 그동안 그 세션의 항공기 ·
 * 선박 diff · pong · heartbeat 는 제때 간다.
 * <ul>
 *   <li>{@link #cached}: 읽는 쪽의 메모리 캐시만 본다(우편함에서 — I/O 없음). 다 답할 수 있으면 부르는 쪽이 곧바로 보낸다(대부분의 다시 계산 — 선박 이동 ·
 *       주기 다시 보기).</li>
 *   <li>{@link #load}: 캐시에 없는 부분을 조회 실행기에서 읽는다 — 저장 정적 보고 → 그 호출부호의 입출항 순서(입출항은 보일 정적 정보의 호출부호로 찾는다).
 *       돌려주는 {@link Flight} 는 둘로 나뉜다: answer = 답(늘 정상으로 끝나고 늦어도 마감 deadlineMs — 운영: 읽기 풀이 답하는 한 번 읽기의 상한 = 연결 대기
 *       2 s + 문장 3 s = 5 s. 그때까지 끝나지 않은 부분은 읽지 못함 — static → stored_unavailable, port_calls → error, 계약에 이미 있는 값), settled = 읽기가
 *       모두 끝남(마감과 무관 — 마감 뒤에도 읽기는 돌아 캐시를 채운다). 세션은 settled 까지 같은 물음으로 새 읽기를 올리지 않고(ShipFanout), 다음 물음의
 *       읽기는 settled 뒤에 시작한다(after) — 한 세션이 조회 실행기에 두는 작업은 늘 하나 이하다.</li>
 *   <li>같은 키의 동시 읽기는 하나(읽는 쪽의 SingleFlight — StoredStaticReader.lookupAsync 는 MMSI, PortCallReader.forStaticAsync 는 호출부호): 같은 선박을
 *       고른 세션들 · 한 세션의 되풀이 물음은 진행 중인 읽기의 future 에 이어 붙는다 — 조회 스레드를 잡지 않는다(join 으로 기다리지 않는다).</li>
 *   <li>선택이 바뀌어 쓰지 않을 조회(wanted false)는 아직 올리지 않은 읽기를 하지 않는다(outcome=skipped) — 한 세션이 선박을 연달아 바꿔도 실행기에 쌓이지 않는다.</li>
 *   <li>실행기(운영 {@link #boundedExecutor}): 스레드 = 읽기 풀 연결 수(스레드마다 연결 하나 — 이 풀 안에서 서로 연결을 기다리지 않는다), 대기열
 *       {@link #queueFor}(WS 연결 상한 이상 — 세션마다 작업 하나 이하라 연결 상한까지의 세션이 모두 읽어도 넘치지 않는다). 가득 차면 그 읽기는 하지 않고
 *       읽지 못함으로 답한다(지표 outcome=rejected — 조용히 버리지 않는다, 기억하지 않아 다음 다시 계산이 다시 올린다).</li>
 *   <li>캐시 수명(찾음 60 s · 실패 15 s · 입출항 15 s)은 읽는 쪽(StoredStaticReader · PortCallReader)이 그대로 맡는다.</li>
 *   <li>지표: wakeline_ws_ship_lookups_total{outcome=ok|deadline|rejected|error|skipped} · wakeline_ws_ship_lookup_seconds(물음 → 답) ·
 *       wakeline_ws_ship_lookup_queue(대기열 길이) · wakeline_ws_ship_lookup_dropped_total(선택 · 물음이 바뀌어 답을 보내지 않은 조회).</li>
 * </ul>
 */
final class ShipLookups implements AutoCloseable {
    /** 조회 실행기 대기열의 기본 · 최소 길이(WS 연결 상한이 더 크면 그 값 — {@link #queueFor}). */
    static final int DEFAULT_QUEUE = 256;
    /** 알 수 없는 출처(저장 정적 보고를 읽는 쪽이 없는 구성 — 시험뿐). */
    static final SelectedStatic UNKNOWN = new SelectedStatic(null, null);
    /** 메모리에 없고 DB 를 (제때) 읽지 못함 — 저장돼 있는지 모름. */
    static final SelectedStatic UNAVAILABLE = new SelectedStatic(null, WsMessages.STATIC_STORED_UNAVAILABLE);
    private static final CompletableFuture<Void> NOW = CompletableFuture.completedFuture(null);

    /** ship_selected 의 정적 정보와 그 출처(계약 v5 §G17 — {@link WsMessages#STATIC_LIVE} 등, 읽는 쪽이 없는 구성에서 모르면 null). */
    record SelectedStatic(ShipStatic stat, String source) {}

    /** 조회 결과 한 벌: 보일 정적 정보(과 출처) · 그 호출부호의 입출항(읽는 쪽이 없는 구성이면 null). */
    record Resolved(SelectedStatic sel, PortCallsInfo calls) {}

    /**
     * 조회 하나의 진행. answer = 답(읽은 값 또는 마감의 읽지 못함 — 늘 정상으로 끝난다). settled = 이 조회의 읽기가 모두 끝남(정상 · 실패 · 건너뜀 — 마감과 무관).
     * 읽기가 마감 안에 끝나면 settled 가 answer 보다 먼저 끝난다(받는 쪽이 답을 볼 때 이미 끝났음을 안다).
     */
    record Flight(CompletableFuture<Resolved> answer, CompletableFuture<Void> settled) {}

    /**
     * 조회 하나(저장 정적 보고 · 입출항): 캐시에서 바로(I/O 없음 — 읽어야 하면 null) 또는 executor 에서 읽기(같은 키의 동시 읽기는 하나 — 운영 읽는 쪽).
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

        /** 막히는 읽기(시험의 가짜 DB): executor 에서 돌린다 — 같은 키 합치기 없음. */
        static <K, V> Source<K, V> blocking(Function<K, V> cached, Function<K, V> load) {
            return of(cached, (k, ex) -> CompletableFuture.supplyAsync(() -> load.apply(k), ex));
        }

        /** 메모리 값(I/O 없음 — 시험의 가짜): 늘 곧바로 답한다. */
        static <K, V> Source<K, V> memory(Function<K, V> f) { return of(f, (k, ex) -> CompletableFuture.completedFuture(f.apply(k))); }
    }

    /** 운영: 저장 정적 보고(캐시 · 같은 MMSI 한 번 읽기 — {@link StoredStaticReader}). */
    static Source<String, StoredStaticReader.Lookup> stored(StoredStaticReader r) { return Source.of(r::cached, r::lookupAsync); }

    /** 운영: 입출항 색인(호출부호별 캐시 · 같은 호출부호 한 번 읽기 — {@link PortCallReader}). */
    static Source<ShipStatic, PortCallsInfo> portCalls(PortCallReader r) { return Source.of(r::cachedForStatic, r::forStaticAsync); }

    /** 대기열 길이: WS 연결 상한 이상(세션마다 작업 하나 이하 — {@link #load} 의 after), 적어도 {@value #DEFAULT_QUEUE}. */
    static int queueFor(int wsMaxConn) { return Math.max(DEFAULT_QUEUE, wsMaxConn); }

    /**
     * 운영 실행기: 데몬 스레드 threads 개(이름 ship-lookup-N — JDBC · Redis 를 기다린다) · 대기열 queue · 넘치면 거절(부르는 쪽이 읽지 못함으로 답한다).
     * 쉬는 스레드는 60 s 뒤 끝난다.
     */
    static ThreadPoolExecutor boundedExecutor(int threads, int queue) {
        ThreadPoolExecutor ex = new ThreadPoolExecutor(threads, threads, 60, TimeUnit.SECONDS, new ArrayBlockingQueue<>(queue),
                Thread.ofPlatform().daemon().name("ship-lookup-", 1).factory(), new ThreadPoolExecutor.AbortPolicy());
        ex.allowCoreThreadTimeOut(true);
        return ex;
    }

    /** 조회 하나의 표시(여러 스레드가 차례로 쓴다 — future 완료가 순서를 보장한다). */
    private static final class Track {
        volatile boolean refused;
        volatile boolean failed;
        volatile boolean skipped;
    }

    private final Executor executor;
    private final long deadlineMs;
    private final Executor deadlines;
    private volatile Source<String, StoredStaticReader.Lookup> stored;
    private volatile Source<ShipStatic, PortCallsInfo> portCalls;
    private final Counter ok;
    private final Counter late;
    private final Counter rejected;
    private final Counter failed;
    private final Counter skipped;
    private final Counter dropped;
    private final Timer latency;

    /**
     * @param executor   읽기를 돌릴 실행기(운영 {@link #boundedExecutor} — 시험은 바로 실행 · 가상 스레드)
     * @param deadlineMs 물음 → 답의 상한(운영: 읽기 풀이 답하는 한 번 읽기의 상한 — ReadPool.readBoundMs)
     */
    ShipLookups(Executor executor, long deadlineMs, MeterRegistry meters) {
        this.executor = executor;
        this.deadlineMs = deadlineMs;
        // 마감 처리는 JDK 의 지연 스레드에서 바로(답 하나를 채우고 우편함에 예약만 한다 — 공용 풀을 쓰지 않는다)
        this.deadlines = CompletableFuture.delayedExecutor(deadlineMs, TimeUnit.MILLISECONDS, Runnable::run);
        this.ok = outcome(meters, "ok", "모든 읽기가 마감 안에 끝난 조회");
        this.late = outcome(meters, "deadline", "마감까지 끝나지 않아 남은 부분을 읽지 못함으로 답한 조회(읽기는 계속돼 캐시를 채운다)");
        this.rejected = outcome(meters, "rejected", "조회 실행기 대기열이 가득 차 읽지 않고 읽지 못함으로 답한 조회");
        this.failed = outcome(meters, "error", "읽는 쪽이 예외로 끝나 읽지 못함으로 답한 조회(읽는 쪽은 예외를 삼킨다 — 결함 신호)");
        this.skipped = outcome(meters, "skipped", "세션의 앞 읽기를 기다리는 동안 선택이 바뀌어 읽지 않고 끝낸 조회");
        this.dropped = Counter.builder("wakeline_ws_ship_lookup_dropped_total")
                .description("선택 · 물음이 바뀌었거나 세션이 닫혀 답을 보내지 않은 선택 선박 조회").register(meters);
        this.latency = Timer.builder("wakeline_ws_ship_lookup_seconds").description("선택 선박 조회의 물음 → 답(마감 포함)")
                .publishPercentiles(0.5, 0.95).register(meters);
        if (executor instanceof ThreadPoolExecutor tpe)
            meters.gauge("wakeline_ws_ship_lookup_queue", tpe, e -> e.getQueue().size());
    }

    private static Counter outcome(MeterRegistry meters, String outcome, String description) {
        return Counter.builder("wakeline_ws_ship_lookups_total").tag("outcome", outcome).description(description).register(meters);
    }

    void setStored(Source<String, StoredStaticReader.Lookup> s) { stored = s; }

    void setPortCalls(Source<ShipStatic, PortCallsInfo> s) { portCalls = s; }

    long deadlineMs() { return deadlineMs; }

    /** 답을 보내지 않은 조회(부르는 쪽 — 선택 · 물음이 바뀌었다, 세션이 닫혔다)를 센다. */
    void dropped() { dropped.increment(); }

    /** 메모리 정적 정보(live — 있으면 그것)와 읽는 쪽의 캐시만으로 답한다(I/O 없음). 한 부분이라도 읽어야 하면 null. */
    Resolved cached(String mmsi, ShipStatic live) {
        SelectedStatic sel;
        if (live != null) sel = new SelectedStatic(live, WsMessages.STATIC_LIVE);
        else {
            Source<String, StoredStaticReader.Lookup> s = stored;
            if (s == null) sel = UNKNOWN;
            else {
                StoredStaticReader.Lookup l = s.cached(mmsi);
                if (l == null) return null;
                sel = selected(l);
            }
        }
        Source<ShipStatic, PortCallsInfo> p = portCalls;
        if (p == null) return new Resolved(sel, null);
        PortCallsInfo c = p.cached(sel.stat());
        return c == null ? null : new Resolved(sel, c);
    }

    /**
     * 읽어서 답한다(부르는 쪽을 막지 않는다). 읽기는 after(세션의 앞 조회의 settled — 없거나 끝났으면 곧바로)가 끝난 뒤 시작하고, 올리기 직전마다 wanted 를
     * 묻는다(false 면 그 읽기를 하지 않는다 — skipped). 답은 늦어도 물음 뒤 {@link #deadlineMs} 에 온다(앞 조회를 기다린 시간도 포함). 바로 실행하는
     * 실행기면 돌아올 때 이미 끝나 있다.
     */
    Flight load(String mmsi, ShipStatic live, CompletableFuture<?> after, BooleanSupplier wanted) {
        long t0 = System.nanoTime();
        Track t = new Track();
        CompletableFuture<Void> turn = after == null || after.isDone() ? NOW : after.handle((v, e) -> null);
        CompletableFuture<SelectedStatic> st = turn.thenCompose(x -> staticPart(mmsi, live, wanted, t));
        CompletableFuture<Resolved> all = st.thenCompose(sel -> callsPart(sel, wanted, t));
        CompletableFuture<Resolved> answer = new CompletableFuture<>();
        CompletableFuture<Void> settled = new CompletableFuture<>();
        all.whenComplete((r, e) -> {
            settled.complete(null); // 읽기가 모두 끝났다 — 답보다 먼저
            Counter outcome = e != null || t.failed ? failed : t.refused ? rejected : t.skipped ? skipped : ok;
            if (answer.complete(r != null ? r : fallback(st))) finish(outcome, t0);
        });
        if (!answer.isDone()) deadlines.execute(() -> {
            if (answer.complete(fallback(st))) finish(late, t0);
        });
        return new Flight(answer, settled);
    }

    private CompletableFuture<SelectedStatic> staticPart(String mmsi, ShipStatic live, BooleanSupplier wanted, Track t) {
        if (live != null) return CompletableFuture.completedFuture(new SelectedStatic(live, WsMessages.STATIC_LIVE));
        Source<String, StoredStaticReader.Lookup> s = stored;
        if (s == null) return CompletableFuture.completedFuture(UNKNOWN);
        StoredStaticReader.Lookup l = s.cached(mmsi);
        if (l != null) return CompletableFuture.completedFuture(selected(l));
        if (!wanted.getAsBoolean()) {
            t.skipped = true;
            return CompletableFuture.completedFuture(UNAVAILABLE);
        }
        return read(() -> s.load(mmsi, executor), t).thenApply(v -> v == null ? UNAVAILABLE : selected(v));
    }

    private CompletableFuture<Resolved> callsPart(SelectedStatic sel, BooleanSupplier wanted, Track t) {
        Source<ShipStatic, PortCallsInfo> p = portCalls;
        if (p == null) return CompletableFuture.completedFuture(new Resolved(sel, null));
        PortCallsInfo c = p.cached(sel.stat());
        if (c != null) return CompletableFuture.completedFuture(new Resolved(sel, c));
        if (!wanted.getAsBoolean()) {
            t.skipped = true;
            return CompletableFuture.completedFuture(new Resolved(sel, unreadCalls(sel.stat())));
        }
        return read(() -> p.load(sel.stat(), executor), t).thenApply(v -> new Resolved(sel, v != null ? v : unreadCalls(sel.stat())));
    }

    /**
     * 읽기 하나를 올린다. 거절(곧바로 던짐 · RejectedExecutionException 으로 끝남 — 대기열 가득 · 종료)은 refused, 그 밖의 예외는 failed 로 표시하고 null 로
     * 끝낸다(부르는 쪽이 '읽지 못함' 값으로 바꾼다). 예외로 끝나지 않는다.
     */
    private static <V> CompletableFuture<V> read(Supplier<CompletableFuture<V>> start, Track t) {
        CompletableFuture<V> f;
        try {
            f = start.get();
        } catch (RuntimeException e) {
            f = CompletableFuture.failedFuture(e);
        }
        return f.handle((v, e) -> {
            if (e == null) return v;
            Throwable cause = e instanceof CompletionException && e.getCause() != null ? e.getCause() : e;
            if (cause instanceof RejectedExecutionException) t.refused = true;
            else t.failed = true;
            return null;
        });
    }

    /** 마감 · 예외 때의 답: 정적 부분이 끝났으면 그것, 아니면 읽지 못함. 입출항은 {@link #unreadCalls}. */
    private Resolved fallback(CompletableFuture<SelectedStatic> st) {
        SelectedStatic sel = st.isDone() && !st.isCompletedExceptionally() ? st.join() : UNAVAILABLE;
        return new Resolved(sel, unreadCalls(sel.stat()));
    }

    /**
     * 입출항을 (제때) 읽지 못했을 때의 답: 읽지 않고 답할 수 있으면(호출부호 없음 · 형식 밖 · 그사이 캐시에 들어온 값) 그것, 아니면 error(색인을 읽지 못함 —
     * '기록 없음' 이 아니다). 읽는 쪽이 없는 구성이면 null.
     */
    private PortCallsInfo unreadCalls(ShipStatic st) {
        Source<ShipStatic, PortCallsInfo> p = portCalls;
        if (p == null) return null;
        PortCallsInfo c = p.cached(st);
        if (c != null) return c;
        return st == null ? null : PortCallsInfo.error(PortCallReader.normalizeCallSign(st.callSign()));
    }

    private void finish(Counter outcome, long t0) {
        outcome.increment();
        latency.record(Duration.ofNanos(System.nanoTime() - t0));
    }

    static SelectedStatic selected(StoredStaticReader.Lookup l) {
        if (l == null) return UNKNOWN;
        return switch (l.status()) {
            case STORED -> new SelectedStatic(l.stat(), WsMessages.STATIC_STORED);
            case NONE -> new SelectedStatic(null, WsMessages.STATIC_NONE);
            case UNAVAILABLE -> UNAVAILABLE;
        };
    }

    @Override
    public void close() {
        if (executor instanceof ExecutorService es) es.shutdownNow();
    }
}
