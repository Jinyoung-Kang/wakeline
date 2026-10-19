package dev.wakeline.weather.web;

import dev.wakeline.aircraft.web.AircraftControllerTest;
import dev.wakeline.airspace.core.AirspaceEdition;
import dev.wakeline.airspace.core.AirspaceRecord;
import dev.wakeline.airspace.core.AirspaceStore;
import dev.wakeline.platform.web.ProblemAdvice;
import dev.wakeline.weather.core.Alert;
import dev.wakeline.weather.core.EngineService;
import dev.wakeline.weather.core.SigmetRecord;
import dev.wakeline.weather.core.SigmetStore;
import dev.wakeline.weather.data.AlertRepository;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.springframework.boot.test.system.CapturedOutput;
import org.springframework.boot.test.system.OutputCaptureExtension;
import org.springframework.dao.QueryTimeoutException;
import org.springframework.jdbc.BadSqlGrammarException;
import org.springframework.jdbc.CannotGetJdbcConnectionException;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

import java.sql.SQLException;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * 알림 한 건 — 근거 공유(계약 v5 §G51): 숫자가 아니면 400 · 없으면 404 · 열린 알림은 엔진에서(5 s) · 닫힌 알림은 DB 에서(300 s) · 구역 사본.
 * DB 장애: 열린 알림은 메모리 값으로 200(구역 사본도 메모리에서 — SigmetStore · 켜진 공역 차수, meta.db_unavailable), 닫힌 알림은 DB 가 원본이라 503.
 */
@ExtendWith(OutputCaptureExtension.class)
class AlertByIdEndpointTest {
    static final Instant T = Instant.parse("2026-10-09T10:00:00Z");
    final EngineService engine = mock(EngineService.class);
    final AlertRepository repo = mock(AlertRepository.class);
    final SigmetStore sigmets = new SigmetStore();
    final AirspaceStore airspaces = new AirspaceStore();
    final MockMvc mvc = MockMvcBuilders.standaloneSetup(new WeatherController(sigmets, engine, null, null, repo, null, null, null, null, airspaces))
            .setControllerAdvice(new ProblemAdvice()).build();

    static Alert sigmetAlert(long id, String sigmetId) {
        return new Alert(id, "OBSERVED", "71be01", "KAL081", sigmetId, "RKRR", "TS", null, T, null, null, null, null, 30000,
                Map.of("method", "observed_point_in_polygon"), false);
    }

    static Alert airspaceAlert(long id, long airspaceId) {
        Alert.Head head = new Alert.Head(null, null, null, null, "airspace", "alert", Map.of("id", airspaceId, "label", "RK R991", "edition", "AIP 25년 5차"));
        return Alert.of(id, "OBSERVED", "71be01", "KAL081", head, T, null, null, 15000, Map.of("method", "observed_point_in_polygon"), false);
    }

    static SigmetRecord sigmet(String id) {
        return new SigmetRecord(id, "RKRR", "INCHEON FIR", "RKSI", "1", "TS", "EMBD", 0, 40000, T.minusSeconds(600), T.plusSeconds(6600), null, null,
                null, null, null, "RKRR SIGMET 1 VALID 090950/091150 RKSI- EMBD TS OBS", "awc_isigmet", T, SigmetRecord.BASE_JSON, SigmetRecord.TOP_JSON);
    }

    static AirspaceRecord airspace(long id) {
        return new AirspaceRecord(id, "restricted", "비행제한구역", "시험", "Other", "RK R991", "시험 제한구역 B", null, null, "polygon",
                new AirspaceRecord.Limit(0, "SFC", "Surface"), new AirspaceRecord.Limit(18000, "FL", "180 Flight Level Altitude"), null, null);
    }

    static CannotGetJdbcConnectionException dbDown() { return new CannotGetJdbcConnectionException("Failed to obtain JDBC Connection"); }

