package dev.wakeline.persist;

import dev.wakeline.DbTestSupport;
import dev.wakeline.PlanCapture;
import dev.wakeline.ingest.SigmetStore;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIf;
import org.springframework.jdbc.core.simple.JdbcClient;

import java.time.Instant;
import java.time.temporal.ChronoUnit;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 조회 경로가 인덱스를 쓰는지(리뷰 v1 성능 항목) — 저장소가 실제로 보내는 SQL·파라미터 형 그대로의 실행 계획({@link PlanCapture})을 본다.
 * 표에는 계획이 인덱스를 고를 만큼의 행을 넣고 ANALYZE 한다.
 */
@EnabledIf("dev.wakeline.DbTestSupport#dockerAvailable")
class QueryPlanDbTest {
    JdbcClient admin;

    @BeforeEach
    void setUp() {
        DbTestSupport.reset();
        admin = DbTestSupport.admin();
    }

    /**
     * R-15: 알림 이력의 hex 필터. 한 문장이 (:hex IS NULL OR e.hex = :hex) 로 hex 유무를 모두 받으면, 같은 연결에서 몇 번 실행된 뒤 쓰이는
     * 일반 계획(plan cache)이 hex 인덱스를 쓸 수 없어 기본 키를 역순으로 표 전체를 훑었다(Rows Removed by Filter 47,695, idx_scan 0).
     * 이제 hex 가 있으면 hex 인덱스로 찾는다(일반 계획에서도).
     */
    @Test
    void alertHistoryHexFilterUsesAHexIndex() {
        admin.sql("""
                INSERT INTO sigmet (id, fir_id, series_id, hazard, valid_from, valid_to, raw_text, provider, fetched_at)
                VALUES ('S-PLAN', 'RKRR', '1', 'TS', now() - interval '30 days', now() + interval '1 day', 'r', 'awc', now())""").update();
        // 20,000행 · 2,000 hex(각 10행) · 최근 20일
        admin.sql("""
                INSERT INTO alert_event (id, hex, sigmet_id, kind, entered_at, left_at, evidence)
                SELECT g, lpad(to_hex(g % 2000), 6, '0'), 'S-PLAN', 'OBSERVED', now() - (g * interval '86 seconds'), now() - (g * interval '86 seconds') + interval '5 minutes',
                       '{"method":"observed_point_in_polygon"}'::jsonb
                FROM generate_series(1, 20000) g""").update();
        admin.sql("ANALYZE alert_event").update();
        admin.sql("ANALYZE sigmet").update();

        PlanCapture plans = new PlanCapture(DbTestSupport.apiDataSource(), "FROM alert_event e JOIN sigmet s", PlanCapture.Mode.GENERIC);
        SimpleMeterRegistry meters = new SimpleMeterRegistry();
        OrderedWriter writer = new OrderedWriter(meters, 10, 20);
        JdbcClient db = JdbcClient.create(plans.dataSource());
        AlertRepository repo = new AlertRepository(db, DbTestSupport.JSON, new SigmetRepository(db, DbTestSupport.JSON, writer), new SigmetStore(), writer, meters);

        Instant now = Instant.now();
        var page = repo.history(now.minus(30, ChronoUnit.DAYS), now, "0003e8", null, 50);
        String plan = plans.last();
        assertThat(plan).as("hex filter plan: %s", plan).contains("\"Index Name\": \"alert_event_hex");
        assertThat(plan).doesNotContain("\"Index Name\": \"alert_event_pkey\"");
        assertThat(page.items()).allSatisfy(r -> assertThat(String.valueOf(r.get("hex")).trim()).isEqualTo("0003e8"));
        assertThat(page.items()).hasSize(10);

        // 커서: 같은 hex 의 다음 페이지(id 역순) — 중복·누락 없이 끝난다
        var first = repo.history(now.minus(30, ChronoUnit.DAYS), now, "0003e8", null, 4);
        var second = repo.history(now.minus(30, ChronoUnit.DAYS), now, "0003e8", first.nextCursor(), 4);
        var third = repo.history(now.minus(30, ChronoUnit.DAYS), now, "0003e8", second.nextCursor(), 4);
        assertThat(third.nextCursor()).isNull();
        java.util.List<Object> ids = new java.util.ArrayList<>();
        for (var p : java.util.List.of(first, second, third)) for (var r : p.items()) ids.add(r.get("id"));
        assertThat(ids).hasSize(10).doesNotHaveDuplicates();

        // hex 없음: 같은 결과 모양(범위 안 전체, id 역순)
        var all = repo.history(now.minus(1, ChronoUnit.DAYS), now, null, null, 50);
        assertThat(all.items()).hasSize(50);
        assertThat(all.nextCursor()).isNotNull();
    }

