package dev.wakeline.persist;

import com.zaxxer.hikari.HikariConfig;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * 선택 조회 전용 읽기 풀(계약 v5 §G18): 연결 대기는 공개 조회 문장 상한 이하만 받는다(그래야 한 번의 읽기 상한 = 연결 대기 + 문장 — 공유 풀의 5 s + 3 s 가
 * 아니다). 크기 1–8. 서버 쪽 statement_timeout · 읽기 전용 · 이름 · 지표 · 기동 때 DB 가 없어도 뜬다. 실제 DB 에서의 값은 StoredStaticIT 가 본다.
 */
class ReadPoolTest {
    static final String URL = "jdbc:postgresql://127.0.0.1:1/none";

    static HikariConfig config(int size, long connectionTimeoutMs) {
        return ReadPool.config(URL, "wakeline_api", "", size, connectionTimeoutMs, new SimpleMeterRegistry());
    }

    @Test void theConnectionWaitIsAtMostThePublicReadStatementLimit() {
        assertThatThrownBy(() -> config(4, Sql.PUBLIC_READ_TIMEOUT_S * 1000L + 1)).isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("connection-timeout-ms");
        assertThatThrownBy(() -> config(4, 249)).isInstanceOf(IllegalStateException.class);
        assertThatThrownBy(() -> config(0, 2_000)).isInstanceOf(IllegalStateException.class).hasMessageContaining("size");
        assertThatThrownBy(() -> config(ReadPool.MAX_SIZE + 1, 2_000)).isInstanceOf(IllegalStateException.class);
        assertThat(config(ReadPool.MAX_SIZE, Sql.PUBLIC_READ_TIMEOUT_S * 1000L).getConnectionTimeout()).isEqualTo(3_000);
    }

    @Test void configuredAsASmallReadOnlyPoolWithTheServerSideStatementLimit() {
        HikariConfig c = config(ReadPool.DEFAULT_SIZE, ReadPool.DEFAULT_CONNECTION_TIMEOUT_MS);
        assertThat(c.getPoolName()).isEqualTo("wakeline-read");
        assertThat(c.getMaximumPoolSize()).isEqualTo(4);
        assertThat(c.getMinimumIdle()).as("no background reconnect loop while the DB is down").isZero();
        assertThat(c.getConnectionTimeout()).isEqualTo(2_000);
        assertThat(c.getValidationTimeout()).isEqualTo(1_000);
        assertThat(c.getInitializationFailTimeout()).as("starts without a DB, connects on first use").isEqualTo(-1);
        assertThat(c.getDataSourceProperties().getProperty("ApplicationName")).isEqualTo("wakeline-api-read");
        assertThat(c.getDataSourceProperties().getProperty("options")).isEqualTo("-c statement_timeout=3s -c default_transaction_read_only=on");
        // 서버가 답하지 않아도 끝나는 읽기(리뷰 — ReadPoolDbTest): 소켓 읽기 5 s(문장 3 s + 2 s) · TCP 연결 맺기 = 연결 대기(초로 올림)
        assertThat(c.getDataSourceProperties().getProperty("socketTimeout")).isEqualTo("5");
        assertThat(c.getDataSourceProperties().getProperty("connectTimeout")).isEqualTo("2");
        assertThat(config(1, 250).getDataSourceProperties().getProperty("connectTimeout")).as("never 0 (= no limit in pgjdbc)").isEqualTo("1");
        assertThat(config(1, 2_001).getDataSourceProperties().getProperty("connectTimeout")).isEqualTo("3");
        assertThat(c.getMetricsTrackerFactory()).isNotNull();
        assertThat(config(1, 500).getValidationTimeout()).as("never longer than the connection wait").isEqualTo(500);
    }

    @Test void startsWithoutADatabase_andStatesItsReadBound() {
        ReadPool p = new ReadPool(URL, "wakeline_api", "", ReadPool.DEFAULT_SIZE, ReadPool.DEFAULT_CONNECTION_TIMEOUT_MS, new SimpleMeterRegistry());
        try {
            assertThat(p.size()).isEqualTo(4);
            assertThat(p.connectionTimeoutMs()).isEqualTo(2_000);
            assertThat(p.readBoundMs()).as("connection wait 2 s + statement 3 s (configured values, not a measurement)").isEqualTo(5_000);
            assertThat(p.hardReadBoundMs()).as("connection wait 2 s + socket timeout 5 s — a server that stops answering").isEqualTo(7_000);
            assertThat(p.jdbc()).isNotNull();
            assertThat(p.active()).isZero();
        } finally {
            p.destroy();
        }
    }
}
