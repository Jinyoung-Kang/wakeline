package dev.wakeline.platform.config;

import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;
import java.time.Duration;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** 계약 §6: api 는 ACL 사용자(wakeline_api)로 접속한다 — 기본·스트림 연결 모두 같은 설정 함수를 쓴다. */
class RedisConfigTest {
    @Test
    void usernameAndPasswordAreApplied() {
        var c = RedisConfig.standalone("redis", 6379, "wakeline_api", "pw");
        assertThat(c.getUsername()).isEqualTo("wakeline_api");
        assertThat(c.getPassword().isPresent()).isTrue();
        var anon = RedisConfig.standalone("redis", 6379, " ", "");
        assertThat(anon.getUsername()).isNull();
        assertThat(anon.getPassword().isPresent()).isFalse();
    }

    /**
     * 명령 상한(계약 v5 §G21 · 리뷰 2026-09-30 #5): 설정 식 하나(COMMAND_TIMEOUT — 기본 3s, application.yml 도 3s)를 Boot 의 Duration 해석으로 읽고, 기본 연결의
     * Lettuce 명령 상한에 그 값을 쓴다. 해석할 수 없거나 0 이하면 기동하지 않는다. 연결은 맺지 않는다(팩토리를 시작하지 않는다).
     */
    @Test
    void commandTimeoutIsOneExpression_parsedLikeBoot_andAppliedToTheDefaultConnection() throws Exception {
        assertThat(RedisConfig.COMMAND_TIMEOUT).isEqualTo("${spring.data.redis.timeout:3s}");
        assertThat(RedisConfig.DEFAULT_COMMAND_TIMEOUT).isEqualTo(Duration.ofSeconds(3));
        assertThat(RedisConfig.commandTimeout("2500ms")).isEqualTo(Duration.ofMillis(2_500));
        assertThat(RedisConfig.commandTimeout("1500")).as("no unit = ms").isEqualTo(Duration.ofMillis(1_500));
        for (String bad : new String[] {"0", "-3s", "soon", "${spring.data.redis.timeout}"})
            assertThatThrownBy(() -> RedisConfig.commandTimeout(bad)).as(bad).isInstanceOf(IllegalStateException.class).hasMessageContaining("spring.data.redis.timeout");
        var f = new RedisConfig().redisConnectionFactory("localhost", 6379, "", "", "2500ms");
        assertThat(f.getClientConfiguration().getCommandTimeout()).isEqualTo(Duration.ofMillis(2_500));
        String yml = new String(getClass().getResourceAsStream("/application.yml").readAllBytes(), StandardCharsets.UTF_8);
        assertThat(yml).as("the value the docs and the web title state").containsPattern("(?m)^      timeout: 3s$");
    }
}
