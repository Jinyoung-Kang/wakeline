package dev.wakeline.it;

import dev.wakeline.DbTestSupport;
import dev.wakeline.ops.OpsUserService;
import dev.wakeline.platform.data.PublicReadGate;
import dev.wakeline.platform.web.Problem;
import io.micrometer.core.instrument.MeterRegistry;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIf;
import org.junit.jupiter.api.extension.ExtendWith;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.system.CapturedOutput;
import org.springframework.boot.test.system.OutputCaptureExtension;
import org.springframework.jdbc.core.simple.JdbcClient;

import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.Statement;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * R-62(ADR-017 §2): DB 가 느려질 때의 격벽. api 연결은 statement_timeout 30 s · lock_timeout 5 s(쓰기·유지보수 포함 모든 문장의 상한),
 * 공개 조회는 3 s 에 끊는다(503 + Retry-After) — 느린 공개 조회가 풀(12)을 오래 잡아 기록기까지 막지 못하게.
 * 로그(조사 2026-10-01 오류 F3): 503 의 WARN 한 줄은 예외가 스스로 말하는 원인(SQLSTATE · 예외 종류)만 적고, 무엇을 물었는지(경로 + 쿼리 문자열)와
 * 요청이 얼마나 걸렸는지(elapsed_ms — 요청 id 필터부터 잰 값)를 싣는다. 예전에는 모두 'data store unavailable' 이었고 쿼리 문자열 · 걸린 시간이 없었다.
 */
@EnabledIf("dev.wakeline.DbTestSupport#dockerAvailable")
@ExtendWith(OutputCaptureExtension.class)
class DbTimeoutsIT extends IntegrationTest {
    static final String PW = "timeouts-horse-battery-staple";
    private static final Pattern ELAPSED = Pattern.compile("elapsed_ms=(\\d+)");

    @Autowired OpsUserService users;
    @Autowired MeterRegistry meters;
    @Autowired org.springframework.context.ApplicationContext ctx;

    @Test
    void apiConnectionsCarryStatementAndLockTimeouts() {
        assertThat(db.sql("SHOW statement_timeout").query(String.class).single()).isEqualTo("30s");
        assertThat(db.sql("SHOW lock_timeout").query(String.class).single()).isEqualTo("5s");
    }

    /**
     * QA-104: 공개 조회가 빌린 공유 풀 연결에는 소켓 읽기 상한 4 s(문장 상한 3 s + 1 s)가 걸리고, 풀에 돌려주면 Hikari 가 풀 기본(0 = 상한 없음)으로
     * 되돌린다 — 같은 연결을 기록기 · 정기 작업이 빌려도 긴 문장(statement_timeout 30 s)이 소켓 상한에 끊기지 않는다. 문장 상한의 취소(새 연결)는
     * 연결 · 읽기 1 s 씩만 기다린다(cancelSignalTimeout — 기본 10 s 면 멈춘 서버에서 13 s).
     */
    @Test
    void aPublicReadConnectionHasASocketTimeoutThatTheWritersDoNotInherit() throws Exception {
        javax.sql.DataSource shared = ctx.getBean(javax.sql.DataSource.class);
        assertThat(((com.zaxxer.hikari.HikariDataSource) shared).getDataSourceProperties().getProperty("cancelSignalTimeout"))
                .isEqualTo(String.valueOf(dev.wakeline.platform.data.Sql.CANCEL_SIGNAL_TIMEOUT_S));
        javax.sql.DataSource publicReads = new PublicReadGate(1, 0, 12, meters).guard(shared);
        Object physical;
        try (Connection c = publicReads.getConnection()) {
            assertThat(c.getNetworkTimeout()).isEqualTo(dev.wakeline.platform.data.Sql.PUBLIC_READ_SOCKET_TIMEOUT_S * 1000);
            physical = ((org.springframework.jdbc.datasource.ConnectionProxy) c).getTargetConnection().unwrap(Connection.class); // Hikari 프록시 → 드라이버 연결
        }
        // Hikari 는 같은 스레드에 방금 돌려받은 연결을 먼저 준다 — 그 연결의 상한이 되돌아갔는지 본다
        try (Connection w = shared.getConnection()) {
            assertThat(w.unwrap(Connection.class)).as("same physical connection").isSameAs(physical);
            assertThat(w.getNetworkTimeout()).as("writers borrow it back without the public read socket timeout").isZero();
        }
    }

