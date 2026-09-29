package dev.wakeline.portcalls;

import dev.wakeline.domain.ShipStatic;
import dev.wakeline.ingest.ShipStore;
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
import java.util.concurrent.ConcurrentHashMap;
import java.util.function.Function;
import java.util.function.LongSupplier;

/**
 * 한국 항만 입출항 읽기(ADR-022). 조회(PORT-MIS)는 수집기만 하고 결과는 Redis wakeline:portcalls:{호출부호}(TTL 캐시)에만 있다 —
 * api 는 그 키를 읽기만 한다. 조회 수요는 {@code DemandService} 가 선박을 선택한 세션의 호출부호로 임대(wakeline:demand:portcalls)를 쓴다.
 * <ul>
 *   <li>호출부호 = AIS 정적 보고의 호출부호를 수집기(portcalls.normalize_call_sign)와 같은 규칙으로 — 언어 간 시험 벡터
 *       schemas/vectors/call-sign-cases.v1.json. 형식 밖이면 no_call_sign(묻지 않는다). 선명으로는 찾지 않는다(동명 선박을 섞지 않게).</li>
 *   <li>호출부호별 5 s 메모리 캐시(선박을 고른 모든 세션이 같은 값을 쓴다). Redis 오류는 error(cache)로 같은 5 s 동안 둔다.</li>
 *   <li>로그에는 호출부호·오류 종류만.</li>
 * </ul>
 */
@Component
public class PortCallReader {
    private static final Logger log = LoggerFactory.getLogger(PortCallReader.class);
    public static final String KEY_PREFIX = "wakeline:portcalls:";
    public static final long TTL_MS = 5_000;
    /** 캐시 항목 상한 — 넘으면 만료된 것을 치우고, 그래도 넘으면 비운다. */
    static final int MAX_ENTRIES = 4_096;

    private record Entry(PortCallsInfo info, long atMs) {}

    private final Function<String, String> get;
    private final ObjectMapper json;
    private final LongSupplier clock;
    private final ConcurrentHashMap<String, Entry> cache = new ConcurrentHashMap<>();
    private final Counter hit;
    private final Counter miss;

    @Autowired
    public PortCallReader(StringRedisTemplate redis, ObjectMapper json, MeterRegistry meters) {
        this(key -> redis.opsForValue().get(key), json, System::currentTimeMillis, meters);
    }

    /** 테스트용(다른 패키지의 WS 시험도 쓴다): Redis GET 과 시계를 주입한다. */
    public PortCallReader(Function<String, String> get, ObjectMapper json, LongSupplier clock) {
        this(get, json, clock, new SimpleMeterRegistry());
    }

    PortCallReader(Function<String, String> get, ObjectMapper json, LongSupplier clock, MeterRegistry meters) {
        this.get = get;
        this.json = json;
        this.clock = clock;
        this.hit = Counter.builder("wakeline_cache_requests_total").tag("cache", "portcalls").tag("result", "hit").register(meters);
        this.miss = Counter.builder("wakeline_cache_requests_total").tag("cache", "portcalls").tag("result", "miss").register(meters);
    }

    /** 이 선박 정적 정보의 호출부호로 읽은 입출항. 정적 정보를 아직 받지 못했으면 no_static(호출부호를 모른다 — '없음' 이 아니다). */
    public PortCallsInfo forStatic(ShipStatic st) {
        return st == null ? PortCallsInfo.noStatic() : forCallSign(st.callSign());
    }

    /**
     * 캐시에 수집기의 결과(ok · none · error · disabled)가 있나 — 있으면 이 호출부호는 새 조회를 일으키지 않는다(수요 한도가 세지 않는다).
     * 결과가 없거나(pending) 캐시를 읽지 못하면(error cache — 모른다) false. 같은 5 s 메모리 캐시를 쓴다.
     */
    public boolean known(String callSign) {
        String cs = normalizeCallSign(callSign);
        if (cs == null) return false;
        PortCallsInfo info = forCallSign(cs);
        return !PortCallsInfo.PENDING.equals(info.status()) && !PortCallsInfo.KIND_CACHE.equals(info.errorKind());
    }

    /** AIS 호출부호 → 입출항. 형식이 틀리면 no_call_sign(Redis 를 읽지 않는다). */
    public PortCallsInfo forCallSign(String raw) {
        String cs = normalizeCallSign(raw);
        if (cs == null) return PortCallsInfo.noCallSign();
        long now = clock.getAsLong();
        Entry e = cache.get(cs);
        if (e != null && now >= e.atMs() && now - e.atMs() < TTL_MS) {
            hit.increment();
            return e.info();
        }
        miss.increment();
        PortCallsInfo info = read(cs);
        if (cache.size() >= MAX_ENTRIES) prune(now);
        cache.put(cs, new Entry(info, now));
        return info;
    }

    private PortCallsInfo read(String cs) {
        String raw;
        try {
            raw = get.apply(KEY_PREFIX + cs);
        } catch (RuntimeException e) {
            log.debug("port-call cache unavailable for {}: {}", cs, e.getClass().getSimpleName());
            return PortCallsInfo.unreadable(cs);
        }
        PortCallsInfo info = PortCallsInfo.fromCache(cs, raw, json);
        if (raw != null && PortCallsInfo.KIND_CACHE.equals(info.errorKind())) log.debug("port-call cache value for {} is unreadable", cs);
        return info;
    }

    private void prune(long now) {
        cache.values().removeIf(e -> now < e.atMs() || now - e.atMs() >= TTL_MS);
        if (cache.size() >= MAX_ENTRIES) cache.clear();
    }

    int cached() { return cache.size(); }

    /**
     * 호출부호 정규화(수집기 portcalls.normalize_call_sign 과 같다): ASCII 가 아니면 null(문자열 전체 — 앞뒤 공백 포함, 대문자 변환 전) →
     * 앞뒤 공백 제거 → 대문자 → {@code ^[A-Z0-9]{3,7}$} 이면 그 값, 아니면 null. 가운데 공백·기호는 지우지 않는다(다른 호출부호로 바꿔 묻지 않는다).
     */
    public static String normalizeCallSign(String raw) {
        if (raw == null) return null;
        for (int i = 0; i < raw.length(); i++) if (raw.charAt(i) >= 0x80) return null;
        String cs = raw.strip().toUpperCase(Locale.ROOT);
        return PortCallsInfo.CALL_SIGN.matcher(cs).matches() ? cs : null;
    }

    /**
     * MMSI → 조회할 호출부호(모르면 null). 화면 카드(ship_selected)와 같은 정적 정보 — 실시간 목록의 것, 없으면 저장된 것
     * ({@code ShipFanout.runSelected} 와 같은 순서).
     */
    public static Function<String, String> callSigns(ShipStore store) {
        return mmsi -> {
            ShipStore.Ship ship = store.view().get(mmsi);
            ShipStatic st = ship != null ? ship.stat() : store.staticOf(mmsi);
            return st == null ? null : normalizeCallSign(st.callSign());
        };
    }
}
