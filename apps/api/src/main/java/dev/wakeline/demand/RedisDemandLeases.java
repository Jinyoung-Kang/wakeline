package dev.wakeline.demand;

import org.springframework.context.annotation.Profile;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.data.redis.core.script.RedisScript;
import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Redis 임대 저장소. 교체는 Lua 한 번(원자적, 공유 연결 그대로 — MULTI 처럼 전용 연결을 열지 않는다): 네 키를 지우고 새 임대를 넣은 뒤
 * 키 자체에도 같은 만료(PEXPIREAT)를 건다 — api 가 죽으면 점수(만료 시각)로 수집기가 무시하고, 키도 곧 사라진다.
 * 상태 읽기는 필요한 필드만 HMGET(최대 6 + 50 필드).
 */
@Profile("!cli & !migrate")
@Component
public class RedisDemandLeases implements DemandLeases {
    /** KEYS = hot, hot:meta, focus, focus:meta · ARGV = 만료 ms, hot 개수, (member, meta)…, focus 개수, (member, meta)… */
    static final RedisScript<Long> REPLACE = RedisScript.of("""
            redis.call('DEL', KEYS[1], KEYS[2], KEYS[3], KEYS[4])
            local exp = ARGV[1]
            local i = 2
            for g = 0, 1 do
              local zkey, hkey = KEYS[1 + g * 2], KEYS[2 + g * 2]
              local n = tonumber(ARGV[i])
              i = i + 1
              for k = 1, n do
                redis.call('ZADD', zkey, exp, ARGV[i])
                redis.call('HSET', hkey, ARGV[i], ARGV[i + 1])
                i = i + 2
              end
              if n > 0 then
                redis.call('PEXPIREAT', zkey, exp)
                redis.call('PEXPIREAT', hkey, exp)
              end
            end
            return 1
            """, Long.class);

    private final StringRedisTemplate redis;

    public RedisDemandLeases(StringRedisTemplate redis) { this.redis = redis; }

    @Override
    public void replace(List<Lease> hot, List<Lease> focus, long expiresAtMs) {
        List<String> args = new ArrayList<>(3 + 2 * (hot.size() + focus.size()));
        args.add(Long.toString(expiresAtMs));
        for (List<Lease> group : List.of(hot, focus)) {
            args.add(Integer.toString(group.size()));
            for (Lease l : group) {
                args.add(l.member());
                args.add(l.metaJson());
            }
        }
        redis.execute(REPLACE, List.of(HOT, HOT_META, FOCUS, FOCUS_META), args.toArray());
    }

    @Override
    public Map<String, String> status(List<String> fields) {
        if (fields.isEmpty()) return Map.of();
        List<Object> values = redis.opsForHash().multiGet(STATUS, new ArrayList<>(fields));
        Map<String, String> out = new HashMap<>();
        if (values == null) return out;
        for (int i = 0; i < fields.size() && i < values.size(); i++) {
            Object v = values.get(i);
            if (v != null) out.put(fields.get(i), v.toString());
        }
        return out;
    }
}
