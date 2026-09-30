package dev.wakeline.ops;

import dev.wakeline.DbTestSupport;
import dev.wakeline.PlanCapture;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIf;
import org.springframework.jdbc.core.simple.JdbcClient;

import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 운영 RUNS 의 조회 계획(도전 리뷰 2026-10-01: "status='error' … ORDER BY id DESC LIMIT 51 은 오류가 드물면 표 대부분을 훑을 수 있다 — EXPLAIN 하라").
 * 운영과 비슷한 분포(30일 · 작업 여럿 · 대부분 ok · 오류는 드묾)를 넣고 ANALYZE 한 뒤, 저장소가 보내는 문장 그대로의 일반 계획(여러 번 실행한 연결이 결국 쓰는
 * 계획 — {@link PlanCapture.Mode#GENERIC})을 본다.
 */
@EnabledIf("dev.wakeline.DbTestSupport#dockerAvailable")
class IngestRunRepositoryDbTest {
    JdbcClient admin;

    @BeforeEach
    void setUp() {
        DbTestSupport.reset();
        admin = DbTestSupport.admin();
        // 200,000행 · 30일(약 13 s 간격) · 작업 5개 · 공급자 2개 · 1,000행에 1행 error(region adsb_fi 는 그중 일부)
        admin.sql("""
                INSERT INTO ingest_run (job, provider, started_at, finished_at, status, http_status, latency_ms, error_text)
                SELECT (ARRAY['region','region','traffic_grid_geom','radar','portcalls_index'])[1 + g % 5],
                       CASE WHEN g % 2 = 0 THEN 'adsb_fi' ELSE 'adsb_lol' END,
                       now() - (g * interval '13 seconds'), now() - (g * interval '13 seconds') + interval '1 second',
                       CASE WHEN g % 1000 = 0 THEN 'error' WHEN g % 997 = 0 THEN 'budget_exhausted' ELSE 'ok' END,
                       CASE WHEN g % 1000 = 0 THEN 502 ELSE 200 END, 200,
                       CASE WHEN g % 1000 = 0 THEN 'HTTP 502 — Bad Gateway ' || g END
                FROM generate_series(1, 200000) g""").update();
        admin.sql("ANALYZE ingest_run").update();
    }

    /** 계획(EXPLAIN FORMAT JSON)에서 ingest_run 을 순차 스캔하는 마디 수 */
    static int seqScansOfIngestRun(String plan) {
        int[] n = {0};
        java.util.function.Consumer<tools.jackson.databind.JsonNode>[] walk = new java.util.function.Consumer[1];
        walk[0] = node -> {
            if ("Seq Scan".equals(node.path("Node Type").asString()) && "ingest_run".equals(node.path("Relation Name").asString())) n[0]++;
            for (var c : node.path("Plans")) walk[0].accept(c);
        };
        for (var root : DbTestSupport.JSON.readTree(plan)) walk[0].accept(root.path("Plan"));
        return n[0];
    }

    /**
     * 창 훑기(ingest_run_started 인덱스 — 요약의 24 h 행)에서 위로 올라가며 첫 Aggregate 에 닿기 전에 있는 Sort · Incremental Sort · WindowAgg 마디 —
     * 있으면 창의 행(운영 약 13,000 · 이 시험 약 6,600)을 모두 정렬한다. 묶은 뒤의 정렬(행 수 = 묶음 수)은 세지 않는다.
     */
    static List<String> sortsOfTheWindowRows(String plan) {
        List<String> out = new java.util.ArrayList<>();
        java.util.Deque<String> above = new java.util.ArrayDeque<>();
        java.util.function.Consumer<tools.jackson.databind.JsonNode>[] walk = new java.util.function.Consumer[1];
        walk[0] = node -> {
            String type = node.path("Node Type").asString();
            if ("ingest_run_started".equals(node.path("Index Name").asString())) {
                for (String t : above) { // 가까운 것부터
                    if (t.equals("Aggregate")) break;
                    if (t.equals("Sort") || t.equals("Incremental Sort") || t.equals("WindowAgg")) out.add(t);
                }
            }
            above.push(type);
            for (var c : node.path("Plans")) walk[0].accept(c);
            above.pop();
        };
        for (var root : DbTestSupport.JSON.readTree(plan)) walk[0].accept(root.path("Plan"));
        return out;
    }

    @Test
    void theDrillDownListUsesTheJobIndexNotABackwardScanOfTheWholeTable() {
        PlanCapture plans = new PlanCapture(DbTestSupport.apiDataSource(), "FROM ingest_run", PlanCapture.Mode.GENERIC);
        IngestRunRepository repo = new IngestRunRepository(JdbcClient.create(plans.dataSource()));
        Instant since = Instant.now().minus(Duration.ofHours(24));

        // 검사 도구 자체: 안쪽 마디의 순차 스캔도 찾는다
        assertThat(seqScansOfIngestRun("[{\"Plan\":{\"Node Type\":\"Limit\",\"Plans\":[{\"Node Type\":\"Seq Scan\",\"Relation Name\":\"ingest_run\"}]}}]")).isEqualTo(1);
        var page = repo.runs(new IngestRunRepository.Filter("region", "adsb_fi", "error", since), null, 50);
        String plan = plans.last();
        // 창(started_at > since)을 인덱스 조건으로 좁힌다(ingest_run_started 또는 ingest_run_job) — 기본 키 역순으로 표 전체를 훑지 않는다
        assertThat(seqScansOfIngestRun(plan)).as("drill-down plan: %s", plan).isZero();
        assertThat(plan).as("drill-down plan: %s", plan).doesNotContain("\"Index Name\": \"ingest_run_pkey\"");
        assertThat(plan).containsAnyOf("\"Index Name\": \"ingest_run_started\"", "\"Index Name\": \"ingest_run_job\"").contains("\"Index Cond\"");
        // 24 h ≈ 6,646행 중 g % 1000 = 0 이고 region · adsb_fi 인 것(g % 10 = 0 이 region · adsb_fi — 1000 의 배수는 모두 그렇다)
        assertThat(page.items()).isNotEmpty().allSatisfy(r -> {
            assertThat(r).containsEntry("job", "region").containsEntry("provider", "adsb_fi").containsEntry("status", "error");
            assertThat(String.valueOf(r.get("error_text"))).startsWith("HTTP 502");
        });
        assertThat(page.nextCursor()).isNull();

        // 커서 쪽 · since 없는 목록(전과 같은 모양)
        var first = repo.runs(new IngestRunRepository.Filter("region", "adsb_fi", "error", null), null, 20);
        assertThat(first.items()).hasSize(20);
        var second = repo.runs(new IngestRunRepository.Filter("region", "adsb_fi", "error", null), first.nextCursor(), 20);
        assertThat(second.items()).extracting(r -> ((Number) r.get("id")).longValue()).allSatisfy(id -> assertThat(id).isLessThan(first.nextCursor()));
    }

    @Test
    void theSummaryScansOnlyTheLast24HoursAndPicksTheNewestRunsText() {
        PlanCapture plans = new PlanCapture(DbTestSupport.apiDataSource(), "hidden_n", PlanCapture.Mode.GENERIC);
        IngestRunRepository repo = new IngestRunRepository(JdbcClient.create(plans.dataSource()));
        // 트랜잭션 없이 부른다: PlanCapture 의 대리 DataSource 는 equals 를 원래 DataSource 에 넘겨, 트랜잭션에 묶인 원래 연결을 쓰면 계획을 잡지 못한다
        // (운영에서는 OpsController 가 한 트랜잭션으로 부른다 — 창의 시작과 요약이 같은 now(), OpsRunsIT)
        var s = repo.summary(false);
        String plan = plans.last();
        // 창은 문장 안의 now() 식이라 일반 계획도 창의 크기를 안다 — 24 h 만 인덱스로(표 전체를 훑지 않는다)
        assertThat(plan).as("summary plan: %s", plan).contains("\"Index Name\": \"ingest_run_started\"");
        assertThat(seqScansOfIngestRun(plan)).as("summary plan: %s", plan).isZero();
        // 리뷰 2026-10-01: 가장 최근 실행을 row_number() 창 함수로 고르면 창의 모든 행(ok 포함)을 글자 키로 정렬해 요약이 약 5배 느렸다(15 s 마다 부른다) —
        // 한 번의 묶음(HashAggregate)에서 고르고 그 id 로 한 행씩 읽는다. 창의 행을 정렬하는 마디가 없어야 한다
        assertThat(sortsOfTheWindowRows("[{\"Plan\":{\"Node Type\":\"Aggregate\",\"Plans\":[{\"Node Type\":\"WindowAgg\",\"Plans\":[{\"Node Type\":\"Sort\","
                + "\"Plans\":[{\"Node Type\":\"Index Scan\",\"Index Name\":\"ingest_run_started\"}]}]}]}}]")).as("the checker itself").containsExactly("Sort", "WindowAgg");
        assertThat(sortsOfTheWindowRows(plan)).as("summary plan: %s", plan).isEmpty();
        assertThat(Duration.between(s.since(), Instant.now().minus(Duration.ofHours(24))).abs()).isLessThan(Duration.ofMinutes(1));
        Map<String, Object> err = s.rows().stream().filter(r -> "region".equals(r.get("job")) && "error".equals(r.get("status"))).findFirst().orElseThrow();
        // 가장 최근 error 는 g = 1000(가장 작은 g 가 가장 최근)
        assertThat(err).containsEntry("last_error_text", "HTTP 502 — Bad Gateway 1000").containsEntry("last_http_status", 502);
        Map<String, Object> budget = s.rows().stream().filter(r -> "budget_exhausted".equals(r.get("status"))).findFirst().orElseThrow();
        assertThat(budget).containsEntry("last_http_status", 200); // 이 시험 자료는 budget_exhausted 에도 200 을 넣었다 — ok 가 아닌 행은 고른다
        // ok 행은 고르지 않는다(오류가 아니다 — 고르려면 창의 ok 행도 모두 따져야 한다): 두 키 모두 null(OpsController 가 JSON null 로 싣는다)
        List<Map<String, Object>> ok = s.rows().stream().filter(r -> "ok".equals(r.get("status"))).toList();
        assertThat(ok).isNotEmpty().allSatisfy(r -> {
            assertThat(r.get("last_error_text")).isNull();
            assertThat(r.get("last_http_status")).isNull();
        });
    }
}
