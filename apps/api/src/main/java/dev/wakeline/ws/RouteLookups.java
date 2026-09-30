package dev.wakeline.ws;

import dev.wakeline.route.RouteInfo;
import dev.wakeline.route.RouteReader;
import dev.wakeline.ws.SelectionLookups.Flight;
import dev.wakeline.ws.SelectionLookups.Reads;
import dev.wakeline.ws.SelectionLookups.Source;
import io.micrometer.core.instrument.MeterRegistry;

import java.time.Duration;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.Executor;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.function.BooleanSupplier;

/**
 * 선택 항공기의 등록 노선(selected.route — 계약 v4 §A) Redis 읽기를 세션 우편함 밖에서(계약 v5 §G21 · ADR-025 개정). 틀은 선택 선박 조회와 같은
 * {@link SelectionLookups} 다 — 이 클래스는 노선의 한 단계 읽기(콜사인 → {@link RouteReader} — wakeline:route:{CALLSIGN})와 그 '읽지 못함' 값만 가진다.
 * <ul>
 *   <li>{@link #cached}: 읽는 쪽의 메모리 캐시(콜사인별 5 s)만 본다(우편함에서 — I/O 없음). 읽어야 하면 null.</li>
 *   <li>{@link #load}: 캐시에 없으면 조회 실행기에서 읽는다(같은 콜사인의 동시 읽기는 세션을 가로질러 하나 — RouteReader 의 SingleFlight). 답은 늦어도 마감
 *       {@link #deadlineMs(Duration)} = Redis 명령 상한(RedisConfig.COMMAND_TIMEOUT — spring.data.redis.timeout, 운영 3 s, 설정값)에 정해진다. 그때까지 끝나지
 *       않았거나 읽지 못했으면 unavailable("노선 조회 실패" — 계약 v4 §A 에 이미 있는 값: Redis 오류). 읽기는 계속돼 캐시를 채운다.</li>
 *   <li>실행기(운영): 스레드 {@value #THREADS}(고른 값 — 잰 값 아님. Lettuce 는 연결 하나를 여러 스레드가 나눠 쓰므로 스레드 수는 Redis 연결 수와 무관하다.
 *       Redis 가 답하지 않으면(멈춤 · 끊긴 줄 모르는 연결) 한 읽기가 스레드를 명령 상한 3 s 잡으므로 그동안 처리량은 스레드 수 / 3 s 다. 공유 연결을 아직
 *       맺지 못했으면 그 읽기가 연결을 맺는 동안 — Lettuce 기본 연결 상한 10 s, RedisConfig 가 설정하지 않는다 — 더 잡는다. 끊긴 것을 아는 연결에서는 곧바로
 *       실패한다(REJECT_COMMANDS). 어느 쪽이든 답은 마감에 나간다), 대기열 {@link SelectionLookups#queueFor}(WS 연결 상한 이상 — 세션마다 작업 하나 이하).
 *       선박 조회 실행기(스레드 = DB 읽기 풀 연결 수)와 나눈다 — Redis 가 느려도 DB 조회 스레드를 잡지 않는다.</li>
 *   <li>지표: wakeline_ws_route_lookups_total{outcome=ok|deadline|rejected|error|skipped} · wakeline_ws_route_lookup_seconds ·
 *       wakeline_ws_route_lookup_queue · wakeline_ws_route_lookup_dropped_total.</li>
 * </ul>
 */
final class RouteLookups implements AutoCloseable {
    /** 운영 조회 실행기의 스레드 수 — 고른 값(잰 값 아님, 위 설명). */
    static final int THREADS = 4;
    /** 조회 실행기 스레드 이름(뒤에 번호). */
    static final String THREAD_NAME = "route-lookup-";

    private final SelectionLookups engine;
    private volatile Source<String, RouteInfo> source;

