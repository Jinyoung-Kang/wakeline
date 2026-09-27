package dev.skywx.config;

import io.lettuce.core.ClientOptions;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Primary;
import org.springframework.data.redis.connection.RedisConnectionFactory;
import org.springframework.data.redis.connection.RedisStandaloneConfiguration;
import org.springframework.data.redis.connection.lettuce.LettuceClientConfiguration;
import org.springframework.data.redis.connection.lettuce.LettuceConnectionFactory;
import org.springframework.data.redis.core.StringRedisTemplate;

import java.time.Duration;

/**
 * Redis 연결 두 벌. 둘 다 ACL 사용자(계약 §6: skywx_api)로 접속한다 — spring.data.redis.username/password.
 * <ul>
 *   <li>기본(@Primary): 세션·요청 제한·상태·설정·레이더 조회. 네이티브 연결 1개를 공유(멀티플렉싱)하고 명령 한도 3 s,
 *       끊겨 있을 때는 명령을 쌓지 않고 바로 실패시킨다(요청 제한은 열림, 로그인은 닫힘으로 즉시 판단).</li>
 *   <li>스트림 전용(streamConnectionFactory): XREADGROUP BLOCK 이 다른 명령을 막지 않도록 분리한다. 소비자 스레드 하나만
 *       쓰므로 이 팩토리 안에서는 연결을 공유해도 된다(명령마다 새 TCP 연결을 열지 않는다).</li>
 * </ul>
 * 사용자 정의 RedisConnectionFactory 가 있으면 Boot 자동 구성이 기본 팩토리·템플릿을 만들지 않으므로 둘 다 여기서 만든다.
 */
@Configuration
public class RedisConfig {

    @Bean
    @Primary
    LettuceConnectionFactory redisConnectionFactory(@Value("${spring.data.redis.host}") String host,
                                                    @Value("${spring.data.redis.port}") int port,
                                                    @Value("${spring.data.redis.username:}") String username,
                                                    @Value("${spring.data.redis.password:}") String password,
                                                    @Value("${spring.data.redis.timeout:3s}") Duration timeout) {
        var client = LettuceClientConfiguration.builder()
                .commandTimeout(timeout)
                .clientOptions(ClientOptions.builder().autoReconnect(true)
                        .disconnectedBehavior(ClientOptions.DisconnectedBehavior.REJECT_COMMANDS).build())
                .build();
        return new LettuceConnectionFactory(standalone(host, port, username, password), client);
    }

    @Bean
    @Primary
    StringRedisTemplate stringRedisTemplate(@Qualifier("redisConnectionFactory") RedisConnectionFactory redisConnectionFactory) {
        return new StringRedisTemplate(redisConnectionFactory);
    }

    @Bean(name = "streamConnectionFactory")
    LettuceConnectionFactory streamConnectionFactory(@Value("${spring.data.redis.host}") String host,
                                                     @Value("${spring.data.redis.port}") int port,
                                                     @Value("${spring.data.redis.username:}") String username,
                                                     @Value("${spring.data.redis.password:}") String password) {
        var client = LettuceClientConfiguration.builder()
                .commandTimeout(Duration.ofSeconds(15))
                .clientOptions(ClientOptions.builder().autoReconnect(true).build())
                .build();
        return new LettuceConnectionFactory(standalone(host, port, username, password), client);
    }

    @Bean(name = "streamRedisTemplate")
    StringRedisTemplate streamRedisTemplate(@Qualifier("streamConnectionFactory") LettuceConnectionFactory streamConnectionFactory) {
        return new StringRedisTemplate(streamConnectionFactory);
    }

    /** ACL 사용자 이름이 비어 있으면 default 사용자(비밀번호만)로 접속한다 — 로컬 단독 실행·테스트용. */
    static RedisStandaloneConfiguration standalone(String host, int port, String username, String password) {
        var conf = new RedisStandaloneConfiguration(host, port);
        if (username != null && !username.isBlank()) conf.setUsername(username.trim());
        if (password != null && !password.isBlank()) conf.setPassword(password);
        return conf;
    }
}
