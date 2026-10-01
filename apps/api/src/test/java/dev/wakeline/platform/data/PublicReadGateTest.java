package dev.wakeline.platform.data;

import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.CannotGetJdbcConnectionException;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.jdbc.datasource.ConnectionProxy;
import org.springframework.jdbc.datasource.DataSourceUtils;
import org.springframework.transaction.support.TransactionSynchronizationManager;

import javax.sql.DataSource;
import java.lang.reflect.Proxy;
import java.sql.Connection;
import java.sql.SQLException;
import java.sql.SQLTransientConnectionException;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/** 공개 조회 격벽(리뷰 cto-2026-10 D6): 허가 수 · 기다림 · 연결을 돌려줄 때 놓기 · 설정 검사, 공유 풀 JdbcClient 의 공개 조회 고르기. */
class PublicReadGateTest {
    /** 연결을 세는 가짜 풀(빌린 수 · 닫힌 수). fail 이면 빌리기가 실패한다. */
    static final class FakePool extends org.springframework.jdbc.datasource.AbstractDataSource {
        final AtomicInteger open = new AtomicInteger();
        final AtomicInteger closed = new AtomicInteger();
        volatile boolean fail;

        @Override
        public Connection getConnection() throws SQLException {
            if (fail) throw new SQLTransientConnectionException("pool timeout");
            open.incrementAndGet();
            return (Connection) Proxy.newProxyInstance(Connection.class.getClassLoader(), new Class<?>[]{Connection.class}, (p, m, a) -> {
                if (m.getName().equals("close")) closed.incrementAndGet();
                if (m.getName().equals("isClosed")) return false;
                return null;
            });
        }

        @Override
        public Connection getConnection(String username, String password) throws SQLException { return getConnection(); }
    }

    final SimpleMeterRegistry meters = new SimpleMeterRegistry();
    final FakePool pool = new FakePool();

    double rejected() { return meters.counter("wakeline_db_public_reads_rejected_total").count(); }

    @AfterEach
    void clearTx() {
        if (TransactionSynchronizationManager.isSynchronizationActive()) TransactionSynchronizationManager.clearSynchronization();
        TransactionSynchronizationManager.setActualTransactionActive(false);
    }

    @Test
    void permitsBoundTheConnectionsAndAreReleasedWhenTheConnectionIsClosed() throws Exception {
        PublicReadGate gate = new PublicReadGate(2, 0, 12, meters);
        DataSource ds = gate.guard(pool);
        Connection a = ds.getConnection(), b = ds.getConnection();
        assertThat(gate.inUse()).isEqualTo(2);
        long t0 = System.nanoTime();
        assertThatThrownBy(ds::getConnection).isInstanceOf(SQLTransientConnectionException.class)
                .hasMessageContaining("public read limit reached: 2 public reads already use the shared pool");
        assertThat((System.nanoTime() - t0) / 1_000_000).as("wait 0 fails at once").isLessThan(200);
        assertThat(pool.open.get()).as("the rejected read did not borrow").isEqualTo(2);
        assertThat(rejected()).isEqualTo(1.0);

        a.close();
        a.close(); // 두 번 닫아도 허가는 한 번만 놓는다
        assertThat(a.isClosed()).isTrue();
        assertThat(pool.closed.get()).isEqualTo(2); // 닫기는 그대로 넘긴다(풀이 판단한다)
        assertThat(gate.inUse()).isEqualTo(1);
        Connection c = ds.getConnection();
        assertThat(gate.inUse()).isEqualTo(2);
        b.close();
        c.close();
        assertThat(gate.inUse()).isZero();
        // Spring 이 쓰는 감싼 연결의 모양
        Connection d = ds.getConnection("u", "p");
        assertThat(d).isInstanceOf(ConnectionProxy.class);
        assertThat(DataSourceUtils.getTargetConnection(d)).isNotSameAs(d);
        assertThat(d.isWrapperFor(ConnectionProxy.class)).isTrue();
        assertThat(d.unwrap(ConnectionProxy.class)).isSameAs(d);
        assertThat(d).isEqualTo(d).isNotEqualTo(c).hasToString("public read connection " + DataSourceUtils.getTargetConnection(d));
        d.close();
        assertThat(gate.inUse()).isZero();
    }

    @Test
    void aWaitingReadGetsThePermitThatIsReleasedWithinTheWait() throws Exception {
        PublicReadGate gate = new PublicReadGate(1, 1_000, 12, meters);
        DataSource ds = gate.guard(pool);
        Connection a = ds.getConnection();
        Thread.ofVirtual().start(() -> {
            try { Thread.sleep(200); a.close(); } catch (Exception ignored) { }
        });
        long t0 = System.nanoTime();
        Connection b = ds.getConnection();
        long ms = (System.nanoTime() - t0) / 1_000_000;
        assertThat(ms).isBetween(150L, 900L);
        b.close();
        // 기다림 안에 놓이지 않으면 기다림만큼 뒤에 실패
        Connection c = ds.getConnection();
        t0 = System.nanoTime();
        assertThatThrownBy(ds::getConnection).isInstanceOf(SQLTransientConnectionException.class).hasMessageContaining("waited 1000 ms");
        assertThat((System.nanoTime() - t0) / 1_000_000).isBetween(900L, 3_000L);
        c.close();
        assertThat(rejected()).isEqualTo(1.0);
    }