    @Test
    void rejectsNonNumericIdsAndSaysWhenItIsGone() throws Exception {
        for (String bad : List.of("abc", "-1", "1e3", "12345678901234567890"))
            mvc.perform(get("/api/v1/alerts/" + bad)).andExpect(status().isBadRequest()).andExpect(jsonPath("$.code").value("BAD_ID"));
        when(engine.activeAlerts(null)).thenReturn(List.of());
        when(repo.byId(77)).thenReturn(null); // Mockito 는 Map 형에 빈 Map 을 돌려준다 — 저장소의 '없음'은 null
        mvc.perform(get("/api/v1/alerts/77")).andExpect(status().isNotFound()).andExpect(jsonPath("$.detail").value("alert not found — closed alerts are kept for 30 days"));
    }

    @Test
    void anOpenAlertComesFromTheEngineWithItsSigmetCopy() throws Exception {
        when(engine.activeAlerts(null)).thenReturn(List.of(sigmetAlert(77, "RKRR:S1")));
        when(repo.sigmetCopy("RKRR:S1")).thenReturn(Map.of("id", "RKRR:S1", "raw_text", "RKRR SIGMET 1 VALID …"));
        mvc.perform(get("/api/v1/alerts/77")).andExpect(status().isOk()).andExpect(header().string("Cache-Control", "max-age=5, public"))
                .andExpect(jsonPath("$.source").value("engine")).andExpect(jsonPath("$.alert.id").value(77)).andExpect(jsonPath("$.alert.hex").value("71be01"))
                .andExpect(jsonPath("$.sigmet.raw_text").value("RKRR SIGMET 1 VALID …")).andExpect(jsonPath("$.retention_days").value(30))
                .andExpect(jsonPath("$.meta.db_unavailable").doesNotExist());
        verify(repo, never()).byId(anyLong());
    }

    @Test
    void aClosedAirspaceAlertComesFromTheDbWithItsAirspaceCopy() throws Exception {
        when(engine.activeAlerts(null)).thenReturn(List.of());
        Map<String, Object> row = new LinkedHashMap<>();
        row.put("id", 78L); row.put("hex", "71be01"); row.put("kind", "OBSERVED"); row.put("left_at", Instant.parse("2026-10-09T10:05:00Z"));
        row.put("close_reason", "left"); row.put("zone_type", "airspace"); row.put("level", "alert"); row.put("airspace", Map.of("id", 5L, "label", "RK P73"));
        when(repo.byId(78)).thenReturn(row);
        when(repo.airspaceCopy(5)).thenReturn(Map.of("id", 5L, "lower_raw", "SFC", "upper_raw", "FL 180", "edition", "AIP 25년 5차"));
        mvc.perform(get("/api/v1/alerts/78")).andExpect(status().isOk()).andExpect(header().string("Cache-Control", "max-age=300, public"))
                .andExpect(jsonPath("$.source").value("db")).andExpect(jsonPath("$.alert.close_reason").value("left"))
                .andExpect(jsonPath("$.airspace.upper_raw").value("FL 180")).andExpect(jsonPath("$.sigmet").doesNotExist());
    }