    /**
     * R-27: 일 통계 traffic_by_hour(시간대별 서로 다른 항공기 수)의 정렬이 디스크로 넘쳤다(external merge, 임시 파일). 집계 트랜잭션이 스스로
     * work_mem 을 넉넉히 잡으므로 연결의 기본값(여기서는 일부러 최소 64 kB)과 상관없이 메모리에서 끝난다. 실제 문장을 EXPLAIN ANALYZE 로 본다.
     */
    @Test
    void dailyTrafficAggregationDoesNotSpillToDisk() {
        java.time.LocalDate day = java.time.LocalDate.now(java.time.ZoneOffset.UTC).minusDays(1);
        Instant d0 = day.atStartOfDay(java.time.ZoneOffset.UTC).toInstant();
        // 관심 지역 안 30,000점(3,000대 × 10점, 하루에 고르게)
        admin.sql("""
                INSERT INTO track_point (hex, ts, geom, alt_ft, provider, fetched_at)
                SELECT lpad(to_hex(g % 3000), 6, '0'), :d0 + (g * interval '2.8 seconds'), ST_SetSRID(ST_MakePoint(127.0 + (g % 100) * 0.01, 36.0), 4326),
                       30000, 'adsb_lol', :d0
                FROM generate_series(1, 30000) g ON CONFLICT DO NOTHING""").param("d0", Sql.ts(d0)).update();
        admin.sql("ANALYZE track_point").update();

        com.zaxxer.hikari.HikariConfig c = new com.zaxxer.hikari.HikariConfig();
        c.setJdbcUrl(DbTestSupport.jdbcUrl("wakeline"));
        c.setUsername("wakeline_api");
        c.setPassword(DbTestSupport.API_PW);
        c.setMaximumPoolSize(2);
        c.setConnectionInitSql("SET work_mem = '64kB'");
        try (com.zaxxer.hikari.HikariDataSource small = new com.zaxxer.hikari.HikariDataSource(c)) {
            PlanCapture plans = new PlanCapture(small, "'traffic_by_hour'", PlanCapture.Mode.ANALYZE);
            javax.sql.DataSource ds = plans.dataSource();
            JdbcClient db = JdbcClient.create(ds);
            var props = PersistDbTest.PROPS;
            var region = new dev.wakeline.ops.RegionSettings(new org.springframework.data.redis.core.StringRedisTemplate(), db, DbTestSupport.JSON, props);
            var tx = new org.springframework.transaction.support.TransactionTemplate(new org.springframework.jdbc.datasource.DataSourceTransactionManager(ds));
            new MaintenanceJobs(db, props, region, tx).aggregateDay(day);

            String plan = plans.last();
            assertThat(plan).as("traffic plan: %s", plan).doesNotContain("\"Sort Space Type\": \"Disk\"");
            assertThat(plan).doesNotContainPattern("\"Temp Written Blocks\": [1-9]");
        }
        assertThat(admin.sql("SELECT sum(value)::int FROM stats_daily WHERE day = :d AND metric = 'traffic_by_hour'").param("d", day)
                .query(Integer.class).single()).as("distinct aircraft per hour, summed").isPositive();
        assertThat(admin.sql("SELECT count(*) FROM stats_daily WHERE day = :d AND metric = 'traffic_by_hour'").param("d", day)
                .query(Long.class).single()).isEqualTo(24L);
    }
}
