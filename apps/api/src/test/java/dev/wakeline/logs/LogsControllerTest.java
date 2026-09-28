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

    /**
     * 형식은 맞지만 부호 없는 64비트를 넘는 스트림 id(Redis 스트림 id 는 두 칸 모두 부호 없는 64비트): cursor 는 400 BAD_CURSOR, 항목 하나는 404.
     * 예전에는 500 이었다(숫자 변환 예외 → ERROR 로그와 스택 — 그 로그가 다시 로그 스트림에 실린다).
     */
    @Test
    void streamIdsBeyondUnsigned64BitsAre400Or404_not500() throws Exception {
        add(1);
        for (String c : new String[]{"99999999999999999999-0", "18446744073709551616-0", "1-18446744073709551616", "1-99999999999999999999"}) {
            mvc.perform(get("/api/v1/ops/logs").param("cursor", c)).andExpect(status().isBadRequest()).andExpect(jsonPath("$.code").value("BAD_CURSOR"));
            mvc.perform(get("/api/v1/ops/logs/" + c)).andExpect(status().isNotFound()).andExpect(jsonPath("$.code").value("NOT_FOUND"));
        }
        // 가장 큰 id 는 받는다(그보다 앞의 항목을 읽는다)
        mvc.perform(get("/api/v1/ops/logs").param("cursor", "18446744073709551615-18446744073709551615")).andExpect(status().isOk())
                .andExpect(jsonPath("$.items.length()").value(1));
        mvc.perform(get("/api/v1/ops/logs").param("cursor", "9223372036854775808-0")).andExpect(status().isOk());
        mvc.perform(get("/api/v1/ops/logs/18446744073709551615-18446744073709551615")).andExpect(status().isNotFound());
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
