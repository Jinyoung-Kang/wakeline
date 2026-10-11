package dev.wakeline.weather.web;

import dev.wakeline.platform.web.ProblemAdvice;
import dev.wakeline.weather.core.WarningRecord;
import dev.wakeline.weather.core.WarningStore;
import org.junit.jupiter.api.Test;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

import java.time.Instant;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.hamcrest.Matchers.hasSize;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/** 기상특보 REST(계약 v5 §G49): 수신 전 · 목록 · ETag 304 · 오래됨 · 이력 파라미터 검사. */
class WarningControllerTest {
    static MockMvc mvc(WarningStore s) {
        return MockMvcBuilders.standaloneSetup(new WarningController(s, null)).setControllerAdvice(new ProblemAdvice()).build();
    }

    @Test
    void beforeAnyListArrivesItSaysNotReceived() throws Exception {
        mvc(new WarningStore()).perform(get("/api/v1/warnings")).andExpect(status().isOk())
                .andExpect(jsonPath("$.received").value(false)).andExpect(jsonPath("$.items", hasSize(0)))
                .andExpect(jsonPath("$.meta.stale").value(true)).andExpect(jsonPath("$.source").value("기상청 API허브 특보현황"));
    }

    @Test
    void servesTheCurrentListWithEtagAndStaleness() throws Exception {
        WarningStore s = new WarningStore();
        Instant at = Instant.now().minusSeconds(60);
        s.replaceIfNewer(at, "kma_warning", List.of(new WarningRecord("S1312020", "남해동부바깥먼바다", "S1310000", "남해동부전해상", true, "풍랑", "예비", "발표", true,
                Instant.parse("2026-10-09T07:00:00Z"), null, Instant.parse("2026-10-10T03:00:00Z"), Instant.parse("2026-10-10T09:00:00Z"),
                "10-10 오후(12–18시 KST)", null, "raw")), 1);
        MockMvc m = mvc(s);
        m.perform(get("/api/v1/warnings")).andExpect(status().isOk())
                .andExpect(header().string("ETag", "\"w" + dev.wakeline.platform.web.Etags.BOOT + "-1\"")).andExpect(header().string("Cache-Control", "max-age=30, public"))
                .andExpect(jsonPath("$.received").value(true)).andExpect(jsonPath("$.dropped").value(1))
                .andExpect(jsonPath("$.items[0].zone_code").value("S1312020")).andExpect(jsonPath("$.items[0].effective_text").value("10-10 오후(12–18시 KST)"))
                .andExpect(jsonPath("$.meta.provider").value("kma_warning")).andExpect(jsonPath("$.meta.stale").value(false));
        m.perform(get("/api/v1/warnings").header("If-None-Match", "\"w" + dev.wakeline.platform.web.Etags.BOOT + "-1\"")).andExpect(status().isNotModified());
    }

    /**
     * AWS 리뷰 2026-10 B-6: ETag 가 프로세스 안 순번("w" + version)뿐이라 재기동마다 1부터 다시 셌다. AWS 데모는 매일 같은 시각에 기동하므로(ADR-039)
     * 오늘 version 이 어제와 같아질 수 있다 — 브라우저 HTTP 캐시가 어제 받은 ETag 로 다시 물으면 304 가 와서 어제 본문(지난 특보 목록)이 그대로 보였다.
     */
    @Test
    void anEtagFromAnEarlierProcessWithTheSameVersionIsNotAnsweredWith304() throws Exception {
        WarningStore s = new WarningStore();
        s.replaceIfNewer(Instant.now().minusSeconds(60), "kma_warning", List.of(), 0);
        MockMvc m = mvc(s);
        String etag = m.perform(get("/api/v1/warnings")).andReturn().getResponse().getHeader("ETag");
        assertThat(etag).isNotEqualTo("\"w1\"").contains(dev.wakeline.platform.web.Etags.BOOT);
        m.perform(get("/api/v1/warnings").header("If-None-Match", "\"w1\"")).andExpect(status().isOk()); // 어제 프로세스의 version 1
        m.perform(get("/api/v1/warnings").header("If-None-Match", etag)).andExpect(status().isNotModified());
    }

    @Test
    void historyRejectsBadZoneAndRange() throws Exception {
        MockMvc m = mvc(new WarningStore());
        m.perform(get("/api/v1/warnings/history").param("zone", "X1")).andExpect(status().isBadRequest()).andExpect(jsonPath("$.code").value("BAD_ZONE"));
        m.perform(get("/api/v1/warnings/history").param("from", "2026-08-01T00:00:00Z").param("to", "2026-10-01T00:00:00Z"))
                .andExpect(status().isBadRequest()).andExpect(jsonPath("$.code").value("BAD_RANGE"));
    }
}
