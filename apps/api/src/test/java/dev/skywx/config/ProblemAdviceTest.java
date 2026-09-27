package dev.skywx.config;

import org.junit.jupiter.api.Test;
import org.springframework.data.redis.RedisConnectionFailureException;
import org.springframework.http.MediaType;
import org.springframework.jdbc.CannotGetJdbcConnectionException;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

import java.sql.SQLTransientConnectionException;
import java.util.Map;

import static org.hamcrest.Matchers.containsString;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/** 오류 → RFC 9457: 저장소 장애는 503 + Retry-After(계약 §2, REL-16), Spring MVC 4xx 는 제 상태 그대로(SEC-10), 나머지만 500. */
class ProblemAdviceTest {

    @RestController
    static class Probe {
        @GetMapping("/db-down") String dbDown() {
            throw new CannotGetJdbcConnectionException("Failed to obtain JDBC Connection", new SQLTransientConnectionException("pool timeout"));
        }
        @GetMapping("/redis-down") String redisDown() { throw new RedisConnectionFailureException("redis down"); }
        @GetMapping("/unavailable") String unavailable() { throw Problem.unavailable("try later"); }
        @GetMapping("/limited") String limited() { throw Problem.tooManyRequests("slow down", 42); }
        @GetMapping("/boom") String boom() { throw new IllegalStateException("bug"); }
        @PostMapping(value = "/json", consumes = MediaType.APPLICATION_JSON_VALUE) String json(@RequestBody Map<String, Object> body) { return "ok"; }
        @GetMapping(value = "/only-json", produces = MediaType.APPLICATION_JSON_VALUE) Map<String, Object> onlyJson() { return Map.of("a", 1); }
    }

    final MockMvc mvc = MockMvcBuilders.standaloneSetup(new Probe()).setControllerAdvice(new ProblemAdvice()).build();

    @Test
    void dataStoreOutageIs503WithRetryAfter() throws Exception {
        mvc.perform(get("/db-down")).andExpect(status().isServiceUnavailable()).andExpect(header().string("Retry-After", "10"))
                .andExpect(content().contentTypeCompatibleWith("application/problem+json"))
                .andExpect(content().string(containsString("UNAVAILABLE")))
                .andExpect(content().string(org.hamcrest.Matchers.not(containsString("pool timeout")))); // 내부 메시지는 싣지 않는다
        mvc.perform(get("/redis-down")).andExpect(status().isServiceUnavailable()).andExpect(header().string("Retry-After", "10"));
        mvc.perform(get("/unavailable")).andExpect(status().isServiceUnavailable()).andExpect(header().string("Retry-After", "10"));
        mvc.perform(get("/limited")).andExpect(status().isTooManyRequests()).andExpect(header().string("Retry-After", "42"));
    }

    @Test
    void springMvcClientErrorsKeepTheirStatusAndHeaders() throws Exception {
        mvc.perform(delete("/db-down")).andExpect(status().isMethodNotAllowed()).andExpect(header().string("Allow", containsString("GET")))
                .andExpect(content().string(containsString("METHOD_NOT_ALLOWED")));
        mvc.perform(post("/json").contentType(MediaType.TEXT_PLAIN).content("x")).andExpect(status().isUnsupportedMediaType())
                .andExpect(header().exists("Accept"));
        mvc.perform(get("/only-json").accept(MediaType.APPLICATION_XML)).andExpect(status().isNotAcceptable())
                .andExpect(content().string(""));
    }

    @Test
    void genuineBugsAreStill500() throws Exception {
        mvc.perform(get("/boom")).andExpect(status().isInternalServerError()).andExpect(content().string(containsString("INTERNAL")))
                .andExpect(header().doesNotExist("Retry-After"));
    }

    @Test
    void briefKeepsRootCauseWithoutStack() {
        String s = ProblemAdvice.brief(new CannotGetJdbcConnectionException("outer", new SQLTransientConnectionException("x".repeat(500))));
        org.assertj.core.api.Assertions.assertThat(s).startsWith("CannotGetJdbcConnectionException ← SQLTransientConnectionException: ").hasSizeLessThan(300);
    }
}
