package dev.wakeline.platform.data;

import io.micrometer.core.instrument.Counter;
import io.micrometer.core.instrument.MeterRegistry;
import org.springframework.jdbc.datasource.ConnectionProxy;
import org.springframework.jdbc.datasource.DelegatingDataSource;

import javax.sql.DataSource;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Proxy;
import java.sql.Connection;
import java.sql.SQLException;
import java.sql.SQLTransientConnectionException;
import java.util.concurrent.Semaphore;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * 공개 조회 격벽(리뷰 cto-2026-10 D6 · api-review §3 B9 — 측정 docs/PERF.md §13): 공유 풀(application.yml spring.datasource.hikari — 12 · 연결 대기 5 s)을
 * 공개 REST 조회({@link Sql#publicRead})와 기록기(항적 · 선박 · 순서 큐) · 운영 · 정기 작업이 같이 쓴다. 문장 상한(3 s, R-62)은 공개 조회 하나가 연결을
 * <b>얼마나 오래</b> 잡는지만 묶고 <b>몇 개가</b> 잡는지는 묶지 않았다 — DB 가 느릴 때 공개 조회가 끝나는 것보다 빨리 들어오면 풀 전체를 잡아 기록기가
 * 5 s 대기 초과로 물러났다(측정: 초당 16건이면 60 s 동안 선박 0행 · 순서 큐 작업 3건만 쓰였다).
 * <ul>
 *   <li>공개 조회는 이 격벽의 허가({@link #permits()}개, 공정 — 먼저 온 순서)를 얻어야 공유 풀에서 연결을 빌린다. 허가는 그 연결을 돌려줄 때 놓는다
 *       (재생처럼 문장을 차례로 내는 요청도 한 번에 연결 하나다). 그래서 공개 조회가 잡는 연결은 늘 {@link #permits()}개 이하 — 나머지는 기록기 몫이다.</li>
 *   <li>허가를 {@link #waitMs()} ms 안에 얻지 못하면 연결을 빌리지 않고 실패한다(SQLTransientConnectionException → Spring 의
 *       CannotGetJdbcConnectionException — 풀 대기 초과 · 문장 상한과 같은 503 + Retry-After, 실시간 결과로 답하는 곳은 meta.db_unavailable).
 *       기다림이 0 이 아닌 까닭: DB 가 멀쩡할 때 한 사용자의 몰림(edge 의 IP 당 burst 30)이 허가 수를 넘었다고 바로 503 이 되지 않게(측정 §13).</li>
 *   <li>지표 wakeline_db_public_reads_rejected_total — 격벽이 돌려보낸 공개 조회(풀 대기 초과는 hikaricp_connections_timeout_total).</li>
 * </ul>
 * 공유 풀 크기보다 작아야 한다(기록기에게 하나 이상 남는다). 선택 조회 읽기 풀(ReadPool)은 따로라 이 격벽을 지나지 않는다.
 */
public final class PublicReadGate {
    public static final int DEFAULT_PERMITS = 6;
    public static final long DEFAULT_WAIT_MS = 1_000;

    private final Semaphore permits;
    private final int size;
    private final long waitMs;
    private final Counter rejected;

    /**
     * @param size     허가 수 — 1 이상, 공유 풀 크기 미만
     * @param waitMs   허가를 기다리는 상한 — 0(바로 실패) 이상, 공개 조회 문장 상한 이하
     * @param poolSize 공유 풀 크기(spring.datasource.hikari.maximum-pool-size)
     */
    public PublicReadGate(int size, long waitMs, int poolSize, MeterRegistry meters) {
        if (size < 1 || size >= poolSize)
            throw new IllegalStateException("wakeline.public-reads.permits must be 1.." + (poolSize - 1) + " (below the shared pool size " + poolSize
                    + ", so the writers keep a connection), got " + size);
        long statementMs = Sql.PUBLIC_READ_TIMEOUT_S * 1000L;
        if (waitMs < 0 || waitMs > statementMs)
            throw new IllegalStateException("wakeline.public-reads.wait-ms must be 0.." + statementMs + " (at most the public read statement limit), got " + waitMs);
        this.permits = new Semaphore(size, true);
        this.size = size;
        this.waitMs = waitMs;
        this.rejected = Counter.builder("wakeline_db_public_reads_rejected_total")
                .description("공개 조회 격벽이 허가를 주지 못해 돌려보낸 공개 조회(503) — 공유 풀은 기록기 몫을 남긴다").register(meters);
    }

    public int permits() { return size; }

    public long waitMs() { return waitMs; }

    /** 지금 쓰고 있는 허가 수(시험 · 진단). */
    public int inUse() { return size - permits.availablePermits(); }

    /** 공유 풀을 감싼 DataSource — 연결을 빌리기 전에 허가를 얻고, 연결을 돌려줄 때 놓는다. 공개 조회 전용 JdbcClient 가 쓴다. */
    public DataSource guard(DataSource shared) { return new Guarded(shared); }

    private final class Guarded extends DelegatingDataSource {
        Guarded(DataSource target) { super(target); }

        @Override
        public Connection getConnection() throws SQLException {
            acquire();
            try {
                return released(super.getConnection());
            } catch (SQLException | RuntimeException | Error e) {
                permits.release();
                throw e;
            }
        }

        @Override
        public Connection getConnection(String username, String password) throws SQLException {
            acquire();
            try {
                return released(super.getConnection(username, password));
            } catch (SQLException | RuntimeException | Error e) {
                permits.release();
                throw e;
            }
        }
    }

    private void acquire() throws SQLException {
        boolean ok;
        try {
            ok = waitMs == 0 ? permits.tryAcquire() : permits.tryAcquire(waitMs, TimeUnit.MILLISECONDS);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new SQLTransientConnectionException("interrupted while waiting for a public read permit", e);
        }
        if (!ok) {
            rejected.increment();
            throw new SQLTransientConnectionException("public read limit reached: " + size + " public reads already use the shared pool (waited "
                    + waitMs + " ms) — the rest of the pool is kept for the writers");
        }
    }

    /** 연결을 감싸 close() 때 허가를 한 번 놓는다(나머지는 그대로 넘긴다). */
    private Connection released(Connection target) {
        AtomicBoolean closed = new AtomicBoolean();
        return (Connection) Proxy.newProxyInstance(ConnectionProxy.class.getClassLoader(), new Class<?>[]{ConnectionProxy.class}, (proxy, m, args) -> {
            switch (m.getName()) {
                case "getTargetConnection" -> { return target; }
                case "equals" -> { return proxy == args[0]; }
                case "hashCode" -> { return System.identityHashCode(proxy); }
                case "toString" -> { return "public read connection " + target; }
                case "isClosed" -> {
                    if (closed.get()) return true;
                }
                case "unwrap" -> {
                    if (((Class<?>) args[0]).isInstance(proxy)) return proxy;
                }
                case "isWrapperFor" -> {
                    if (((Class<?>) args[0]).isInstance(proxy)) return true;
                }
                case "close" -> {
                    try {
                        return invoke(target, m, args);
                    } finally {
                        if (closed.compareAndSet(false, true)) permits.release();
                    }
                }
                default -> { }
            }
            return invoke(target, m, args);
        });
    }

    private static Object invoke(Object target, java.lang.reflect.Method m, Object[] args) throws Throwable {
        try {
            return m.invoke(target, args);
        } catch (InvocationTargetException e) {
            throw e.getTargetException();
        }
    }
}
