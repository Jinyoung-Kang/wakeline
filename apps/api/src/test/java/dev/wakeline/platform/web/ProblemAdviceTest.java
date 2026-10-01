package dev.wakeline.platform.web;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.springframework.boot.test.system.CapturedOutput;
import org.springframework.boot.test.system.OutputCaptureExtension;
import org.springframework.http.converter.HttpMessageNotWritableException;
import io.lettuce.core.RedisCommandExecutionException;
import io.lettuce.core.RedisLoadingException;
import org.springframework.data.redis.RedisConnectionFailureException;
import org.springframework.data.redis.connection.lettuce.LettuceExceptionConverter;
import org.springframework.http.MediaType;
import org.springframework.dao.QueryTimeoutException;
import org.springframework.jdbc.CannotGetJdbcConnectionException;
import org.springframework.jdbc.UncategorizedSQLException;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

import java.io.IOException;
import java.sql.SQLException;
import java.sql.SQLTransientConnectionException;
import java.util.List;
import java.util.Map;

import static org.hamcrest.Matchers.containsString;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/** 오류 → RFC 9457: 저장소 장애는 503 + Retry-After(계약 §2, REL-16), Spring MVC 4xx 는 제 상태 그대로(SEC-10), 나머지만 500. */
@ExtendWith(OutputCaptureExtension.class)
class ProblemAdviceTest {

    @RestController
    static class Probe {
        @GetMapping("/db-down") String dbDown() {
            throw new CannotGetJdbcConnectionException("Failed to obtain JDBC Connection", new SQLTransientConnectionException("pool timeout"));
        }
        @GetMapping("/redis-down") String redisDown() { throw new RedisConnectionFailureException("redis down"); }
        // Redis 가 기동하며 AOF 를 읽는 동안 명령마다 '-LOADING' 으로 답한다 — Spring Data Redis 의 Lettuce 번역(그대로 씀)이 만드는 모양
        @GetMapping("/redis-loading") String redisLoading() {
            throw new LettuceExceptionConverter().convert(new RedisLoadingException("LOADING Redis is loading the dataset in memory"));
        }
        // 다른 Redis 명령 오류(예: 키의 형이 다름)는 결함일 수 있다 — 503 으로 삼키지 않는다
        @GetMapping("/redis-wrongtype") String redisWrongType() {
            throw new LettuceExceptionConverter().convert(new RedisCommandExecutionException("WRONGTYPE Operation against a key holding the wrong kind of value"));
        }
        // pgjdbc: 쿼리 한도(setQueryTimeout)가 보낸 취소 · 서버 statement_timeout 모두 SQLSTATE 57014 — Spring 은 QueryTimeoutException 으로 번역한다
        @GetMapping("/cancelled") String cancelled() {
            throw new QueryTimeoutException("PreparedStatementCallback; SQL [SELECT 1]; ERROR: canceling statement due to user request",
                    new SQLException("ERROR: canceling statement due to user request", "57014"));
        }
        // lock_timeout: SQLSTATE 55P03 — Spring 의 기본 번역(SQLStateSQLExceptionTranslator)은 부류 55 를 몰라 UncategorizedSQLException 이다(DbTimeoutsIT 가 실제 DB 로 확인)
        @GetMapping("/lock-timeout") String lockTimeout() {
            throw new UncategorizedSQLException("PreparedStatementCallback", "SELECT 1", new SQLException("ERROR: canceling statement due to lock timeout", "55P03"));
        }
        @GetMapping("/uncategorized") String uncategorized() {
            throw new UncategorizedSQLException("PreparedStatementCallback", "SELECT 1", new SQLException("ERROR: internal error", "XX000"));
        }
        // Spring Data Redis 도 명령 시간 초과를 QueryTimeoutException 으로 준다 — SQLSTATE 가 없다
        @GetMapping("/redis-timeout") String redisTimeout() {
            throw new QueryTimeoutException("Redis command timed out", new RuntimeException("Command timed out after 3 second(s)"));
        }
        // TransactionTemplate(운영 쓰기)이 풀에서 연결을 얻지 못함 — DataSourceTransactionManager.doBegin 이 Hikari 의 풀 대기 초과를 감싼다
        @GetMapping("/tx-pool") String txPool() {
            throw new org.springframework.transaction.CannotCreateTransactionException("Could not open JDBC Connection for transaction",
                    new SQLTransientConnectionException("HikariPool-1 - Connection is not available, request timed out after 5000ms"));
        }
        // 교착(40P01): Spring 은 부류 40 을 비관적 잠금 실패로 번역한다 — 저장소가 '없는' 것이 아니다
        @GetMapping("/deadlock") String deadlock() {
            throw new org.springframework.dao.PessimisticLockingFailureException("PreparedStatementCallback; SQL [UPDATE x]; ERROR: deadlock detected",
                    new SQLException("ERROR: deadlock detected", "40P01"));
        }
        // 연결 실패(08001)를 감싼 연결 얻기 실패 — 예외 종류로 말하고 SQLSTATE 를 곁들인다
        @GetMapping("/refused") String refused() {
            throw new CannotGetJdbcConnectionException("Failed to obtain JDBC Connection", new SQLException("Connection to db:5432 refused", "08001"));
        }
        // 공개 조회(Sql.publicRead)는 SQL 앞 주석에 이름과 그 문장의 한도를 싣는다 — Spring 은 실패한 SQL 을 예외 메시지에 그대로 싣는다
        @GetMapping("/labelled") String labelled() {
            throw new QueryTimeoutException("PreparedStatementCallback; SQL [/* wakeline replay.radar_frame limit_s=3 */ SELECT frame_time FROM radar_frame];"
                    + " ERROR: canceling statement due to user request", new SQLException("ERROR: canceling statement due to user request", "57014"));
        }
        @GetMapping("/unavailable") String unavailable() { throw Problem.unavailable("try later"); }
        @GetMapping("/limited") String limited() { throw Problem.tooManyRequests("slow down", 42); }
        @GetMapping("/boom") String boom() { throw new IllegalStateException("bug"); }
        // 배포 뒤 로그(2026-09-30): 응답을 쓰는 중 브라우저가 떠나면 Spring 이 이 모양으로 던진다 — /ships/{mmsi}/track 에서 'unhandled error' ERROR 4건
        @GetMapping("/gone") String gone() {
            throw new HttpMessageNotWritableException("Could not write JSON: ServletOutputStream failed to write: java.io.IOException: Broken pipe",
                    new IOException("ServletOutputStream failed to write: java.io.IOException: Broken pipe", new IOException("Broken pipe")));
        }
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

