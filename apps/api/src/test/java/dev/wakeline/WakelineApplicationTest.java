package dev.wakeline;

import org.junit.jupiter.api.Test;

import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

/** CLI: --password-stdin(계약 §7 — 비밀번호가 명령행·환경에 남지 않는다), 비밀번호 규칙, --migrate 는 DDL 비밀번호만 필요. */
class WakelineApplicationTest {
    static ByteArrayInputStream in(String s) { return new ByteArrayInputStream(s.getBytes(StandardCharsets.UTF_8)); }

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
        assertThat(WakelineApplication.createOpsUser(false, in(""), Map.of())).isEqualTo(2);                      // 환경변수도 없음
        assertThat(WakelineApplication.createOpsUser(false, in(""), Map.of("WAKELINE_OPS_PASSWORD", "tiny"))).isEqualTo(2);
        assertThat(WakelineApplication.createOpsUser(true, in("long-enough-password\n"), Map.of("WAKELINE_OPS_USER", " "))).isEqualTo(2);
    }

    @Test
    void migrateNeedsOnlyTheMigratorPassword() {
        assertThat(WakelineApplication.migrate(Map.of("DB_HOST", "127.0.0.1"))).isEqualTo(2);
    }
}
