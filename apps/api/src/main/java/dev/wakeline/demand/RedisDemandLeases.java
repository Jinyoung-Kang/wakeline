package dev.wakeline.demand;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.context.annotation.Profile;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.data.redis.core.script.RedisScript;
import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.function.LongSupplier;

/**
 * Redis 임대 저장소. 교체는 Lua 한 번(원자적, 공유 연결 그대로 — MULTI 처럼 전용 연결을 열지 않는다): 네 키를 지우고 새 임대를 넣은 뒤
 * 키 자체에도 만료를 건다 — api 가 죽으면 점수(만료 시각)로 수집기가 무시하고, 키도 곧 사라진다.
 * 키 만료는 api 시계로 잰 남은 시간(PEXPIRE, 만료 epoch ms − 지금)이다 — 절대 시각(PEXPIREAT)으로 걸면 Redis 가 제 시계로 재므로 Redis 시계가
 * api 보다 늦은 만큼 키가 60 s 를 넘겨 살았다(DemandIT 에서 PTTL 60,012 로 드러남 — RedisDemandLeasesIT). 점수는 계약대로 만료 epoch ms.
 * 상태 읽기는 필요한 필드만 HMGET(최대 6 + 50 필드).
 */
@Profile("!cli & !migrate")
@Component
public class RedisDemandLeases implements DemandLeases {
    /** KEYS = hot, hot:meta, focus, focus:meta · ARGV = 만료 epoch ms(점수), 키 만료 ms(남은 시간), hot 개수, (member, meta)…, focus 개수, (member, meta)… */
    static final RedisScript<Long> REPLACE = RedisScript.of("""
            redis.call('DEL', KEYS[1], KEYS[2], KEYS[3], KEYS[4])
            local exp = ARGV[1]
            local ttl = ARGV[2]
            local i = 3
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
                redis.call('PEXPIRE', zkey, ttl)
                redis.call('PEXPIRE', hkey, ttl)
              end
            end
            return 1
            """, Long.class);

    /** KEYS = portcalls · ARGV = 만료 epoch ms(점수), 키 만료 ms(남은 시간), 호출부호… — 지우고 다시 넣은 뒤 키에도 만료. 바꾼 수를 돌려준다. */
    static final RedisScript<Long> REPLACE_PORT_CALLS = RedisScript.of("""
            redis.call('DEL', KEYS[1])
            local exp = ARGV[1]
            for i = 3, #ARGV do
              redis.call('ZADD', KEYS[1], exp, ARGV[i])
            end
            if #ARGV > 2 then
              redis.call('PEXPIRE', KEYS[1], ARGV[2])
            end
            return #ARGV - 2
            """, Long.class);

    private final StringRedisTemplate redis;
    private final LongSupplier clock;

    @Autowired
    public RedisDemandLeases(StringRedisTemplate redis) { this(redis, System::currentTimeMillis); }

    /** clock = api 시계(epoch ms) — 시험이 Redis 와 다른 시계를 주입한다 */
    RedisDemandLeases(StringRedisTemplate redis, LongSupplier clock) {
        this.redis = redis;
        this.clock = clock;
    }

    /** 키 만료(ms): api 시계로 잰 남은 시간 — 이미 지났으면 1 ms(곧 사라진다) */
    long keyTtlMs(long expiresAtMs) {
        return Math.max(1L, expiresAtMs - clock.getAsLong());
    }

    @Override
    public void replace(List<Lease> hot, List<Lease> focus, long expiresAtMs) {
        List<String> args = new ArrayList<>(4 + 2 * (hot.size() + focus.size()));
        args.add(Long.toString(expiresAtMs));
        args.add(Long.toString(keyTtlMs(expiresAtMs)));
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
    public void replacePortCalls(List<String> callSigns, long expiresAtMs) {
        List<String> args = new ArrayList<>(2 + callSigns.size());
        args.add(Long.toString(expiresAtMs));
        args.add(Long.toString(keyTtlMs(expiresAtMs)));
        args.addAll(callSigns);
        redis.execute(REPLACE_PORT_CALLS, List.of(PORT_CALLS), args.toArray());
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
