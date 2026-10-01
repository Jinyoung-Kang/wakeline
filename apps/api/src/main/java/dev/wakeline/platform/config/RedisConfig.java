package dev.wakeline.platform.config;

import io.lettuce.core.ClientOptions;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.convert.DurationStyle;
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
 * Redis 연결 두 벌. 둘 다 ACL 사용자(계약 §6: wakeline_api)로 접속한다 — spring.data.redis.username/password.
 * <ul>
 *   <li>기본(@Primary): 세션·요청 제한·상태·설정·레이더 조회. 네이티브 연결 1개를 공유(멀티플렉싱)하고 명령 한도 3 s,
 *       끊겨 있을 때는 명령을 쌓지 않고 바로 실패시킨다(요청 제한은 열림, 로그인은 닫힘으로 즉시 판단).</li>
 *   <li>스트림 전용(streamConnectionFactory): XREADGROUP BLOCK 이 다른 명령을 막지 않도록 분리한다. 소비자 스레드 하나만
 *       쓰므로 이 팩토리 안에서는 연결을 공유해도 된다(명령마다 새 TCP 연결을 열지 않는다).</li>
 * </ul>
 * 사용자 정의 RedisConnectionFactory 가 있으면 Boot 자동 구성이 기본 팩토리·템플릿을 만들지 않으므로 둘 다 여기서 만든다 — 그래서 spring.data.redis.* 중
 * 이 클래스가 읽지 않는 키(예: connect-timeout)는 효과가 없다. 연결 상한은 설정하지 않아 lettuce-core 기본값(SocketOptions.DEFAULT_CONNECT_TIMEOUT 10 s)이고,
 * 그 상한은 연결을 맺을 때만 걸린다(공유 연결은 처음 쓸 때 맺는다 — eagerInitialization 을 켜지 않았다. 맺지 못했으면 다음 명령이 다시 맺는다). 맺은 연결이
 * 끊긴 것을 Lettuce 가 알면 자동 재연결 동안 명령은 기다리지 않고 곧바로 실패한다(REJECT_COMMANDS). 끊긴 줄 모르거나(패킷이 사라짐) 서버가 답하지 않으면
 * (멈춤 · 과부하) 명령마다 명령 상한까지 기다린다.
 */
@Configuration
public class RedisConfig {
    /** 기본 연결의 Redis 명령 상한 — spring.data.redis.timeout 이 없을 때(application.yml 은 3s 를 적는다). */
    static final String DEFAULT_COMMAND_TIMEOUT_TEXT = "3s";
    /**
     * Redis 명령 상한의 설정 식(spring.data.redis.timeout, 없으면 {@value #DEFAULT_COMMAND_TIMEOUT_TEXT}) — 한 곳. 기본 연결의 Lettuce 명령 상한이고,
     * 그 명령을 기다리는 쪽도 같은 식 · 같은 해석({@link #commandTimeout})으로 읽는다: WS selected.route 답의 마감(WsHub → ws.RouteLookups)과 REST 노선
     * 읽기가 진행 중인 같은 콜사인의 읽기를 기다리는 상한(route.RouteReader) — 계약 v5 §G21.
     */
    public static final String COMMAND_TIMEOUT = "${spring.data.redis.timeout:" + DEFAULT_COMMAND_TIMEOUT_TEXT + "}";
    /** {@link #DEFAULT_COMMAND_TIMEOUT_TEXT} 의 길이(설정 없이 만드는 시험 구성의 기본값). */
    public static final Duration DEFAULT_COMMAND_TIMEOUT = commandTimeout(DEFAULT_COMMAND_TIMEOUT_TEXT);

    /**
     * 설정 글자(spring.data.redis.timeout — 예 "3s") → 길이. Boot 가 Duration 속성을 묶을 때와 같은 해석(DurationStyle — 단위가 없으면 ms). 해석할 수 없거나
     * 0 이하(상한 없음)면 기동하지 않는다 — 명령 상한이 곧 노선 답의 마감 · REST 기다림의 상한이라 '상한 없음' 을 받을 수 없다.
     */
    public static Duration commandTimeout(String raw) {
        Duration d;
        try {
            d = DurationStyle.detectAndParse(raw);
        } catch (IllegalArgumentException e) {
            throw new IllegalStateException("spring.data.redis.timeout is not a duration: " + raw, e);
        }
        if (d.isNegative() || d.isZero())
            throw new IllegalStateException("spring.data.redis.timeout must be positive — it bounds every Redis command and the route answers, got " + raw);
        return d;
    }

    @Bean
    @Primary
    LettuceConnectionFactory redisConnectionFactory(@Value("${spring.data.redis.host}") String host,
                                                    @Value("${spring.data.redis.port}") int port,
                                                    @Value("${spring.data.redis.username:}") String username,
                                                    @Value("${spring.data.redis.password:}") String password,
                                                    @Value(COMMAND_TIMEOUT) String timeout) {
        var client = LettuceClientConfiguration.builder()
                .commandTimeout(commandTimeout(timeout))
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
