package dev.wakeline.rest;

import dev.wakeline.platform.web.ProblemAdvice;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import org.junit.jupiter.api.Test;
import org.springframework.data.redis.RedisConnectionFailureException;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.data.redis.core.ValueOperations;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;
import tools.jackson.databind.json.JsonMapper;

import java.util.Base64;
import java.util.function.Function;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * 기상청 레이더 프레임 영상(/api/v1/radar/kr/{tm}.png — ADR-012). 리뷰 cto-2026-10 A3 · 결정 6: Redis 일시 장애는 503 + Retry-After(계약 §2 — 예전에는
 * '없음' 404 로 답해 브라우저가 1 h 동안 없는 영상으로 알았다), 없는 프레임은 404, 깨진 값(base64 아님)은 404 + wakeline_radar_kr_parse_errors_total
 * {field="frame_png"}(R-72 — 예전에는 500).
 */
class KrRadarFrameEndpointTest {
    static final String TM = "202609291440";
    final SimpleMeterRegistry meters = new SimpleMeterRegistry();

    @SuppressWarnings("unchecked")
    MockMvc mvc(Function<String, String> get) {
        ValueOperations<String, String> values = mock(ValueOperations.class);
        when(values.get(anyString())).thenAnswer(inv -> get.apply(inv.getArgument(0)));
        StringRedisTemplate redis = new StringRedisTemplate() {
            @Override public ValueOperations<String, String> opsForValue() { return values; }
        };
        WeatherController c = new WeatherController(null, null, null, null, null, null, redis, JsonMapper.builder().build(), meters);
        return MockMvcBuilders.standaloneSetup(c).setControllerAdvice(new ProblemAdvice()).build();
    }

    double parseErrors() {
        var c = meters.find("wakeline_radar_kr_parse_errors_total").tag("field", "frame_png").counter();
        return c == null ? 0 : c.count();
    }

    @Test
    void aStoredFrameIsServedAsPng() throws Exception {
        byte[] png = {(byte) 0x89, 'P', 'N', 'G', 1, 2, 3};
        mvc(k -> k.equals("wakeline:radar_kr:frame:" + TM) ? Base64.getEncoder().encodeToString(png) : null)
                .perform(get("/api/v1/radar/kr/" + TM + ".png"))
                .andExpect(status().isOk()).andExpect(header().string("Content-Type", "image/png")).andExpect(content().bytes(png));
    }

    @Test
    void aRedisOutageIs503WithRetryAfterNotAMissingFrame() throws Exception {
        mvc(k -> { throw new RedisConnectionFailureException("redis down"); })
                .perform(get("/api/v1/radar/kr/" + TM + ".png"))
                .andExpect(status().isServiceUnavailable()).andExpect(header().string("Retry-After", "10"))
                .andExpect(jsonPath("$.code").value("UNAVAILABLE"));
    }

    @Test
    void aMissingFrameIs404AndACorruptOneIs404AndCounted() throws Exception {
        mvc(k -> null).perform(get("/api/v1/radar/kr/" + TM + ".png"))
                .andExpect(status().isNotFound()).andExpect(jsonPath("$.code").value("NOT_FOUND"));
        assertThat(parseErrors()).isZero();
        mvc(k -> "%%% not base64 %%%").perform(get("/api/v1/radar/kr/" + TM + ".png"))
                .andExpect(status().isNotFound()).andExpect(jsonPath("$.code").value("NOT_FOUND"));
        assertThat(parseErrors()).isEqualTo(1.0);
    }
}