    /**
     * @param executor   읽기를 돌릴 실행기(운영 {@link #boundedExecutor} — 시험은 바로 실행 · 가상 스레드)
     * @param deadlineMs 물음 → 답의 상한(운영: {@link #deadlineMs(Duration)} — Redis 명령 상한)
     */
    RouteLookups(Executor executor, long deadlineMs, MeterRegistry meters) {
        this.engine = new SelectionLookups("route", "선택 항공기 노선 조회", executor, deadlineMs, meters);
    }

    /** 운영: 노선 읽기(콜사인별 5 s 캐시 · 같은 콜사인 한 번 읽기 — {@link RouteReader}). */
    static Source<String, RouteInfo> of(RouteReader r) { return Source.of(r::cached, r::loadAsync); }

    /** 운영 실행기: 데몬 스레드 threads 개(route-lookup-N — Redis 를 기다린다) · 대기열 queue · 넘치면 거절(부르는 쪽이 unavailable 로 답한다). */
    static ThreadPoolExecutor boundedExecutor(int threads, int queue) { return SelectionLookups.boundedExecutor(THREAD_NAME, threads, queue); }

    /**
     * 답의 마감 = Redis 명령 상한(RedisConfig.COMMAND_TIMEOUT — 한 번의 GET 이 서버를 기다리는 상한). 이보다 늦게 끝나는 것은 공유 연결을 맺으면서 읽는 읽기 ·
     * 실행기 대기열에서 기다린 읽기뿐이다. 0 이하(상한 없음)는 받지 않는다 — 기동하지 않는다(답의 상한을 말할 수 없다).
     */
    static long deadlineMs(Duration redisCommandTimeout) {
        if (redisCommandTimeout == null || redisCommandTimeout.isNegative() || redisCommandTimeout.isZero())
            throw new IllegalStateException("spring.data.redis.timeout must be positive — it bounds the WS selected.route answer, got " + redisCommandTimeout);
        return redisCommandTimeout.toMillis();
    }

    /** 노선의 출처(운영: {@link #of}). null 이면 노선을 싣지 않는다(시험 구성 — selected.route null). */
    void setSource(Source<String, RouteInfo> s) { source = s; }

    boolean enabled() { return source != null; }

    long deadlineMs() { return engine.deadlineMs(); }

    /** 답을 보내지 않은 조회(선택 · 물음이 바뀌었다, 세션이 닫혔다)를 센다. */
    void dropped() { engine.dropped(); }

    /** 캐시만으로 답한다(I/O 없음 — 우편함에서). callsign 은 정규화한 값. 읽어야 하거나 출처가 없으면 null. */
    RouteInfo cached(String callsign) {
        Source<String, RouteInfo> s = source;
        return s == null ? null : s.cached(callsign);
    }

    /**
     * 읽어서 답한다(부르는 쪽을 막지 않는다). 읽기는 after(세션의 앞 조회의 settled)가 끝난 뒤 시작하고, 올리기 직전에 wanted 를 묻는다(false 면 읽지
     * 않는다 — skipped). 답은 늦어도 물음 뒤 {@link #deadlineMs()} 에 온다 — 끝나지 않았거나 읽지 못했으면(거절 · 예외 · 건너뜀) unavailable.
     */
    Flight<RouteInfo> load(String callsign, CompletableFuture<?> after, BooleanSupplier wanted) {
        Reads r = engine.begin(after, wanted);
        CompletableFuture<RouteInfo> all = r.turn().thenCompose(x -> read(callsign, r));
        return engine.flight(r, all, () -> RouteInfo.unavailable(callsign));
    }

    private CompletableFuture<RouteInfo> read(String callsign, Reads r) {
        Source<String, RouteInfo> s = source;
        RouteInfo c = s == null ? null : s.cached(callsign);
        if (c != null) return CompletableFuture.completedFuture(c); // 앞 조회를 기다리는 사이 다른 세션의 읽기가 채웠다
        if (s == null || !r.wanted()) return CompletableFuture.completedFuture(null); // 읽지 않는다 — 답은 unavailable
        return r.read(() -> s.load(callsign, r.executor()));
    }

    @Override
    public void close() { engine.close(); }
}
