package dev.skywx.engine;

import dev.skywx.domain.AircraftState;
import dev.skywx.domain.GeoJson;
import dev.skywx.domain.SigmetRecord;
import org.locationtech.jts.geom.Coordinate;
import org.locationtech.jts.geom.Geometry;
import org.locationtech.jts.geom.LineString;

import java.time.Instant;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.stream.Collectors;

/**
 * 교차 판정(10.2절)과 진입 예측(10.3절). 순수 함수 — 상태는 AlertStateMachine 이 가진다.
 * 판정 조건: 수평(폴리곤 안) ∧ 고도대(base ≤ alt ≤ top) ∧ 유효시간. 지상 항공기는 제외(VA·TC 는 base 0 인 경우가 많음).
 * 관측·예측 모두 '현재' 로 볼 수 있는 위치(AircraftState.fresh: opensky 300 s, 그 외 60 s 이내)만 쓴다.
 */
public final class IntersectionEngine {
    public static final int PREDICT_STEPS = 10;
    public static final int PREDICT_STEP_S = 60;
    public static final int PREDICT_HORIZON_S = PREDICT_STEPS * PREDICT_STEP_S;
    public static final double PREDICT_MIN_GS_KT = 60.0;
    public static final double PREDICT_MAX_ABS_LAT = 85.0;

    /** 예측 진입 방식: 수평 경계 통과 · 상승/강하로 고도대 진입 · 이미 안에 있는데 경보 유효 시작. */
    public static final String ENTRY_LATERAL = "lateral";
    public static final String ENTRY_VERTICAL = "vertical";
    public static final String ENTRY_VALID_FROM = "valid_from";

    private IntersectionEngine() {}

    public record Hit(String hex, SigmetRecord sigmet, int polygonIndex, int altFt) {}

    /** 관측 교차: hex → hits. 병렬 스트림(인덱스 질의는 스레드 안전). 오래된 위치는 관측으로 쓰지 않는다. */
    public static Map<String, List<Hit>> observe(Collection<AircraftState> states, SigmetIndex index, Instant now) {
        if (index.size() == 0) return Map.of();
        return states.parallelStream()
                .filter(a -> !a.onGround() && a.altFt() != null && a.fresh(now))
                .flatMap(a -> index.queryPoint(a.lon(), a.lat()).stream()
                        .filter(it -> it.sigmet().validAt(now) && it.sigmet().bandContains(a.altFt()))
                        .map(it -> new Hit(a.hex(), it.sigmet(), it.polygonIndex(), a.altFt())))
                .collect(Collectors.groupingByConcurrent(Hit::hex));
    }

    /**
     * 예측 1건. etaS 는 판정 시각(now)부터, etaAt = now + etaS. altAtEntry 는 진입 시각의 추정 고도.
     * positionAgeS = now − seen_at(관측 위치를 now 로 먼저 전진시킨 시간). vrateAssumedZero = 수직속도 미보고 → 수평비행 가정.
     */
    public record Prediction(String hex, SigmetRecord sigmet, int polygonIndex, int etaS, Instant etaAt, int altAtEntry, double distanceNm,
                             String entry, double positionAgeS, boolean vrateAssumedZero) {}

    /** 이 항공기를 예측할 수 있는가. predict() 의 대상 선정과 WS "selected" 가 같은 규칙을 쓴다. */
    public static PredictionAvailability availability(AircraftState a, Instant now, boolean turning) {
        if (a == null) return PredictionAvailability.unavailable(null);
        if (!a.fresh(now)) return PredictionAvailability.unavailable(PredictionAvailability.STALE);
        if (a.onGround()) return PredictionAvailability.unavailable(PredictionAvailability.ON_GROUND);
        if (a.altFt() == null || a.gsKt() == null || a.trackDeg() == null) return PredictionAvailability.unavailable(PredictionAvailability.NO_TRACK);
        if (a.gsKt() < PREDICT_MIN_GS_KT) return PredictionAvailability.unavailable(PredictionAvailability.SLOW);
        if (turning) return PredictionAvailability.unavailable(PredictionAvailability.TURNING);
        if (Math.abs(a.lat()) > PREDICT_MAX_ABS_LAT) return PredictionAvailability.unavailable(null); // 극지방: 계약 사유 값 없음
        return PredictionAvailability.AVAILABLE;
    }

