package dev.wakeline.airspace;

import dev.wakeline.airspace.core.AirspaceEdition;
import dev.wakeline.airspace.core.AirspaceRecord;
import dev.wakeline.airspace.core.AirspaceStore;
import dev.wakeline.airspace.web.AirspaceController;
import dev.wakeline.platform.web.ProblemAdvice;
import org.junit.jupiter.api.Test;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;
import tools.jackson.databind.json.JsonMapper;

import java.time.Instant;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.hamcrest.Matchers.hasSize;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/** 공역 레이어 REST(계약 v5 §G47 · ADR-034): 자료 없음 · 차수와 출처 · 속성 · ETag → 304 · 종류 거르기 · 잘못된 거르기 400. */
class AirspaceControllerTest {
    static final JsonMapper JSON = JsonMapper.builder().build();

    static AirspaceRecord rec(long id, String cat, String ident, String name, AirspaceRecord.Limit lo, AirspaceRecord.Limit hi, String kind) {
        return new AirspaceRecord(id, cat, "종류 " + cat, "통제공역 / " + cat, null, ident, name, null, null, kind, lo, hi, null,
                JSON.readTree("{\"type\":\"Polygon\",\"coordinates\":[[[132,36],[132.2,36],[132.2,36.2],[132,36.2],[132,36]]]}"));
    }

    static MockMvc mvc(AirspaceStore s) {
        return MockMvcBuilders.standaloneSetup(new AirspaceController(s)).setControllerAdvice(new ProblemAdvice()).build();
    }

    static AirspaceStore withEdition() {
        AirspaceStore s = new AirspaceStore();
        s.replace(new AirspaceStore.Snapshot(new AirspaceEdition(3, "AIP 25년 5차", "AIP 25년 5차 기준", "ab".repeat(32), Instant.parse("2026-10-09T05:00:00Z")),
                List.of(rec(11, "prohibited", "RK P99", "시험 금지구역 A", new AirspaceRecord.Limit(0, "SFC", "Ground"), new AirspaceRecord.Limit(null, "UNL", "Unlimited"), "polygon"),
                        rec(12, "restricted", null, "시험 제한구역 B", new AirspaceRecord.Limit(0, "SFC", "Surface"), new AirspaceRecord.Limit(18_000, "FL", "180 Flight Level Altitude"), "polygon"))));
        return s;
    }

    @Test
    void withoutDataTheCollectionIsEmptyAndTheEditionNull() throws Exception {
        mvc(new AirspaceStore()).perform(get("/api/v1/airspace"))
                .andExpect(status().isOk())
                .andExpect(header().string("Content-Type", "application/geo+json"))
                .andExpect(header().string("ETag", "\"asnone\""))
                .andExpect(jsonPath("$.type").value("FeatureCollection"))
                .andExpect(jsonPath("$.edition").isEmpty())
                .andExpect(jsonPath("$.features", hasSize(0)))
                .andExpect(jsonPath("$.meta.provider").isEmpty())
                .andExpect(jsonPath("$.source").value("국토교통부 공역정보 지도자료(AIP 차수 기준)"));
    }

    @Test
    void servesTheEditionSourceAndNormalisedLimits_withPublicCacheAndEtag() throws Exception {
        MockMvc m = mvc(withEdition());
        MvcResult r = m.perform(get("/api/v1/airspace"))
                .andExpect(status().isOk())
                .andExpect(header().string("Cache-Control", "max-age=300, public"))
                .andExpect(header().string("ETag", "\"as3-abababababab\""))
                .andExpect(jsonPath("$.edition.label").value("AIP 25년 5차"))
                .andExpect(jsonPath("$.edition.currency_checked").value(false))
                .andExpect(jsonPath("$.meta.provider").value("molit_airspace"))
                .andExpect(jsonPath("$.meta.stale").value(false))
                .andExpect(jsonPath("$.features", hasSize(2)))
                .andExpect(jsonPath("$.features[0].id").value("11"))
                .andExpect(jsonPath("$.features[0].geometry.type").value("Polygon"))
                .andExpect(jsonPath("$.features[0].properties.label").value("RK P99"))
                .andExpect(jsonPath("$.features[0].properties.upper.ft").isEmpty())
                .andExpect(jsonPath("$.features[0].properties.upper.basis").value("UNL"))
                .andExpect(jsonPath("$.features[1].properties.label").value("시험 제한구역 B"))  // 식별자가 없으면 이름
                .andExpect(jsonPath("$.features[1].properties.upper.ft").value(18_000))
                .andExpect(jsonPath("$.features[1].properties.upper.raw").value("180 Flight Level Altitude"))
                .andReturn();
        assertThat(r.getResponse().getContentAsString()).contains("\"upper\":{\"ft\":null,\"basis\":\"UNL\"");
        m.perform(get("/api/v1/airspace").header("If-None-Match", "\"as3-abababababab\"")).andExpect(status().isNotModified());
    }

    @Test
    void categoryFilterNarrowsAndKeysTheEtag_andABadFilterIs400() throws Exception {
        MockMvc m = mvc(withEdition());
        m.perform(get("/api/v1/airspace").param("category", "restricted,danger"))
                .andExpect(status().isOk())
                .andExpect(header().string("ETag", "\"as3-abababababab-danger.restricted\""))
                .andExpect(jsonPath("$.features", hasSize(1)))
                .andExpect(jsonPath("$.features[0].properties.category").value("restricted"));
        for (String bad : List.of("Restricted", "a,,b", "x".repeat(33), "a;b")) {
            m.perform(get("/api/v1/airspace").param("category", bad))
                    .andExpect(status().isBadRequest())
                    .andExpect(jsonPath("$.code").value("BAD_CATEGORY"));
        }
    }

    @Test
    void storeReportsAChangeOnlyWhenTheEditionChanges() {
        AirspaceStore s = new AirspaceStore();
        AirspaceEdition a = new AirspaceEdition(1, "a", null, "a".repeat(64), Instant.EPOCH);
        assertThat(s.replace(AirspaceStore.Snapshot.EMPTY)).isFalse();
        assertThat(s.replace(new AirspaceStore.Snapshot(a, List.of()))).isTrue();
        assertThat(s.replace(new AirspaceStore.Snapshot(a, List.of()))).isFalse();
        assertThat(s.replace(new AirspaceStore.Snapshot(new AirspaceEdition(2, "b", null, "b".repeat(64), Instant.EPOCH), List.of()))).isTrue();
        assertThat(s.replace(AirspaceStore.Snapshot.EMPTY)).isTrue();
        assertThat(new AirspaceRecord.Limit(5_000, "AGL", "x").comparable()).isFalse();
        assertThat(new AirspaceRecord.Limit(null, "UNL", "x").comparable()).isTrue();
    }
}
