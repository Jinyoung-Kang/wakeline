package dev.wakeline.ws;

import dev.wakeline.aircraft.web.AircraftJson;
import dev.wakeline.domain.AircraftState;
import io.micrometer.core.instrument.Counter;
import io.micrometer.core.instrument.MeterRegistry;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import tools.jackson.databind.ObjectMapper;

import java.util.EnumMap;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * 항공기별 인코딩 JSON 조각 캐시(PERF-8). 같은 AircraftState(스냅샷이 바뀌지 않는 한 같은 객체)는 인코딩마다 한 번만 직렬화하고,
 * 세션별 snapshot/diff 는 bbox 안 조각을 이어 붙이기만 한다 — 세션 수만큼 9,000 개 맵을 만들고 직렬화하던 비용을 없앤다.
 * 전세계 스냅샷(2분 주기)의 상태 객체는 지역 스냅샷(10 s)이 바뀌어도 그대로라 재사용된다.
 */
final class AircraftJsonCache {
    /** 병합 뷰보다 이만큼 넘게 커지면 뷰에 없는 hex 를 걷어낸다. */
    static final int PRUNE_SLACK = 2_000;

    private record Entry(AircraftState state, String json) {}

    private final ObjectMapper json;
    private final Map<AircraftJson.Encoding, ConcurrentHashMap<String, Entry>> maps = new EnumMap<>(AircraftJson.Encoding.class);
    /** 적중률(R-53): 조각을 다시 쓴 횟수(hit)와 새로 직렬화한 횟수(miss). */
    private final Counter hit;
    private final Counter miss;

    AircraftJsonCache(ObjectMapper json) { this(json, new SimpleMeterRegistry()); }

    AircraftJsonCache(ObjectMapper json, MeterRegistry meters) {
        this.json = json;
        for (AircraftJson.Encoding e : AircraftJson.Encoding.values()) maps.put(e, new ConcurrentHashMap<>());
        this.hit = Counter.builder("wakeline_cache_requests_total").tag("cache", "aircraft_json").tag("result", "hit").register(meters);
        this.miss = Counter.builder("wakeline_cache_requests_total").tag("cache", "aircraft_json").tag("result", "miss").register(meters);
    }

    String get(AircraftState a, AircraftJson.Encoding enc) {
        ConcurrentHashMap<String, Entry> m = maps.get(enc);
        Entry e = m.get(a.hex());
        if (e != null && (e.state == a || e.state.equals(a))) {
            hit.increment();
            return e.json;
        }
        miss.increment();
        String s = json.writeValueAsString(AircraftJson.encode(a, enc));
        m.put(a.hex(), new Entry(a, s));
        return s;
    }

    /** 현재 병합 뷰에 없는 항목을 걷어낸다(크기가 뷰 + PRUNE_SLACK 을 넘을 때만 — 매번 전체를 훑지 않는다). */
    void prune(Map<String, AircraftState> current) {
        for (ConcurrentHashMap<String, Entry> m : maps.values()) {
            if (m.size() > current.size() + PRUNE_SLACK) m.keySet().removeIf(h -> !current.containsKey(h));
        }
    }

    int size(AircraftJson.Encoding enc) { return maps.get(enc).size(); }
}
