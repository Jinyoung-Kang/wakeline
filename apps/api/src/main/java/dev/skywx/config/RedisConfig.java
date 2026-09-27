package dev.skywx.config;

import io.lettuce.core.ClientOptions;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.data.redis.connection.RedisStandaloneConfiguration;
import org.springframework.data.redis.connection.lettuce.LettuceClientConfiguration;
import org.springframework.data.redis.connection.lettuce.LettuceConnectionFactory;
import org.springframework.data.redis.core.StringRedisTemplate;

import java.time.Duration;

/**
 * 스트림 소비 전용 연결. 기본 Lettuce 연결은 공유(shared)라 XREADGROUP BLOCK 이 다른 명령을 막는다 —
 * 소비자는 공유하지 않는 별도 팩토리를 쓴다.
 */
@Configuration
public class RedisConfig {

    @Bean(name = "streamConnectionFactory")
    LettuceConnectionFactory streamConnectionFactory(@Value("${spring.data.redis.host}") String host,
                                                     @Value("${spring.data.redis.port}") int port,
                                                     @Value("${spring.data.redis.password:}") String password) {
        var conf = new RedisStandaloneConfiguration(host, port);
        if (password != null && !password.isBlank()) conf.setPassword(password);
        var client = LettuceClientConfiguration.builder()
                .commandTimeout(Duration.ofSeconds(15))
                .clientOptions(ClientOptions.builder().autoReconnect(true).build())
                .build();
        var f = new LettuceConnectionFactory(conf, client);
        f.setShareNativeConnection(false);
        return f;
    }

    @Bean(name = "streamRedisTemplate")
    StringRedisTemplate streamRedisTemplate(LettuceConnectionFactory streamConnectionFactory) {
        return new StringRedisTemplate(streamConnectionFactory);
    }
}
