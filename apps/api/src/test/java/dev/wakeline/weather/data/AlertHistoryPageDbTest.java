package dev.wakeline.weather.data;

import dev.wakeline.DbTestSupport;
import dev.wakeline.platform.data.OrderedWriter;
import dev.wakeline.platform.data.Sql;
import dev.wakeline.weather.core.SigmetStore;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIf;
import org.springframework.jdbc.core.simple.JdbcClient;

import java.time.Instant;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 알림 이력 쪽의 순서 · 커서(계약 v5 §G36 · QA-401): entered_at 최신순, 같은 시각은 id 역순. 커서는 앞 쪽 마지막 행의 id 이고, 다음 쪽은 그 행의
 * (entered_at, id) 뒤부터 — 같은 시각 묶음이 쪽 경계를 넘어도 빠짐 · 겹침이 없다. 없는 id 의 커서는 빈 쪽.
 * 자료는 id 순서를 일부러 시각 순서와 거꾸로 두어(예전의 id 역순 정렬이면 오래된 것부터 나온다) 정렬 열이 entered_at 인 것을 가른다.
 * 기대 순서는 넣은 행을 Java 에서 정렬해 만든다(저장소의 ORDER BY 를 베끼지 않는다).
 */
@EnabledIf("dev.wakeline.DbTestSupport#dockerAvailable")
class AlertHistoryPageDbTest {
    static final Instant T0 = Instant.parse("2026-09-15T00:00:00Z");
    static final Instant FROM = T0.minusSeconds(3600), TO = T0.plusSeconds(3 * 3600);
    /** 같은 시각(T0 + 20분 30초) 7행 — id 는 섞어서. */
    static final List<Long> TIE_A = List.of(5001L, 7007L, 5002L, 9009L, 5003L, 6006L, 5004L);
    static final Instant TIE_A_AT = T0.plusSeconds(20 * 60 + 30);
    /** hex b00001 의 같은 시각(T0 + 30분 30초) 4행 — 자연키(hex, sigmet, kind, entered_at)가 겹치지 않게 SIGMET · 종류를 바꾼다. */
    static final Instant TIE_B_AT = T0.plusSeconds(30 * 60 + 30);
    static final String HEX = "b00001";

    record Row(long id, Instant at, String hex) {}

    static AlertRepository repo;

    @BeforeAll
    static void seed() {
        DbTestSupport.reset();
        JdbcClient admin = DbTestSupport.admin();
        admin.sql("""
                INSERT INTO sigmet (id, fir_id, series_id, hazard, valid_from, valid_to, raw_text, provider, fetched_at)
                SELECT 'HP-S' || n, 'RKRR', n::text, 'TS', :f, :t, 'r', 'awc', :f FROM generate_series(1, 4) n""")
                .param("f", Sql.ts(T0.minusSeconds(86400))).param("t", Sql.ts(T0.plusSeconds(86400))).update();
        // 40행: 1분 간격, id 는 시각과 거꾸로(10,000 − g) · hex b00000..b00004 돌려 가며
        admin.sql("""
                INSERT INTO alert_event (id, hex, sigmet_id, kind, entered_at, evidence)
                SELECT 10000 - g, 'b0000' || (g % 5), 'HP-S1', 'OBSERVED', :t0 + g * interval '1 minute', '{"method":"observed_point_in_polygon"}'::jsonb
                FROM generate_series(1, 40) g""").param("t0", Sql.ts(T0)).update();
        for (int i = 0; i < TIE_A.size(); i++)
            admin.sql("""
                    INSERT INTO alert_event (id, hex, sigmet_id, kind, entered_at, evidence)
                    VALUES (:id, :hex, 'HP-S1', 'OBSERVED', :at, '{"method":"observed_point_in_polygon"}'::jsonb)""")
                    .param("id", TIE_A.get(i)).param("hex", "c0000" + (i + 1)).param("at", Sql.ts(TIE_A_AT)).update();
        admin.sql("""
                INSERT INTO alert_event (id, hex, sigmet_id, kind, entered_at, evidence) VALUES
                  (8100, :hex, 'HP-S1', 'OBSERVED', :at, '{"method":"observed_point_in_polygon"}'::jsonb),
                  (8300, :hex, 'HP-S2', 'OBSERVED', :at, '{"method":"observed_point_in_polygon"}'::jsonb),
                  (8200, :hex, 'HP-S3', 'PREDICTED', :at, '{"method":"predicted"}'::jsonb),
                  (8400, :hex, 'HP-S4', 'PREDICTED', :at, '{"method":"predicted"}'::jsonb)""")
                .param("hex", HEX).param("at", Sql.ts(TIE_B_AT)).update();
        admin.sql("ANALYZE alert_event").update();
        SimpleMeterRegistry meters = new SimpleMeterRegistry();
        OrderedWriter writer = new OrderedWriter(meters, 10, 20);
        JdbcClient db = DbTestSupport.apiClient();
        repo = new AlertRepository(db, DbTestSupport.JSON, new SigmetRepository(db, DbTestSupport.JSON, writer), new SigmetStore(), writer, meters);
    }

