package dev.wakeline.logs;

import dev.wakeline.config.ProblemAdvice;
import dev.wakeline.ops.Resolution;
import dev.wakeline.ops.Resolutions;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

import java.time.Instant;
import java.util.List;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * 계약 v5 §C4 입력 규칙: 서비스(여러 개)·수준은 정해진 값만, fp 16자리 16진, 요청 id 형식, 글자 검색 200자 이하, since ≤ until,
 * cursor 는 스트림 id(§G2: "server:" · "client:" 머리 — 없으면 server), limit 1–200(기본 100 — 범위 밖은 끝값으로). 틀리면 400 problem+json, 없는 항목은 404.
 * 항목 하나는 server → client 순(stream= 으로 한 스트림만).
 * (인증·익명 404 는 LogsIT — 이 경로는 /api/v1/ops/** 보안 규칙을 그대로 따른다.)
 */
class LogsControllerTest {
    final LogReaderTest.MemStream stream = new LogReaderTest.MemStream();
    final LogReaderTest.MemStream client = new LogReaderTest.MemStream();
    /** 활성 해결(계약 v5 §G13) — 시험마다 바꾼다. */
    Resolutions resolutions = Resolutions.of(List.of(), Resolutions.State.OK);
    MockMvc mvc;

    @BeforeEach
    void setUp() {
        mvc = MockMvcBuilders.standaloneSetup(new LogsController(new LogReader(stream, client), () -> resolutions))
                .setControllerAdvice(new ProblemAdvice()).build();
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
                {"cursor", "abc", "BAD_CURSOR"}, {"cursor", "edge:1-0", "BAD_CURSOR"}, {"cursor", "client:", "BAD_CURSOR"},
                {"cursor", "client:1-0:x", "BAD_CURSOR"}, {"q", "x".repeat(201), "BAD_QUERY"}}) {
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
            mvc.perform(get("/api/v1/ops/logs").param("cursor", "client:" + c)).andExpect(status().isBadRequest()).andExpect(jsonPath("$.code").value("BAD_CURSOR"));
            mvc.perform(get("/api/v1/ops/logs/" + c)).andExpect(status().isNotFound()).andExpect(jsonPath("$.code").value("NOT_FOUND"));
        }
        // 가장 큰 id 는 받는다(그보다 앞의 항목을 읽는다)
        mvc.perform(get("/api/v1/ops/logs").param("cursor", "18446744073709551615-18446744073709551615")).andExpect(status().isOk())
                .andExpect(jsonPath("$.items.length()").value(1));
        mvc.perform(get("/api/v1/ops/logs").param("cursor", "9223372036854775808-0")).andExpect(status().isOk());
        mvc.perform(get("/api/v1/ops/logs/18446744073709551615-18446744073709551615")).andExpect(status().isNotFound());
    }

    /** §G2: 두 스트림을 합친 목록 — 항목마다 stream, cursor 는 스트림 이름 머리를 붙여 돌려주고 그대로 받는다. */
    @Test
    void listMergesBothStreams_andTheCursorNamesTheStream() throws Exception {
        add(2);
        Instant t = Instant.parse("2026-09-29T00:00:00Z");
        client.add(t.toEpochMilli() + 5, 0, LogReaderTest.event(t, "web-client", "ERROR", "browser", "c", "bbbbbbbbbbbbbbbb", null, null, 0));
        String cid = (t.toEpochMilli() + 5) + "-0";
        mvc.perform(get("/api/v1/ops/logs").param("limit", "1")).andExpect(status().isOk())
                .andExpect(jsonPath("$.items[0].id").value(cid)).andExpect(jsonPath("$.items[0].stream").value("client"))
                .andExpect(jsonPath("$.nextCursor").value("client:" + cid));
        mvc.perform(get("/api/v1/ops/logs").param("cursor", "client:" + cid)).andExpect(status().isOk())
                .andExpect(jsonPath("$.items.length()").value(2)).andExpect(jsonPath("$.items[0].stream").value("server"));
        mvc.perform(get("/api/v1/ops/logs").param("cursor", "server:" + (t.toEpochMilli() + 2) + "-0")).andExpect(status().isOk())
                .andExpect(jsonPath("$.items.length()").value(1)).andExpect(jsonPath("$.items[0].message").value("m1"));
        mvc.perform(get("/api/v1/ops/logs/groups")).andExpect(status().isOk()).andExpect(jsonPath("$.groups.length()").value(2));
    }

    /** §G2: 항목 하나는 server → client 순. stream=server|client 로 한 스트림만(같은 id 가 둘 다에 있을 때), 그 밖의 값은 400 BAD_STREAM. */
    @Test
    void oneEntryLooksInTheServerStreamThenTheClientStream() throws Exception {
        add(1);
        Instant t = Instant.parse("2026-09-29T00:00:00Z");
        String twin = (t.toEpochMilli() + 1) + "-0";
        client.add(t.toEpochMilli() + 1, 0, LogReaderTest.event(t, "web-client", "ERROR", "browser", "client twin", "bbbbbbbbbbbbbbbb", null, null, 0));
        client.add(t.toEpochMilli() + 9, 0, LogReaderTest.event(t, "web-client", "ERROR", "browser", "client only", "bbbbbbbbbbbbbbbb", null, null, 0));
        mvc.perform(get("/api/v1/ops/logs/" + twin)).andExpect(status().isOk()).andExpect(jsonPath("$.stream").value("server"))
                .andExpect(jsonPath("$.message").value("m1"));
        mvc.perform(get("/api/v1/ops/logs/" + twin).param("stream", "client")).andExpect(status().isOk())
                .andExpect(jsonPath("$.stream").value("client")).andExpect(jsonPath("$.message").value("client twin"));
        mvc.perform(get("/api/v1/ops/logs/" + (t.toEpochMilli() + 9) + "-0")).andExpect(status().isOk())
                .andExpect(jsonPath("$.stream").value("client")).andExpect(jsonPath("$.message").value("client only"));
        mvc.perform(get("/api/v1/ops/logs/" + (t.toEpochMilli() + 9) + "-0").param("stream", "server")).andExpect(status().isNotFound());
        mvc.perform(get("/api/v1/ops/logs/" + twin).param("stream", "edge")).andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.code").value("BAD_STREAM"));
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

    /**
     * 계약 v5 §G13: resolved=hide(기본) | show — 그 밖의 값은 400 BAD_RESOLVED. 목록 · 묶음은 hidden_resolved(가린 수)와 resolution_state
     * (ok | stale | unavailable — 해결 기록을 DB 에서 읽었는가)를, 항목 · 묶음 · 항목 하나는 resolved({id, upto, resolved_by} | null)를 싣는다.
     */
    @Test
    void resolvedEntriesAreHiddenUnlessShowIsAsked() throws Exception {
        Instant t = Instant.parse("2026-09-29T00:00:00Z");
        for (int i = 1; i <= 3; i++) // m1 · m2 · m3: ts = 스트림 id = T0 + 1 · 2 · 3 ms, 모두 fp aaaa…
            stream.add(t.toEpochMilli() + i, 0, LogReaderTest.event(t.plusMillis(i), "api", "WARN", "L", "m" + i, "aaaaaaaaaaaaaaaa", null, null, 0));
        resolutions = Resolutions.of(List.of(new Resolution(9, Resolution.LOG_GROUP, "aaaaaaaaaaaaaaaa", t.plusMillis(2), t, "ops", null)),
                Resolutions.State.STALE);
        mvc.perform(get("/api/v1/ops/logs")).andExpect(status().isOk())
                .andExpect(jsonPath("$.items.length()").value(1)).andExpect(jsonPath("$.items[0].message").value("m3"))
                .andExpect(jsonPath("$.items[0].resolved").isEmpty())
                .andExpect(jsonPath("$.hiddenResolved").value(2)).andExpect(jsonPath("$.resolutionState").value("stale"));
        mvc.perform(get("/api/v1/ops/logs").param("resolved", "SHOW ")).andExpect(status().isOk())
                .andExpect(jsonPath("$.items.length()").value(3)).andExpect(jsonPath("$.items[1].resolved.id").value(9))
                .andExpect(jsonPath("$.items[1].resolved.resolved_by").value("ops"))
                .andExpect(jsonPath("$.hiddenResolved").value(0));
        mvc.perform(get("/api/v1/ops/logs/groups")).andExpect(status().isOk())
                .andExpect(jsonPath("$.groups[0].count").value(1)).andExpect(jsonPath("$.hiddenResolved").value(2))
                .andExpect(jsonPath("$.resolutionState").value("stale"));
        mvc.perform(get("/api/v1/ops/logs/groups").param("resolved", "show")).andExpect(status().isOk())
                .andExpect(jsonPath("$.groups[0].count").value(3));
        String first = (t.toEpochMilli() + 1) + "-0";
        mvc.perform(get("/api/v1/ops/logs/" + first)).andExpect(status().isOk()).andExpect(jsonPath("$.resolved.id").value(9));
        for (String path : new String[]{"/api/v1/ops/logs", "/api/v1/ops/logs/groups"})
            mvc.perform(get(path).param("resolved", "all")).andExpect(status().isBadRequest())
                    .andExpect(content().contentTypeCompatibleWith("application/problem+json")).andExpect(jsonPath("$.code").value("BAD_RESOLVED"));
    }
}
