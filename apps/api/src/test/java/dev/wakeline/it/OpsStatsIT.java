package dev.wakeline.it;

import dev.wakeline.ops.OpsUserService;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIf;
import org.springframework.beans.factory.annotation.Autowired;

import java.time.LocalDate;
import java.time.ZoneOffset;

import static org.assertj.core.api.Assertions.assertThat;

/** 운영 통계 재집계(POST /api/v1/ops/stats/aggregate). */
@EnabledIf("dev.wakeline.DbTestSupport#dockerAvailable")
class OpsStatsIT extends IntegrationTest {
    static final String PW = "stats-horse-battery-staple";

    @Autowired OpsUserService users;

    /**
     * R-46: 끝나지 않은 날(오늘 이후, UTC)은 재집계하지 않는다(400 BAD_DAY) — 부분 집계가 완성된 통계처럼 굳지 않게.
     * 끝난 날은 감사 기록과 함께 집계된다.
     */
    @Test
    void onlyFinishedDaysCanBeReaggregated() {
        OpsBrowser b = OpsBrowser.login(this, users, "it-stats", PW);
        LocalDate today = LocalDate.now(ZoneOffset.UTC);
        for (LocalDate d : new LocalDate[]{today, today.plusDays(1)}) {
            long audits = count("SELECT count(*) FROM audit_log WHERE action = 'STATS_AGGREGATE' AND target = ?", d.toString());
            assertProblem(b.post("/api/v1/ops/stats/aggregate?day=" + d), 400, "BAD_DAY", "/api/v1/ops/stats/aggregate");
            assertThat(count("SELECT count(*) FROM audit_log WHERE action = 'STATS_AGGREGATE' AND target = ?", d.toString())).isEqualTo(audits);
        }
        LocalDate y = today.minusDays(1);
        IntegrationTest.Res ok = b.post("/api/v1/ops/stats/aggregate?day=" + y);
        assertThat(ok.status()).isEqualTo(200);
        assertThat(ok.json().path("day").asString()).isEqualTo(y.toString());
    }
}
