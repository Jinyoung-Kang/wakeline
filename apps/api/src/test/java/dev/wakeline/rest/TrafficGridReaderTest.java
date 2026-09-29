package dev.wakeline.rest;

import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import org.junit.jupiter.api.Test;
import org.springframework.data.redis.RedisConnectionFailureException;
import org.springframework.mock.web.MockHttpServletRequest;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.json.JsonMapper;

import java.time.Instant;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 연안 교통량(ADR-023): 수집기 스냅샷 wakeline:traffic_grid 와 heartbeat 로 공개 /traffic/grid 상태를 정한다 — 검증(R-72: 틀린 값은 쓰지 않고 센다),
 * 오래됨(regDt 15분 초과 → 칸 없음), 꺼짐(신선한 heartbeat 의 state), 5 s 메모 · 같은 원문은 다시 해석하지 않음, ETag(내용 · 상태).
 * Redis 는 가짜 — 값은 합성.
 */
class TrafficGridReaderTest {
    static final ObjectMapper JSON = JsonMapper.builder().build();
    static final Instant REG = Instant.parse("2026-09-29T09:05:05Z");

    final AtomicLong clock = new AtomicLong(REG.plusSeconds(70).toEpochMilli());
    final Map<Object, Object> hb = new HashMap<>();
    final AtomicInteger gets = new AtomicInteger();
    final SimpleMeterRegistry meters = new SimpleMeterRegistry();
    volatile String raw;
    volatile boolean down;
    final TrafficGridReader reader = new TrafficGridReader(() -> {
        gets.incrementAndGet();
        if (down) throw new RedisConnectionFailureException("down");
        return raw;
    }, () -> hb, JSON, clock::get, meters);

    static String snapshot(String cells, String over) {
        return ("{\"v\":1,\"reg_dt_kst\":\"2026-09-29T18:05:05+09:00\",\"reg_dt_utc\":\"2026-09-29T09:05:05Z\",\"fetched_at\":\"2026-09-29T09:06:01.250Z\","
                + "\"total\":3,\"total_count\":3,\"partial\":false,\"rejected\":0,\"resolved\":2,\"unresolved\":1,\"pending\":1,\"not_found\":0,\"off_grid\":0,\"failed\":0,"
                + "\"cell_deg\":0.025,\"cells\":" + cells + over + "}");
    }

    static final String CELLS = "[[\"GR4_F2K41_C3\",37.45,126.6,12,34.0],[\"GR4_F2K41_D3\",37.425,126.6,102,100.0]]";

    double errors(String field) {
        var c = meters.find("wakeline_traffic_grid_parse_errors_total").tag("field", field).counter();
        return c == null ? 0 : c.count();
    }

    @Test
    void validSnapshotIsAvailableWithVerifiedCells() {
        raw = snapshot(CELLS, "");
        TrafficGridReader.View v = reader.read();
        assertThat(v.status()).isEqualTo("ok");
        assertThat(v.available()).isTrue();
        assertThat(v.parsed().cells()).containsExactly(List.of("GR4_F2K41_C3", 37.45, 126.6, 12, 34.0), List.of("GR4_F2K41_D3", 37.425, 126.6, 102, 100.0));
        assertThat(v.parsed().counts()).containsEntry("resolved", 2).containsEntry("unresolved", 1).containsEntry("pending", 1).containsEntry("partial", false);
        assertThat(v.etag()).matches("^\"t[0-9a-f]{16}\"$");
        Map<String, Object> body = TrafficGridController.body(v, new MockHttpServletRequest(), REG.plusSeconds(70));
        assertThat(body).containsEntry("available", true).containsEntry("status", "ok").containsEntry("reg_dt_kst", "2026-09-29T18:05:05+09:00")
                .containsEntry("reg_dt_utc", REG).containsEntry("age_s", 70L).containsEntry("cell_deg", 0.025).containsEntry("invalid_cells", 0)
                .containsEntry("source", TrafficGridReader.SOURCE);
        assertThat(TrafficGridReader.SOURCE).containsEntry("provider", "한국해양교통안전공단 MTIS 실시간 해양교통정보")
                .containsEntry("grid", "해양수산부 해양격자 4단계").containsEntry("note", "5분 집계 — 격자별 선박 척수(개별 위치 아님)");
    }