    @Test
    void aFailedBorrowReleasesThePermit() {
        PublicReadGate gate = new PublicReadGate(1, 0, 12, meters);
        DataSource ds = gate.guard(pool);
        pool.fail = true;
        assertThatThrownBy(ds::getConnection).isInstanceOf(SQLTransientConnectionException.class).hasMessage("pool timeout");
        assertThatThrownBy(() -> ds.getConnection("u", "p")).isInstanceOf(SQLTransientConnectionException.class).hasMessage("pool timeout");
        assertThat(gate.inUse()).isZero();
        assertThat(rejected()).isZero();
    }

    @Test
    void anInterruptedWaitFailsAndKeepsTheInterrupt() throws Exception {
        PublicReadGate gate = new PublicReadGate(1, 1_000, 12, meters);
        DataSource ds = gate.guard(pool);
        Connection a = ds.getConnection();
        List<Object> seen = new ArrayList<>();
        Thread t = Thread.ofVirtual().start(() -> {
            Thread.currentThread().interrupt();
            try { ds.getConnection(); } catch (SQLException e) { seen.add(e.getMessage()); }
            seen.add(Thread.currentThread().isInterrupted());
        });
        t.join(2_000);
        assertThat(seen).containsExactly("interrupted while waiting for a public read permit", true);
        a.close();
    }

    @Test
    void settingsAreChecked() {
        assertThatThrownBy(() -> new PublicReadGate(0, 0, 12, meters)).isInstanceOf(IllegalStateException.class).hasMessageContaining("1..11");
        assertThatThrownBy(() -> new PublicReadGate(12, 0, 12, meters)).isInstanceOf(IllegalStateException.class).hasMessageContaining("below the shared pool size 12");
        assertThatThrownBy(() -> new PublicReadGate(6, -1, 12, meters)).isInstanceOf(IllegalStateException.class).hasMessageContaining("0..3000");
        assertThatThrownBy(() -> new PublicReadGate(6, 3_001, 12, meters)).isInstanceOf(IllegalStateException.class).hasMessageContaining("0..3000");
        PublicReadGate g = new PublicReadGate(11, 3_000, 12, meters);
        assertThat(g.permits()).isEqualTo(11);
        assertThat(g.waitMs()).isEqualTo(3_000);
    }

    /** 공유 풀 JdbcClient: 공개 조회(Sql.publicRead)만 격벽 쪽 JdbcClient 로, 그 밖의 문장 · 트랜잭션 안의 공개 조회 · 평범한 JdbcClient 는 그대로. */
    @Test
    void sharedClientSendsOnlyPublicReadsThroughTheGate() {
        JdbcClient all = mock(JdbcClient.class), reads = mock(JdbcClient.class), plain = mock(JdbcClient.class);
        JdbcClient.StatementSpec viaAll = mock(JdbcClient.StatementSpec.class), viaReads = mock(JdbcClient.StatementSpec.class),
                viaPlain = mock(JdbcClient.StatementSpec.class);
        when(all.sql(org.mockito.ArgumentMatchers.anyString())).thenReturn(viaAll);
        when(reads.sql(org.mockito.ArgumentMatchers.anyString())).thenReturn(viaReads);
        when(plain.sql(org.mockito.ArgumentMatchers.anyString())).thenReturn(viaPlain);
        when(viaAll.withQueryTimeout(Sql.PUBLIC_READ_TIMEOUT_S)).thenReturn(viaAll);
        when(viaReads.withQueryTimeout(Sql.PUBLIC_READ_TIMEOUT_S)).thenReturn(viaReads);
        when(viaPlain.withQueryTimeout(Sql.PUBLIC_READ_TIMEOUT_S)).thenReturn(viaPlain);
        SharedJdbcClient shared = new SharedJdbcClient(all, reads);

        assertThat(shared.sql("SELECT 1")).isSameAs(viaAll);
        assertThat(Sql.publicRead(shared, "test.read", "SELECT 1")).isSameAs(viaReads);
        assertThat(Sql.publicRead(plain, "test.read", "SELECT 1")).isSameAs(viaPlain);
        TransactionSynchronizationManager.setActualTransactionActive(true);
        assertThat(Sql.publicRead(shared, "test.read", "SELECT 1")).as("inside a transaction: the transaction's connection").isSameAs(viaAll);
    }

    /** 감싼 DataSource 위의 JdbcClient 가 넘친 공개 조회를 Spring 의 CannotGetJdbcConnectionException 으로 올린다(ProblemAdvice → 503 + Retry-After). */
    @Test
    void aRejectedPublicReadSurfacesAsCannotGetJdbcConnection() throws Exception {
        PublicReadGate gate = new PublicReadGate(1, 0, 12, meters);
        DataSource ds = gate.guard(pool);
        Connection held = ds.getConnection();
        assertThatThrownBy(() -> JdbcClient.create(ds).sql("SELECT 1").query(Integer.class).single())
                .isInstanceOf(CannotGetJdbcConnectionException.class).hasRootCauseInstanceOf(SQLTransientConnectionException.class)
                .rootCause().hasMessageContaining("public read limit reached");
        held.close();
    }
}
