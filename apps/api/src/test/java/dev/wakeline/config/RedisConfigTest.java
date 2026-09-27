package dev.wakeline.config;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

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
}
