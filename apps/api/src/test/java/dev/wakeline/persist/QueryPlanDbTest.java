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
     * R-51: 항공기 검색(hex·등록부호 앞부분 일치)이 aircraft 표 전체를 순차 스캔했다(표는 보존 없이 커진다). 앞부분 인덱스로 찾는다 —
     * 같은 연결에서 여러 번 실행된 뒤의 일반 계획에서도(LIKE 파라미터는 일반 계획에서 인덱스를 못 쓴다).
     */
    @Test
    void aircraftSearchUsesPrefixIndexesAlsoInTheGenericPlan() {
        admin.sql("""
                INSERT INTO aircraft (hex, registration, type_code, source, first_seen, last_seen)
                SELECT lpad(to_hex(g), 6, '0'), 'N' || g, 'B738', 'fixture', now() - interval '2 days', now() - (g * interval '1 second')
                FROM generate_series(1, 20000) g""").update();
        admin.sql("""
                INSERT INTO aircraft (hex, registration, type_code, source, first_seen, last_seen) VALUES
                  ('71c001', 'HL8001', 'B77W', 'fixture', now(), now()), ('71c002', 'HL8002', 'A333', 'fixture', now(), now() - interval '1 minute'),
                  ('a1b2c3', 'HL7777', 'A321', 'fixture', now(), now()), ('71d000', NULL, NULL, 'fixture', now(), now())""").update();
        admin.sql("ANALYZE aircraft").update();
        PlanCapture plans = new PlanCapture(DbTestSupport.apiDataSource(), "FROM aircraft", PlanCapture.Mode.GENERIC);
        AircraftRepository repo = new AircraftRepository(JdbcClient.create(plans.dataSource()), DbTestSupport.JSON);

        var hl8 = repo.search("HL8", 20);
        String plan = plans.last();
        assertThat(plan).as("search plan: %s", plan).doesNotContain("\"Node Type\": \"Seq Scan\"");
        assertThat(plan).contains("\"Index Name\": \"aircraft_registration_prefix\"").contains("\"Index Name\": \"aircraft_hex_prefix\"");
        assertThat(hl8).extracting(r -> r.get("registration")).containsExactly("HL8001", "HL8002"); // last_seen 최신순
        assertThat(repo.search("71C", 20)).extracting(r -> String.valueOf(r.get("hex")).trim()).containsExactlyInAnyOrder("71c001", "71c002");
        assertThat(repo.search("71", 20)).extracting(r -> String.valueOf(r.get("hex")).trim()).contains("71c001", "71c002", "71d000");
        assertThat(repo.search("ZZZZ", 20)).isEmpty();
        assertThat(repo.search("N1999", 20)).extracting(r -> r.get("registration")).contains("N1999", "N19990", "N19999").doesNotContain("N2000");
    }

    /**
     * 계약 v5 §B1: 선박 검색(ship 표는 보존 없이 커진다)이 조건마다 인덱스를 쓴다 — 선명·호출부호 앞부분은 V10 의 text_pattern_ops 식 인덱스 둘(BitmapOr),
     * IMO 는 V10 ship_imo, MMSI 정확·앞부분은 기본 키. 같은 연결에서 여러 번 실행된 뒤의 일반 계획에서도(파라미터 그대로).
     */
    @Test
    void shipSearchUsesIndexesAlsoInTheGenericPlan() {
        // 20,000행: 선명 'SHIP n' · 호출부호 'CSn' · IMO 9000000+n, 1,000행마다 정적 정보 없음(위치로만 만든 행)
        admin.sql("""
                INSERT INTO ship (mmsi, name, call_sign, imo, ship_type, first_seen, last_seen, updated_at, provider)
                SELECT lpad((200000000 + g)::text, 9, '0'), CASE WHEN g % 1000 = 0 THEN NULL ELSE 'SHIP ' || g END,
                       CASE WHEN g % 1000 = 0 THEN NULL ELSE 'CS' || g END, CASE WHEN g % 1000 = 0 THEN NULL ELSE 9000000 + g END, 70,
                       now() - interval '2 days', now() - (g * interval '1 second'), CASE WHEN g % 1000 = 0 THEN NULL ELSE now() - interval '1 day' END, 'fixture'
                FROM generate_series(1, 20000) g""").update();
        admin.sql("""
                INSERT INTO ship (mmsi, name, call_sign, imo, ship_type, first_seen, last_seen, updated_at, provider) VALUES
                  ('440100001', 'HANJIN BUSAN', 'D7HB', 9321483, 70, now() - interval '3 days', now() - interval '1 hour', now(), 'fixture'),
                  ('440100002', 'HANJIN', 'D7HJ', NULL, 80, now() - interval '3 days', now() - interval '2 hours', now(), 'fixture'),
                  ('440100003', 'hanjin lower', NULL, NULL, 30, now() - interval '3 days', now(), now(), 'fixture'),
                  ('563000004', 'SG STAR', 'HANJ1', 4400000, 60, now() - interval '3 days', now(), now(), 'fixture')""").update();
        admin.sql("ANALYZE ship").update();
        PlanCapture plans = new PlanCapture(DbTestSupport.apiDataSource(), "FROM ship s WHERE", PlanCapture.Mode.GENERIC);
        ShipRepository repo = new ShipRepository(null, JdbcClient.create(plans.dataSource()));
        java.util.function.Function<String, java.util.List<String>> mmsis = q -> repo.search(dev.wakeline.domain.ShipQuery.parse(q), 20).stream()
                .map(ShipRepository.SearchRow::mmsi).toList();

        // 선명·호출부호 앞부분(대소문자 무시): 정확 일치(HANJIN) → last_seen 최신 순, 호출부호 HANJ1 도
        assertThat(mmsis.apply("hanjin")).containsExactly("440100002", "440100003", "440100001");
        String text = plans.last();
        assertThat(text).as("text plan: %s", text).doesNotContain("\"Node Type\": \"Seq Scan\"");
        assertThat(text).contains("\"Index Name\": \"ship_name_prefix\"").contains("\"Index Name\": \"ship_call_sign_prefix\"");
        // 같은 last_seen(한 문장의 now())은 MMSI 순
        assertThat(mmsis.apply("HANJ")).containsExactly("440100003", "563000004", "440100001", "440100002");
        assertThat(mmsis.apply("SHIP 1999")).containsExactly("200001999", "200019990", "200019991", "200019992", "200019993", "200019994",
                "200019995", "200019996", "200019997", "200019998", "200019999");
        assertThat(mmsis.apply("ZZZZ")).isEmpty();

        assertThat(mmsis.apply("IMO 9321483")).containsExactly("440100001");
        String imo = plans.last();
        assertThat(imo).as("imo plan: %s", imo).doesNotContain("\"Node Type\": \"Seq Scan\"").contains("\"Index Name\": \"ship_imo\"");

        assertThat(mmsis.apply("440100002")).containsExactly("440100002");
        assertThat(plans.last()).contains("\"Index Name\": \"ship_pkey\"").doesNotContain("\"Node Type\": \"Seq Scan\"");
        assertThat(mmsis.apply("4401")).containsExactly("440100003", "440100001", "440100002");
        String prefix = plans.last();
        assertThat(prefix).as("mmsi prefix plan: %s", prefix).contains("\"Index Name\": \"ship_pkey\"").doesNotContain("\"Node Type\": \"Seq Scan\"");
        // 7자리: IMO 4400000 정확(먼저) + MMSI 4400000.. 앞부분(없음)
        assertThat(mmsis.apply("4400000")).containsExactly("563000004");
        String seven = plans.last();
        assertThat(seven).as("7-digit plan: %s", seven).contains("\"Index Name\": \"ship_imo\"").contains("\"Index Name\": \"ship_pkey\"")
                .doesNotContain("\"Node Type\": \"Seq Scan\"");
        assertThat(mmsis.apply("2000")).as("MMSI prefix 2000xxxxx").hasSize(20).startsWith("200000001", "200000002");
    }

    /**
     * 계약 v5 §B1: 검색 결과의 저장 정적 정보 + 마지막 저장 위치 시각(한 문장). 행이 없는 MMSI 는 결과에 없고, 위치로만 만든 행은 정적 정보 null.
     * 마지막 위치 시각은 MMSI 마다 기본 키 역순 한 행(파티션 전체를 훑지 않는다).
     */
    @Test
    void shipLookupReturnsStoredStaticAndLastPositionPerMmsi() {
        // 계획이 인덱스를 고를 만큼: ship 20,000행 · 위치 200척 × 60분
        admin.sql("""
                INSERT INTO ship (mmsi, name, first_seen, last_seen, updated_at, provider)
                SELECT lpad((200000000 + g)::text, 9, '0'), 'SHIP ' || g, now() - interval '2 days', now(), now(), 'fixture'
                FROM generate_series(1, 20000) g""").update();
        admin.sql("""
                INSERT INTO ship_position (mmsi, ts, geom, position_source, provider)
                SELECT lpad((200000000 + g)::text, 9, '0'), date_trunc('minute', now()) - m * interval '1 minute', ST_SetSRID(ST_MakePoint(129, 35), 4326),
                       'epfs', 'fixture'
                FROM generate_series(1, 200) g, generate_series(0, 59) m""").update();
        admin.sql("""
                INSERT INTO ship (mmsi, name, call_sign, imo, ship_type, first_seen, last_seen, updated_at, provider) VALUES
                  ('440100001', 'HANJIN BUSAN', 'D7HB', 9321483, 70, now(), now(), now(), 'fixture'),
                  ('440100005', NULL, NULL, NULL, NULL, now(), now(), NULL, 'fixture')""").update();
        admin.sql("""
                INSERT INTO ship_position (mmsi, ts, geom, position_source, provider)
                SELECT '440100001', date_trunc('minute', now()) - g * interval '1 minute', ST_SetSRID(ST_MakePoint(129, 35), 4326), 'epfs', 'fixture'
                FROM generate_series(0, 120) g""").update();
        admin.sql("""
                INSERT INTO ship_position (mmsi, ts, geom, position_source, provider)
                VALUES ('440100005', date_trunc('minute', now()) - interval '3 hours', ST_SetSRID(ST_MakePoint(129, 35), 4326), NULL, 'fixture')""").update();
        admin.sql("ANALYZE ship").update();
        admin.sql("ANALYZE ship_position").update();
        PlanCapture plans = new PlanCapture(DbTestSupport.apiDataSource(), "unnest(string_to_array", PlanCapture.Mode.GENERIC);
        ShipRepository repo = new ShipRepository(null, JdbcClient.create(plans.dataSource()));
        var known = repo.lookup(java.util.List.of("440100001", "440100005", "440199999"));
        assertThat(known.keySet()).containsExactlyInAnyOrder("440100001", "440100005");
        assertThat(known.get("440100001").stat().name()).isEqualTo("HANJIN BUSAN");
        assertThat(known.get("440100001").lastPositionAt()).isEqualTo(Instant.now().truncatedTo(ChronoUnit.MINUTES));
        assertThat(known.get("440100005").stat()).as("row made from positions only").isNull();
        assertThat(known.get("440100005").lastPositionAt()).isEqualTo(Instant.now().truncatedTo(ChronoUnit.MINUTES).minus(3, ChronoUnit.HOURS));
        String plan = plans.last();
        assertThat(plan).as("lookup plan: %s", plan).doesNotContain("\"Node Type\": \"Seq Scan\"").contains("ship_position_");
        assertThat(repo.lookup(java.util.List.of())).isEmpty();
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
