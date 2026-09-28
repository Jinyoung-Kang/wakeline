package dev.wakeline.logs;

import dev.wakeline.config.ProblemAdvice;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

import java.time.Instant;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * 계약 v5 §C4 입력 규칙: 서비스(여러 개)·수준은 정해진 값만, fp 16자리 16진, 요청 id 형식, 글자 검색 200자 이하, since ≤ until,
 * cursor 는 스트림 id, limit 1–200(기본 100 — 범위 밖은 끝값으로). 틀리면 400 problem+json, 없는 항목은 404.
 * (인증·익명 404 는 LogsIT — 이 경로는 /api/v1/ops/** 보안 규칙을 그대로 따른다.)
 */
class LogsControllerTest {
    final LogReaderTest.MemStream stream = new LogReaderTest.MemStream();
    MockMvc mvc;

    @BeforeEach
    void setUp() {
        mvc = MockMvcBuilders.standaloneSetup(new LogsController(new LogReader(stream))).setControllerAdvice(new ProblemAdvice()).build();
    }

    void add(int n) {
        Instant t = Instant.parse("2026-09-29T00:00:00Z");
        for (int i = 1; i <= n; i++)
            stream.add(t.toEpochMilli() + i, 0, LogReaderTest.event(t, "api", "WARN", "L", "m" + i, "aaaaaaaaaaaaaaaa", null, null, 0));
    }

    @Test
    void badParametersAre400() throws Exception {
        for (String[] p : new String[][]{
                {"service", "db", "BAD_SERVICE"}, {"level", "INFO", "BAD_LEVEL"}, {"fp", "XYZ", "BAD_FP"}, {"rid", "bad id", "BAD_RID"},
                {"cursor", "abc", "BAD_CURSOR"}, {"q", "x".repeat(201), "BAD_QUERY"}}) {
            mvc.perform(get("/api/v1/ops/logs").param(p[0], p[1])).andExpect(status().isBadRequest())
                    .andExpect(content().contentTypeCompatibleWith("application/problem+json"))
                    .andExpect(jsonPath("$.code").value(p[2]));
        }
        mvc.perform(get("/api/v1/ops/logs").param("since", "2026-09-29T02:00:00Z").param("until", "2026-09-29T01:00:00Z"))
                .andExpect(status().isBadRequest()).andExpect(jsonPath("$.code").value("BAD_RANGE"));
        mvc.perform(get("/api/v1/ops/logs").param("since", "yesterday")).andExpect(status().isBadRequest());
        mvc.perform(get("/api/v1/ops/logs/groups").param("service", "nope")).andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.code").value("BAD_SERVICE"));
    }

    @Test
    void serviceAndLevelAcceptSeveralValues_commaOrRepeated() throws Exception {
        add(3);
        mvc.perform(get("/api/v1/ops/logs").param("service", "api,collector").param("level", "warn")).andExpect(status().isOk())
                .andExpect(jsonPath("$.items.length()").value(3));
        mvc.perform(get("/api/v1/ops/logs").param("service", "ais").param("service", "web-client")).andExpect(status().isOk())
                .andExpect(jsonPath("$.items.length()").value(0));
    }

    @Test
    void limitDefaultsTo100AndIsClampedTo200() throws Exception {
        add(250);
        mvc.perform(get("/api/v1/ops/logs")).andExpect(status().isOk()).andExpect(jsonPath("$.items.length()").value(100));
        mvc.perform(get("/api/v1/ops/logs").param("limit", "1000")).andExpect(status().isOk()).andExpect(jsonPath("$.items.length()").value(200));
        mvc.perform(get("/api/v1/ops/logs").param("limit", "0")).andExpect(status().isOk()).andExpect(jsonPath("$.items.length()").value(1));
    }

    @Test
    void oneEntryOr404() throws Exception {
        add(1);
        String id = stream.entries.firstKey()[0] + "-0";
        mvc.perform(get("/api/v1/ops/logs/" + id)).andExpect(status().isOk()).andExpect(jsonPath("$.id").value(id))
                .andExpect(jsonPath("$.message").value("m1"));
        mvc.perform(get("/api/v1/ops/logs/1-0")).andExpect(status().isNotFound()).andExpect(jsonPath("$.code").value("NOT_FOUND"));
        mvc.perform(get("/api/v1/ops/logs/not-an-id")).andExpect(status().isNotFound());
    }
}
