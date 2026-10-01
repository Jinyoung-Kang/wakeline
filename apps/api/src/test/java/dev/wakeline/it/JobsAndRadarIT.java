package dev.wakeline.it;

import dev.wakeline.DbTestSupport;
import dev.wakeline.history.MaintenanceJobs;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIf;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import tools.jackson.databind.JsonNode;

import java.sql.Timestamp;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.time.temporal.ChronoUnit;
import java.util.Base64;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 앱이 스스로 도는 유지 작업(FR-17)과 기상청 레이더 목록(FR-31)을 실제 역할·실제 Redis ACL 로:
 * <ul>
 *   <li>파티션 생성·삭제·보존 삭제·1분 요약 따라잡기·일 통계를 앱의 빈(DML 전용 wakeline_api)으로 실행하고 결과(행·파티션)로 확인한다
 *       — 작업은 실패를 로그로만 남기므로 예외가 없다는 것만으로는 부족하다(VERIFICATION #16 회귀 방지).</li>
 *   <li>레이더 목록은 이미지가 아직 있는 프레임만 싣는다(REL-19). 키는 수집기 ACL 사용자로 쓴다.</li>
 * </ul>
 */
@EnabledIf("dev.wakeline.DbTestSupport#dockerAvailable")
class JobsAndRadarIT extends IntegrationTest {
    @Autowired MaintenanceJobs jobs;

    static JdbcClient as(String user, String pw) {
        return JdbcClient.create(new DriverManagerDataSource(DbTestSupport.jdbcUrl(ItStack.DB), user, pw));
    }

    static String partition(LocalDate d) { return "track_point_" + d.format(DateTimeFormatter.BASIC_ISO_DATE); }

    long exists(String table) { return count("SELECT count(*) FROM pg_class WHERE relname = ?", table); }

    void track(String hex, Instant ts, double lat, double lon) {
        db.sql("INSERT INTO track_point (hex, ts, geom, alt_ft, gs_kt, provider, fetched_at) VALUES (:h, :ts, ST_SetSRID(ST_MakePoint(:lon, :lat), 4326), 30000, 400, 'fixture', now()) ON CONFLICT DO NOTHING")
                .param("h", hex).param("ts", Timestamp.from(ts)).param("lon", lon).param("lat", lat).update();
    }

    @Test
    void maintenanceJobsWorkUnderTheDmlOnlyApiRole() {
        LocalDate today = LocalDate.now(ZoneOffset.UTC);
        String future = partition(today.plusDays(3));
        String old = partition(today.minusDays(10));
        JdbcClient migrator = as("wakeline_migrator", DbTestSupport.MIGRATOR_PW);
        migrator.sql("DROP TABLE IF EXISTS " + future).update();
        migrator.sql("CREATE TABLE IF NOT EXISTS " + old + " PARTITION OF track_point FOR VALUES FROM ('" + today.minusDays(10) + "') TO ('" + today.minusDays(9) + "')").update();

        // 수집기 테이블: 보존 기간 밖(지워질 것) + 안(남을 것) — 수집기 역할로 쓴다
        JdbcClient col = as("wakeline_collector", DbTestSupport.COLLECTOR_PW);
        col.sql("INSERT INTO airport (icao, geom) VALUES ('ZZOL', ST_SetSRID(ST_MakePoint(127, 37), 4326)) ON CONFLICT DO NOTHING").update();
        col.sql("INSERT INTO metar_obs (icao, obs_time, raw, provider, fetched_at) VALUES ('ZZOL', now() - interval '40 days', 'it-old', 'awc', now()), "
                + "('ZZOL', now() - interval '1 hour', 'it-new', 'awc', now()) ON CONFLICT DO NOTHING").update();
        col.sql("INSERT INTO radar_frame (frame_time, host, path, fetched_at) VALUES (now() - interval '8 days', 'h', '/it-old', now()), (now() - interval '1 hour', 'h', '/it-new', now()) ON CONFLICT DO NOTHING").update();
        col.sql("INSERT INTO ingest_run (job, provider, started_at, status) VALUES ('it_old', 'x', now() - interval '31 days', 'ok'), ('it_new', 'x', now(), 'ok')").update();
        col.sql("INSERT INTO quality_event (rule, created_at) VALUES ('it_old', now() - interval '31 days'), ('it_new', now())").update();
        col.sql("INSERT INTO quality_rule_count (day, rule, count) VALUES (CURRENT_DATE - 91, 'it_old', 1), (CURRENT_DATE, 'it_new', 1) ON CONFLICT DO NOTHING").update();
        db.sql("INSERT INTO track_point_1m (hex, ts_minute, geom, n) VALUES ('a1e0aa', date_trunc('minute', now() - interval '31 days'), ST_SetSRID(ST_MakePoint(127, 37), 4326), 1) ON CONFLICT DO NOTHING").update();

        jobs.ensurePartitions();
        assertThat(exists(future)).as("partition created by the api role (SECURITY DEFINER)").isEqualTo(1);

        jobs.dropOldPartitions();
        assertThat(exists(old)).as("expired partition dropped").isZero();
        assertThat(exists(partition(today))).isEqualTo(1);
        assertThat(count("SELECT count(*) FROM metar_obs WHERE raw LIKE 'it-%'")).isEqualTo(1);
        assertThat(count("SELECT count(*) FROM radar_frame WHERE path LIKE '/it-%'")).isEqualTo(1);
        assertThat(count("SELECT count(*) FROM ingest_run WHERE job LIKE 'it_%'")).isEqualTo(1);
        assertThat(count("SELECT count(*) FROM quality_event WHERE rule LIKE 'it_%'")).isEqualTo(1);
        assertThat(count("SELECT count(*) FROM quality_rule_count WHERE rule LIKE 'it_%'")).isEqualTo(1);
        assertThat(count("SELECT count(*) FROM track_point_1m WHERE hex = 'a1e0aa'")).isZero();

        // 1분 요약 따라잡기: 5시간 전(다른 테스트가 쓰지 않는 닫힌 시간)의 관심 지역 항적 2점 → 1행(n=2)
        Instant hour = Instant.now().truncatedTo(ChronoUnit.HOURS).minus(5, ChronoUnit.HOURS);
        track("a1e001", hour.plusSeconds(600), 37.0, 127.0);
        track("a1e001", hour.plusSeconds(620), 37.01, 127.01);
        track("a1e0bb", hour.plusSeconds(600), 51.5, -0.1); // 관심 지역 밖 — 요약하지 않는다
        jobs.catchUp();
        assertThat(db.sql("SELECT n FROM track_point_1m WHERE hex = 'a1e001' AND ts_minute = :m").param("m", Timestamp.from(hour.plusSeconds(600)))
                .query(Integer.class).single()).isEqualTo(2);
        assertThat(count("SELECT count(*) FROM track_point_1m WHERE hex = 'a1e0bb'")).isZero();

        // 일 통계(어제 — KST 날짜, 계약 v5 §G20): 관심 지역 안의 서로 다른 항공기 수 + 어느 지역을 셌는지. 시(dim)는 KST 시 —
        // 20:00 KST 는 그 KST 날짜의 11:00 UTC 라 운영 파티션(어제 · 오늘 UTC)에 든다
        LocalDate y = dev.wakeline.history.MaintenanceJobs.today().minusDays(1);
        Instant eightPm = y.atStartOfDay(dev.wakeline.history.MaintenanceJobs.DAY_ZONE).toInstant().plusSeconds(20 * 3600);
        track("a1e002", eightPm.plusSeconds(5), 36.0, 128.0);
        track("a1e003", eightPm.plusSeconds(65), 36.1, 128.1);
        jobs.aggregate(y);
        JsonNode traffic = get("/api/v1/stats/traffic?day=" + y).json();
        assertThat(traffic.path("scope").asString()).isEqualTo("region");
        assertThat(traffic.path("region").path("radius_nm").asInt()).isPositive();
        assertThat(traffic.path("day_zone").asString()).isEqualTo("Asia/Seoul");
        JsonNode twenty = null;
        for (JsonNode it : traffic.path("items")) if ("20".equals(it.path("dim").asString())) twenty = it;
        assertThat(twenty).as("KST hour 20 bucket").isNotNull();
        assertThat(twenty.path("value").asInt()).isGreaterThanOrEqualTo(2);
    }

    static final String PNG_1X1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

    @Test
    void kmaRadarListsOnlyFramesWhoseImageStillExists() {
        StringRedisTemplate col = ItStack.collector();
        String expired = "202609271200", live = "202609271210";
        String now = Instant.now().toString();
        try {
            col.opsForValue().set("wakeline:radar_kr:frame:" + live, PNG_1X1);
            col.opsForValue().set("wakeline:radar_kr:frames", """
                    [{"tm":"%s","obs_tm":"%s","fetched_at":"%s","echo_cells":12},{"tm":"bad-tm"},{"tm":"%s","obs_tm":"%s","fetched_at":"%s","echo_cells":34}]"""
                    .formatted(expired, expired, now, live, live, now));
            ItStack.hset(col, "wakeline:radar_kr:meta", Map.ofEntries(
                    Map.entry("available", "1"), Map.entry("status", "200"), Map.entry("note", ""), Map.entry("latest_tm", live),
                    Map.entry("product", "HSR"), Map.entry("cmp", "HSR"), Map.entry("coordinates", "[[121.8,39.9],[132.9,39.9],[132.9,31.6],[121.8,31.6]]"),
                    Map.entry("width", "640"), Map.entry("height", "480"), Map.entry("projection", "EPSG:3857"), Map.entry("grid", "{\"nx\":2305,\"ny\":2881}"),
                    Map.entry("legend", "[{\"dbz\":10,\"color\":\"#00c8ff\"}]"), Map.entry("min_dbz", "0.5"), Map.entry("stations", "KSN,GDK"),
                    Map.entry("fetched_at", now)));

            Res r = get("/api/v1/radar/kr");
            assertThat(r.status()).isEqualTo(200);
            assertThat(r.header("Cache-Control")).contains("public");
            JsonNode body = r.json();
            assertThat(body.path("available").asBoolean()).isTrue();
            assertThat(body.path("georeferenced").asBoolean()).isTrue();
            assertThat(body.path("frames").size()).as("expired image and malformed tm are not listed").isEqualTo(1);
            // 받은 시각이 영상 버전(ADR-021 — 다시 받아 바뀐 영상이 브라우저 캐시의 옛 영상으로 보이지 않게)
            assertThat(body.path("frames").get(0).path("url").asString()).isEqualTo("/api/v1/radar/kr/" + live + ".png?v=" + Instant.parse(now).toEpochMilli());
            assertThat(body.path("image_size").get(0).asInt()).isEqualTo(640);
            assertThat(body.path("coordinates").size()).isEqualTo(4);
            assertThat(get("/api/v1/radar/kr", headers("If-None-Match", r.header("ETag"))).status()).isEqualTo(304);

            Res png = get("/api/v1/radar/kr/" + live + ".png");
            assertThat(png.status()).isEqualTo(200);
            assertThat(png.header("Content-Type")).isEqualTo("image/png");
            assertProblem(get("/api/v1/radar/kr/" + expired + ".png"), 404, "NOT_FOUND", "/api/v1/radar/kr/" + expired + ".png");
            assertProblem(get("/api/v1/radar/kr/abc.png"), 400, "BAD_TM", "/api/v1/radar/kr/abc.png");

            // 이미지까지 만료되면: 목록이 비고, 쓸 수 있다고 말하지 않는다
            ItStack.admin().delete("wakeline:radar_kr:frame:" + live);
            JsonNode gone = get("/api/v1/radar/kr").json();
            assertThat(gone.path("available").asBoolean()).isFalse();
            assertThat(gone.path("georeferenced").asBoolean()).isFalse();
            assertThat(gone.path("frames").size()).isZero();
        } finally {
            ItStack.deleteKeys("wakeline:radar_kr:*");
        }
        assertThat(Base64.getDecoder().decode(PNG_1X1)).startsWith(new byte[]{(byte) 0x89, 'P', 'N', 'G'});
        assertThat(List.of(expired, live)).allMatch(t -> t.matches("^\\d{12}$"));
    }
}
