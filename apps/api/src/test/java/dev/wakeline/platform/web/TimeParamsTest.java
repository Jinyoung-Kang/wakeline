package dev.wakeline.platform.web;

import org.junit.jupiter.api.Test;
import org.springframework.format.support.DefaultFormattingConversionService;
import org.springframework.http.ResponseEntity;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;
import org.springframework.web.bind.WebDataBinder;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.time.Instant;
import java.time.LocalDate;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * 시각 · 날짜 파라미터의 범위(QA-207 · QA-201 · QA-202 · QA-208 — 계약 v5 §G32): 모든 컨트롤러가 ProblemAdvice 의 바인더로 같은 규칙을 받는다.
 * 범위 안은 예전과 같은 값(해석 · 같은 이름 여럿이면 첫 값), 끝값은 받고, 밖은 400 BAD_REQUEST(problem+json — 컨트롤러에 닿지 않는다).
 */
class TimeParamsTest {
    @RestController
    static class Probe {
        @GetMapping("/t")
        ResponseEntity<Map<String, Object>> t(@RequestParam(required = false) Instant at, @RequestParam(required = false) LocalDate day) {
            return ResponseEntity.ok(Map.of("at", String.valueOf(at), "day", String.valueOf(day)));
        }
    }

    final MockMvc mvc = MockMvcBuilders.standaloneSetup(new Probe()).setControllerAdvice(new ProblemAdvice()).build();

    @Test
    void valuesInsideTheRangeBindAsBeforeAndTheEndsAreIncluded() throws Exception {
        mvc.perform(get("/t").param("at", "2026-10-02T03:00:00Z").param("day", "2026-10-02")).andExpect(status().isOk())
                .andExpect(jsonPath("$.at").value("2026-10-02T03:00:00Z")).andExpect(jsonPath("$.day").value("2026-10-02"));
        mvc.perform(get("/t").param("at", "1970-01-01T00:00:00Z").param("day", "1970-01-01")).andExpect(status().isOk());
        mvc.perform(get("/t").param("at", "9999-12-31T23:59:59.999999999Z").param("day", "9999-12-31")).andExpect(status().isOk());
        mvc.perform(get("/t")).andExpect(status().isOk()).andExpect(jsonPath("$.at").value("null"));
        mvc.perform(get("/t").param("at", "")).andExpect(status().isOk()).andExpect(jsonPath("$.at").value("null"));
        // 같은 이름이 여럿이면 첫 값(변환 서비스의 배열 → 값 규칙과 같다 — 예전 동작)
        mvc.perform(get("/t").param("at", "2026-10-02T03:00:00Z", "2026-10-03T03:00:00Z")).andExpect(status().isOk())
                .andExpect(jsonPath("$.at").value("2026-10-02T03:00:00Z"));
    }

    @Test
    void valuesOutsideTheRangeAre400BeforeTheController() throws Exception {
        for (String at : new String[]{"1969-12-31T23:59:59.999Z", "+10000-01-01T00:00:00Z", "-1000000000-01-01T00:00:00Z", "+1000000000-12-31T23:59:59Z"})
            mvc.perform(get("/t").param("at", at)).andExpect(status().isBadRequest())
                    .andExpect(content().contentTypeCompatibleWith("application/problem+json"))
                    .andExpect(jsonPath("$.code").value("BAD_REQUEST"))
                    .andExpect(jsonPath("$.detail").value("invalid parameter: at — out of the supported range 1970-01-01T00:00:00Z – 9999-12-31T23:59:59.999999999Z"));
        for (String day : new String[]{"1969-12-31", "-5000-01-01", "+10000-01-01", "+999999999-12-31"})
            mvc.perform(get("/t").param("day", day)).andExpect(status().isBadRequest())
                    .andExpect(jsonPath("$.detail").value("invalid parameter: day — out of the supported range 1970-01-01 – 9999-12-31"));
        // 첫 값이 범위 밖이면 여럿인 값 전체가 틀린 글자다 — 역시 400
        mvc.perform(get("/t").param("at", "1900-01-01T00:00:00Z", "2026-10-03T03:00:00Z")).andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.detail").value("invalid parameter: at"));
        // 형식이 틀린 글자는 전과 같은 400
        mvc.perform(get("/t").param("day", "2026-02-30")).andExpect(status().isBadRequest()).andExpect(jsonPath("$.detail").value("invalid parameter: day"));
    }

    @Test
    void theEditorReadsIsoWithoutAConversionServiceAndChecksValuesItIsGiven() {
        WebDataBinder plain = new WebDataBinder(null, "at");
        TimeParams.register(plain);
        assertThat(plain.convertIfNecessary("2026-10-02T03:00:00Z", Instant.class)).isEqualTo(Instant.parse("2026-10-02T03:00:00Z"));
        assertThat(plain.convertIfNecessary("2026-10-02", LocalDate.class)).isEqualTo(LocalDate.of(2026, 10, 2));
        assertThatThrownBy(() -> plain.convertIfNecessary("not a time", Instant.class)).hasRootCauseInstanceOf(java.time.format.DateTimeParseException.class);
        assertThatThrownBy(() -> plain.convertIfNecessary("1969-12-31", LocalDate.class)).hasRootCauseInstanceOf(TimeParams.OutOfRange.class);

        WebDataBinder formatted = new WebDataBinder(null, "at");
        formatted.setConversionService(new DefaultFormattingConversionService());
        TimeParams.register(formatted);
        assertThat(formatted.convertIfNecessary("2026-10-02T03:00:00Z", Instant.class)).isEqualTo(Instant.parse("2026-10-02T03:00:00Z"));
        var editor = formatted.findCustomEditor(Instant.class, null);
        editor.setValue(Instant.parse("2026-10-02T03:00:00Z"));
        assertThat(editor.getValue()).isEqualTo(Instant.parse("2026-10-02T03:00:00Z"));
        assertThatThrownBy(() -> editor.setValue(Instant.parse("1960-01-01T00:00:00Z"))).isInstanceOf(TimeParams.OutOfRange.class);
        editor.setValue(new String[0]);
        assertThat(editor.getValue()).isNull();
        assertThat(TimeParams.checked((Instant) null)).isNull();
        assertThat(TimeParams.checked((LocalDate) null)).isNull();
    }
}