    /**
     * 열린 알림은 엔진 메모리에 있다 — SIGMET 사본을 DB 에서 읽지 못해도(연결 · 허가 대기 · 3 s 한도) 503 이 아니라 200 + meta.db_unavailable, 사본은
     * SigmetStore 의 값(철회 시각은 저장소만 알아 없다). 다른 '실시간 값 + 저장소' 경로(항공기 · 선박 상세, /watch)와 같은 WARN 한 줄.
     */
    @Test
    void anOpenSigmetAlertIsAnsweredFromMemoryWhenItsCopyCannotBeRead(CapturedOutput out) throws Exception {
        when(engine.activeAlerts(null)).thenReturn(List.of(sigmetAlert(77, "RKRR:S1")));
        sigmets.replace(T, "awc", Map.of("RKRR:S1", sigmet("RKRR:S1")));
        when(repo.sigmetCopy("RKRR:S1")).thenThrow(dbDown());
        mvc.perform(get("/api/v1/alerts/77")).andExpect(status().isOk()).andExpect(header().string("Cache-Control", "max-age=5, public"))
                .andExpect(jsonPath("$.source").value("engine")).andExpect(jsonPath("$.alert.id").value(77)).andExpect(jsonPath("$.meta.db_unavailable").value(true))
                .andExpect(jsonPath("$.sigmet.id").value("RKRR:S1")).andExpect(jsonPath("$.sigmet.fir_name").value("INCHEON FIR"))
                .andExpect(jsonPath("$.sigmet.raw_text").value("RKRR SIGMET 1 VALID 090950/091150 RKSI- EMBD TS OBS"))
                .andExpect(jsonPath("$.sigmet.base_ft").value(0)).andExpect(jsonPath("$.sigmet.top_ft").value(40000))
                .andExpect(jsonPath("$.sigmet.base_source").value("json")).andExpect(jsonPath("$.sigmet.provider").value("awc_isigmet"))
                .andExpect(jsonPath("$.sigmet.withdrawn_at").doesNotExist()).andExpect(jsonPath("$.retention_days").value(30));
        List<String> lines = AircraftControllerTest.warnLines(out);
        assertThat(lines).hasSize(1);
        assertThat(lines.get(0)).contains("could not get a DB connection request_id=- path=/api/v1/alerts/{id} uri=\"/api/v1/alerts/77\" elapsed_ms=- → 200 without stored data (meta.db_unavailable): ");
        verify(repo, never()).byId(anyLong());
    }

    /** 열린 공역 알림: 공역 사본을 DB 에서 읽지 못하면 켜진 차수(AirspaceStore)의 행으로 — 같은 키, 차수 이름 · 고도 한계 원문 · edition_active. */
    @Test
    void anOpenAirspaceAlertIsAnsweredFromTheActiveEditionWhenItsCopyCannotBeRead() throws Exception {
        when(engine.activeAlerts(null)).thenReturn(List.of(airspaceAlert(78, 5)));
        airspaces.replace(new AirspaceStore.Snapshot(new AirspaceEdition(3, "AIP 25년 5차", "공역정보", "ab".repeat(32), T), List.of(airspace(4), airspace(5))));
        when(repo.airspaceCopy(5)).thenThrow(new QueryTimeoutException("PreparedStatementCallback; SQL [/* wakeline alerts.airspace_copy limit_s=3 */ SELECT …]",
                new SQLException("ERROR: canceling statement due to user request", "57014")));
        mvc.perform(get("/api/v1/alerts/78")).andExpect(status().isOk()).andExpect(header().string("Cache-Control", "max-age=5, public"))
                .andExpect(jsonPath("$.source").value("engine")).andExpect(jsonPath("$.alert.id").value(78)).andExpect(jsonPath("$.meta.db_unavailable").value(true))
                .andExpect(jsonPath("$.airspace.id").value(5)).andExpect(jsonPath("$.airspace.ident").value("RK R991"))
                .andExpect(jsonPath("$.airspace.lower_basis").value("SFC")).andExpect(jsonPath("$.airspace.lower_raw").value("Surface"))
                .andExpect(jsonPath("$.airspace.upper_ft").value(18000)).andExpect(jsonPath("$.airspace.upper_raw").value("180 Flight Level Altitude"))
                .andExpect(jsonPath("$.airspace.edition").value("AIP 25년 5차")).andExpect(jsonPath("$.airspace.edition_active").value(true))
                .andExpect(jsonPath("$.sigmet").doesNotExist());
    }

