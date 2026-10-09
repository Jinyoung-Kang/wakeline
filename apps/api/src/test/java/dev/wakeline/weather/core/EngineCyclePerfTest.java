package dev.wakeline.weather.core;

import dev.wakeline.aircraft.core.AircraftState;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;

import java.time.Instant;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Random;
import java.util.Set;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 측정(ADR-035 · 계획 docs/plans/features-2026-10 PLAN §6 — docs/PERF.md §16): 판정 엔진 한 주기(관측 교차 · 10분 예측 · 알림 상태 머신)의 시간.
 * 항공기 10,000대(전세계 고르게 + 한반도 주변 1,500대 — 고정 시드), SIGMET 60개(전세계 1–4° 상자). 공역 판정을 더하기 전과 뒤를 같은 자료로 잰다:
 * 'sigmet' = SIGMET 만, 'sigmet+zones' = 같은 자료에 한반도 주변 작은 구역 100개(0.05–0.3° — 공역 판정 대상 크기)를 더한 것.
 * 실행: {@code ./gradlew --offline perfTest --tests 'dev.wakeline.weather.core.EngineCyclePerfTest'} — 데우기 30번 뒤 61번의 가운데 값 · p95.
 */
@Tag("perf")
class EngineCyclePerfTest {
    static final int N = 10_000;
    static final int WARM = 30;
    static final int RUNS = 61;
    static final Instant T0 = Instant.parse("2026-10-09T05:00:00Z");

    static List<SigmetRecord> sigmets(Random r) {
        List<SigmetRecord> out = new ArrayList<>();
        for (int i = 0; i < 60; i++) {
            double lon = -170 + r.nextDouble() * 340, lat = -60 + r.nextDouble() * 120, w = 1 + r.nextDouble() * 3, h = 1 + r.nextDouble() * 3;
            out.add(new SigmetRecord("S" + i, "FIR" + i, "x", "x", "x", "TS", null, 0, 45_000, T0.minusSeconds(3600), T0.plusSeconds(4 * 3600),
                    TestData.box(lon, lat, lon + w, lat + h), null, null, null, null, "RAW", "awc_isigmet", T0, SigmetRecord.BASE_JSON, SigmetRecord.TOP_JSON));
        }
        return out;
    }

    /** 한반도 주변(124–132E · 33–39N) 작은 구역 — 공역 판정 대상(금지 · 원전 · 제한) 크기 · 수의 대역(SIGMET 모양으로 — 같은 판정 길을 탄다) */
    static List<SigmetRecord> zones(Random r) {
        List<SigmetRecord> out = new ArrayList<>();
        for (int i = 0; i < 100; i++) {
            double lon = 124 + r.nextDouble() * 8, lat = 33 + r.nextDouble() * 6, s = 0.05 + r.nextDouble() * 0.25;
            out.add(new SigmetRecord("Z" + i, "RKRR", "x", "x", "x", "AIRSPACE", null, 0, 18_000, T0.minusSeconds(3600), T0.plusSeconds(400 * 24 * 3600L),
                    TestData.box(lon, lat, lon + s, lat + s), null, null, null, null, "RAW", "molit", T0, SigmetRecord.BASE_JSON, SigmetRecord.TOP_JSON));
        }
        return out;
    }

    static List<AircraftState> aircraft(Random r, Instant seen) {
        List<AircraftState> out = new ArrayList<>(N);
        for (int i = 0; i < N; i++) {
            boolean korea = i < 1_500;
            double lat = korea ? 33 + r.nextDouble() * 6 : -60 + r.nextDouble() * 120;
            double lon = korea ? 124 + r.nextDouble() * 8 : -180 + r.nextDouble() * 360;
            int alt = 1_000 + r.nextInt(40_000);
            out.add(new AircraftState("%06x".formatted(i), "T" + i, null, null, null, lat, lon, alt, 200.0 + r.nextInt(300), r.nextDouble() * 360,
                    (double) (r.nextInt(3) - 1) * 500, false, "1200", seen, "adsb_fi", seen, 0, false));
        }
        return out;
    }