    /**
     * 리뷰 cto-2026-10 최종 리뷰: Redis 가 다시 켜지며 AOF 를 읽는 동안(배포 때 redis 를 다시 만든다 — ADR-017 §6.3) 명령마다 LOADING 으로 답한다.
     * Lettuce 번역은 이것을 분류되지 않은 RedisSystemException 으로 준다 — 저장소를 잠시 못 쓰는 것이므로 503 + Retry-After(계약 §2), 다른 명령 오류는 500.
     */
    @Test
    void redisLoadingItsDatasetIs503_otherRedisCommandErrorsAreStill500(CapturedOutput out) throws Exception {
        mvc.perform(get("/redis-loading")).andExpect(status().isServiceUnavailable()).andExpect(header().string("Retry-After", "10"))
                .andExpect(content().string(containsString("UNAVAILABLE")));
        org.assertj.core.api.Assertions.assertThat(out.getAll()).contains("redis loading its dataset request_id=- path=/redis-loading")
                .doesNotContain("unhandled error request_id=- path=/redis-loading");
        org.assertj.core.api.Assertions.assertThat(ProblemAdvice.isUnavailable(new LettuceExceptionConverter().convert(
                new RedisLoadingException("LOADING Redis is loading the dataset in memory")))).isTrue();
        mvc.perform(get("/redis-wrongtype")).andExpect(status().isInternalServerError()).andExpect(header().doesNotExist("Retry-After"));
        org.assertj.core.api.Assertions.assertThat(out.getAll()).contains("unhandled error request_id=- path=/redis-wrongtype");
    }

