package dev.wakeline.persist;

import com.zaxxer.hikari.HikariConfig;
import com.zaxxer.hikari.HikariDataSource;
import com.zaxxer.hikari.metrics.micrometer.MicrometerMetricsTrackerFactory;
import io.micrometer.core.instrument.MeterRegistry;
import org.springframework.beans.factory.DisposableBean;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Component;

/**
 * WS 선택 선박 조회 전용 작은 읽기 풀(계약 v5 §G18 · ADR-025) — 저장 정적 보고({@link StoredStaticReader})와 한국 항만 입출항 색인
 * ({@code PortCallIndex})만 쓴다. 공유 풀(application.yml spring.datasource.hikari — 12 · 연결 대기 5 s)과 나눈 까닭:
 * <ul>
 *   <li>연결 대기 상한을 문장 상한 이하로: 공유 풀의 연결 대기 5 s 는 공개 조회 문장 상한({@value Sql#PUBLIC_READ_TIMEOUT_S} s)보다 길어, 풀이 바닥나면 한 번의
 *       읽기가 최악 5 s + 3 s 걸렸다. 이 풀은 연결 대기 {@code wakeline.read-pool.connection-timeout-ms}(기본 {@value #DEFAULT_CONNECTION_TIMEOUT_MS} ms,
 *       문장 상한 이하만 받는다) — 한 번의 읽기 상한 = 연결 대기 + 문장 = {@link #readBoundMs()}(기본 5,000 ms).</li>
 *   <li>격벽: 선택 조회가 몰리거나 느려도 기록기(항적 · 선박 · 알림) · REST 가 쓰는 공유 풀을 잡지 않는다. 반대로 공유 풀이 바닥나도 선택 조회는 이 풀로 읽는다.</li>
 *   <li>연결마다 서버 쪽 statement_timeout = 공개 조회 상한 · 읽기 전용 트랜잭션(default_transaction_read_only) — 문장마다 거는 JDBC 상한
 *       ({@link Sql#publicRead})과 같은 값을 서버도 지킨다(취소 요청이 가지 못해도 끊긴다). 쓰기는 이 풀에서 할 수 없다.</li>
 * </ul>
 * 크기 {@code wakeline.read-pool.size}(기본 {@value #DEFAULT_SIZE}, 1–{@value #MAX_SIZE}) = 선택 조회 실행기의 스레드 수(ShipFanout — 스레드마다 연결 하나라
 * 이 풀 안에서는 서로 연결을 기다리지 않는다). DB 연결 수: 역할별 상한(CONNECTION LIMIT)은 없고(infra/db/init/01-roles.sh) 서버 max_connections 는
 * 기본 100(infra/compose.yml 이 바꾸지 않는다 — 슈퍼유저 예약 3) — api 는 공유 풀 12 + 이 풀 4 = 16, 수집기 프로세스는 각 2(db.py max_size).
 * 최소 유휴 0 — 쓸 때 맺고 10분 쉬면 닫는다(선택은 드물다 — 연결 맺기는 로컬 DB 에서 수 ms 로 읽기 상한에 견줘 작다). DB 가 없는 동안 뒤에서 되풀이해
 * 맺으려 하지 않고, 기동 때 DB 가 없어도 뜬다(initializationFailTimeout −1 — 첫 사용 때 맺는다, 실패는 연결 대기 상한 안에 예외 → 읽는 쪽이 '읽지 못함').
 * 지표: hikaricp_connections_*{pool="wakeline-read"}(Micrometer — 대기 시간 · 시간 초과 수 · 사용 중 연결).
 */
@Component
public class ReadPool implements DisposableBean {
    public static final String POOL_NAME = "wakeline-read";
    public static final int DEFAULT_SIZE = 4;
    public static final int MAX_SIZE = 8;
    public static final long DEFAULT_CONNECTION_TIMEOUT_MS = 2_000;
    /** Hikari 가 받는 가장 짧은 연결 대기. */
    static final long MIN_CONNECTION_TIMEOUT_MS = 250;
    /** 빌려줄 때 연결 확인(isValid) 상한 — 연결 대기보다 길 수 없다. */
    static final long VALIDATION_TIMEOUT_MS = 1_000;

    private final HikariDataSource ds;
    private final JdbcClient jdbc;
    private final int size;
    private final long connectionTimeoutMs;

    public ReadPool(@Value("${spring.datasource.url}") String url,
                    @Value("${spring.datasource.username}") String username,
                    @Value("${spring.datasource.password:}") String password,
                    @Value("${wakeline.read-pool.size:" + DEFAULT_SIZE + "}") int size,
                    @Value("${wakeline.read-pool.connection-timeout-ms:" + DEFAULT_CONNECTION_TIMEOUT_MS + "}") long connectionTimeoutMs,
                    MeterRegistry meters) {
        this.ds = new HikariDataSource(config(url, username, password, size, connectionTimeoutMs, meters));
        this.jdbc = JdbcClient.create(ds);
        this.size = size;
        this.connectionTimeoutMs = connectionTimeoutMs;
    }

    /** 설정 검사 + Hikari 설정(기동 때 한 번). 틀린 값은 뜨지 않게 막는다(조용히 고쳐 쓰지 않는다). */
    static HikariConfig config(String url, String username, String password, int size, long connectionTimeoutMs, MeterRegistry meters) {
        if (size < 1 || size > MAX_SIZE)
            throw new IllegalStateException("wakeline.read-pool.size must be 1.." + MAX_SIZE + ", got " + size);
        long statementMs = Sql.PUBLIC_READ_TIMEOUT_S * 1000L;
        if (connectionTimeoutMs < MIN_CONNECTION_TIMEOUT_MS || connectionTimeoutMs > statementMs)
            throw new IllegalStateException("wakeline.read-pool.connection-timeout-ms must be " + MIN_CONNECTION_TIMEOUT_MS + ".." + statementMs
                    + " (at most the public read statement limit), got " + connectionTimeoutMs);
        HikariConfig c = new HikariConfig();
        c.setPoolName(POOL_NAME);
        c.setJdbcUrl(url);
        c.setUsername(username);
        c.setPassword(password);
        c.setMaximumPoolSize(size);
        c.setMinimumIdle(0);
        c.setConnectionTimeout(connectionTimeoutMs);
        c.setValidationTimeout(Math.min(VALIDATION_TIMEOUT_MS, connectionTimeoutMs));
        c.setInitializationFailTimeout(-1);
        c.addDataSourceProperty("ApplicationName", "wakeline-api-read");
        c.addDataSourceProperty("options", "-c statement_timeout=" + Sql.PUBLIC_READ_TIMEOUT_S + "s -c default_transaction_read_only=on");
        c.setMetricsTrackerFactory(new MicrometerMetricsTrackerFactory(meters));
        return c;
    }

    public JdbcClient jdbc() { return jdbc; }

    /** 연결 수 = 선택 조회 실행기의 스레드 수. */
    public int size() { return size; }

    public long connectionTimeoutMs() { return connectionTimeoutMs; }

    /** 이 풀에서 한 번의 읽기(문장 하나)가 걸릴 수 있는 최대 시간: 연결 대기 + 공개 조회 문장 상한(설정값의 합 — 잰 값 아님). */
    public long readBoundMs() { return connectionTimeoutMs + Sql.PUBLIC_READ_TIMEOUT_S * 1000L; }

    /** 지금 빌려 간 연결 수(시험 · 진단 — 지표는 hikaricp_connections_active). */
    public int active() {
        var mx = ds.getHikariPoolMXBean();
        return mx == null ? 0 : mx.getActiveConnections();
    }

    @Override
    public void destroy() { ds.close(); }
}