    static double[] run(List<SigmetRecord> zones) {
        AlertIds ids = new AlertIds(System::currentTimeMillis);
        AlertStateMachine fsm = new AlertStateMachine(ids::next);
        Map<String, SigmetRecord> byId = new HashMap<>();
        for (SigmetRecord s : zones) byId.put(s.id(), s);
        AlertStateMachine.SigmetSet set = AlertStateMachine.SigmetSet.of(byId, T0);
        ZoneIndex index = new ZoneIndex(zones, T0);
        long[] ns = new long[RUNS];
        int events = 0;
        for (int k = 0; k < WARM + RUNS; k++) {
            Instant now = T0.plusSeconds(10L * k);
            List<AircraftState> states = aircraft(new Random(7), now);  // 같은 위치 · 새 관측 시각(seen_at 이 바뀐 관측)
            Map<String, AircraftState> all = new HashMap<>(states.size() * 2);
            for (AircraftState a : states) all.put(a.hex(), a);
            long t = System.nanoTime();
            var hits = IntersectionEngine.observe(states, index, now);
            var preds = IntersectionEngine.predict(states, index, now, fsm.confirmedByHex(), Set.of());
            var evs = fsm.step(hits, preds, all, now, new AlertStateMachine.Cycle(k, k, false, false, Set.of(), set));
            long d = System.nanoTime() - t;
            if (k >= WARM) ns[k - WARM] = d;
            events += evs.size();
        }
        assertThat(events).isPositive();
        Arrays.sort(ns);
        return new double[]{ns[RUNS / 2] / 1e6, ns[(int) Math.ceil(RUNS * 0.95) - 1] / 1e6, index.size()};
    }

    /** SIGMET 과 구역을 따로 — 상태 머신 · 색인 둘(EngineService 의 공역 판정과 같은 배치) */
    static double[] runTwo(List<SigmetRecord> sig, List<SigmetRecord> zones) {
        AlertIds ids = new AlertIds(System::currentTimeMillis);
        AlertStateMachine f1 = new AlertStateMachine(ids::next), f2 = new AlertStateMachine(ids::next);
        Map<String, SigmetRecord> a = new HashMap<>(), b = new HashMap<>();
        for (SigmetRecord x : sig) a.put(x.id(), x);
        for (SigmetRecord x : zones) b.put(x.id(), x);
        AlertStateMachine.SigmetSet sa = AlertStateMachine.SigmetSet.of(a, T0), sb = AlertStateMachine.SigmetSet.of(b, T0);
        ZoneIndex ia = new ZoneIndex(sig, T0), ib = new ZoneIndex(zones, T0);
        long[] ns = new long[RUNS];
        for (int k = 0; k < WARM + RUNS; k++) {
            Instant now = T0.plusSeconds(10L * k);
            List<AircraftState> states = aircraft(new Random(7), now);
            Map<String, AircraftState> all = new HashMap<>(states.size() * 2);
            for (AircraftState s : states) all.put(s.hex(), s);
            long t = System.nanoTime();
            f1.step(IntersectionEngine.observe(states, ia, now), IntersectionEngine.predict(states, ia, now, f1.confirmedByHex(), Set.of()), all, now,
                    new AlertStateMachine.Cycle(k, k, false, false, Set.of(), sa));
            f2.step(IntersectionEngine.observe(states, ib, now), IntersectionEngine.predict(states, ib, now, f2.confirmedByHex(), Set.of()), all, now,
                    new AlertStateMachine.Cycle(k, k, false, false, Set.of(), sb));
            long d = System.nanoTime() - t;
            if (k >= WARM) ns[k - WARM] = d;
        }
        Arrays.sort(ns);
        return new double[]{ns[RUNS / 2] / 1e6, ns[(int) Math.ceil(RUNS * 0.95) - 1] / 1e6};
    }

    @Test
    void measure() {
        List<SigmetRecord> s = sigmets(new Random(1));
        List<SigmetRecord> both = new ArrayList<>(s);
        both.addAll(zones(new Random(2)));
        double[] a = run(s), b = run(both);
        System.out.printf("engine cycle (%d aircraft) — sigmet: median %.1f ms · p95 %.1f ms (index %d polygons)%n", N, a[0], a[1], (int) a[2]);
        System.out.printf("engine cycle (%d aircraft) — sigmet+zones: median %.1f ms · p95 %.1f ms (index %d polygons)%n", N, b[0], b[1], (int) b[2]);
        double[] c = runTwo(s, zones(new Random(2)));
        System.out.printf("engine cycle (%d aircraft) — sigmet | zones (two state machines): median %.1f ms · p95 %.1f ms%n", N, c[0], c[1]);
    }
}
