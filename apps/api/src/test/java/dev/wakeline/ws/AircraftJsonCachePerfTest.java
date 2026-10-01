package dev.wakeline.ws;

import dev.wakeline.aircraft.core.AircraftState;
import dev.wakeline.aircraft.web.AircraftJson;
import dev.wakeline.geo.Bbox;
import io.micrometer.core.instrument.Counter;
import io.micrometer.prometheusmetrics.PrometheusConfig;
import io.micrometer.prometheusmetrics.PrometheusMeterRegistry;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;

import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Random;
import java.util.function.Supplier;

/**
 * 측정(리뷰 cto-2026-10 · api-review §4 P4 — docs/PERF.md §13, 선택 항목): WS 팬아웃이 세션마다 항공기 조각을 이어 붙일 때 AircraftJsonCache.get 이 항공기마다
 * 적중 카운터를 올린다(전세계 보기 10,000대 = 세션 · 틱마다 10,000번). 운영과 같은 Prometheus 레지스트리의 카운터로, 세션 하나의 전세계 스냅샷 이어 붙이기
 * (리뷰 ReviewScratchFanoutPerfTest 와 같은 모양 — 10,000대 · 전세계 bbox · 조각은 이미 캐시에) 와 그 안의 카운터 증가 10,000번만을 따로 잰다.
 * 실행: {@code ./gradlew --offline perfTest --tests 'dev.wakeline.ws.AircraftJsonCachePerfTest'} — 가운데 값(데우기 20번 뒤 41번).
 */
@Tag("perf")
class AircraftJsonCachePerfTest {
    static final int N = 10_000, RUNS = 41;

    @Test
    void measure() throws Exception {
        Instant now = Instant.now();
        Random rnd = new Random(2);
        List<AircraftState> states = new ArrayList<>(N);
        for (int i = 0; i < N; i++)
            states.add(new AircraftState(String.format("%06x", 0x300000 + i), "C" + i, null, null, null, -60 + rnd.nextDouble() * 120,
                    -175 + rnd.nextDouble() * 350, 30000, 450.0, 90.0, 0.0, false, "1200", now, "opensky", now, 0, false));
        PrometheusMeterRegistry meters = new PrometheusMeterRegistry(PrometheusConfig.DEFAULT);
        AircraftJsonCache cache = new AircraftJsonCache(WsTestKit.JSON, meters);
        for (AircraftState s : states) cache.get(s, AircraftJson.Encoding.WORLD); // 조각은 모든 세션이 같이 쓴다 — 이미 있다
        Bbox world = Bbox.world();
        double concat = median(() -> {
            StringBuilder all = new StringBuilder(1 << 20);
            for (AircraftState s : states) if (world.contains(s.lat(), s.lon())) all.append(cache.get(s, AircraftJson.Encoding.WORLD)).append(',');
            return all.length();
        });
        Counter hit = meters.find("wakeline_cache_requests_total").tag("result", "hit").counter();
        double increments = median(() -> {
            for (int i = 0; i < N; i++) hit.increment();
            return hit.count();
        });
        List<String> out = List.of(
                String.format("world snapshot concat for one session (10,000 cached fragments): %.3f ms", concat),
                String.format("of which 10,000 hit-counter increments (Prometheus registry): %.3f ms = %.1f %%", increments, 100 * increments / concat));
        out.forEach(System.out::println);
        Path p = Path.of("build/perf/aircraft-json-cache.txt");
        Files.createDirectories(p.getParent());
        Files.write(p, out);
    }

    static double median(Supplier<Object> w) {
        for (int i = 0; i < 20; i++) w.get();
        double[] t = new double[RUNS];
        for (int i = 0; i < RUNS; i++) {
            long t0 = System.nanoTime();
            w.get();
            t[i] = (System.nanoTime() - t0) / 1e6;
        }
        Arrays.sort(t);
        return t[RUNS / 2];
    }
}
