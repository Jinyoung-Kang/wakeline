package dev.skywx.engine;

import dev.skywx.domain.AircraftState;
import dev.skywx.domain.GeoJson;
import dev.skywx.domain.SigmetRecord;
import org.locationtech.jts.geom.Coordinate;
import org.locationtech.jts.geom.Geometry;
import org.locationtech.jts.geom.LineString;
import org.locationtech.jts.geom.Point;

import java.time.Instant;
import java.util.ArrayList;
import java.util.Collection;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;

/**
 * 교차 판정(10.2절)과 진입 예측(10.3절). 순수 함수 — 상태는 AlertStateMachine 이 가진다.
 * 판정 조건: 수평(폴리곤 안) ∧ 고도대(base ≤ alt ≤ top) ∧ 유효시간. 지상 항공기는 제외(VA·TC 는 base 0 인 경우가 많음).
 */
public final class IntersectionEngine {
    public static final int PREDICT_STEPS = 10;
    public static final int PREDICT_STEP_S = 60;
    public static final double PREDICT_MIN_GS_KT = 60.0;

    private IntersectionEngine() {}

    public record Hit(String hex, SigmetRecord sigmet, int polygonIndex, int altFt) {}

    /** 관측 교차: hex → hits. 병렬 스트림(인덱스 질의는 스레드 안전). */
    public static Map<String, List<Hit>> observe(Collection<AircraftState> states, SigmetIndex index, Instant now) {
        if (index.size() == 0) return Map.of();
        return states.parallelStream()
                .filter(a -> !a.onGround() && a.altFt() != null)
                .flatMap(a -> index.queryPoint(a.lon(), a.lat()).stream()
                        .filter(it -> it.sigmet().validAt(now) && it.sigmet().bandContains(a.altFt()))
                        .map(it -> new Hit(a.hex(), it.sigmet(), it.polygonIndex(), a.altFt())))
                .collect(Collectors.groupingByConcurrent(Hit::hex));
    }

    public record Prediction(String hex, SigmetRecord sigmet, int polygonIndex, int etaS, int altAtEntry, double distanceNm) {}

    /**
     * 10분 dead reckoning 궤적이 SIGMET 과 만나면 첫 교차 시각(초)과 그 시각의 고도로 판정한다.
     * @param excluded 현재 이미 안에 있는 (hex → sigmet id 집합) — 관측 알림이 있는 조합은 예측하지 않는다.
     * @param turning  최근 관측에서 15° 넘게 선회 중인 hex — 예측 보류(문서화된 한계)
     */
    public static List<Prediction> predict(Collection<AircraftState> states, SigmetIndex index, Instant now,
                                           Map<String, java.util.Set<String>> excluded, java.util.Set<String> turning) {
        if (index.size() == 0) return List.of();
        return states.parallelStream()
                .filter(a -> !a.onGround() && a.altFt() != null && a.gsKt() != null && a.trackDeg() != null
                        && a.gsKt() >= PREDICT_MIN_GS_KT && !turning.contains(a.hex()) && Math.abs(a.lat()) <= 85)
                .flatMap(a -> predictOne(a, index, now, excluded.getOrDefault(a.hex(), java.util.Set.of())).stream())
                .toList();
    }

    static List<Prediction> predictOne(AircraftState a, SigmetIndex index, Instant now, java.util.Set<String> excludedIds) {
        Coordinate[] path = new Coordinate[PREDICT_STEPS + 1];
        path[0] = new Coordinate(a.lon(), a.lat());
        for (int i = 1; i <= PREDICT_STEPS; i++) {
            double[] p = DeadReckoning.predict(a.lat(), a.lon(), a.trackDeg(), a.gsKt(), i * PREDICT_STEP_S);
            path[i] = new Coordinate(p[1], p[0]);
            if (Math.abs(path[i].x - path[i - 1].x) > 180) return List.of(); // 경도 ±180 을 넘는 궤적은 예측 생략
        }
        LineString line = GeoJson.GF.createLineString(path);
        List<SigmetIndex.Item> items = index.queryGeometry(line);
        if (items.isEmpty()) return List.of();
        List<Prediction> out = new ArrayList<>(1);
        for (SigmetIndex.Item it : items) {
            if (excludedIds.contains(it.sigmet().id())) continue;
            double tEntry = firstIntersectionSeconds(it, path);
            if (tEntry < 0) continue;
            double vr = a.vrateFpm() == null ? 0 : a.vrateFpm();
            int altAtEntry = (int) Math.round(a.altFt() + vr * tEntry / 60.0);
            Instant entryTime = now.plusSeconds((long) tEntry);
            if (!it.sigmet().bandContains(altAtEntry) || !it.sigmet().validAt(entryTime)) continue;
            double dist = a.gsKt() * tEntry / 3600.0;
            out.add(new Prediction(a.hex(), it.sigmet(), it.polygonIndex(), (int) Math.round(tEntry), altAtEntry, Math.round(dist * 10) / 10.0));
        }
        return out;
    }

    /** 선분별 교차 검사로 60 s 구간을 찾고 그 안에서 선형 보간. 출발점이 이미 안이면 -1(관측 영역). */
    static double firstIntersectionSeconds(SigmetIndex.Item it, Coordinate[] path) {
        Point start = GeoJson.GF.createPoint(path[0]);
        if (it.prepared().intersects(start)) return -1;
        for (int i = 1; i < path.length; i++) {
            LineString seg = GeoJson.GF.createLineString(new Coordinate[]{path[i - 1], path[i]});
            if (!it.prepared().intersects(seg)) continue;
            Geometry x = seg.intersection(it.polygon());
            if (x.isEmpty()) continue;
            double best = Double.MAX_VALUE;
            for (Coordinate c : x.getCoordinates()) best = Math.min(best, path[i - 1].distance(c));
            double segLen = path[i - 1].distance(path[i]);
            double frac = segLen == 0 ? 0 : Math.min(1.0, best / segLen);
            return (i - 1) * PREDICT_STEP_S + frac * PREDICT_STEP_S;
        }
        return -1;
    }
}
