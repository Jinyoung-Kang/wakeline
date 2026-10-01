package dev.wakeline.ops;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.ConfigurableObjectInputStream;
import org.springframework.data.redis.serializer.JdkSerializationRedisSerializer;
import org.springframework.data.redis.serializer.RedisSerializer;
import org.springframework.data.redis.serializer.SerializationException;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InvalidClassException;
import java.io.ObjectInputFilter;
import java.io.ObjectOutputStream;

/**
 * Spring Session(Redis) 직렬화 심층 방어(SEC-5). 세션 값(보안 컨텍스트 등)은 JDK 직렬화로 저장되는데, 기본 역직렬화는 클래스 제한이 없다 —
 * Redis 에 쓸 수 있는 누군가가(ACL 로 막혀 있지만 뚫렸다면) 세션 키에 가젯 체인을 넣으면 api 에서 임의 코드가 돌 수 있다.
 * 여기서는 세션 전용 역직렬화에 허용 목록 필터(JEP 290 ObjectInputFilter)를 건다: 세션에 실제로 들어가는 클래스만 받고 나머지는 거부,
 * 깊이·참조 수·바이트·배열 길이 상한으로 거대 그래프(DoS)도 막는다. 기존 세션 형식(JDK 직렬화)은 그대로라 로그인 중인 세션이 깨지지 않는다.
 * <p>
 * 필터는 이 스트림에만 적용한다(JVM 전체 jdk.serialFilter 가 아니다 — 다른 라이브러리의 역직렬화를 예기치 않게 깨지 않게).
 * 세션에 새 클래스를 넣으면 {@link #FILTER_PATTERN} 에 더해야 한다(거부된 값은 없는 것으로 처리되어 다시 로그인하게 된다 — 닫힌 쪽 실패).
 */
@Configuration(proxyBeanMethods = false)
public class SessionSerializationConfig {
    private static final Logger log = LoggerFactory.getLogger(SessionSerializationConfig.class);
    /**
     * 허용 목록. 세션 해시 필드: creationTime·lastAccessedTime(Long)·maxInactiveInterval(Integer)·sessionAttr:SPRING_SECURITY_CONTEXT
     * (SecurityContextImpl → OpsAuthentication(AbstractAuthenticationToken) → OpsUserService$User, 권한 목록 → SimpleGrantedAuthority)·
     * sessionAttr:ops_user_id(Integer). java.util 은 권한 목록의 불변 리스트(Collections$Unmodifiable* → ArrayList) 때문에 둔다
     * — java.util 단독으로는 코드 실행 가젯이 없고, 그래프 크기는 상한으로 묶는다. java.lang.Object 는 ArrayList 내부 배열(Object[])의
     * 원소 형(필터는 배열의 원소 형으로 판정한다) 때문이다. 실제 세션 그래프를 풀어 본 클래스 목록으로 정했다(SessionSerializationConfigTest).
     */
    static final String FILTER_PATTERN = String.join(";",
            "maxdepth=16", "maxrefs=512", "maxbytes=65536", "maxarray=4096",
            "java.lang.Object", "java.lang.Number", "java.lang.Long", "java.lang.Integer", "java.lang.String", "java.lang.Boolean", "java.lang.Enum",
            "java.util.*",
            "org.springframework.security.core.context.SecurityContextImpl",
            "org.springframework.security.core.authority.SimpleGrantedAuthority",
            "org.springframework.security.authentication.AbstractAuthenticationToken",
            "dev.wakeline.ops.OpsAuthentication",
            "dev.wakeline.ops.OpsUserService$User",
            "!*");
    static final ObjectInputFilter FILTER = ObjectInputFilter.Config.createFilter(FILTER_PATTERN);

    /** Spring Session 이 이 이름의 빈을 기본 직렬화기로 쓴다(RedisHttpSessionConfiguration). */
    @Bean("springSessionDefaultRedisSerializer")
    RedisSerializer<Object> springSessionDefaultRedisSerializer() {
        return filteredJdkSerializer(SessionSerializationConfig.class.getClassLoader());
    }

    static RedisSerializer<Object> filteredJdkSerializer(ClassLoader loader) {
        return new JdkSerializationRedisSerializer(SessionSerializationConfig::serialize, bytes -> deserialize(bytes, loader));
    }

    static byte[] serialize(Object o) {
        try (ByteArrayOutputStream bos = new ByteArrayOutputStream(256); ObjectOutputStream out = new ObjectOutputStream(bos)) {
            out.writeObject(o);
            out.flush();
            return bos.toByteArray();
        } catch (IOException e) {
            throw new SerializationException("cannot serialize session value", e);
        }
    }

    /**
     * 허용 목록 밖(필터 거부 — 객체를 만들기 전에 멈춘다)이거나 깨진 값은 null 로 돌려준다: 그 세션 속성은 없는 것이 되어 요청은 익명으로
     * 처리된다(닫힌 쪽 실패 — /ops 는 404, 운영자는 다시 로그인). 예외로 올리면 그 쿠키를 가진 모든 요청이 500 이 되어 로그인도 할 수 없다.
     */
    static Object deserialize(byte[] bytes, ClassLoader loader) {
        try (ConfigurableObjectInputStream in = new ConfigurableObjectInputStream(new ByteArrayInputStream(bytes), loader)) {
            in.setObjectInputFilter(FILTER);
            return in.readObject();
        } catch (InvalidClassException e) { // 필터 거부(허용 목록 밖·그래프 상한 초과)
            log.warn("session value rejected by the deserialization allow-list — treated as absent: {}", e.getMessage());
            return null;
        } catch (IOException | ClassNotFoundException e) {
            log.warn("session value unreadable — treated as absent: {}", e.toString());
            return null;
        }
    }
}