    @Test
    void aPublicReadStuckOnALockIsCutAfterThreeSecondsWith503(CapturedOutput out) throws Exception {
        String at = Instant.now().minusSeconds(300).truncatedTo(ChronoUnit.SECONDS).toString();
        String query = "at=" + at + "&bbox=124,33,132,39";
        String path = "/api/v1/replay?" + query;
        try (Connection c = DriverManager.getConnection(DbTestSupport.jdbcUrl(ItStack.DB), "postgres", DbTestSupport.ROOT_PW);
             Statement s = c.createStatement()) {
            c.setAutoCommit(false);
            s.execute("LOCK TABLE radar_frame IN ACCESS EXCLUSIVE MODE"); // 재생의 레이더 조회가 이 잠금을 기다린다
            Thread releaser = Thread.ofVirtual().start(() -> {
                try { Thread.sleep(9_000); c.rollback(); } catch (Exception ignored) { }
            });
            long t0 = System.nanoTime();
            Res r = get(path);
            long ms = (System.nanoTime() - t0) / 1_000_000;
            releaser.interrupt();
            c.rollback();
            assertProblem(r, 503, "UNAVAILABLE", "/api/v1/replay");
            assertThat(r.header("Retry-After")).isNotBlank();
            assertThat(ms).as("cut by the 3 s public read timeout (not the 5 s lock timeout, not the lock holder)").isBetween(2_500L, 4_900L);
            // pgjdbc 가 3 s 쿼리 한도로 취소를 보내면 서버는 57014 'canceling statement due to user request' 로 답한다 — 로그는 그 SQLSTATE 만 말한다
            String line = warnLine(out, r.header("X-Request-Id"));
            // 어느 문장이 끊겼는지와 그 문장의 한도는 호출부가 붙인 이름표(Sql.publicRead)에서 — 실제 Spring 예외 메시지를 거쳐
            assertThat(line).contains("statement cancelled (SQLSTATE 57014)")
                    .contains("path=/api/v1/replay query=\"" + query + "\"")
                    .contains(" statement=replay.radar_frame statement_limit_s=3 → 503: ")
                    .contains("canceling statement due to user request")
                    .doesNotContain("data store unavailable");
            assertThat(elapsedMs(line)).as("elapsed time of the request, measured by the api").isBetween(2_500L, ms);
        }
        assertThat(get(path).status()).as("the same read works once the lock is gone").isEqualTo(200);
    }

    /**
     * 공개 조회가 아닌 문장(3 s 쿼리 한도 없음)은 연결의 lock_timeout 5 s 에 끊긴다 — PostgreSQL 55P03(lock_not_available). Spring 의 기본 예외 번역
     * (SQLExceptionSubclassTranslator → SQLStateSQLExceptionTranslator)은 SQLSTATE 부류 55 를 모르므로 UncategorizedSQLException 이 된다. 예전에는
     * 그래서 500 INTERNAL + ERROR(스택)였다 — 잠금 대기는 서버 결함이 아니라 잠시 뒤 되는 일이다: 503 + Retry-After 로 답한다.
     */
    @Test
    void aStatementPastTheLockTimeoutIs503WithRetryAfterNotAnInternalError(CapturedOutput out) throws Exception {
        OpsBrowser b = OpsBrowser.login(this, users, "it-timeouts", PW);
        try (Connection c = DriverManager.getConnection(DbTestSupport.jdbcUrl(ItStack.DB), "postgres", DbTestSupport.ROOT_PW);
             Statement s = c.createStatement()) {
            c.setAutoCommit(false);
            s.execute("LOCK TABLE ingest_run IN ACCESS EXCLUSIVE MODE"); // /ops/runs 의 조회가 이 잠금을 기다린다
            Thread releaser = Thread.ofVirtual().start(() -> {
                try { Thread.sleep(12_000); c.rollback(); } catch (Exception ignored) { }
            });
            long t0 = System.nanoTime();
            Res r = b.get("/api/v1/ops/runs?limit=5&resolved=show");
            long ms = (System.nanoTime() - t0) / 1_000_000;
            releaser.interrupt();
            c.rollback();
            assertProblem(r, 503, "UNAVAILABLE", "/api/v1/ops/runs");
            assertThat(r.header("Retry-After")).isNotBlank();
            assertThat(ms).as("cut by the 5 s lock timeout (not the lock holder)").isBetween(4_500L, 9_000L);
            String line = warnLine(out, r.header("X-Request-Id"));
            assertThat(line).contains("lock not available (SQLSTATE 55P03)")
                    .contains("path=/api/v1/ops/runs query=\"limit=5&resolved=show\"")
                    .contains("canceling statement due to lock timeout");
            assertThat(elapsedMs(line)).isBetween(4_500L, ms);
            assertThat(out.getAll()).doesNotContain("unhandled error request_id=" + r.header("X-Request-Id"));
        }
        assertThat(b.get("/api/v1/ops/runs?limit=5&resolved=show").status()).isEqualTo(200);
    }

