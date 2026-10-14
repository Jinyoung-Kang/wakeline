package dev.wakeline.qa;

import dev.wakeline.it.IntegrationTest;
import dev.wakeline.it.ItStack;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIf;
import org.junit.jupiter.api.extension.ExtendWith;
import org.springframework.boot.test.system.CapturedOutput;
import org.springframework.boot.test.system.OutputCaptureExtension;

import java.nio.charset.StandardCharsets;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * QA-1102(QA 2026-10-aws · api 보안 · 견고성): 익명 로그인(POST /api/v1/ops/session — permitAll)의 username 에 NUL(U+0000)이 있으면 500 INTERNAL +
 * ERROR 스택(실패한 SQL 포함)이다. Login 레코드는 @NotBlank · @Size(max = 64) 만 보고, OpsUserService.authenticate 가 그 값을 그대로
 * {@code SELECT … FROM ops_user WHERE username = :u} 의 매개변수로 보낸다 — PostgreSQL 이 'invalid byte sequence for encoding "UTF8": 0x00'(SQLSTATE 22021)
 * 으로 거절하고, 그 DataIntegrityViolationException 은 ProblemAdvice 에서 '결함일 수 있는 DB 오류'(500 + ERROR)로 간다. QA-002(운영 /ops/runs 필터의 NUL —
 * 세션 필요)와 같은 부류이나 이 경로는 익명이다(요청 제한 로그인 IP당 분당 10 안에서 매번 ERROR 1건 — 서버 로그 스트림 wakeline:logs 에 실린다).
 * <p>기대: 400(형식 오류) 또는 401 BAD_CREDENTIALS(없는 계정과 같은 답). 500 · ERROR 없음.
 * <p>실행: {@code cd apps/api && ./gradlew --offline test --tests 'dev.wakeline.qa.Qa1102LoginUsernameNulIs500IT'}
 */
@EnabledIf("dev.wakeline.DbTestSupport#dockerAvailable")
@ExtendWith(OutputCaptureExtension.class)
class Qa1102LoginUsernameNulIs500IT extends IntegrationTest {
    @BeforeEach
    void clearCounters() {
        ItStack.deleteKeys("rl:*");
    }

    @Test
    void aNulInTheLoginUsernameIsAClientErrorNot500(CapturedOutput output) {
        byte[] body = "{\"username\":\"qa\\u0000ops\",\"password\":\"whatever-password\"}".getBytes(StandardCharsets.UTF_8);
        QaRawHttp.Res r = QaRawHttp.send(port, "POST", "/api/v1/ops/session", Map.of("Content-Type", "application/json"), body);
        assertThat(r.status()).as("anonymous login with a NUL in the username — body %s", r.body()).isIn(400, 401);
        assertThat(output.getOut()).as("server log").doesNotContain("unhandled error request_id=" + r.header("X-Request-Id"));
    }
}
