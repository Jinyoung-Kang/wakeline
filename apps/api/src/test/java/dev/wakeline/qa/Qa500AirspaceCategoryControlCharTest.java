package dev.wakeline.qa;

import dev.wakeline.airspace.core.AirspaceStore;
import dev.wakeline.airspace.web.AirspaceController;
import dev.wakeline.platform.web.ProblemAdvice;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * QA-500(출시 QA 2차 · 보안(견고성)): GET /api/v1/airspace 의 category 는 "[a-z_]{1,32} 쉼표 목록"(계약 v5 §G47)인데, 조각을 trim() 으로 다듬어
 * 앞뒤의 제어 문자(NUL · 탭 · 줄바꿈 · 0x1F 이하)를 지운 뒤 검사한다 — 'prohibited\0' 이 200 으로 받아들여진다(격리 스택 A 퍼징: category=a%00 → 200).
 * 같은 부류를 §G43 에서 strip()(공백만)으로 고쳤다(Params.hex · icao). 제어 문자는 400 BAD_CATEGORY 여야 한다.
 */
class Qa500AirspaceCategoryControlCharTest {
    final MockMvc mvc = MockMvcBuilders.standaloneSetup(new AirspaceController(new AirspaceStore())).setControllerAdvice(new ProblemAdvice()).build();

    @ParameterizedTest
    @ValueSource(strings = {"prohibited\u0000", "\u0000prohibited", "prohibited\t", "restricted,danger\n", "prohibited\u001f"})
    void controlCharactersAroundACategoryAre400(String raw) throws Exception {
        mvc.perform(get("/api/v1/airspace").param("category", raw))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.code").value("BAD_CATEGORY"));
    }
}