    /**
     * D6(리뷰 cto-2026-10 · api-review §3 B9 — docs/PERF.md §13): 느린 공개 조회가 공유 풀(12)을 모두 잡지 못한다. 공개 조회는 공개 조회 격벽
     * (PublicReadGate — 허가 6)을 지나야 연결을 빌리고, 넘치는 것은 연결을 빌리지 않은 채 503 + Retry-After 로 끝난다(문장 상한과 같은 답).
     * 그래서 공개 조회가 아닌 문장(기록기 · 운영 · 정기 작업과 같은 길 — 앱의 JdbcClient)은 바로 연결을 얻는다.
     * 예전: 잠금에 걸린 재생 20개가 풀 12개를 모두 잡아, 그 문장은 3 s 상한이 공개 조회를 끊을 때까지(약 2.5 s) 기다렸다.
     */
    @Test
    void slowPublicReadsLeaveSharedPoolConnectionsForTheWriters(CapturedOutput out) throws Exception {
        String at = Instant.now().minusSeconds(300).truncatedTo(ChronoUnit.SECONDS).toString();
        String path = "/api/v1/replay?at=" + at + "&bbox=124,33,132,39";
        JdbcClient admin = admin();
        String stuck = "SELECT count(*) FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE '%wakeline replay.radar_frame%'";
        java.util.Queue<Res> results = new java.util.concurrent.ConcurrentLinkedQueue<>();
        java.util.List<Thread> requests = new java.util.ArrayList<>();
        long probeMs;
        long maxStuck = 0;
        try (Connection c = DriverManager.getConnection(DbTestSupport.jdbcUrl(ItStack.DB), "postgres", DbTestSupport.ROOT_PW);
             Statement s = c.createStatement()) {
            c.setAutoCommit(false);
            s.execute("LOCK TABLE radar_frame IN ACCESS EXCLUSIVE MODE"); // 재생의 레이더 조회가 이 잠금을 기다린다(3 s 상한까지 연결을 잡는다)
            Thread releaser = Thread.ofVirtual().start(() -> {
                try { Thread.sleep(15_000); c.rollback(); } catch (Exception ignored) { }
            });
            for (int i = 0; i < 20; i++) requests.add(Thread.ofVirtual().start(() -> results.add(get(path))));
            long deadline = System.currentTimeMillis() + 2_000;
            while (System.currentTimeMillis() < deadline && maxStuck < PublicReadGate.DEFAULT_PERMITS) {
                maxStuck = Math.max(maxStuck, admin.sql(stuck).query(Long.class).single());
                Thread.sleep(20);
            }
            Thread.sleep(300); // 더 잡을 수 있었다면 이 사이에 잡는다
            maxStuck = Math.max(maxStuck, admin.sql(stuck).query(Long.class).single());
            long t0 = System.nanoTime();
            assertThat(db.sql("SELECT 1").query(Integer.class).single()).isEqualTo(1); // 공개 조회가 아닌 문장 — 기록기와 같은 길
            probeMs = (System.nanoTime() - t0) / 1_000_000;
            for (Thread t : requests) t.join(15_000);
            releaser.interrupt();
            c.rollback();
        }
        assertThat(probeMs).as("a non-public statement gets a shared-pool connection while the public reads are stuck").isLessThan(1_000L);
        assertThat(maxStuck).as("public reads holding a shared-pool connection while stuck on the lock").isEqualTo(PublicReadGate.DEFAULT_PERMITS);
        assertThat(results).hasSize(20).allSatisfy(r -> {
            assertProblem(r, 503, "UNAVAILABLE", "/api/v1/replay");
            assertThat(r.header("Retry-After")).isEqualTo(String.valueOf(Problem.UNAVAILABLE_RETRY_AFTER_S));
        });
        // 격벽이 돌려보낸 것: 연결을 빌리지 않았다 — 원인 메시지가 말한다(풀 대기 초과 · 문장 취소와 구별된다)
        long rejected = results.stream().filter(r -> warnLine(out, r.header("X-Request-Id")).contains("public read limit reached")).count();
        assertThat(rejected).isEqualTo(20 - PublicReadGate.DEFAULT_PERMITS);
        assertThat(meters.find("wakeline_db_public_reads_rejected_total").counter().count()).isGreaterThanOrEqualTo(rejected);
        assertThat(get(path).status()).as("the same read works once the lock is gone").isEqualTo(200);
    }

    /** 이 요청의 503 WARN 한 줄(요청 id 로 고른다). */
    static String warnLine(CapturedOutput out, String requestId) {
        assertThat(requestId).isNotBlank();
        return out.getAll().lines().filter(l -> l.contains("WARN") && l.contains("request_id=" + requestId)).findFirst()
                .orElseThrow(() -> new AssertionError("no WARN line for request_id=" + requestId));
    }

    static long elapsedMs(String line) {
        Matcher m = ELAPSED.matcher(line);
        assertThat(m.find()).as("elapsed_ms in: %s", line).isTrue();
        return Long.parseLong(m.group(1));
    }
}
