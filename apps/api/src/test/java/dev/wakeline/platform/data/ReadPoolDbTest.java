package dev.wakeline.platform.data;

import com.zaxxer.hikari.HikariDataSource;
import dev.wakeline.DbTestSupport;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIf;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.sql.Connection;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 읽기 풀의 읽기 상한이 네트워크에 기대지 않는가(리뷰 — 계약 v5 §G18 · ADR-025). 서버 쪽 statement_timeout 과 JDBC 문장 상한(취소 요청 — 새 연결로
 * 보낸다)은 서버가 답할 때만 읽기를 끝낸다. 서버가 멈췄거나(일시정지 · 망 단절) 답이 오지 않으면 이미 소켓에서 기다리는 읽기는 pgjdbc socketTimeout
 * (기본 0 = 끝없이)만 끝낼 수 있다 — 그러지 않으면 조회 스레드가 TCP keepalive 가 포기할 때까지 묶인다.
 * <p>재현: 실제 PostgreSQL 앞에 서버 → 클라이언트 방향을 멈출 수 있는 TCP 중계를 두고, 운영과 같은 읽기 풀 설정({@link ReadPool#config})으로 연결을 연 뒤
 * 중계를 멈추고 문장 하나를 보낸다.
 */
@EnabledIf("dev.wakeline.DbTestSupport#dockerAvailable")
class ReadPoolDbTest {

    /** 서버 → 클라이언트 방향을 멈출 수 있는 TCP 중계(서버가 멈춘 것처럼 — 연결은 열린 채 답이 오지 않는다). */
    static final class FreezingProxy implements AutoCloseable {
        final ServerSocket server;
        final List<Socket> sockets = new CopyOnWriteArrayList<>();
        volatile boolean frozen;

        FreezingProxy(String host, int port) throws IOException {
            server = new ServerSocket(0, 16, InetAddress.getLoopbackAddress());
            Thread.ofVirtual().start(() -> {
                while (!server.isClosed()) {
                    try {
                        Socket client = server.accept();
                        if (frozen) { // 멈춘 서버: TCP 는 받지만(커널) 답하지 않는다 — 새 연결(취소 요청)도 그렇다
                            sockets.add(client);
                            continue;
                        }
                        Socket upstream = new Socket(host, port);
                        sockets.add(client);
                        sockets.add(upstream);
                        pump(client, upstream, false);
                        pump(upstream, client, true);
                    } catch (IOException e) {
                        return; // 닫혔다
                    }
                }
            });
        }

        private void pump(Socket from, Socket to, boolean fromServer) {
            Thread.ofVirtual().start(() -> {
                byte[] buf = new byte[8192];
                try {
                    InputStream in = from.getInputStream();
                    OutputStream out = to.getOutputStream();
                    for (int n; (n = in.read(buf)) >= 0; ) {
                        while (fromServer && frozen) Thread.sleep(20); // 받은 바이트를 넘기지 않고 쥔다
                        out.write(buf, 0, n);
                        out.flush();
                    }
                } catch (IOException | InterruptedException e) {
                    // 한쪽이 닫혔다
                } finally {
                    closeQuietly(from);
                    closeQuietly(to);
                }
            });
        }

        int port() { return server.getLocalPort(); }

        private static void closeQuietly(Socket s) {
            try { s.close(); } catch (IOException ignored) { /* 이미 닫힘 */ }
        }

        @Override public void close() throws IOException {
            frozen = false;
            server.close();
            for (Socket s : sockets) closeQuietly(s);
        }
    }

    /**
     * 문장 상한(setQueryTimeout — Sql.publicRead 가 거는 3 s)의 취소는 새 연결로 서버에 보낸다. 서버가 멈췄으면 그 취소도 답을 받지 못하고, pgjdbc 는 문장을
     * 돌려주기 전에 취소가 끝나기를 기다린다 — 기본 cancelSignalTimeout 10 s 면 소켓 상한(5 s)이 지나도 3 + 10 = 13 s 동안 조회 스레드가 묶였다(QA-104 와
     * 같은 원인). 취소에 1 s(연결 · 읽기 각각)까지만 쓰면 소켓 상한 안에 끝난다.
     */
    @Test void aCancelThatCannotReachAFrozenServer_doesNotOutlastTheSocketTimeout() throws Exception {
        DbTestSupport.start();
        ExecutorService runner = Executors.newVirtualThreadPerTaskExecutor();
        try (FreezingProxy proxy = new FreezingProxy(DbTestSupport.host(), DbTestSupport.port());
             HikariDataSource ds = new HikariDataSource(ReadPool.config("jdbc:postgresql://127.0.0.1:" + proxy.port() + "/wakeline", "wakeline_api",
                     DbTestSupport.API_PW, 1, ReadPool.DEFAULT_CONNECTION_TIMEOUT_MS, new SimpleMeterRegistry()));
             Connection c = ds.getConnection();
             Statement st = c.createStatement()) {
            st.setQueryTimeout(Sql.PUBLIC_READ_TIMEOUT_S);
            assertThat(one(st)).isEqualTo(1);
            proxy.frozen = true;
            long t0 = System.nanoTime();
            CompletableFuture<Object> read = CompletableFuture.supplyAsync(() -> {
                try {
                    return one(st);
                } catch (SQLException e) {
                    return e;
                }
            }, runner);
            Object out = read.get(30, TimeUnit.SECONDS);
            long ms = (System.nanoTime() - t0) / 1_000_000;
            assertThat(out).isInstanceOf(SQLException.class);
            assertThat(ms).as("the out-of-band cancel must not hold the read past the socket timeout (%d s)", ReadPool.SOCKET_TIMEOUT_S)
                    .isLessThan(ReadPool.SOCKET_TIMEOUT_S * 1000L + 1_000);
        } finally {
            runner.shutdownNow();
        }
    }

    static int one(Statement st) throws SQLException {
        try (ResultSet rs = st.executeQuery("SELECT 1")) {
            rs.next();
            return rs.getInt(1);
        }
    }

    /**
     * 연결을 연 뒤 서버의 답이 멈추면: 관찰(고치기 전) — 문장이 8 s 가 지나도 돌아오지 않았다(socketTimeout 없음 — 서버 statement_timeout 은 이미 답한 문장에
     * 소용없고 답은 오지 않는다). 조회 스레드 넷이 이렇게 묶이면 실행기가 가득 찬다.
     * 고친 뒤: 소켓 읽기 상한({@value ReadPool#SOCKET_TIMEOUT_S} s)에 예외로 끝난다(연결은 끊긴 것으로 버려진다).
     */
    @Test void aServerThatStopsAnswering_endsAReadAtTheSocketTimeout() throws Exception {
        DbTestSupport.start();
        ExecutorService runner = Executors.newVirtualThreadPerTaskExecutor();
        try (FreezingProxy proxy = new FreezingProxy(DbTestSupport.host(), DbTestSupport.port());
             HikariDataSource ds = new HikariDataSource(ReadPool.config("jdbc:postgresql://127.0.0.1:" + proxy.port() + "/wakeline", "wakeline_api",
                     DbTestSupport.API_PW, 1, ReadPool.DEFAULT_CONNECTION_TIMEOUT_MS, new SimpleMeterRegistry()));
             Connection c = ds.getConnection();
             Statement st = c.createStatement()) {
            assertThat(one(st)).as("the connection works through the relay").isEqualTo(1);
            proxy.frozen = true;
            CompletableFuture<Object> read = CompletableFuture.supplyAsync(() -> {
                try {
                    return one(st);
                } catch (SQLException e) {
                    return e;
                }
            }, runner);
            long t0 = System.nanoTime();
            Object out = read.get(ReadPool.SOCKET_TIMEOUT_S + 5L, TimeUnit.SECONDS);
            long ms = (System.nanoTime() - t0) / 1_000_000;
            assertThat(out).as("ended by the socket timeout, not by an answer").isInstanceOf(SQLException.class);
            long socketMs = ReadPool.SOCKET_TIMEOUT_S * 1000L;
            assertThat(ms).as("the socket timeout (5 s), not TCP keepalive").isBetween(socketMs - 500, socketMs + 2_500);
            Throwable cause = (Throwable) out;
            while (cause.getCause() != null && !(cause instanceof java.net.SocketTimeoutException)) cause = cause.getCause();
            assertThat(cause).isInstanceOf(java.net.SocketTimeoutException.class);
            assertThat(c.isValid(1)).as("the broken connection is not reused").isFalse();
        } finally {
            runner.shutdownNow();
        }
    }
}
