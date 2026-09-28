package dev.wakeline.ops;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.stereotype.Service;

import java.time.Duration;
import java.util.Set;

/**
 * 운영자별 세션 목록(R-95, ADR-017 §3): 비밀번호를 바꾸면(make ops-user → {@link OpsUserService#upsert}) 그 사용자의 기존 세션을 모두 지운다.
 * <p>
 * Spring Session 의 색인 저장소(RedisIndexedSessionRepository — 사용자 이름으로 세션 찾기)는 쓸 수 없다: 세션을 만들 때 PUBLISH(생성 이벤트)를
 * 하고, 만료·삭제 알림을 받으려고 PSUBSCRIBE 와 CONFIG SET notify-keyspace-events 를 쓰는데, Redis ACL 이 wakeline_api 에 채널 권한
 * (resetchannels)과 CONFIG(-@dangerous)를 주지 않는다 — 로그인이 NOPERM 으로 실패한다(infra/redis/start.sh). 그래서 같은 색인을 키 하나로 둔다:
 * {@code wakeline:ops:user-sessions:{userId}} = 세션 id 집합(SADD·SMEMBERS·DEL, 모두 ACL 이 허용하는 wakeline:* 명령).
 * <ul>
 *   <li>TTL = 절대 수명 + 1 h. 로그인마다 다시 걸리므로 살아 있는 세션(절대 수명 안)은 모두 목록에 있다. 그보다 오래된 세션은 절대 수명으로 이미 끝났다.</li>
 *   <li>목록에 남은 id 가 이미 만료·로그아웃된 세션이면 지우기는 아무 일도 하지 않는다(없는 키 DEL).</li>
 *   <li>세션 키 형식은 Spring Session(RedisSessionRepository)의 {@code <namespace>:sessions:<id>} — SecurityIT 가 실제 세션으로 확인한다.</li>
 * </ul>
 * CLI(profile cli)에서도 쓰므로 프로필 제한이 없다(Redis 연결은 api 와 같은 ACL 사용자).
 */
@Service
public class OpsSessionRegistry {
    static final String KEY_PREFIX = "wakeline:ops:user-sessions:";
    private final StringRedisTemplate redis;
    private final String sessionKeyPrefix;
    private final Duration ttl;

    public OpsSessionRegistry(StringRedisTemplate redis,
                              @Value("${spring.session.data.redis.namespace:spring:session}") String sessionNamespace,
                              @Value("${wakeline.ops-session-max-age:8h}") Duration maxAge) {
        this.redis = redis;
        this.sessionKeyPrefix = sessionNamespace + ":sessions:";
        this.ttl = maxAge.plusHours(1);
    }

    static String key(int userId) { return KEY_PREFIX + userId; }

    /** 로그인: 이 세션을 사용자 목록에 올린다(세션 id 교체 뒤의 최종 id). */
    public void register(int userId, String sessionId) {
        String k = key(userId);
        redis.opsForSet().add(k, sessionId);
        redis.expire(k, ttl);
    }

    /** 로그아웃: 목록에서 뺀다. */
    public void unregister(int userId, String sessionId) {
        redis.opsForSet().remove(key(userId), sessionId);
    }

    /**
     * 이 사용자의 세션을 모두 지운다(Redis 에서 삭제 → 다음 요청은 익명 → /ops 404). Redis 오류는 그대로 올린다 — 호출자가 알려야 한다.
     * @return 실제로 지운 세션 수
     */
    public int revokeAll(int userId) {
        String k = key(userId);
        Set<String> ids = redis.opsForSet().members(k);
        int n = 0;
        if (ids != null) for (String id : ids) if (Boolean.TRUE.equals(redis.delete(sessionKeyPrefix + id))) n++;
        redis.delete(k);
        return n;
    }
}
