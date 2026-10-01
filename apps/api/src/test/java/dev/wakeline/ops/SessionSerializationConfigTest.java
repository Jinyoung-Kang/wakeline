package dev.wakeline.ops;

import org.junit.jupiter.api.Test;
import org.springframework.data.redis.serializer.RedisSerializer;
import org.springframework.data.redis.serializer.SerializationException;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.security.core.context.SecurityContextImpl;

import java.io.Serializable;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** SEC-5: 세션 역직렬화는 허용 목록만 받는다 — 실제 세션 값은 왕복하고, 목록 밖 클래스·거대 그래프는 거부한다. */
class SessionSerializationConfigTest {
    final RedisSerializer<Object> ser = new SessionSerializationConfig().springSessionDefaultRedisSerializer();

    @Test
    void realSessionValuesRoundTrip() {
        var auth = new OpsAuthentication(new OpsUserService.User(7, "admin", "OPS"), List.of(new SimpleGrantedAuthority("ROLE_OPS")));
        Object back = ser.deserialize(ser.serialize(new SecurityContextImpl(auth)));
        assertThat(back).isInstanceOf(SecurityContextImpl.class);
        var a = (OpsAuthentication) ((SecurityContextImpl) back).getAuthentication();
        assertThat(a.user()).isEqualTo(new OpsUserService.User(7, "admin", "OPS"));
        assertThat(a.isAuthenticated()).isTrue();
        assertThat(a.getAuthorities()).extracting(Object::toString).containsExactly("ROLE_OPS");
        // Spring Session 해시 필드(생성·접근 시각, 만료 간격)와 ops_user_id
        assertThat(ser.deserialize(ser.serialize(1_790_000_000_000L))).isEqualTo(1_790_000_000_000L);
        assertThat(ser.deserialize(ser.serialize(28_800))).isEqualTo(28_800);
        assertThat(ser.deserialize(ser.serialize("x"))).isEqualTo("x");
        assertThat(ser.deserialize(new byte[0])).isNull();
    }

    /** 허용 목록 밖의 직렬화 가능 클래스(가젯 체인의 입구가 될 수 있는 것)는 거부한다. */
    static final class NotAllowed implements Serializable { int x = 1; }

    /** 거부된 값은 만들지 않고(필터가 인스턴스 생성 전에 멈춘다) 없는 것(null)으로 — 세션은 익명이 되어 다시 로그인하게 된다(닫힌 쪽 실패). */
    static final class NotAllowedCounter implements Serializable {
        static final java.util.concurrent.atomic.AtomicInteger READS = new java.util.concurrent.atomic.AtomicInteger();
        private void readObject(java.io.ObjectInputStream in) throws java.io.IOException, ClassNotFoundException { READS.incrementAndGet(); in.defaultReadObject(); }
    }

    @Test
    void classesOutsideTheAllowListAreRejected() {
        assertThat(ser.deserialize(SessionSerializationConfig.serialize(new NotAllowed()))).isNull();
        assertThat(ser.deserialize(SessionSerializationConfig.serialize(new NotAllowedCounter()))).isNull();
        assertThat(NotAllowedCounter.READS.get()).as("rejected before any of its code ran").isZero();
        assertThat(ser.deserialize(SessionSerializationConfig.serialize(java.net.URI.create("http://example.invalid/")))).isNull();
        assertThat(ser.deserialize(new byte[]{1, 2, 3, 4})).isNull(); // 깨진 값
        // 허용된 컨테이너 안에 숨긴 비허용 원소도 거부된다
        List<Object> smuggled = new ArrayList<>(List.of("ok", new NotAllowed()));
        assertThat(ser.deserialize(SessionSerializationConfig.serialize(smuggled))).isNull();
    }

    /** 허용된 클래스라도 거대한·깊은 그래프(역직렬화 DoS)는 상한에 걸린다. */
    @Test
    void oversizedGraphsAreRejected() {
        List<Object> big = new ArrayList<>();
        for (int i = 0; i < 5_000; i++) big.add("s" + i);
        assertThat(ser.deserialize(SessionSerializationConfig.serialize(big))).isNull();
        Object deep = new HashMap<>();
        for (int i = 0; i < 40; i++) { HashMap<String, Object> m = new HashMap<>(); m.put("n", deep); deep = m; }
        Object deepFinal = deep;
        assertThat(ser.deserialize(SessionSerializationConfig.serialize(deepFinal))).isNull();
        assertThatThrownBy(() -> SessionSerializationConfig.serialize(new Object())).isInstanceOf(SerializationException.class); // 직렬화 불가
    }

    /**
     * 특성 시험(리뷰 cto-2026-10 api §2.7-1 · §5.4-3): 허용 목록은 클래스 이름 글자다. 세션 클래스를 옮기거나 이름을 바꾸면 목록이 그 클래스를 더는 허용하지
     * 않아 배포 때 모든 운영 세션이 읽히지 않는다(다시 로그인). 목록에 적힌 클래스는 모두 지금 있는 직렬화 가능한 클래스여야 한다.
     */
    @Test
    void everyClassNamedInTheAllowListExistsAndIsSerializable() throws ClassNotFoundException {
        List<String> names = new ArrayList<>();
        for (String e : SessionSerializationConfig.FILTER_PATTERN.split(";"))
            if (!e.contains("=") && !e.endsWith("*") && !e.startsWith("!")) names.add(e);
        assertThat(names).contains("dev.wakeline.ops.OpsAuthentication", "dev.wakeline.ops.OpsUserService$User");
        for (String n : names) {
            Class<?> c = Class.forName(n);
            if (c != Object.class) assertThat(Serializable.class.isAssignableFrom(c)).as(n).isTrue();
        }
    }

    /**
     * 특성 시험: 2026-10-01 의 코드가 직렬화한 운영 세션의 보안 컨텍스트(운영자 7 · admin · ROLE_OPS — 리소스 파일)가 지금도 읽힌다. 세션 클래스를 옮기거나 바꾸면
     * (serialVersionUID 를 정하지 않은 OpsAuthentication 은 필드 · 메서드만 바뀌어도) 배포 때 로그인 중인 운영자가 모두 로그아웃된다 — 여기서 먼저 알린다.
     * Spring Security 의 판을 올리면(SecurityContextImpl 등의 serialVersionUID 가 판마다 바뀐다) 실제로도 세션이 끊기므로 이 시험도 실패한다 — 그렇게
     * 알고 올리는 것이면 리소스를 새로 만든다: Base64(SessionSerializationConfig.serialize(new SecurityContextImpl(같은 OpsAuthentication))).
     */
    @Test
    void aSessionWrittenBeforeTheRestructureStillDeserializes() throws Exception {
        byte[] golden;
        try (var in = getClass().getResourceAsStream("ops-security-context.v1.b64")) {
            assertThat(in).as("golden session blob").isNotNull();
            golden = java.util.Base64.getMimeDecoder().decode(in.readAllBytes());
        }
        Object back = ser.deserialize(golden);
        assertThat(back).isInstanceOf(SecurityContextImpl.class);
        var a = (OpsAuthentication) ((SecurityContextImpl) back).getAuthentication();
        assertThat(a.user()).isEqualTo(new OpsUserService.User(7, "admin", "OPS"));
        assertThat(a.isAuthenticated()).isTrue();
        assertThat(a.getAuthorities()).extracting(Object::toString).containsExactly("ROLE_OPS");
    }
}
