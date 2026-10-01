package dev.wakeline.coverage;

import dev.wakeline.platform.data.Sql;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.Instant;
import java.util.Properties;
import java.util.function.Consumer;

/**
 * 관측 수신 격자의 부트스트랩 원천(ADR-027): ship_position 을 시 조각마다 칸 · MMSI 로 묶어 읽는다. 기동 때 한 번(요청 경로 밖)만 쓴다.
 * <ul>
 *   <li><b>연결 하나</b>(풀 없음 — DriverManager): 공유 풀(기록기 · REST — 12)도 선택 조회 전용 풀(ReadPool — 스레드마다 연결 하나, ADR-025)도 쓰지 않는다
 *       — 부트스트랩이 몇 분 걸려도 그 풀의 연결을 잡지 않는다(격벽 — 재시작 직후 백로그를 쓰는 기록기 · 사용자 조회가 이 읽기를 기다리지 않는다). 한 차례(첫 읽기 ·
 *       다시 읽기 한 번)가 끝나면 닫는다 — 다시 읽기를 기다리는 동안 잡지 않는다. DB 연결 수: api 는 부트스트랩이 읽는 동안만 12 + 4 + 1.</li>
 *   <li><b>상한</b>(ADR-025 의 읽기 규칙과 같은 모양 — 값은 이 일에 맞춰 고른 것, 잰 값 아님): 서버 statement_timeout {@value #STATEMENT_TIMEOUT_S} s ·
 *       JDBC 문장 상한 같은 값 · pgjdbc socketTimeout {@value #SOCKET_TIMEOUT_S} s(문장 상한 + 2 s — 서버가 멈추거나 망이 끊겨도 끝난다) ·
 *       connectTimeout {@value #CONNECT_TIMEOUT_S} s · loginTimeout {@value #LOGIN_TIMEOUT_S} s. 넘으면 그 시는 나중에 다시 읽는다(ShipCoverage — 1 · 2 · 5 · 10분 뒤).
 *       문장 상한 30 s 의 근거(2026-09-30 22:49 KST 배포 직후 — 전에는 10 s): 한 시 문장은 한가한 DB 에서 0.44 s(EXPLAIN ANALYZE — ship_position_&lt;날&gt;_ts_idx
 *       비트맵 스캔, 약 168k 행)인데, 재시작 직후 경합에서 5시간을 29 s(평균 약 5.8 s)에 읽고 여섯째 시가 10 s 를 넘었다 — 10 s 는 경합 중 평균의 두 배도 안 됐다.
 *       상한에 걸려 취소된 문장은 한 일을 버리고 다시 읽기가 처음부터 다시 하므로, 경합 중에는 짧은 상한이 DB 일을 오히려 늘린다. 30 s 는 이 api 의 다른 배경 문장
 *       (공유 풀 statement_timeout 30 s — application.yml)과 같은 값이다. 사용자 조회(선택 조회 풀 3 s)를 굶기지 않는다: 이 연결은 그 풀의 것이 아니고(아래 연결 하나),
 *       한 번에 문장 하나(부트스트랩 가상 스레드 하나)다.</li>
 *   <li><b>읽기 전용</b>: 서버 default_transaction_read_only=on + Connection.setReadOnly — 이 연결로는 쓸 수 없다. 조각마다 읽기 전용 트랜잭션 하나
 *       (커서로 {@value #FETCH_SIZE} 행씩 받는다 — 결과 전체를 드라이버가 한 번에 들지 않게).</li>
 *   <li>문장: 칸 = floor(ST_X · 2) · floor(ST_Y · 2)(격자와 같은 식 — 2 를 곱하는 것은 정확하다), 칸 · MMSI 마다 위치 수와 가장 늦은 ts. ts 조건은
 *       파티션(UTC 일) · BRIN(ts)을 쓴다.</li>
 * </ul>
 */
@org.springframework.context.annotation.Profile("!cli & !migrate")
@Component
public class JdbcCoverageSource implements CoverageSource {
    public static final int STATEMENT_TIMEOUT_S = 30;
    public static final int SOCKET_TIMEOUT_S = STATEMENT_TIMEOUT_S + 2;
    public static final int CONNECT_TIMEOUT_S = 2;
    public static final int LOGIN_TIMEOUT_S = 5;
    static final int FETCH_SIZE = 5_000;
    public static final String APPLICATION_NAME = "wakeline-api-coverage";
    static final String SQL = """
            SELECT floor(ST_X(geom) * %1$d)::int AS lon_idx, floor(ST_Y(geom) * %1$d)::int AS lat_idx, mmsi, count(*)::int AS n, max(ts) AS last
            FROM ship_position WHERE ts >= ?::timestamptz AND ts < ?::timestamptz
            GROUP BY 1, 2, 3""".formatted(CoverageGrid.CELLS_PER_DEG);

    private final String url;
    private final String username;
    private final String password;
    private final int statementTimeoutS;

    @Autowired
    public JdbcCoverageSource(@Value("${spring.datasource.url}") String url, @Value("${spring.datasource.username}") String username,
                              @Value("${spring.datasource.password:}") String password) {
        this(url, username, password, STATEMENT_TIMEOUT_S);
    }

    /** 시험용: 문장 상한을 바꾼다(시간 초과 재현). */
    JdbcCoverageSource(String url, String username, String password, int statementTimeoutS) {
        this.url = url;
        this.username = username;
        this.password = password;
        this.statementTimeoutS = statementTimeoutS;
    }

    /** 연결 속성(비밀번호 포함 — 로그에 싣지 않는다). */
    Properties properties() {
        Properties p = new Properties();
        p.setProperty("user", username);
        p.setProperty("password", password == null ? "" : password);
        p.setProperty("ApplicationName", APPLICATION_NAME);
        p.setProperty("options", "-c statement_timeout=" + statementTimeoutS + "s -c default_transaction_read_only=on");
        p.setProperty("socketTimeout", String.valueOf(statementTimeoutS + 2));
        p.setProperty("connectTimeout", String.valueOf(CONNECT_TIMEOUT_S));
        p.setProperty("loginTimeout", String.valueOf(LOGIN_TIMEOUT_S));
        return p;
    }

    @Override
    public Session open() throws SQLException {
        Connection c = DriverManager.getConnection(url, properties());
        try {
            c.setReadOnly(true);
            c.setAutoCommit(false); // 커서 받기(fetchSize)는 트랜잭션 안에서만 된다
        } catch (SQLException e) {
            c.close();
            throw e;
        }
        return new Session() {
            @Override
            public void read(long fromMs, long toMs, Consumer<Row> sink) throws SQLException {
                try (PreparedStatement ps = c.prepareStatement(SQL)) {
                    ps.setQueryTimeout(statementTimeoutS);
                    ps.setFetchSize(FETCH_SIZE);
                    ps.setObject(1, Sql.ts(Instant.ofEpochMilli(fromMs)));
                    ps.setObject(2, Sql.ts(Instant.ofEpochMilli(toMs)));
                    try (ResultSet rs = ps.executeQuery()) {
                        while (rs.next()) {
                            sink.accept(new Row(rs.getInt(1), rs.getInt(2), Integer.parseInt(rs.getString(3)), rs.getInt(4),
                                    rs.getObject(5, java.time.OffsetDateTime.class).toInstant().toEpochMilli()));
                        }
                    }
                    c.commit();
                } catch (SQLException | RuntimeException e) {
                    try { c.rollback(); } catch (SQLException ignored) { /* 연결이 이미 끊겼다 — 닫을 때 정리된다 */ }
                    throw e;
                }
            }

            @Override
            public void close() throws SQLException { c.close(); }
        };
    }
}
