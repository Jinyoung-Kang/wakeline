package dev.wakeline.weather.data;

import org.springframework.data.redis.core.RedisCallback;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.stereotype.Component;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * 기상청 레이더 합성(ADR-012 · ADR-021)을 수집기가 Redis 에 쓴 그대로 읽는다 — 메타 해시(wakeline:radar_kr:meta), 프레임 목록(wakeline:radar_kr:frames),
 * 프레임 PNG(wakeline:radar_kr:frame:{tm}, base64). 예전에는 WeatherController 가 직접 읽었다(리뷰 cto-2026-10 api §2.5 phase 3 · ADR-028: 컨트롤러는
 * Redis 를 쓰지 않는다). 값을 믿지 않는 검사(R-72 — KrRadarFrames · KrRadarMissing)와 응답 모양은 컨트롤러가 그대로 한다.
 * Redis 오류의 뜻은 읽는 것마다 예전과 같다: 목록 · 메타는 '모름'(사용 불가로 답한다), 프레임 PNG 는 던진다(일시 장애 — ProblemAdvice 가 503 + Retry-After,
 * 리뷰 cto-2026-10 A3 결정 6).
 */
@org.springframework.context.annotation.Profile("!cli & !migrate")
@Component
public class KrRadarReader {
    static final String META = "wakeline:radar_kr:meta";
    static final String FRAMES = "wakeline:radar_kr:frames";
    static final String FRAME = "wakeline:radar_kr:frame:";

    private final StringRedisTemplate redis;

    public KrRadarReader(StringRedisTemplate redis) { this.redis = redis; }

    /** 메타 해시와 프레임 목록 JSON(없으면 null). */
    public record Listing(Map<Object, Object> meta, String framesJson) {}

    /** 메타 해시 · 프레임 목록. Redis 오류면 빈 해시 · null(모름). */
    public Listing listing() {
        try {
            return new Listing(redis.opsForHash().entries(META), redis.opsForValue().get(FRAMES));
        } catch (RuntimeException e) {
            return new Listing(Map.of(), null);
        }
    }

    /** 프레임 PNG 키가 남아 있는지 한 번의 파이프라인(EXISTS × n)으로 확인한다. Redis 오류면 빈 목록(없다고 본다). */
    public List<Boolean> framesExist(List<String> tms) {
        if (tms.isEmpty()) return List.of();
        try {
            List<Object> r = redis.executePipelined((RedisCallback<Object>) conn -> {
                for (String tm : tms) conn.keyCommands().exists((FRAME + tm).getBytes(StandardCharsets.UTF_8));
                return null;
            });
            List<Boolean> out = new ArrayList<>(r.size());
            for (Object o : r) out.add(o instanceof Boolean b ? b : o instanceof Number n && n.longValue() > 0);
            return out;
        } catch (RuntimeException e) {
            return List.of();
        }
    }

    /** 프레임 PNG(base64 글자). 없으면 null. Redis 오류는 삼키지 않고 던진다(일시 장애 — 503). */
    public String frame(String tm) { return redis.opsForValue().get(FRAME + tm); }
}