    /** 메모리에도 그 구역이 없으면(SIGMET 이 목록에서 빠짐 · 차수 없음 · 켜진 차수에 없는 행) 사본은 없다(null) — 지어 채우지 않는다. 그래도 200. */
    @Test
    void whenMemoryDoesNotHoldTheZoneEitherTheCopyIsLeftOut() throws Exception {
        when(engine.activeAlerts(null)).thenReturn(List.of(sigmetAlert(77, "RKRR:GONE"), airspaceAlert(78, 5), airspaceAlert(79, 9)));
        when(repo.sigmetCopy("RKRR:GONE")).thenThrow(dbDown());
        when(repo.airspaceCopy(anyLong())).thenThrow(dbDown());
        mvc.perform(get("/api/v1/alerts/77")).andExpect(status().isOk()).andExpect(jsonPath("$.meta.db_unavailable").value(true))
                .andExpect(jsonPath("$.sigmet").doesNotExist());
        mvc.perform(get("/api/v1/alerts/78")).andExpect(status().isOk()).andExpect(jsonPath("$.meta.db_unavailable").value(true))
                .andExpect(jsonPath("$.airspace").doesNotExist()); // 공역 자료 없음(차수 없음)
        airspaces.replace(new AirspaceStore.Snapshot(new AirspaceEdition(3, "AIP 25년 5차", "공역정보", "ab".repeat(32), T), List.of(airspace(5))));
        mvc.perform(get("/api/v1/alerts/79")).andExpect(status().isOk()).andExpect(jsonPath("$.meta.db_unavailable").value(true))
                .andExpect(jsonPath("$.airspace").doesNotExist()); // 켜진 차수에 없는 행
    }

    /** 닫힌 알림은 DB 가 원본이다 — 행도 사본도 DB 에서 못 읽으면 지금처럼 503 + Retry-After(메모리 값으로 바꾸지 않는다). */
    @Test
    void aClosedAlertStays503WhenTheDbIsDown() throws Exception {
        when(engine.activeAlerts(null)).thenReturn(List.of());
        sigmets.replace(T, "awc", Map.of("RKRR:S1", sigmet("RKRR:S1")));
        when(repo.byId(80)).thenThrow(dbDown());
        mvc.perform(get("/api/v1/alerts/80")).andExpect(status().isServiceUnavailable()).andExpect(header().string("Retry-After", "10"))
                .andExpect(jsonPath("$.code").value("UNAVAILABLE"));
        Map<String, Object> row = new LinkedHashMap<>();
        row.put("id", 81L); row.put("hex", "71be01"); row.put("sigmet_id", "RKRR:S1"); row.put("left_at", Instant.parse("2026-10-09T10:05:00Z"));
        when(repo.byId(81)).thenReturn(row);
        when(repo.sigmetCopy("RKRR:S1")).thenThrow(dbDown());
        mvc.perform(get("/api/v1/alerts/81")).andExpect(status().isServiceUnavailable()).andExpect(header().string("Retry-After", "10"))
                .andExpect(jsonPath("$.code").value("UNAVAILABLE"));
    }

    /** DB 결함(문법 · 권한)은 저장소 장애가 아니다 — 열린 알림이어도 db_unavailable 로 삼키지 않고 500 + ERROR. */
    @Test
    void aDefectInTheCopyLookupIs500EvenForAnOpenAlert(CapturedOutput out) throws Exception {
        when(engine.activeAlerts(null)).thenReturn(List.of(sigmetAlert(77, "RKRR:S1")));
        sigmets.replace(T, "awc", Map.of("RKRR:S1", sigmet("RKRR:S1")));
        when(repo.sigmetCopy("RKRR:S1")).thenThrow(new BadSqlGrammarException("PreparedStatementCallback", "SELECT … FROM sigmet",
                new SQLException("ERROR: column \"x\" does not exist", "42703")));
        mvc.perform(get("/api/v1/alerts/77")).andExpect(status().isInternalServerError()).andExpect(header().doesNotExist("Retry-After"));
        assertThat(AircraftControllerTest.warnLines(out)).isEmpty();
        assertThat(out.getAll()).contains("unhandled error");
    }
}
