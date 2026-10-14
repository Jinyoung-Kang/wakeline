package dev.wakeline.qa;

import dev.wakeline.DbTestSupport;
import dev.wakeline.platform.data.OrderedWriter;
import dev.wakeline.platform.data.Sql;
import dev.wakeline.platform.support.Receipt;
import dev.wakeline.weather.core.WarningRecord;
import dev.wakeline.weather.core.WeatherEvents;
import dev.wakeline.weather.data.WarningRepository;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIf;
import org.springframework.jdbc.core.simple.JdbcClient;

import java.time.Instant;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * QA-1203(AWS 공개 데모 QA · 기능 · 이력): 특보 이력(V20 wx_warning — 계약 v5 §G49 'ended_at = 목록에서 빠진 시각')은 줄을 버린 목록(dropped &gt; 0)에서
 * 빠진 특보를 끝내지 않는다(WarningRepository.persist — AWS 리뷰 B-4). 버려지는 줄이 그 특보 자신이 아니라 계속 발효 중인 다른 특보라면(예: 구역 이름이 계약
 * 한도 80자를 넘어 수집기가 매 주기 버리는 줄 — 그 특보가 며칠 발효 중) 그동안 해제된 특보는 하나도 끝나지 않는다: 이력이 해제된 특보를 무기한 '발효 중'
 * (ended_at 없음)으로 내고, 버려지던 줄이 사라진 뒤 첫 온전한 목록의 시각을 끝난 시각으로 영구히 남긴다(실제 해제보다 며칠 늦게).
 * 수집기는 버린 줄의 구역 부호를 알지만(길이 초과는 해석 뒤 검사) 봉투에는 수만 싣는다.
 */
@EnabledIf("dev.wakeline.DbTestSupport#dockerAvailable")
class Qa1203WarningNeverEndsWhileLinesAreDroppedDbTest {
    static final Instant T = Instant.parse("2026-10-09T07:05:00Z");
    static final Instant ISSUED = Instant.parse("2026-10-09T07:00:00Z");
    JdbcClient admin;
    OrderedWriter writer;
    WarningRepository repo;

    @BeforeEach
    void setUp() {
        DbTestSupport.reset();
        admin = DbTestSupport.admin();
        writer = new OrderedWriter(new SimpleMeterRegistry(), 10, 20);
        repo = new WarningRepository(DbTestSupport.apiClient(), writer);
    }

    static WarningRecord heavyRain(String zone) {
        return new WarningRecord(zone, "구역 " + zone, null, null, false, "호우", "주의보", "발표", false, ISSUED, ISSUED.plusSeconds(3600),
                null, null, null, null, "raw " + zone);
    }

    void receive(Instant at, int dropped, WarningRecord... ws) {
        repo.onWarnings(new WeatherEvents.WarningsReceived(at, "kma_warning", List.of(ws), dropped, Receipt.NONE));
        writer.drainNow();
    }

    Object endedAt(String zone) {
        return admin.sql("SELECT ended_at FROM wx_warning WHERE zone_code = :z").param("z", zone).query().singleRow().get("ended_at");
    }

    /**
     * 호우주의보 L1100100 이 07:10 에 해제됐다. 같은 때부터 다른 특보(구역 이름 81자) 한 줄이 매 주기(5분) 버려진다 — 그 특보는 하루 넘게 발효 중이다.
     */
    @Test
    void aLiftedWarningEndsEvenWhileAnotherWarningsLineIsDroppedEveryCycle() {
        receive(T, 0, heavyRain("L1100100"));                            // 온전한 목록 — 발효 중
        Instant lifted = T.plusSeconds(300);
        for (int i = 0; i < 288; i++) receive(lifted.plusSeconds(300L * i), 1); // 24 h 동안 5분마다: L1100100 없음 · 다른 특보 한 줄을 버림

        // 공개 이력(/warnings/history 기본 창 24 h)이 내는 그 특보 — ended_at 이 없으면 '아직 발효 중'
        List<Map<String, Object>> h = repo.history(lifted.plusSeconds(300L * 287).minusSeconds(24 * 3600), lifted.plusSeconds(300L * 287), "L1100100", 10);
        assertThat(h).hasSize(1);
        assertThat(h.getFirst().get("ended_at"))
                .as("ended_at of the warning lifted at %s, after 24 h of lists without it (each list dropped another warning's line)", lifted).isNotNull();
    }

    /** 버려지던 줄이 사라진 뒤(첫 온전한 목록): 끝난 시각은 목록에서 빠진 시각이어야 한다(계약 §G49) — 지금은 그 온전한 목록의 시각(하루 늦게) */
    @Test
    void theEndTimeIsWhenTheWarningLeftTheListNotTheFirstCleanListAfterTheDroppedStreak() {
        receive(T, 0, heavyRain("L1100100"));
        Instant lifted = T.plusSeconds(300);
        for (int i = 0; i < 288; i++) receive(lifted.plusSeconds(300L * i), 1);
        Instant clean = lifted.plusSeconds(300L * 288);
        receive(clean, 0);                                                  // 버리던 특보도 해제 — 온전한 빈 목록

        assertThat(Sql.toInstant(endedAt("L1100100"))).as("ended_at of the warning that left the list at %s", lifted).isEqualTo(lifted);
    }
}
