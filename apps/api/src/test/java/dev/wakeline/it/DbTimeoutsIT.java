package dev.wakeline.it;

import dev.wakeline.DbTestSupport;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIf;

import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.Statement;
import java.time.Instant;
import java.time.temporal.ChronoUnit;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * R-62(ADR-017 §2): DB 가 느려질 때의 격벽. api 연결은 statement_timeout 30 s · lock_timeout 5 s(쓰기·유지보수 포함 모든 문장의 상한),
 * 공개 조회는 3 s 에 끊는다(503 + Retry-After) — 느린 공개 조회가 풀(12)을 오래 잡아 기록기까지 막지 못하게.
 */
@EnabledIf("dev.wakeline.DbTestSupport#dockerAvailable")
class DbTimeoutsIT extends IntegrationTest {

    @Test
    void apiConnectionsCarryStatementAndLockTimeouts() {
        assertThat(db.sql("SHOW statement_timeout").query(String.class).single()).isEqualTo("30s");
        assertThat(db.sql("SHOW lock_timeout").query(String.class).single()).isEqualTo("5s");
    }

    @Test
    void aPublicReadStuckOnALockIsCutAfterThreeSecondsWith503() throws Exception {
        String at = Instant.now().minusSeconds(300).truncatedTo(ChronoUnit.SECONDS).toString();
        String path = "/api/v1/replay?at=" + at + "&bbox=124,33,132,39";
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
        }
        assertThat(get(path).status()).as("the same read works once the lock is gone").isEqualTo(200);
    }
}