    /**
     * 관측 위치를 seen_at → now 로 먼저 전진시킨 뒤 10분 dead reckoning 궤적에서
     * 수평(폴리곤 안) ∧ 고도대 ∧ 유효시간 이 처음 모두 참이 되는 시각을 찾는다(수평 진입·수직 진입 모두).
     * @param excluded 현재 이미 안에 있는 (hex → sigmet id 집합) — 관측 알림이 있는 조합은 예측하지 않는다.
     * @param turning  최근 관측에서 15° 넘게 선회 중인 hex — 예측 보류(문서화된 한계)
     */
    public static List<Prediction> predict(Collection<AircraftState> states, SigmetIndex index, Instant now,
                                           Map<String, Set<String>> excluded, Set<String> turning) {
        if (index.size() == 0) return List.of();
        return states.parallelStream()
                .filter(a -> availability(a, now, turning.contains(a.hex())).available())
                .flatMap(a -> predictOne(a, index, now, excluded.getOrDefault(a.hex(), Set.of())).stream())
                .toList();
    }

    static List<Prediction> predictOne(AircraftState a, SigmetIndex index, Instant now, Set<String> excludedIds) {
        double age = Math.max(0, a.ageSeconds(now));
        double lat0 = a.lat(), lon0 = a.lon();
        if (age > 0) {
            double[] p = DeadReckoning.predict(a.lat(), a.lon(), a.trackDeg(), a.gsKt(), age);
            lat0 = p[0];
            lon0 = p[1];
        }
        if (Math.abs(lat0) > PREDICT_MAX_ABS_LAT) return List.of();
        boolean vrUnknown = a.vrateFpm() == null;
        double vr = vrUnknown ? 0 : a.vrateFpm();
        double alt0 = a.altFt() + vr * age / 60.0;

        Coordinate[] path = new Coordinate[PREDICT_STEPS + 1];
        path[0] = new Coordinate(lon0, lat0);
        for (int i = 1; i <= PREDICT_STEPS; i++) {
            double[] p = DeadReckoning.predict(lat0, lon0, a.trackDeg(), a.gsKt(), i * PREDICT_STEP_S);
            path[i] = new Coordinate(p[1], p[0]);
            if (Math.abs(path[i].x - path[i - 1].x) > 180) return List.of(); // 경도 ±180 을 넘는 궤적은 예측 생략
        }
        LineString line = GeoJson.GF.createLineString(path);
        List<SigmetIndex.Item> items = index.queryGeometry(line);
        if (items.isEmpty()) return List.of();
        List<Prediction> out = new ArrayList<>(1);
        for (SigmetIndex.Item it : items) {
            if (excludedIds.contains(it.sigmet().id())) continue;
            Entry e = firstEntry(it, path, alt0, vr, now);
            if (e == null) continue;
            int altAtEntry = (int) Math.round(alt0 + vr * e.t() / 60.0);
            double dist = a.gsKt() * e.t() / 3600.0;
            int etaS = (int) Math.round(e.t());
            Instant etaAt = now.plusSeconds(etaS); // 계약: eta_at = judged_at + eta_s
            out.add(new Prediction(a.hex(), it.sigmet(), it.polygonIndex(), etaS, etaAt, altAtEntry,
                    Math.round(dist * 10) / 10.0, e.kind(), Math.round(age * 10) / 10.0, vrUnknown));
        }
        return out;
    }

    record Entry(double t, String kind) {}

