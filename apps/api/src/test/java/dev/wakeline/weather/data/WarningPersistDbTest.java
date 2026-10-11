package dev.wakeline.weather.data;

import dev.wakeline.DbTestSupport;
import dev.wakeline.platform.data.OrderedWriter;
import dev.wakeline.platform.support.Receipt;
import dev.wakeline.weather.core.WarningRecord;
import dev.wakeline.weather.core.WeatherEvents;
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
 * 기상특보 이력(V20 · ADR-036)을 실제 PostgreSQL + api 계정으로: 목록마다 자연키로 이어 쓰고, 빠진 특보는 그 목록의 수신 시각으로 끝내고, 다시 나타나면
 * 다시 연다. 같은 수신 시각 이하의 목록(재전달)은 건너뛴다. 이력 조회는 창과 겹치는 것 · 구역 거르기.
 */
@EnabledIf("dev.wakeline.DbTestSupport#dockerAvailable")
class WarningPersistDbTest {
    static final Instant T = Instant.parse("2026-10-09T07:05:00Z");
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

    static WarningRecord w(String zone, String kind, String level, Instant issued, String endNotice) {
        boolean pre = "예비".equals(level);
        return new WarningRecord(zone, "구역 " + zone, null, null, zone.startsWith("S"), kind, level, "발표", pre, issued, pre ? null : issued.plusSeconds(3600),
                pre ? issued.plusSeconds(86400) : null, pre ? issued.plusSeconds(86400 + 21600) : null, pre ? "10-10 오후(12–18시 KST)" : null, endNotice, "raw " + zone);
    }

    void receive(Instant at, WarningRecord... ws) { receiveDropped(at, 0, ws); }

    void receiveDropped(Instant at, int dropped, WarningRecord... ws) {
        repo.onWarnings(new WeatherEvents.WarningsReceived(at, "kma_warning", List.of(ws), dropped, Receipt.NONE));
        writer.drainNow();
    }

    Map<String, Object> row(String zone) {
        return admin.sql("SELECT zone_code, first_seen, last_seen, ended_at, end_notice, effective_at, effective_text FROM wx_warning WHERE zone_code = :z")
                .param("z", zone).query().singleRow();
    }

    @Test
    void listsAreKeptInOrder_endedWhenGone_reopenedWhenBack() {
        Instant iss = Instant.parse("2026-10-09T07:00:00Z");
        WarningRecord a = w("S1312020", "풍랑", "예비", iss, null), b = w("L1100100", "호우", "주의보", iss, null);
        receive(T, a, b);
        receive(T.plusSeconds(300), a, w("L1100100", "호우", "주의보", iss, "202610091800")); // 해제예고가 붙음
        assertThat(row("L1100100")).containsEntry("end_notice", "202610091800").containsEntry("ended_at", null);
        assertThat(row("S1312020").get("effective_at")).isNull();
        assertThat(row("S1312020").get("effective_text")).isEqualTo("10-10 오후(12–18시 KST)");

        receive(T.plusSeconds(600), a); // 호우주의보가 빠졌다 — 끝
        assertThat(dev.wakeline.platform.data.Sql.toInstant(row("L1100100").get("ended_at"))).isEqualTo(T.plusSeconds(600));
        assertThat(row("S1312020").get("ended_at")).isNull();

        receive(T.plusSeconds(300), b); // 재전달(이미 저장한 시각 이하) — 건너뛴다
        assertThat(row("L1100100").get("ended_at")).isNotNull();

        receive(T.plusSeconds(900), a, b); // 다시 나타남 — 같은 자연키를 다시 연다
        Map<String, Object> rb = row("L1100100");
        assertThat(rb.get("ended_at")).isNull();
        assertThat(dev.wakeline.platform.data.Sql.toInstant(rb.get("first_seen"))).isEqualTo(T);
        assertThat(dev.wakeline.platform.data.Sql.toInstant(rb.get("last_seen"))).isEqualTo(T.plusSeconds(900));

        receive(T.plusSeconds(1200)); // 빈 목록 — 모두 끝
        assertThat(admin.sql("SELECT count(*) FROM wx_warning WHERE ended_at IS NULL").query(Long.class).single()).isZero();

        assertThat(repo.history(T.minusSeconds(60), T.plusSeconds(2000), null, 50)).extracting(m -> m.get("zone_code"))
                .containsExactlyInAnyOrder("S1312020", "L1100100");
        assertThat(repo.history(T.minusSeconds(60), T.plusSeconds(2000), "S1312020", 50)).singleElement()
                .satisfies(m -> assertThat(m).containsEntry("level", "예비").containsEntry("preliminary", true).containsEntry("effective_at", null));
        assertThat(repo.history(T.plusSeconds(5000), T.plusSeconds(6000), null, 50)).isEmpty();
    }

    /**
     * QA 2026-10-release 보고 §7-1 · AWS 리뷰 B-4: 수집기는 해석하지 못한 줄을 목록에서 빼고 수(dropped)만 보낸다. 그 목록에 없는 특보를 '끝남'으로
     * 닫으면, 줄만 버려졌을 뿐 아직 발효 중인 특보가 그 시각에 끝난 것으로 이력에 남았다 — 줄을 버린 목록에서는 끝내지 않는다(다음 온전한 목록이 닫는다).
     */
    @Test
    void aListWithDroppedLinesDoesNotEndTheWarningsItLacks() {
        Instant iss = Instant.parse("2026-10-09T07:00:00Z");
        WarningRecord a = w("S1312020", "풍랑", "예비", iss, null), b = w("L1100100", "호우", "주의보", iss, null);
        receive(T, a, b);
        receiveDropped(T.plusSeconds(300), 1, a); // b 의 줄이 해석되지 않아 빠졌다
        assertThat(row("L1100100").get("ended_at")).isNull();
        receive(T.plusSeconds(600), a); // 온전한 목록에도 없다 — 그때 끝
        assertThat(dev.wakeline.platform.data.Sql.toInstant(row("L1100100").get("ended_at"))).isEqualTo(T.plusSeconds(600));
    }
}
