package dev.wakeline.platform.data;

import com.zaxxer.hikari.HikariConfig;
import com.zaxxer.hikari.HikariDataSource;
import com.zaxxer.hikari.metrics.micrometer.MicrometerMetricsTrackerFactory;
import io.micrometer.core.instrument.MeterRegistry;
import org.springframework.beans.factory.DisposableBean;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Component;

/**
 * WS 선택 선박 조회 전용 작은 읽기 풀(계약 v5 §G18 · ADR-025) — 저장 정적 보고({@link dev.wakeline.ships.data.StoredStaticReader})와 한국 항만 입출항 색인
 * ({@code PortCallIndex})만 쓴다. 공유 풀(application.yml spring.datasource.hikari — 12 · 연결 대기 5 s)과 나눈 까닭:
 * <ul>
 *   <li>연결 대기 상한을 문장 상한 이하로: 공유 풀의 연결 대기 5 s 는 공개 조회 문장 상한({@value Sql#PUBLIC_READ_TIMEOUT_S} s)보다 길어, 풀이 바닥나면 한 번의
 *       읽기가 최악 5 s + 3 s 걸렸다. 이 풀은 연결 대기 {@code wakeline.read-pool.connection-timeout-ms}(기본 {@value #DEFAULT_CONNECTION_TIMEOUT_MS} ms,
 *       문장 상한 이하만 받는다) — 한 번의 읽기 상한 = 연결 대기 + 문장 = {@link #readBoundMs()}(기본 5,000 ms).</li>
 *   <li>격벽: 선택 조회가 몰리거나 느려도 기록기(항적 · 선박 · 알림) · REST 가 쓰는 공유 풀을 잡지 않는다. 반대로 공유 풀이 바닥나도 선택 조회는 이 풀로 읽는다.</li>
 *   <li>연결마다 서버 쪽 statement_timeout = 공개 조회 상한 · 읽기 전용 트랜잭션(default_transaction_read_only) — 문장마다 거는 JDBC 상한
 *       ({@link Sql#publicRead})과 같은 값을 서버도 지킨다(취소 요청이 가지 못해도 끊긴다). 쓰기는 이 풀에서 할 수 없다.</li>
 *   <li>망에 기대지 않는 상한(리뷰 — ReadPoolDbTest): 위 두 상한은 서버가 답할 때만 문장을 끝낸다. 서버가 멈췄거나 망이 끊겨 답이 오지 않으면 이미 소켓에서
 *       기다리는 읽기는 pgjdbc socketTimeout(기본 0 = 끝없이)만 끝낼 수 있다 — {@value #SOCKET_TIMEOUT_S} s(문장 상한 + 2 s: 서버가 답하는 문장은
 *       statement_timeout 이 먼저 끝낸다). 연결 맺기의 TCP 연결은 connectTimeout = 연결 대기를 초로 올림(기본 2 s — 새 연결을 맺는 Hikari 스레드도
 *       쌓이지 않게). 문장 상한의 취소도 새 연결이라 멈춘 서버에서는 답을 받지 못하고 pgjdbc 는 그것을 기다린 뒤 문장을 돌려준다 — 취소의 연결 · 읽기를
 *       {@value Sql#CANCEL_SIGNAL_TIMEOUT_S} s 씩으로 묶어(기본 10 s 면 3 + 10 = 13 s 였다 — QA-104, ReadPoolDbTest) 문장 상한 + 취소 ≤ 소켓 상한이다.
 *       그래서 한 문장의 최악 = 연결 대기 + 소켓 상한 = {@link #hardReadBoundMs()}(기본 7,000 ms — 설정값의 합, 잰 값 아님).</li>
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
    /** 소켓 읽기 하나의 상한(pgjdbc socketTimeout, 초) — 공개 조회 문장 상한 + 2 s. 서버가 답하지 않는 읽기를 끝낸다(끊긴 연결은 풀이 버린다). */
    public static final int SOCKET_TIMEOUT_S = Sql.PUBLIC_READ_TIMEOUT_S + 2;

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
        c.addDataSourceProperty("socketTimeout", String.valueOf(SOCKET_TIMEOUT_S));
        c.addDataSourceProperty("cancelSignalTimeout", String.valueOf(Sql.CANCEL_SIGNAL_TIMEOUT_S));
        c.addDataSourceProperty("connectTimeout", String.valueOf(connectTimeoutS(connectionTimeoutMs)));
        c.setMetricsTrackerFactory(new MicrometerMetricsTrackerFactory(meters));
        return c;
    }

    /** pgjdbc connectTimeout(초 — 정수): 연결 대기를 초로 올린 값(250 ms → 1 s · 2,000 ms → 2 s). */
    static int connectTimeoutS(long connectionTimeoutMs) { return (int) Math.max(1, (connectionTimeoutMs + 999) / 1000); }

    public JdbcClient jdbc() { return jdbc; }

    /** 연결 수 = 선택 조회 실행기의 스레드 수. */
    public int size() { return size; }

    public long connectionTimeoutMs() { return connectionTimeoutMs; }

    /**
     * 서버가 답하는 동안 이 풀에서 한 번의 읽기(문장 하나)가 걸릴 수 있는 최대 시간: 연결 대기 + 공개 조회 문장 상한(설정값의 합 — 잰 값 아님). 선택 조회의
     * 답 마감(ShipLookups)이 이 값이다.
     */
    public long readBoundMs() { return connectionTimeoutMs + Sql.PUBLIC_READ_TIMEOUT_S * 1000L; }

    /**
     * 서버가 멈췄거나 망이 끊겨 답이 오지 않을 때의 최대 시간: 연결 대기 + 소켓 읽기 상한({@value #SOCKET_TIMEOUT_S} s) — 조회 스레드가 한 문장에 묶이는
     * 최악(설정값의 합 — 잰 값 아님).
     */
    public long hardReadBoundMs() { return connectionTimeoutMs + SOCKET_TIMEOUT_S * 1000L; }

    /** 지금 빌려 간 연결 수(시험 · 진단 — 지표는 hikaricp_connections_active). */
    public int active() {
        var mx = ds.getHikariPoolMXBean();
        return mx == null ? 0 : mx.getActiveConnections();
    }

    @Override
    public void destroy() { ds.close(); }
}
