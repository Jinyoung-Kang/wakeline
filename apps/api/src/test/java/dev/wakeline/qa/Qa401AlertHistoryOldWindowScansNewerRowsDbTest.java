package dev.wakeline.qa;

import dev.wakeline.DbTestSupport;
import dev.wakeline.PlanCapture;
import dev.wakeline.platform.data.OrderedWriter;
import dev.wakeline.weather.core.SigmetStore;
import dev.wakeline.weather.data.AlertRepository;
import dev.wakeline.weather.data.SigmetRepository;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import org.assertj.core.api.SoftAssertions;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIf;
import org.springframework.jdbc.core.simple.JdbcClient;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.json.JsonMapper;

import javax.sql.DataSource;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.List;

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
 * <p>고친 뒤(계약 v5 §G36): 쪽은 entered_at 최신순 · 같은 시각은 id 역순이고, 인덱스 alert_event_entered · alert_event_hex 를 창의 끝부터 읽다가
 * 한 쪽을 채우면 멈춘다. {@link #everyWindowReadsAboutOnePageInBothPlans} 가 오래된 · 최근 · 30일 창 × hex 유무 × 첫 쪽 · 커서 쪽을 맞춤 계획과
 * 일반 계획(같은 연결에서 여러 번 실행된 뒤의 plan cache) 모두에서 EXPLAIN (ANALYZE, BUFFERS) 로 재어 alert_event 에서 읽은 행이 한 쪽 남짓인지 본다
 * (고친 뒤 잰 값: 모든 칸 52 · 54행, 창 안의 행이 한 쪽보다 적으면 그 수 · 1 ms 아래). 고치기 전(같은 시드): 25일 전 6 h 첫 쪽 맞춤 계획 251,115행(기본 키 역순 ·
 * 123 ms), 일반 계획은 창 안의 행을 모두 읽고 정렬했다 — 최근 24 h 10,144행 · 30일 창 304,320행(597 ms) · 붐비는 hex 30일 4,320행.</p>
 */
@EnabledIf("dev.wakeline.DbTestSupport#dockerAvailable")
class Qa401AlertHistoryOldWindowScansNewerRowsDbTest {
    static final ObjectMapper M = JsonMapper.builder().build();
    /** 30일 내내 10분마다 알림이 나는 hex(4,320행) — hex 조건이 있는 쪽도 한 쪽 남짓만 읽는지 본다(finding 의 hex=f10000 과 같은 값). */
    static final String BUSY_HEX = "f10000";
    static final int LIMIT = 50;
    /**
     * 한 쪽에서 alert_event 를 읽어도 되는 행의 상한(잰 값: 첫 쪽 52 · 커서 쪽 54): 쪽(limit + 1) + Incremental Sort 가 마지막 시각 묶음의 끝을
     * 알아보는 1행 + 커서 쪽이면 커서 행을 기본 키로 찾는 1행과 인덱스 조건(entered_at ≤ 커서 행의 시각)이 다시 읽고 필터로 버리는 커서 행 1행
     * + 같은 시각 묶음 여유 2행(붐비는 hex 의 행은 90분마다 다른 행과 같은 시각이다). 창보다 새로운 행을 훑으면 수천 · 수십만 행이다.
     */
    static final long PAGE_READ_BOUND = (LIMIT + 1) + 1 + 2 + 2;

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
        // 붐비는 hex 하나: 30일 · 10분마다(4,320행). id 는 같은 규칙 + 1(위 행과 같은 ms 여도 겹치지 않게)
        admin.sql("""
                INSERT INTO alert_event (id, hex, callsign, sigmet_id, kind, entered_at, left_at, evidence, close_reason)
                SELECT (extract(epoch FROM t) * 1000)::bigint * 1000 + 1, :hex, 'BUSY',
                       'Q401-' || greatest(0, floor(extract(epoch FROM t - (now() - interval '31 days')) / 108)::int - 1), 'OBSERVED', t, t + interval '10 minutes',
                       jsonb_build_object('method', 'observed_point_in_polygon', 'pad', repeat('x', 560)), 'left'
                FROM generate_series(1, 4320) g, LATERAL (SELECT now() - interval '30 days' + g * interval '10 minutes' AS t) tt""")
                .param("hex", BUSY_HEX).update();
        admin.sql("ANALYZE alert_event").update();
        admin.sql("ANALYZE sigmet").update();
    }

    static AlertRepository repo(PlanCapture plans) { return repo(plans.dataSource()); }

    static AlertRepository repo(DataSource ds) {
        SimpleMeterRegistry meters = new SimpleMeterRegistry();
        OrderedWriter writer = new OrderedWriter(meters, 10, 20);
        JdbcClient db = JdbcClient.create(ds);
        return new AlertRepository(db, DbTestSupport.JSON, new SigmetRepository(db, DbTestSupport.JSON, writer), new SigmetStore(), writer, meters);
    }

    @Test
    void anOldOneHourWindowDoesNotScanEveryNewerAlert() {
        PlanCapture plans = new PlanCapture(DbTestSupport.apiDataSource(), "FROM alert_event e JOIN sigmet s", PlanCapture.Mode.ANALYZE);
        AlertRepository repo = repo(plans);

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

    record Window(String name, Instant from, Instant to) {}

    /**
     * 오래된 창(25일 전 6 h · 29일 전 1 h) · 최근 창(최근 24 h — API 기본 · 최근 1 h) · 30일 창 전체 × hex 없음 · 붐비는 hex × 첫 쪽 · 커서 쪽(둘째 쪽)을
     * 맞춤 계획(처음 몇 번의 실행)과 일반 계획(같은 연결에서 여러 번 실행된 뒤 — plan_cache_mode = force_generic_plan) 모두로 실행해
     * alert_event 에서 읽은 행(인덱스 · 힙 스캔이 낸 행 + 필터 · 재검사로 버린 행)이 {@link #PAGE_READ_BOUND} 이하인지 본다.
     * 기본 키를 역순으로 훑는 계획(창보다 새로운 행 전부)은 어느 칸에서도 나오면 안 된다.
     */
    @Test
    void everyWindowReadsAboutOnePageInBothPlans() {
        Instant now = Instant.now();
        List<Window> windows = List.of(
                new Window("old 25d 6h", now.minus(25, ChronoUnit.DAYS), now.minus(25, ChronoUnit.DAYS).plus(6, ChronoUnit.HOURS)),
                new Window("old 29d 1h", now.minus(29, ChronoUnit.DAYS), now.minus(29, ChronoUnit.DAYS).plus(1, ChronoUnit.HOURS)),
                new Window("recent 24h", now.minus(1, ChronoUnit.DAYS), now),
                new Window("recent 1h", now.minus(1, ChronoUnit.HOURS), now),
                new Window("full 30d", now.minus(30, ChronoUnit.DAYS), now));
        SoftAssertions soft = new SoftAssertions();
        List<String> table = new ArrayList<>();
        table.add(String.format("%-11s %-6s %-6s %-7s %5s %6s %6s %7s %8s  %s", "window", "hex", "page", "plan", "items", "read", "hit", "read_b", "ms", "alert_event access"));
        for (PlanCapture.Mode mode : List.of(PlanCapture.Mode.ANALYZE, PlanCapture.Mode.GENERIC_ANALYZE)) {
            for (Window w : windows) {
                for (String hex : new String[]{null, BUSY_HEX}) {
                    // 첫 쪽의 next_cursor 는 계획을 잡지 않는 저장소로 구한다(둘째 쪽 계획만 잡는다)
                    var first = repo(DbTestSupport.apiDataSource()).history(w.from(), w.to(), hex, null, LIMIT);
                    // 창 안의 행이 한 쪽 이하면(붐비는 hex 의 1 h 창 = 6행) 둘째 쪽이 없다 — 첫 쪽만 잰다
                    List<Long> cursors = new ArrayList<>();
                    cursors.add(null);
                    if (first.nextCursor() != null) cursors.add(first.nextCursor());
                    for (Long cursor : cursors) {
                        PlanCapture plans = new PlanCapture(DbTestSupport.apiDataSource(), "FROM alert_event e JOIN sigmet s", mode);
                        var page = repo(plans).history(w.from(), w.to(), hex, cursor, LIMIT);
                        JsonNode root = M.readTree(plans.last()).get(0);
                        JsonNode plan = root.get("Plan");
                        long read = readFromAlertEvent(plan);
                        String access = accessPaths(plan, new ArrayList<>()).toString();
                        String row = String.format("%-11s %-6s %-6s %-7s %5d %6d %6d %7d %8.2f  %s", w.name(), hex == null ? "-" : hex, cursor == null ? "first" : "cursor",
                                mode == PlanCapture.Mode.ANALYZE ? "custom" : "generic", page.items().size(), read, plan.path("Shared Hit Blocks").asLong(),
                                plan.path("Shared Read Blocks").asLong(), root.get("Execution Time").asDouble(), access);
                        table.add(row);
                        // 빈 쪽이면 읽은 행이 적어도 뜻이 없다 — 시드의 모든 창에 행이 있다
                        soft.assertThat(page.items()).as(row).isNotEmpty();
                        soft.assertThat(read).as("%s — 계획: %s", row, plans.last()).isLessThanOrEqualTo(PAGE_READ_BOUND);
                        soft.assertThat(access).as(row).doesNotContain("alert_event_pkey Backward");
                    }
                }
            }
        }
        String report = String.join("\n", table);
        System.out.println("QA-401 plan matrix (limit " + LIMIT + ", bound " + PAGE_READ_BOUND + " rows):\n" + report);
        soft.assertAll();
    }

    /** 계획 나무에서 alert_event 를 읽는 마디의 'Rows Removed by Filter' 합. */
    static long removedFromAlertEvent(JsonNode n) {
        long sum = 0;
        if ("alert_event".equals(n.path("Relation Name").asString()) && n.has("Rows Removed by Filter"))
            sum += n.get("Rows Removed by Filter").asLong() * Math.max(1, n.path("Actual Loops").asLong(1));
        for (JsonNode c : n.path("Plans")) sum += removedFromAlertEvent(c);
        return sum;
    }

    /** alert_event 를 읽는 마디(인덱스 · 힙 · 순차 스캔)가 낸 행 + 필터 · 재검사로 버린 행의 합(반복 수를 곱한다). 비트맵 인덱스 마디는 힙 마디가 센다. */
    static long readFromAlertEvent(JsonNode n) {
        long sum = 0;
        if ("alert_event".equals(n.path("Relation Name").asString())) {
            long loops = Math.max(1, n.path("Actual Loops").asLong(1));
            sum += (n.path("Actual Rows").asLong() + n.path("Rows Removed by Filter").asLong() + n.path("Rows Removed by Index Recheck").asLong()) * loops;
        }
        for (JsonNode c : n.path("Plans")) sum += readFromAlertEvent(c);
        return sum;
    }

    /** alert_event 를 읽는 마디의 '마디 종류 인덱스 방향' 목록(보고 · 단언용). */
    static List<String> accessPaths(JsonNode n, List<String> out) {
        if ("alert_event".equals(n.path("Relation Name").asString()) || n.path("Index Name").asString().startsWith("alert_event"))
            out.add(n.path("Node Type").asString() + (n.has("Index Name") ? " " + n.path("Index Name").asString() : "")
                    + (n.has("Scan Direction") ? " " + n.path("Scan Direction").asString() : "") + (n.has("Subplan Name") ? " (" + n.path("Subplan Name").asString() + ")" : ""));
        for (JsonNode c : n.path("Plans")) accessPaths(c, out);
        return out;
    }
}
