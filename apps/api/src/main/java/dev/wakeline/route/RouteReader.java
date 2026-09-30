package dev.wakeline.route;

import dev.wakeline.domain.AircraftState;
import dev.wakeline.persist.SingleFlight;
import io.micrometer.core.instrument.Counter;
import io.micrometer.core.instrument.MeterRegistry;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.stereotype.Component;
import tools.jackson.databind.ObjectMapper;

import java.util.Locale;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executor;
import java.util.function.Function;
import java.util.function.LongSupplier;
import java.util.regex.Pattern;

/**
 * 등록 노선 읽기(계약 v4 §A · ADR-016). 조회(adsbdb)는 수집기만 하고 결과는 Redis wakeline:route:{CALLSIGN}(TTL 캐시)에만 있다 —
 * api 는 그 키를 읽기만 하고 어디에도 쓰지 않는다(약관: 저장·재게시 금지).
 * <ul>
 *   <li>콜사인 = 항공기 상태의 콜사인을 trim → ASCII 가 아니면 콜사인 없음 → 대문자, {@code ^[A-Z0-9]{3,8}$} 가 아니면 no_callsign(묻지 않는다).
 *       수집기(route.normalize_callsign)와 같은 규칙이고(계약 v4 §G A-1), 집중 추적 임대 메타의 callsign 도 이 값이다.</li>
 *   <li>콜사인별 5 s 메모리 캐시(WS 세션·REST 가 같은 값을 쓴다). Redis 오류는 unavailable 로 같은 5 s 동안 둔다(장애 중에 매번 묻지 않는다).
 *       캐시 시각은 읽기가 끝난 때다(느린 읽기 뒤에도 5 s 를 온전히 쓴다).</li>
 *   <li>같은 콜사인의 동시 읽기는 하나({@link SingleFlight} — 계약 v5 §G21): 그 항공기를 고른 세션들 · REST 가 캐시가 빈 동안 함께 불러도 Redis 는 한 번 읽고,
 *       기다리는 쪽은 진행 중인 읽기의 future 에 이어 붙는다(WS 조회 스레드를 잡지 않는다).</li>
 *   <li>부르는 쪽(계약 v5 §G21 · ADR-025 개정): {@link #cached} 는 WS 세션 우편함에서 — 메모리만 본다. {@link #loadAsync} 는 Redis 를 우편함 밖 노선 조회
 *       실행기(ws.RouteLookups)에서 읽는다 — 기다리는 동안에도 그 세션의 pong · diff 는 간다. {@link #forCallsign} 은 같은 읽기를 부른 스레드에서(REST 항공기
 *       상세 · 시험). 한 번의 읽기 상한은 Redis 명령 상한 spring.data.redis.timeout(3 s — 설정값, 잰 값 아님) — 연결을 새로 맺어야 하면 Lettuce 연결 상한
 *       (spring.data.redis.connect-timeout 이 없으면 라이브러리 기본 10 s)이 더해진다.</li>
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
    /** 콜사인 → 진행 중인 Redis 읽기. 같은 콜사인의 동시 miss 는 이것에 이어 붙는다(Redis 를 한 번만 읽는다). */
    private final SingleFlight<String, RouteInfo> inflight = new SingleFlight<>();
    /** 5 s 메모리 캐시 적중률(R-53) — hit 는 Redis 를 읽지 않은 것(캐시 · 진행 중인 읽기에 붙음), miss 는 Redis 읽기. */
    private final Counter hit;
    private final Counter miss;

    @Autowired
    public RouteReader(StringRedisTemplate redis, ObjectMapper json, MeterRegistry meters) {
        this(key -> redis.opsForValue().get(key), json, System::currentTimeMillis, meters);
    }

    /** 지표 없이(테스트 컨텍스트). */
    public RouteReader(StringRedisTemplate redis, ObjectMapper json) {
        this(redis, json, new SimpleMeterRegistry());
    }

    /** 테스트용(다른 패키지의 컨트롤러·WS 시험도 쓴다): Redis GET 과 시계를 주입한다. */
    public RouteReader(Function<String, String> get, ObjectMapper json, LongSupplier clock) {
        this(get, json, clock, new SimpleMeterRegistry());
    }

    RouteReader(Function<String, String> get, ObjectMapper json, LongSupplier clock, MeterRegistry meters) {
        this.get = get;
        this.json = json;
        this.clock = clock;
        this.hit = Counter.builder("wakeline_cache_requests_total").tag("cache", "route").tag("result", "hit").register(meters);
        this.miss = Counter.builder("wakeline_cache_requests_total").tag("cache", "route").tag("result", "miss").register(meters);
    }

    /** 이 항공기의 노선(상태가 없으면 null — 콜사인을 모른다). */
    public RouteInfo forAircraft(AircraftState a) {
        return a == null ? null : forCallsign(a.callsign());
    }

    /** 공급자 콜사인 → 노선(부른 스레드에서 읽는다 — REST · 시험). 형식이 틀리면 no_callsign. 같은 콜사인을 다른 스레드가 읽는 중이면 그 결과를 기다린다. */
    public RouteInfo forCallsign(String raw) {
        String cs = normalizeCallsign(raw);
        if (cs == null) return RouteInfo.noCallsign();
        try {
            return loadAsync(cs, Runnable::run).join();
        } catch (CompletionException e) { // 그 읽기가 결함(Error)으로 끝났다 — 기다린 쪽은 모름
            return RouteInfo.unavailable(cs);
        }
    }

    /**
     * 캐시에만 묻는다(Redis 를 읽지 않는다 — WS 세션 우편함에서 불러도 된다). callsign 은 {@link #normalizeCallsign} 을 거친 값. 신선하면(5 s 안) 그 값
     * (지표 hit), 아니면 null — 부르는 쪽이 {@link #loadAsync} 를 우편함 밖에서 부른다.
     */
    public RouteInfo cached(String callsign) {
        Entry e = cache.get(callsign);
        if (!fresh(e, clock.getAsLong())) return null;
        hit.increment();
        return e.route();
    }

    /**
     * 이 콜사인(정규화한 값)의 노선을 executor 에서 읽는다(WS 선택 조회 — 우편함 밖). 신선한 캐시면 곧바로 끝난 future. 같은 콜사인을 이미 읽는 중이면 그
     * 읽기의 future(스레드를 잡지 않는다 — 지표 hit). Redis 오류는 unavailable 값으로 끝난다. future 가 예외로 끝나는 것은 실행기가 거절했을 때
     * (RejectedExecutionException — 기억하지 않는다)와 읽기의 결함(Error)뿐 — 부르는 쪽이 '조회 실패' 로 말한다.
     */
    public CompletableFuture<RouteInfo> loadAsync(String callsign, Executor executor) {
        Entry e = cache.get(callsign);
        if (fresh(e, clock.getAsLong())) {
            hit.increment();
            return CompletableFuture.completedFuture(e.route());
        }
        SingleFlight.Flight<RouteInfo> f = inflight.run(callsign, () -> readThrough(callsign), executor);
        if (f.joined()) hit.increment();
        return f.result();
    }

    /** 진행 중 표시를 얻은 쪽만: 그사이 다른 읽기가 캐시를 채웠으면 그것, 아니면 Redis 를 읽어 캐시에 넣는다(시각 = 읽기가 끝난 때). */
    private RouteInfo readThrough(String cs) {
        Entry e = cache.get(cs);
        if (fresh(e, clock.getAsLong())) {
            hit.increment();
            return e.route();
        }
        miss.increment();
        RouteInfo r = read(cs);
        long now = clock.getAsLong();
        if (cache.size() >= MAX_ENTRIES) prune(now);
        cache.put(cs, new Entry(r, now));
        return r;
    }

    private static boolean fresh(Entry e, long now) {
        return e != null && now >= e.atMs() && now - e.atMs() < TTL_MS;
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
        cache.values().removeIf(e -> !fresh(e, now));
        if (cache.size() >= MAX_ENTRIES) cache.clear();
    }

    int cachedEntries() { return cache.size(); }

    int inflight() { return inflight.size(); }

    /**
     * 계약 v4 §G A-1: 앞뒤 공백 제거 → ASCII 가 아니면 null → 대문자 → {@code ^[A-Z0-9]{3,8}$} 이면 그 값, 아니면 null.
     * ASCII 검사를 대문자 변환보다 먼저 한다 — 'ı'·'ſ' 같은 글자가 대문자 변환으로 ASCII(I·S)가 되어 다른 콜사인의 노선을 읽지 않게.
     */
    public static String normalizeCallsign(String raw) {
        if (raw == null) return null;
        String s = raw.strip();
        for (int i = 0; i < s.length(); i++) if (s.charAt(i) >= 0x80) return null;
        String cs = s.toUpperCase(Locale.ROOT);
        return CALLSIGN.matcher(cs).matches() ? cs : null;
    }
}
