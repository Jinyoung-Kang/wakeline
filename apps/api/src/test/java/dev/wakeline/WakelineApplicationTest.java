package dev.wakeline;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.springframework.boot.test.system.CapturedOutput;
import org.springframework.boot.test.system.OutputCaptureExtension;

import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

/** CLI: --password-stdin(계약 §7 — 비밀번호가 명령행·환경에 남지 않는다), 비밀번호 규칙, --migrate 는 DDL 비밀번호만 필요. */
@ExtendWith(OutputCaptureExtension.class)
class WakelineApplicationTest {
    static ByteArrayInputStream in(String s) { return new ByteArrayInputStream(s.getBytes(StandardCharsets.UTF_8)); }

    /** AWS 리뷰 2026-10 C-1: migrate 는 URL 을 직접 만들어 드라이버 기본(sslmode=prefer — 서버 인증서를 검증하지 않음)이었다. AWS 에서는 RDS 인증서를 검증한다. */
    @Test
    void migrateUrlCarriesTheTlsSettingsOnlyWhenGiven() {
        Map<String, String> base = Map.of("DB_HOST", "db.example", "DB_MIGRATOR_PASSWORD", "x");
        assertThat(WakelineApplication.migrateUrl(base)).isEqualTo("jdbc:postgresql://db.example:5432/wakeline?ApplicationName=wakeline-migrate"); // 로컬과 같다
        Map<String, String> aws = new java.util.HashMap<>(base);
        aws.put("DB_SSLMODE", "verify-full");
        aws.put("DB_SSLROOTCERT", "/etc/wakeline/rds-ca.pem");
        assertThat(WakelineApplication.migrateUrl(aws))
                .isEqualTo("jdbc:postgresql://db.example:5432/wakeline?ApplicationName=wakeline-migrate&sslmode=verify-full&sslrootcert=%2Fetc%2Fwakeline%2Frds-ca.pem");
    }

    @Test
    void migrateRefusesAnUnknownSslMode(CapturedOutput out) {
        assertThat(WakelineApplication.migrate(Map.of("DB_MIGRATOR_PASSWORD", "x", "DB_SSLMODE", "verify-full&sslfactory=x"))).isEqualTo(2);
        assertThat(out.getErr()).contains("DB_SSLMODE");
    }

    @Test
    void readsExactlyOneLineWithoutTrimming() throws Exception {
        assertThat(WakelineApplication.readPasswordLine(in("  spaced secret  \r\nsecond line\n"))).isEqualTo("  spaced secret  ");
        assertThat(WakelineApplication.readPasswordLine(in("no-newline-at-end"))).isEqualTo("no-newline-at-end");
        assertThat(WakelineApplication.readPasswordLine(in(""))).isNull();
    }

    @Test
    void passwordRules() {
        assertThat(WakelineApplication.checkOpsPassword(null)).isNotNull();
        assertThat(WakelineApplication.checkOpsPassword("short")).contains("at least 12");
        assertThat(WakelineApplication.checkOpsPassword("correct-horse-battery")).isNull();
        assertThat(WakelineApplication.checkOpsPassword("가".repeat(25))).contains("72 bytes"); // 25자 = 75바이트 — BCrypt 가 뒤를 버린다
    }

    @Test
    void createOpsUserRejectsBadInputBeforeTouchingTheDatabase() {
        assertThat(WakelineApplication.createOpsUser(true, in(""), Map.of())).isEqualTo(2);
        assertThat(WakelineApplication.createOpsUser(true, in("short\n"), Map.of())).isEqualTo(2);
        assertThat(WakelineApplication.createOpsUser(false, in(""), Map.of())).isEqualTo(2);                      // --password-stdin 없음
        assertThat(WakelineApplication.createOpsUser(false, in(""), Map.of("WAKELINE_OPS_PASSWORD", "tiny"))).isEqualTo(2);
        assertThat(WakelineApplication.createOpsUser(true, in("long-enough-password\n"), Map.of("WAKELINE_OPS_USER", " "))).isEqualTo(2);
    }

    /**
     * 리뷰 cto-2026-10 S8(결정 5): 비밀번호는 표준 입력으로만 받는다 — 환경변수 WAKELINE_OPS_PASSWORD 는 읽지 않는다(docker exec -e 로 넘기면 argv ·
     * 프로세스 환경에 남는다). --password-stdin 이 없으면 무엇을 해야 하는지 알리고 2 로 끝난다(환경변수의 값은 보지도 않는다).
     */
    @Test
    void thePasswordIsReadFromStdinOnlyNeverFromTheEnvironment(CapturedOutput out) {
        assertThat(WakelineApplication.createOpsUser(false, in(""), Map.of("WAKELINE_OPS_PASSWORD", "tiny"))).isEqualTo(2);
        assertThat(out.getErr()).contains("--password-stdin").doesNotContain("at least 12");
    }

    /** R-95: ops-user 는 끝낸 기존 세션 수를 알리고, 세션을 끝내지 못하면(Redis 장애) 비밀번호는 바뀐 채 종료 코드 3 으로 알린다. */
    @Test
    void opsUserReportsEndedSessionsAndRevocationFailure() {
        var out = new java.io.ByteArrayOutputStream();
        var err = new java.io.ByteArrayOutputStream();
        dev.wakeline.ops.OpsUserService ok = new dev.wakeline.ops.OpsUserService(null, null) {
            @Override public int upsert(String username, String password) { return 2; }
        };
        assertThat(WakelineApplication.applyOpsUser(ok, "admin", "long-enough-password", new java.io.PrintStream(out, true), new java.io.PrintStream(err, true))).isZero();
        assertThat(out.toString()).contains("ops user 'admin' ready").contains("ended 2 existing session(s)");

        dev.wakeline.ops.OpsUserService fresh = new dev.wakeline.ops.OpsUserService(null, null) {
            @Override public int upsert(String username, String password) { return 0; }
        };
        out.reset();
        assertThat(WakelineApplication.applyOpsUser(fresh, "admin", "long-enough-password", new java.io.PrintStream(out, true), new java.io.PrintStream(err, true))).isZero();
        assertThat(out.toString()).isEqualTo("ops user 'admin' ready" + System.lineSeparator());

        dev.wakeline.ops.OpsUserService redisDown = new dev.wakeline.ops.OpsUserService(null, null) {
            @Override public int upsert(String username, String password) {
                throw new SessionsNotRevoked(username, new IllegalStateException("redis down"));
            }
        };
        assertThat(WakelineApplication.applyOpsUser(redisDown, "admin", "long-enough-password", new java.io.PrintStream(out, true), new java.io.PrintStream(err, true))).isEqualTo(3);
        assertThat(err.toString()).contains("ops user 'admin'").contains("password updated").contains("could not be ended").doesNotContain("long-enough-password");
    }

    @Test
    void migrateNeedsOnlyTheMigratorPassword() {
        assertThat(WakelineApplication.migrate(Map.of("DB_HOST", "127.0.0.1"))).isEqualTo(2);
    }
}