    /**
     * 조사 2026-10-01(오류 F3): 503 의 WARN 은 원인을 예외가 스스로 말하는 것(SQLSTATE · 예외 종류)으로만 적는다 — 호출부가 준 적 없는 한도나 까닭을 짐작해
     * 적지 않는다(예: 57014 는 공개 조회의 3 s 한도일 수도, 서버의 statement_timeout 30 s 일 수도 있다 — 어느 쪽인지는 원인 메시지가 말한다).
     * 무엇을 물었는지(경로 + 쿼리 문자열 — 가림 규칙을 거쳐)와 걸린 시간(elapsed_ms — 요청 id 필터가 없으면 '-')을 싣는다.
     */
    @Test
    void transientStoreFailuresAreWordedFromTheirOwnClassOrSqlState(CapturedOutput out) throws Exception {
        mvc.perform(get("/cancelled").queryParam("at", "2026-09-30T13:55:00Z").queryParam("bbox", "124,33,132,39"))
                .andExpect(status().isServiceUnavailable()).andExpect(header().string("Retry-After", "10"))
                .andExpect(content().string(containsString("UNAVAILABLE")))
                .andExpect(content().string(org.hamcrest.Matchers.not(containsString("canceling")))); // 내부 메시지는 싣지 않는다
        mvc.perform(get("/lock-timeout")).andExpect(status().isServiceUnavailable()).andExpect(header().string("Retry-After", "10"))
                .andExpect(content().string(containsString("UNAVAILABLE")));
        mvc.perform(get("/db-down")).andExpect(status().isServiceUnavailable());
        mvc.perform(get("/redis-timeout")).andExpect(status().isServiceUnavailable());
        mvc.perform(get("/redis-down")).andExpect(status().isServiceUnavailable());
        List<String> lines = warnLines(out);
        org.assertj.core.api.Assertions.assertThat(lines).hasSize(5);
        org.assertj.core.api.Assertions.assertThat(lines.get(0))
                .contains("statement cancelled (SQLSTATE 57014) request_id=- path=/cancelled query=\"at=2026-09-30T13:55:00Z&bbox=124,33,132,39\" elapsed_ms=- → 503: ")
                .contains("canceling statement due to user request")
                .doesNotContain("3 s").doesNotContain("limit").doesNotContain("data store unavailable");
        org.assertj.core.api.Assertions.assertThat(lines.get(1)).contains("lock not available (SQLSTATE 55P03) request_id=- path=/lock-timeout elapsed_ms=- → 503: ")
                .contains("canceling statement due to lock timeout");
        org.assertj.core.api.Assertions.assertThat(lines.get(2)).contains("could not get a DB connection request_id=- path=/db-down elapsed_ms=- → 503: ")
                .contains("pool timeout");
        org.assertj.core.api.Assertions.assertThat(lines.get(3)).contains("query timeout request_id=- path=/redis-timeout elapsed_ms=- → 503: ")
                .doesNotContain("SQLSTATE");
        org.assertj.core.api.Assertions.assertThat(lines.get(4)).contains("data store unavailable request_id=- path=/redis-down elapsed_ms=- → 503: ");
        org.assertj.core.api.Assertions.assertThat(out.getAll()).doesNotContain("unhandled error");
    }

    /**
     * 리뷰 2026-10-01: 첫 마디가 'data store unavailable' 로 뭉개지던 나머지 — 트랜잭션용 연결을 열지 못함(CannotCreateTransactionException, 운영 쓰기의
     * TransactionTemplate 이 풀 대기 초과를 이렇게 감싼다)은 그 예외 종류로, 그 밖의 SQLSTATE(교착 40P01 등)는 그 SQLSTATE 로 적는다. SQLSTATE 가 없는
     * 저장소 장애만 'data store unavailable'.
     */
    @Test
    void transactionOpenFailuresAndOtherSqlStatesAreNamedNotCalledUnavailable(CapturedOutput out) throws Exception {
        mvc.perform(get("/tx-pool")).andExpect(status().isServiceUnavailable()).andExpect(header().string("Retry-After", "10"));
        mvc.perform(get("/deadlock")).andExpect(status().isServiceUnavailable()).andExpect(header().string("Retry-After", "10"));
        mvc.perform(get("/refused")).andExpect(status().isServiceUnavailable());
        List<String> lines = warnLines(out);
        org.assertj.core.api.Assertions.assertThat(lines).hasSize(3);
        org.assertj.core.api.Assertions.assertThat(lines.get(0)).contains("could not open a DB connection for a transaction request_id=- path=/tx-pool")
                .contains("Connection is not available, request timed out after 5000ms");
        org.assertj.core.api.Assertions.assertThat(lines.get(1)).contains("DB error (SQLSTATE 40P01) request_id=- path=/deadlock").contains("deadlock detected");
        org.assertj.core.api.Assertions.assertThat(lines.get(2)).contains("could not get a DB connection (SQLSTATE 08001) request_id=- path=/refused");
        org.assertj.core.api.Assertions.assertThat(lines).noneMatch(l -> l.contains("data store unavailable"));
    }

