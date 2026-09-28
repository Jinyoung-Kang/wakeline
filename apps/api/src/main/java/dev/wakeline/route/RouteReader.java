package dev.wakeline.route;

import dev.wakeline.domain.AircraftState;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.stereotype.Component;
import tools.jackson.databind.ObjectMapper;

import java.util.Locale;
import java.util.concurrent.ConcurrentHashMap;
import java.util.function.Function;
import java.util.function.LongSupplier;
import java.util.regex.Pattern;

/**
 * 등록 노선 읽기(계약 v4 §A · ADR-016). 조회(adsbdb)는 수집기만 하고 결과는 Redis wakeline:route:{CALLSIGN}(TTL 캐시)에만 있다 —
 * api 는 그 키를 읽기만 하고 어디에도 쓰지 않는다(약관: 저장·재게시 금지).
 * <ul>
 *   <li>콜사인 = 항공기 상태의 콜사인을 trim·대문자, {@code ^[A-Z0-9]{3,8}$} 가 아니면 no_callsign(묻지 않는다).</li>
 *   <li>콜사인별 5 s 메모리 캐시(WS 세션·REST 가 같은 값을 쓴다). Redis 오류는 unavailable 로 같은 5 s 동안 둔다(장애 중에 매번 묻지 않는다).</li>
 *   <li>로그에는 콜사인·오류 종류만(노선 내용은 쓰지 않는다).</li>
 * </ul>
 */
@Component
public class RouteReader {
    private static final Logger log = LoggerFactory.getLogger(RouteReader.class);
    public static final String KEY_PREFIX = "wakeline:route:";
    static final Pattern CALLSIGN = Pattern.compile("^[A-Z0-9]{3,8}$");
    public static final long TTL_MS = 5_000;
    /** 캐시 항목 상한 — 넘으면 만료된 것을 치우고, 그래도 넘으면 비운다(공개 REST 로 콜사인을 바꿔 가며 불러도 메모리가 자라지 않게). */
    static final int MAX_ENTRIES = 4_096;

    private record Entry(RouteInfo route, long atMs) {}

    private final Function<String, String> get;
    private final ObjectMapper json;
    private final LongSupplier clock;
    private final ConcurrentHashMap<String, Entry> cache = new ConcurrentHashMap<>();

    @Autowired
    public RouteReader(StringRedisTemplate redis, ObjectMapper json) {
        this(key -> redis.opsForValue().get(key), json, System::currentTimeMillis);
    }

    /** 테스트용(다른 패키지의 컨트롤러·WS 시험도 쓴다): Redis GET 과 시계를 주입한다. */
    public RouteReader(Function<String, String> get, ObjectMapper json, LongSupplier clock) {
        this.get = get;
        this.json = json;
        this.clock = clock;
    }

    /** 이 항공기의 노선(상태가 없으면 null — 콜사인을 모른다). */
    public RouteInfo forAircraft(AircraftState a) {
        return a == null ? null : forCallsign(a.callsign());
    }

    /** 공급자 콜사인 → 노선. 형식이 틀리면 no_callsign. */
    public RouteInfo forCallsign(String raw) {
        String cs = normalizeCallsign(raw);
        if (cs == null) return RouteInfo.noCallsign();
        long now = clock.getAsLong();
        Entry e = cache.get(cs);
        if (e != null && now >= e.atMs() && now - e.atMs() < TTL_MS) return e.route();
        RouteInfo r = read(cs);
        if (cache.size() >= MAX_ENTRIES) prune(now);
        cache.put(cs, new Entry(r, now));
        return r;
    }

    private RouteInfo read(String cs) {
        String raw;
        try {
            raw = get.apply(KEY_PREFIX + cs);
        } catch (RuntimeException e) {
            log.debug("route cache unavailable for {}: {}", cs, e.getClass().getSimpleName());
            return RouteInfo.unavailable(cs);
        }
        RouteInfo r = RouteInfo.fromCache(cs, raw, json);
        if (raw != null && RouteInfo.UNAVAILABLE.equals(r.status())) log.debug("route cache value for {} is an error or unreadable", cs);
        return r;
    }

    private void prune(long now) {
        cache.values().removeIf(e -> now < e.atMs() || now - e.atMs() >= TTL_MS);
        if (cache.size() >= MAX_ENTRIES) cache.clear();
    }

    int cached() { return cache.size(); }

    /** trim·대문자 뒤 {@code ^[A-Z0-9]{3,8}$} 이면 그 값, 아니면 null. */
    public static String normalizeCallsign(String raw) {
        if (raw == null) return null;
        String cs = raw.strip().toUpperCase(Locale.ROOT);
        return CALLSIGN.matcher(cs).matches() ? cs : null;
    }
}
