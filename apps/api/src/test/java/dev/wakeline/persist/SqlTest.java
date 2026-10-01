package dev.wakeline.persist;

import dev.wakeline.platform.web.ProblemAdvice;
import org.junit.jupiter.api.Test;
import org.springframework.dao.QueryTimeoutException;
import org.springframework.jdbc.core.simple.JdbcClient;

import javax.sql.DataSource;
import java.lang.reflect.Proxy;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.SQLException;
import java.util.ArrayList;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * 공개 조회 문장의 이름표(조사 2026-10-01 오류 F3 · 도전 better_fix): {@link Sql#publicRead} 는 호출부가 준 이름과 그 문장의 한도를 SQL 앞 주석으로
 * 싣는다. 문장이 실패하면 Spring 이 예외 메시지('SQL [...]')에 그 SQL 을 그대로 싣고, 503 WARN 이 거기서 이름과 한도를 읽는다 — 재생처럼 문장
 * 3~4개를 차례로 내는 요청에서 어느 문장이 끊겼는지. 이름이 없는 문장(공개 조회가 아닌 것)은 짐작해 적지 않는다.
 */
class SqlTest {

    @Test
    void theTagCarriesTheLabelAndTheStatementLimit() {
        assertThat(Sql.tag("replay.track_point", Sql.PUBLIC_READ_TIMEOUT_S)).isEqualTo("/* wakeline replay.track_point limit_s=3 */ ");
    }

    /** 이름은 SQL 주석 안에 들어간다 — 주석을 닫거나 로그 줄을 깨는 글자는 받지 않는다(코드의 상수지만 틀리면 뜨기 전에 드러나게). */
    @Test
    void labelsThatCouldBreakOutOfTheCommentAreRejected() {
        for (String bad : new String[]{"", "Replay", "a */ DROP", "a b", "a:b", "x".repeat(65)})
            assertThatThrownBy(() -> Sql.tag(bad, 3)).as(bad).isInstanceOf(IllegalArgumentException.class);
    }

    /**
     * 실제 경로: JdbcClient → 드라이버가 57014 로 취소 → Spring 번역(QueryTimeoutException, 메시지에 SQL) → ProblemAdvice 가 읽는 이름표.
     * DB 없이 — 드라이버를 흉내 내는 DataSource(보낸 SQL 을 모으고, 실행은 57014 로 실패).
     */
    @Test
    void aCancelledPublicReadNamesItsStatementAndLimitForTheLog() {
        List<String> sent = new ArrayList<>();
        List<Integer> timeouts = new ArrayList<>();
        JdbcClient db = JdbcClient.create(cancellingDataSource(sent, timeouts));
        var e = org.junit.jupiter.api.Assertions.assertThrows(QueryTimeoutException.class, () ->
                Sql.publicRead(db, "replay.radar_frame", "SELECT frame_time FROM radar_frame WHERE frame_time > :t").param("t", 1).query().listOfRows());
        assertThat(sent).singleElement().asString().startsWith("/* wakeline replay.radar_frame limit_s=3 */ SELECT frame_time FROM radar_frame");
        assertThat(timeouts).containsExactly(Sql.PUBLIC_READ_TIMEOUT_S);
        assertThat(ProblemAdvice.statement(e)).isEqualTo(" statement=replay.radar_frame statement_limit_s=3");
        assertThat(ProblemAdvice.statement(new QueryTimeoutException("SQL [SELECT 1]; canceled", new SQLException("x", "57014")))).isEmpty();
    }

    static DataSource cancellingDataSource(List<String> sent, List<Integer> timeouts) {
        return (DataSource) Proxy.newProxyInstance(SqlTest.class.getClassLoader(), new Class<?>[]{DataSource.class}, (p, m, a) -> switch (m.getName()) {
            case "getConnection" -> connection(sent, timeouts);
            case "isWrapperFor" -> false;
            case "hashCode" -> System.identityHashCode(p);
            case "equals" -> p == a[0];
            default -> null;
        });
    }

    static Connection connection(List<String> sent, List<Integer> timeouts) {
        return (Connection) Proxy.newProxyInstance(SqlTest.class.getClassLoader(), new Class<?>[]{Connection.class}, (p, m, a) -> switch (m.getName()) {
            case "prepareStatement" -> {
                sent.add((String) a[0]);
                yield statement(timeouts);
            }
            case "getAutoCommit", "isClosed", "isWrapperFor" -> false;
            case "hashCode" -> System.identityHashCode(p);
            case "equals" -> p == a[0];
            default -> null;
        });
    }

    static PreparedStatement statement(List<Integer> timeouts) {
        return (PreparedStatement) Proxy.newProxyInstance(SqlTest.class.getClassLoader(), new Class<?>[]{PreparedStatement.class}, (p, m, a) -> switch (m.getName()) {
            case "setQueryTimeout" -> {
                timeouts.add((Integer) a[0]);
                yield null;
            }
            case "executeQuery", "execute" -> throw new SQLException("ERROR: canceling statement due to user request", "57014");
            case "getWarnings" -> null;
            case "isWrapperFor" -> false;
            case "hashCode" -> System.identityHashCode(p);
            case "equals" -> p == a[0];
            default -> null;
        });
    }
}
