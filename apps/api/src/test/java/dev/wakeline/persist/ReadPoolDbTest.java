package dev.wakeline.persist;

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
import java.util.concurrent.TimeoutException;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

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

    static int one(Statement st) throws SQLException {
        try (ResultSet rs = st.executeQuery("SELECT 1")) {
            rs.next();
            return rs.getInt(1);
        }
    }

    /**
     * 연결을 연 뒤 서버의 답이 멈추면: 관찰(고치기 전) — 문장이 8 s 가 지나도 돌아오지 않는다(socketTimeout 없음 — 서버 statement_timeout 은 이미 답한 문장에
     * 소용없고 답은 오지 않는다). 조회 스레드 넷이 이렇게 묶이면 실행기가 가득 찬다.
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
            assertThatThrownBy(() -> read.get(8, TimeUnit.SECONDS)).as("observed: no socket timeout — the read is still blocked after 8 s")
                    .isInstanceOf(TimeoutException.class);
            proxy.frozen = false; // 쥔 답을 넘긴다 — 막힌 문장이 끝난다
            assertThat(read.get(10, TimeUnit.SECONDS)).isEqualTo(1);
        } finally {
            runner.shutdownNow();
        }
    }
}
