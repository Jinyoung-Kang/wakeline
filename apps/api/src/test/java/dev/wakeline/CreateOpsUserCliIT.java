package dev.wakeline;

import dev.wakeline.it.ItStack;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIf;
import org.springframework.jdbc.core.simple.JdbcClient;

import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * `make ops-user`(= java -jar app.jar --create-ops-user --password-stdin)가 실제로 cli 프로필 컨텍스트를 띄워 계정을 만든다.
 * 전에는 입력 검사(WakelineApplicationTest)만 시험해, cli 프로필에서 빠지는 수집 헬스 기여자(ingestPipeline)를 헬스 그룹 ingest 가
 * 가리켜 컨텍스트가 뜨지 못하는 것(2026-09-28 부터)을 놓쳤다 — 격리 스택에서 계정을 만들다 발견(VERIFICATION #33).
 * 앱과 같은 방법으로 접속 정보를 준다(시스템 속성 = 환경 변수와 같은 우선순위 계층, application.yml 보다 앞).
 */
@EnabledIf("dev.wakeline.DbTestSupport#dockerAvailable")
class CreateOpsUserCliIT {
    private static final List<String> PROPS = List.of("spring.datasource.url", "spring.datasource.username", "spring.datasource.password",
            "spring.data.redis.host", "spring.data.redis.port", "spring.data.redis.username", "spring.data.redis.password");

    @AfterEach
    void clear() { PROPS.forEach(System::clearProperty); }

    @Test
    void theCliProfileContextStartsAndCreatesTheOperator() {
        ItStack.start();
        System.setProperty("spring.datasource.url", DbTestSupport.jdbcUrl(ItStack.DB));
        System.setProperty("spring.datasource.username", "wakeline_api");
        System.setProperty("spring.datasource.password", DbTestSupport.API_PW);
        System.setProperty("spring.data.redis.host", ItStack.redisHost());
        System.setProperty("spring.data.redis.port", String.valueOf(ItStack.redisPort()));
        System.setProperty("spring.data.redis.username", "wakeline_api");
        System.setProperty("spring.data.redis.password", ItStack.REDIS_API_PW);

        var stdin = new ByteArrayInputStream("cli-it-password-0001\n".getBytes(StandardCharsets.UTF_8));
        int rc = WakelineApplication.createOpsUser(true, stdin, Map.of("WAKELINE_OPS_USER", "cli-it"));

        assertThat(rc).as("exit code of --create-ops-user").isZero();
        var admin = JdbcClient.create(new org.springframework.jdbc.datasource.DriverManagerDataSource(
                DbTestSupport.jdbcUrl(ItStack.DB), "postgres", DbTestSupport.ROOT_PW));
        assertThat(admin.sql("SELECT count(*) FROM ops_user WHERE username = 'cli-it'").query(Long.class).single()).isEqualTo(1L);
    }
}
