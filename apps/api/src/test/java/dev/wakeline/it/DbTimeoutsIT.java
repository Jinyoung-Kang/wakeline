package dev.wakeline.it;

import dev.wakeline.DbTestSupport;
import dev.wakeline.ops.OpsUserService;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIf;
import org.junit.jupiter.api.extension.ExtendWith;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.system.CapturedOutput;
import org.springframework.boot.test.system.OutputCaptureExtension;

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

    @Test
    void apiConnectionsCarryStatementAndLockTimeouts() {
        assertThat(db.sql("SHOW statement_timeout").query(String.class).single()).isEqualTo("30s");
        assertThat(db.sql("SHOW lock_timeout").query(String.class).single()).isEqualTo("5s");
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
            assertThat(line).contains("statement cancelled (SQLSTATE 57014)")
                    .contains("path=/api/v1/replay query=\"" + query + "\"")
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