    /** 넣은 행 중 [from, to](양끝 포함) · hex 에 맞는 것의 id — entered_at 최신순, 같은 시각은 id 역순(Java 에서 정렬). */
    static List<Long> expected(Instant from, Instant to, String hex) {
        List<Row> rows = DbTestSupport.admin().sql("SELECT id, entered_at, hex FROM alert_event")
                .query((rs, i) -> new Row(rs.getLong(1), rs.getTimestamp(2).toInstant(), rs.getString(3))).list();
        return rows.stream().filter(r -> !r.at().isBefore(from) && !r.at().isAfter(to) && (hex == null || hex.equals(r.hex())))
                .sorted(Comparator.comparing(Row::at).thenComparingLong(Row::id).reversed()).map(Row::id).toList();
    }

    static List<Long> ids(AlertRepository.Page p) {
        return p.items().stream().map(m -> ((Number) m.get("id")).longValue()).toList();
    }

    /** next_cursor 를 끝까지 따라가며 모은 id. 쪽마다: limit 이하, next_cursor 는 그 쪽 마지막 행의 id(공개 계약 그대로). */
    static List<Long> walk(Instant from, Instant to, String hex, int limit) {
        List<Long> all = new ArrayList<>();
        Long cursor = null;
        for (int pages = 0; pages < 1000; pages++) {
            var page = repo.history(from, to, hex, cursor, limit);
            List<Long> got = ids(page);
            assertThat(got).as("limit %d 쪽 %d", limit, pages).hasSizeLessThanOrEqualTo(limit);
            all.addAll(got);
            if (page.nextCursor() == null) return all;
            assertThat(got).as("다음이 있으면 꽉 찬 쪽").hasSize(limit);
            assertThat(page.nextCursor()).as("next_cursor = 마지막 행의 id").isEqualTo(got.getLast());
            cursor = page.nextCursor();
        }
        throw new AssertionError("pages did not end");
    }

    @Test
    void pageIsNewestFirstByEnteredAtWithIdTieBreak() {
        List<Long> want = expected(FROM, TO, null);
        assertThat(want).hasSize(51);
        var page = repo.history(FROM, TO, null, null, 200);
        assertThat(ids(page)).containsExactlyElementsOf(want);
        assertThat(page.nextCursor()).isNull();
        // id 는 시각과 거꾸로라 예전의 id 역순이면 다른 순서다 — 이 시험이 정렬 열을 가른다
        assertThat(ids(page)).isNotEqualTo(want.stream().sorted(Comparator.reverseOrder()).toList());
        // 같은 시각 묶음 안은 id 역순, 그 앞은 더 늦은 시각(T0 + 21분), 뒤는 더 이른 시각(T0 + 20분)
        int i = ids(page).indexOf(9009L);
        assertThat(ids(page).subList(i, i + 7)).containsExactly(9009L, 7007L, 6006L, 5004L, 5003L, 5002L, 5001L);
        assertThat(page.items().get(i - 1).get("entered_at")).isEqualTo(T0.plusSeconds(21 * 60));
        assertThat(page.items().get(i + 7).get("entered_at")).isEqualTo(T0.plusSeconds(20 * 60));
        // hex 조건이 있어도 같은 순서(같은 시각 4행 포함)
        List<Long> hexWant = expected(FROM, TO, HEX);
        assertThat(hexWant).hasSize(12);
        assertThat(ids(repo.history(FROM, TO, HEX, null, 200))).containsExactlyElementsOf(hexWant);
        assertThat(ids(repo.history(FROM, TO, HEX, null, 200))).containsSubsequence(8400L, 8300L, 8200L, 8100L);
    }

    @Test
    void cursorPagesCoverEveryRowExactlyOnceEvenAcrossEqualTimes() {
        // 같은 시각 7행 묶음이 쪽 경계를 여러 번 넘는 크기들(1 · 2 · 3 · 5) · 묶음과 같은 크기(7) · 한 쪽(50 — 51행이라 둘째 쪽 1행)
        for (int limit : new int[]{1, 2, 3, 4, 5, 7, 50})
            assertThat(walk(FROM, TO, null, limit)).as("limit %d", limit).containsExactlyElementsOf(expected(FROM, TO, null));
        for (int limit : new int[]{1, 2, 3, 5})
            assertThat(walk(FROM, TO, HEX, limit)).as("hex · limit %d", limit).containsExactlyElementsOf(expected(FROM, TO, HEX));
        // 창이 같은 시각 한 점이면(양끝 포함) 그 묶음 7행만 — 쪽 넘김도 그 안에서
        assertThat(walk(TIE_A_AT, TIE_A_AT, null, 2)).containsExactly(9009L, 7007L, 6006L, 5004L, 5003L, 5002L, 5001L);
    }

    @Test
    void anUnknownCursorGivesAnEmptyPage() {
        // 커서는 앞 쪽 마지막 행의 id — 그 행이 없으면(보존 삭제로 지워짐 · 지어낸 값) 이을 자리를 모르므로 빈 쪽, next_cursor 없음
        for (String hex : new String[]{null, HEX}) {
            var page = repo.history(FROM, TO, hex, 123_456_789L, 50);
            assertThat(page.items()).as("hex %s", hex).isEmpty();
            assertThat(page.nextCursor()).isNull();
        }
        // 있는 id 는 그 행 뒤부터(같은 시각 묶음 가운데의 행이어도)
        List<Long> want = expected(FROM, TO, null);
        int i = want.indexOf(6006L);
        assertThat(ids(repo.history(FROM, TO, null, 6006L, 3))).containsExactlyElementsOf(want.subList(i + 1, i + 4));
        List<Map<String, Object>> last = repo.history(FROM, TO, null, want.getLast(), 50).items();
        assertThat(last).as("마지막 행 뒤는 빈 쪽").isEmpty();
    }
}