    /**
     * 3조건(수평 안 ∧ 고도대 ∧ 유효시간)이 처음 동시에 참이 되는 시각(초, now 기준). 이미 t=0 에 참이면(관측 영역) null.
     * 수평 구간은 60 s 선분별 교차로 구하고(선형 보간), 고도는 alt0 + vr·t 직선, 유효시간은 [valid_from, valid_to).
     */
    static Entry firstEntry(SigmetIndex.Item it, Coordinate[] path, double alt0, double vrFpm, Instant now) {
        SigmetRecord s = it.sigmet();
        double horizon = (path.length - 1) * (double) PREDICT_STEP_S;
        double untilFrom = (s.validFrom().toEpochMilli() - now.toEpochMilli()) / 1000.0;
        double untilTo = (s.validTo().toEpochMilli() - now.toEpochMilli()) / 1000.0;
        double v0 = Math.max(0, untilFrom), v1 = Math.min(horizon, untilTo);
        if (v0 > v1 || v0 >= untilTo) return null;
        double[] band = bandInterval(alt0, vrFpm, s.baseFt(), s.topFt(), horizon);
        if (band == null) return null;
        // 빠른 길: 지금 이미 3조건이 참(수평 안·고도대 안·유효) — 관측의 영역이므로 구간 계산 없이 끝낸다
        if (band[0] == 0 && v0 == 0 && it.prepared().intersects(GeoJson.GF.createPoint(path[0]))) return null;
        for (double[] h : insideIntervals(it, path)) {
            double t0 = Math.max(h[0], Math.max(band[0], v0));
            double t1 = Math.min(h[1], Math.min(band[1], v1));
            if (t0 > t1 || t0 >= untilTo) continue;
            if (t0 <= 1e-6) return null; // 지금 이미 안 — 예측이 아니라 관측의 영역
            String kind = t0 == h[0] ? ENTRY_LATERAL : t0 == band[0] ? ENTRY_VERTICAL : ENTRY_VALID_FROM;
            return new Entry(t0, kind);
        }
        return null;
    }

    /** alt(t) = alt0 + vr·t/60 이 [base, top] 안인 시간 구간 ∩ [0, horizon]. top null = 상한 없음(가정). 없으면 null. */
    static double[] bandInterval(double alt0, double vrFpm, int base, Integer top, double horizon) {
        double lo, hi;
        if (vrFpm == 0) {
            if (alt0 < base || (top != null && alt0 > top)) return null;
            lo = 0;
            hi = horizon;
        } else {
            double tBase = (base - alt0) * 60.0 / vrFpm;
            double tTop = top == null ? (vrFpm > 0 ? Double.POSITIVE_INFINITY : Double.NEGATIVE_INFINITY) : (top - alt0) * 60.0 / vrFpm;
            if (vrFpm > 0) { lo = tBase; hi = tTop; } else { lo = tTop; hi = tBase; }
            lo = Math.max(0, lo);
            hi = Math.min(horizon, hi);
        }
        return lo <= hi ? new double[]{lo, hi} : null;
    }

    /** 궤적이 폴리곤(수평) 안에 있는 시간 구간들(시작 시각 오름차순, 맞닿은 구간은 병합). 경계 위도 '안' 으로 본다. */
    static List<double[]> insideIntervals(SigmetIndex.Item it, Coordinate[] path) {
        List<double[]> raw = new ArrayList<>();
        for (int i = 1; i < path.length; i++) {
            double ta = (i - 1) * (double) PREDICT_STEP_S;
            LineString seg = GeoJson.GF.createLineString(new Coordinate[]{path[i - 1], path[i]});
            if (!it.prepared().intersects(seg)) continue;
            if (it.prepared().covers(seg)) {
                raw.add(new double[]{ta, ta + PREDICT_STEP_S});
                continue;
            }
            Geometry x = seg.intersection(it.polygon());
            double segLen = path[i - 1].distance(path[i]);
            for (int g = 0; g < x.getNumGeometries(); g++) {
                Geometry part = x.getGeometryN(g);
                if (part.isEmpty()) continue;
                double fMin = Double.POSITIVE_INFINITY, fMax = Double.NEGATIVE_INFINITY;
                for (Coordinate c : part.getCoordinates()) {
                    double f = segLen == 0 ? 0 : Math.min(1.0, path[i - 1].distance(c) / segLen);
                    fMin = Math.min(fMin, f);
                    fMax = Math.max(fMax, f);
                }
                raw.add(new double[]{ta + fMin * PREDICT_STEP_S, ta + fMax * PREDICT_STEP_S});
            }
        }
        raw.sort(Comparator.comparingDouble(r -> r[0]));
        List<double[]> merged = new ArrayList<>(raw.size());
        for (double[] r : raw) {
            if (!merged.isEmpty() && r[0] <= merged.getLast()[1] + 1e-6) merged.getLast()[1] = Math.max(merged.getLast()[1], r[1]);
            else merged.add(r);
        }
        return merged;
    }
}