    @Test
    void staleSnapshotServesNoCellsAndChangesTheEtag() {
        raw = snapshot(CELLS, "");
        String fresh = reader.read().etag();
        clock.set(REG.plusSeconds(TrafficGridReader.STALE_AFTER_S + 1).toEpochMilli());
        TrafficGridReader.View v = reader.read();
        assertThat(v.status()).isEqualTo("stale");
        assertThat(v.etag()).isNotEqualTo(fresh).endsWith("-s\"");
        Map<String, Object> body = TrafficGridController.body(v, new MockHttpServletRequest(), REG.plusSeconds(TrafficGridReader.STALE_AFTER_S + 1));
        assertThat(body).containsEntry("available", false).containsEntry("cells", List.of()).containsEntry("reg_dt_utc", REG);
    }

    @Test
    void disabledStateNeedsAFreshHeartbeat() {
        raw = snapshot(CELLS, "");
        hb.put("traffic_grid_state", "no_key");
        hb.put("traffic_grid_at", REG.plusSeconds(60).toString());
        TrafficGridReader.View v = reader.read();
        assertThat(v.status()).isEqualTo("disabled");
        assertThat(v.disabledReason()).isEqualTo("no_key");
        assertThat(v.etag()).isEqualTo("\"td-no_key\"");
        // 수집기 heartbeat 가 오래되면(멈춤) 그 state 는 지금 값이 아니다 — 스냅샷으로 판단
        hb.put("traffic_grid_at", REG.minusSeconds(600).toString());
        clock.addAndGet(TrafficGridReader.MEMO_MS);
        assertThat(reader.read().status()).isEqualTo("ok");
        for (String s : List.of("fixture", "operator_off")) {
            hb.put("traffic_grid_state", s);
            hb.put("traffic_grid_at", Instant.ofEpochMilli(clock.get()).toString());
            clock.addAndGet(TrafficGridReader.MEMO_MS);
            assertThat(reader.read().disabledReason()).isEqualTo(s);
        }
        hb.put("traffic_grid_state", "active");
        clock.addAndGet(TrafficGridReader.MEMO_MS);
        assertThat(reader.read().status()).isEqualTo("ok");
    }

    @Test
    void missingSnapshotOrRedisFailureIsNoData() {
        TrafficGridReader.View v = reader.read();
        assertThat(v.status()).isEqualTo("no_data");
        assertThat(TrafficGridController.body(v, new MockHttpServletRequest(), REG)).containsEntry("available", false)
                .containsEntry("reg_dt_utc", null).containsEntry("total", null).containsEntry("cells", List.of());
        raw = snapshot(CELLS, "");
        down = true;
        clock.addAndGet(TrafficGridReader.MEMO_MS);
        assertThat(reader.read().status()).isEqualTo("no_data");
    }

    @Test
    void readsAreMemoizedAndTheSameRawIsNotReparsed() {
        raw = snapshot(CELLS, "");
        TrafficGridReader.View a = reader.read();
        reader.read();
        assertThat(gets.get()).isEqualTo(1);
        clock.addAndGet(TrafficGridReader.MEMO_MS);
        TrafficGridReader.View b = reader.read();
        assertThat(gets.get()).isEqualTo(2);
        assertThat(b.parsed()).isSameAs(a.parsed());
        assertThat(b.etag()).isEqualTo(a.etag());
        raw = snapshot(CELLS.replace(",12,", ",13,"), "");
        clock.addAndGet(TrafficGridReader.MEMO_MS);
        assertThat(reader.read().etag()).isNotEqualTo(a.etag());
        clock.set(0); // 시계가 뒤로 가도 다시 읽는다
        reader.read();
        assertThat(gets.get()).isEqualTo(4);
    }

    @Test
    void malformedSnapshotsAreInvalidAndCounted() {
        String[][] bad = {
                {"not json", "json"},
                {snapshot(CELLS, "").replace("\"v\":1", "\"v\":2"), "version"},
                {snapshot(CELLS, "").replace("18:05:05+09:00", "18:05:05+00:00"), "reg_dt"},
                {snapshot(CELLS, "").replace("\"fetched_at\":\"2026-09-29T09:06:01.250Z\"", "\"fetched_at\":\"soon\""), "fetched_at"},
                {snapshot(CELLS, "").replace("\"cell_deg\":0.025", "\"cell_deg\":0.05"), "cell_deg"},
                {snapshot(CELLS, "").replace("\"resolved\":2", "\"resolved\":-2"), "resolved"},
                {snapshot(CELLS, "").replace("\"unresolved\":1", "\"unresolved\":2"), "counts"},
                {snapshot(CELLS, "").replace("\"failed\":0,", ""), "failed"},
                {snapshot(CELLS, "").replace("\"failed\":0", "\"failed\":1"), "counts"},
                {snapshot(CELLS, "").replace("\"total_count\":3", "\"total_count\":\"3\""), "total_count"},
                {snapshot(CELLS, "").replace("\"partial\":false", "\"partial\":\"no\""), "partial"},
                {snapshot("[]", ""), "cells"},
        };
        for (String[] b : bad) {
            raw = b[0];
            clock.addAndGet(TrafficGridReader.MEMO_MS);
            TrafficGridReader.View v = reader.read();
            assertThat(v.status()).as(b[1]).isEqualTo("invalid");
            assertThat(v.available()).isFalse();
            assertThat(errors(b[1])).as(b[1]).isGreaterThanOrEqualTo(1);
        }
        assertThat(TrafficGridController.body(reader.read(), new MockHttpServletRequest(), REG)).containsEntry("cells", List.of());
    }

