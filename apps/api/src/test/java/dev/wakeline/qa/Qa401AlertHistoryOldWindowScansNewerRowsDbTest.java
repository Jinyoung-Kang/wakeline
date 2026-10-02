package dev.wakeline.qa;

import dev.wakeline.DbTestSupport;
import dev.wakeline.PlanCapture;
import dev.wakeline.platform.data.OrderedWriter;
import dev.wakeline.weather.core.SigmetStore;
import dev.wakeline.weather.data.AlertRepository;
import dev.wakeline.weather.data.SigmetRepository;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIf;
import org.springframework.jdbc.core.simple.JdbcClient;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.json.JsonMapper;

import java.time.Instant;
import java.time.temporal.ChronoUnit;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * QA-401(QA 2026-10 성능): 공개 {@code GET /api/v1/alerts/history} 의 '오래된 좁은 창'(30일 보존 안 · 범위 30일 이하 — 합법 파라미터, hex · cursor 없음)이
 * alert_event 를 기본 키 역순으로 그 창보다 새로운 행 전부를 훑는다({@code ORDER BY e.id DESC LIMIT} — 플래너는 맞는 행이 id 순서에 고르게 퍼져 있다고 보고
 * 곧 멈출 것으로 계산하지만, 알림 id 는 시각에서 만들어져(AlertIds — epoch ms × 1000) 오래된 창의 행은 모두 역순 스캔의 끝에 몰려 있다).
 * 격리 스택 A(알림 약 117만 행 · 29.5일 — ADR-017 R-06 의 '하루 약 50 MB')에서 15–29일 전 1 h 창은 늘 공개 조회 상한 3 s 에 끊겨 503 이 되고
 * (EXPLAIN: Rows Removed by Filter 1,009,071 · 9.5 s), 초당 2건(api 의 IP 당 한도 분당 120 과 같다)이면 공개 조회 격벽(허가 6)을 차지해
 * 재생 · 통계 · 항적 요청의 26–53 % 가 503 이 된다(perf/qa/qa-401-alerts-history-old-window.js).
 * 이 시험은 같은 꼴을 작게 만든다: 30일 · 300,000행(id 가 entered_at 순), 25일 전 6 h 창(약 2,500행), 저장소가 실제로 보내는 문장의 EXPLAIN ANALYZE 로
 * 버린 행 수를 본다. 플래너는 창 안의 행이 많을수록(창이 넓거나 알림이 잦을수록) 역순 스캔을 고른다 — 이 표 크기에서 1 h 창(약 416행)은 entered_at 인덱스를
 * 고르고(통과), 격리 스택 A 의 117만 행에서는 1 h 창(약 1,550행)부터 역순 스캔을 골랐다.
 */
@EnabledIf("dev.wakeline.DbTestSupport#dockerAvailable")
class Qa401AlertHistoryOldWindowScansNewerRowsDbTest {
    static final ObjectMapper M = JsonMapper.builder().build();

    @BeforeAll
    static void seed() {
        DbTestSupport.reset();
        JdbcClient admin = DbTestSupport.admin();
        // 30일 동안 108 s 마다 SIGMET 하나(2–6 h 유효) — 알림이 그 시각에 유효한 SIGMET 을 가리킨다
        admin.sql("""
                INSERT INTO sigmet (id, fir_id, series_id, hazard, valid_from, valid_to, raw_text, provider, fetched_at)
                SELECT 'Q401-' || n, 'RKRR', '1', 'TS', now() - interval '31 days' + n * interval '108 seconds',
                       now() - interval '31 days' + n * interval '108 seconds' + interval '3 hours', 'r', 'awc', now()
                FROM generate_series(0, 25000) n""").update();
        // 30일 · 300,000행(8.64 s 간격), id = epoch ms × 1000 (AlertIds) — 운영처럼 id 순서 = 시각 순서. 근거 JSON 은 운영 행과 비슷한 길이(약 600자)
        admin.sql("""
                INSERT INTO alert_event (id, hex, callsign, sigmet_id, kind, entered_at, left_at, evidence, close_reason)
                SELECT (extract(epoch FROM t) * 1000)::bigint * 1000, lpad(to_hex(g % 20000), 6, '0'), 'QA' || (g % 9000),
                       'Q401-' || greatest(0, floor(extract(epoch FROM t - (now() - interval '31 days')) / 108)::int - 1), 'OBSERVED', t, t + interval '10 minutes',
                       jsonb_build_object('method', 'observed_point_in_polygon', 'pad', repeat('x', 560)), 'left'
                FROM generate_series(1, 300000) g, LATERAL (SELECT now() - interval '30 days' + g * interval '8.64 seconds' AS t) tt""").update();
        admin.sql("ANALYZE alert_event").update();
        admin.sql("ANALYZE sigmet").update();
    }

    @Test
    void anOldOneHourWindowDoesNotScanEveryNewerAlert() {
        PlanCapture plans = new PlanCapture(DbTestSupport.apiDataSource(), "FROM alert_event e JOIN sigmet s", PlanCapture.Mode.ANALYZE);
        SimpleMeterRegistry meters = new SimpleMeterRegistry();
        OrderedWriter writer = new OrderedWriter(meters, 10, 20);
        JdbcClient db = JdbcClient.create(plans.dataSource());
        AlertRepository repo = new AlertRepository(db, DbTestSupport.JSON, new SigmetRepository(db, DbTestSupport.JSON, writer), new SigmetStore(), writer, meters);

        Instant from = Instant.now().minus(25, ChronoUnit.DAYS);
        var page = repo.history(from, from.plus(6, ChronoUnit.HOURS), null, null, 50);
        assertThat(page.items()).as("창 안에 행이 있다(약 2,500행)").hasSize(50);

        JsonNode plan = M.readTree(plans.last()).get(0).get("Plan");
        long removed = removedFromAlertEvent(plan);
        double ms = M.readTree(plans.last()).get(0).get("Execution Time").asDouble();
        // 창 안의 행은 약 2,500행 — 창보다 새로운 행(약 25일치 · 25만 행)을 읽고 버리면 오래된 창일수록(보존 30일 · 하루 수만 건) 공개 조회 상한 3 s 를 넘는다
        assertThat(removed)
                .as("alert_event 에서 읽고 버린 행(Rows Removed by Filter) — 25일 전 6 h 창 · limit 50. 실행 %.0f ms. 계획: %s", ms, plans.last())
                .isLessThan(10_000);
    }

    /** 계획 나무에서 alert_event 를 읽는 마디의 'Rows Removed by Filter' 합. */
    static long removedFromAlertEvent(JsonNode n) {
        long sum = 0;
        if ("alert_event".equals(n.path("Relation Name").asString()) && n.has("Rows Removed by Filter"))
            sum += n.get("Rows Removed by Filter").asLong() * Math.max(1, n.path("Actual Loops").asLong(1));
        for (JsonNode c : n.path("Plans")) sum += removedFromAlertEvent(c);
        return sum;
    }
}
