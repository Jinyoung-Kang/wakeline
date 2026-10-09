package dev.wakeline.weather.web;

import dev.wakeline.platform.web.ProblemAdvice;
import dev.wakeline.weather.core.Alert;
import dev.wakeline.weather.core.EngineService;
import dev.wakeline.weather.data.AlertRepository;
import org.junit.jupiter.api.Test;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/** 알림 한 건 — 근거 공유(계약 v5 §G51): 숫자가 아니면 400 · 없으면 404 · 열린 알림은 엔진에서(5 s) · 닫힌 알림은 DB 에서(300 s) · 구역 사본. */
class AlertByIdEndpointTest {
    final EngineService engine = mock(EngineService.class);
    final AlertRepository repo = mock(AlertRepository.class);
    final MockMvc mvc = MockMvcBuilders.standaloneSetup(new WeatherController(null, engine, null, null, repo, null, null, null, null))
            .setControllerAdvice(new ProblemAdvice()).build();

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
        Instant t = Instant.parse("2026-10-09T10:00:00Z");
        when(engine.activeAlerts(null)).thenReturn(List.of(new Alert(77, "OBSERVED", "71be01", "KAL081", "RKRR:S1", "RKRR", "TS", null, t, null, null, null, null, 30000,
                Map.of("method", "observed_point_in_polygon"), false)));
        when(repo.sigmetCopy("RKRR:S1")).thenReturn(Map.of("id", "RKRR:S1", "raw_text", "RKRR SIGMET 1 VALID …"));
        mvc.perform(get("/api/v1/alerts/77")).andExpect(status().isOk()).andExpect(header().string("Cache-Control", "max-age=5, public"))
                .andExpect(jsonPath("$.source").value("engine")).andExpect(jsonPath("$.alert.id").value(77)).andExpect(jsonPath("$.alert.hex").value("71be01"))
                .andExpect(jsonPath("$.sigmet.raw_text").value("RKRR SIGMET 1 VALID …")).andExpect(jsonPath("$.retention_days").value(30));
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
}