    @Test
    void failedLookupsAreTheirOwnCountAndAddUpWithTheOthers() {
        // 위치 조회가 거듭 실패해 잠시 묻지 않는 칸(failed)은 확인 중(pending)과 따로 — 합이 미해석과 같아야 한다
        raw = snapshot(CELLS, "").replace("\"pending\":1", "\"pending\":0").replace("\"failed\":0", "\"failed\":1");
        TrafficGridReader.View v = reader.read();
        assertThat(v.status()).isEqualTo("ok");
        assertThat(v.parsed().counts()).containsEntry("pending", 0).containsEntry("failed", 1);
        assertThat(TrafficGridController.body(v, new MockHttpServletRequest(), REG.plusSeconds(70))).containsEntry("failed", 1);
    }

    @Test
    void aRegDtFromTheFutureIsInvalidNotOk() {
        // 수집기가 막지만 api 도 믿지 않는다(R-72): 지금보다 FUTURE_SKEW_S 넘게 앞선 regDt 는 invalid — 칸 없음, 나이 0 으로 '신선'하게 보이지 않는다
        raw = snapshot(CELLS, "");
        clock.set(REG.minusSeconds(TrafficGridReader.FUTURE_SKEW_S + 1).toEpochMilli());
        TrafficGridReader.View v = reader.read();
        assertThat(v.status()).isEqualTo("invalid");
        assertThat(v.available()).isFalse();
        assertThat(v.etag()).isEqualTo("\"ti\"");
        Map<String, Object> body = TrafficGridController.body(v, new MockHttpServletRequest(), Instant.ofEpochMilli(clock.get()));
        assertThat(body).containsEntry("cells", List.of()).containsEntry("reg_dt_utc", null).containsEntry("age_s", null);
        reader.read();
        clock.addAndGet(TrafficGridReader.MEMO_MS);
        reader.read();
        assertThat(errors("reg_dt_future")).as("같은 원문은 한 번만 센다").isEqualTo(1);
        // 시계 차이(FUTURE_SKEW_S 안)는 받는다
        clock.set(REG.minusSeconds(TrafficGridReader.FUTURE_SKEW_S - 10).toEpochMilli());
        assertThat(reader.read().status()).isEqualTo("ok");
    }

    @Test
    void invalidCellsAreDroppedAndCountedNotInvented() {
        String cells = "[[\"GR4_OK\",37.45,126.6,12,34.0],[\"GR4 BAD\",37.45,126.6,1,1],[\"GR4_OFF\",37.4512,126.6,1,1],[\"GR4_NEG\",37.45,126.6,-1,1],"
                + "[\"GR4_PCT\",37.45,126.6,1,100.5],[\"GR4_SHORT\",37.45,126.6,1],\"x\",[\"GR4_LAT\",90.0,126.6,1,1]]";
        raw = snapshot(cells, "").replace("\"total\":3", "\"total\":9").replace("\"resolved\":2", "\"resolved\":8");
        TrafficGridReader.View v = reader.read();
        assertThat(v.status()).isEqualTo("ok");
        assertThat(v.parsed().cells()).containsExactly(List.of("GR4_OK", 37.45, 126.6, 12, 34.0));
        assertThat(v.parsed().invalidCells()).isEqualTo(7);
        assertThat(errors("cell")).isEqualTo(7);
    }

    @Test
    void latticeCheckMatchesTheCollector() {
        assertThat(TrafficGridReader.onLattice(37.475)).isTrue();
        assertThat(TrafficGridReader.onLattice(37.4750000009)).isTrue();
        assertThat(TrafficGridReader.onLattice(37.475002)).isFalse();
        assertThat(TrafficGridReader.onLattice(Double.NaN)).isFalse();
        assertThat(TrafficGridReader.kstOf("2026-09-29T18:05:05+09:00", REG)).isTrue();
        assertThat(TrafficGridReader.kstOf("2026-09-29T18:05:05", REG)).isFalse();
        assertThat(TrafficGridReader.kstOf("2026-09-29T09:05:05Z", REG)).isFalse();
    }
}