    /**
     * 조사 2026-10-01 오류 F3(도전 better_fix): 재생은 3 s 상한 문장 3~4개를 차례로 낸다 — WARN 은 어느 문장이 끊겼는지와 그 문장에 걸린 한도를 적는다.
     * 둘 다 호출부가 준 것(Sql.publicRead 의 이름표)만: 이름표가 없는 문장(공개 조회가 아닌 것 — 한도가 연결 설정뿐)은 문장도 한도도 적지 않는다.
     */
    @Test
    void aLabelledPublicReadNamesItsStatementAndLimit_anUnlabelledOneNamesNeither(CapturedOutput out) throws Exception {
        mvc.perform(get("/labelled")).andExpect(status().isServiceUnavailable());
        mvc.perform(get("/cancelled")).andExpect(status().isServiceUnavailable());
        List<String> lines = warnLines(out);
        org.assertj.core.api.Assertions.assertThat(lines.get(0))
                .contains("statement cancelled (SQLSTATE 57014) request_id=- path=/labelled elapsed_ms=- statement=replay.radar_frame statement_limit_s=3 → 503: ");
        org.assertj.core.api.Assertions.assertThat(lines.get(1)).contains("elapsed_ms=- → 503: ").doesNotContain("statement=").doesNotContain("limit");
    }

    /** 다른 SQLSTATE 의 분류되지 않은 SQL 예외는 여전히 결함이다 — 500 + ERROR(503 으로 삼키지 않는다). */
    @Test
    void otherUncategorizedSqlErrorsAreStill500(CapturedOutput out) throws Exception {
        mvc.perform(get("/uncategorized")).andExpect(status().isInternalServerError()).andExpect(header().doesNotExist("Retry-After"))
                .andExpect(content().string(containsString("INTERNAL")));
        org.assertj.core.api.Assertions.assertThat(out.getAll()).contains("unhandled error request_id=- path=/uncategorized");
    }

    /**
     * 쿼리 문자열은 로그 가림 규칙(LogMasker — 계약 v5 §C5)을 거치고, 따옴표 안에 싣는다 — 로그 지문(LogEvents.template 이 따옴표 안을 '…' 로 바꾼다)이
     * 값(bbox · 시각)마다 갈리지 않게. 너무 길면 자르고 잘라 낸 글자 수를 적는다.
     */
    @Test
    void theLoggedQueryIsMaskedQuotedAndBounded(CapturedOutput out) throws Exception {
        mvc.perform(get("/cancelled?bbox=124,33,132,39&token=abc123secret"));
        mvc.perform(get("/cancelled?bbox=-10.5,33,132.25,39&token=zzz"));
        mvc.perform(get("/cancelled?q=" + "x".repeat(600)));
        List<String> lines = warnLines(out);
        org.assertj.core.api.Assertions.assertThat(lines.get(0)).contains("query=\"bbox=124,33,132,39&token=***\"").doesNotContain("abc123secret");
        org.assertj.core.api.Assertions.assertThat(dev.wakeline.logs.LogEvents.template(message(lines.get(0))))
                .isEqualTo(dev.wakeline.logs.LogEvents.template(message(lines.get(1))));
        org.assertj.core.api.Assertions.assertThat(lines.get(2)).contains("…(+").doesNotContain("x".repeat(600));
    }

    static List<String> warnLines(CapturedOutput out) {
        return out.getAll().lines().filter(l -> l.contains("WARN") && l.contains("ProblemAdvice")).toList();
    }

    /** 콘솔 한 줄에서 로그 메시지만(로거 이름 뒤). */
    static String message(String line) {
        int i = line.indexOf("ProblemAdvice");
        String rest = line.substring(i + "ProblemAdvice".length());
        return rest.substring(rest.indexOf(' ') + 1).replaceFirst("^[\\s:-]+", "");
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
    void aClientThatLeftMidResponseIsNotLoggedAsAnError(CapturedOutput out) throws Exception {
        mvc.perform(get("/gone"));
        org.assertj.core.api.Assertions.assertThat(out.getAll()).doesNotContain("unhandled error").doesNotContain("ERROR");
        mvc.perform(get("/boom")); // 진짜 결함은 여전히 ERROR
        org.assertj.core.api.Assertions.assertThat(out.getAll()).contains("unhandled error");
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
