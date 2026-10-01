package dev.wakeline.qa;

import dev.wakeline.logs.ClientErrorController;
import dev.wakeline.logs.LogSink;
import dev.wakeline.logs.LogStream;
import dev.wakeline.platform.config.AppProperties;
import dev.wakeline.platform.web.ProblemAdvice;
import dev.wakeline.platform.web.RateLimiter;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;
import org.mockito.ArgumentCaptor;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;
import tools.jackson.databind.json.JsonMapper;

import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * QA-209(QA 2026-10 기능 · 로그 값): POST /api/v1/client-errors 는 브라우저 시각 ts 를 context.client_ts 로 다시 적는데, 형식기
 * {@code DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'")}(ClientErrorController.java:67)의 'y' 는 기원(era) 안의 연도라 연도 0 이하(기원전)가
 * 기원후 연도로 바뀐다 — ts "-999999999-01-01T00:00:00Z" 가 "+1000000000-01-01T00:00:00.000Z" 로, "0000-06-01T00:00:00Z" 가 "0001-06-01…" 로 저장된다.
 * 격리 스택 A 의 /ops/logs(stream client)에서 'QA-func probe — ts min' 항목의 client_ts 가 +1000000000-01-01T00:00:00.000Z 였다.
 */
class Qa209ClientErrorTsYearOfEraTest {
    static final AppProperties PROPS = new AppProperties("", "36.5,127.8", 250, 120, 200, 5, 10, 30, 2500, 0, "classpath:schemas", 72, 30,
            120, List.of("http://localhost:8700"), List.of());

    @ParameterizedTest(name = "ts {0}")
    @CsvSource({
            "0000-06-01T00:00:00Z, 0000-06-01T00:00:00.000Z",
            "-999999999-01-01T00:00:00Z, -999999999-01-01T00:00:00.000Z",
    })
    void theStoredClientTimestampIsTheInstantTheBrowserSent(String ts, String expected) throws Exception {
        LogSink sink = mock(LogSink.class);
        when(sink.enabled()).thenReturn(true);
        when(sink.instance()).thenReturn("api-test");
        RateLimiter limiter = mock(RateLimiter.class);
        when(limiter.hitStrict(anyString(), anyString(), anyInt())).thenReturn(new long[]{1, 60});
        MockMvc mvc = MockMvcBuilders.standaloneSetup(new ClientErrorController(sink, limiter, PROPS)).setControllerAdvice(new ProblemAdvice()).build();

        mvc.perform(post("/api/v1/client-errors").contentType(MediaType.APPLICATION_JSON)
                        .content("{\"message\":\"boom\",\"path\":\"/\",\"ts\":\"" + ts + "\"}"))
                .andExpect(status().isNoContent());

        ArgumentCaptor<LogSink.Body> body = ArgumentCaptor.forClass(LogSink.Body.class);
        verify(sink).submit(eq(LogStream.CLIENT), anyString(), anyString(), any(), anyString(), body.capture());
        String json = body.getValue().json("0123456789abcdef", 0);
        String clientTs = JsonMapper.builder().build().readTree(json).path("context").path("client_ts").asString();
        assertThat(clientTs).as("context.client_ts for ts=%s (entry %s)", ts, json).isEqualTo(expected);
    }
}
