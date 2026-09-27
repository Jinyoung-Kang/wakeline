package dev.skywx.engine;

import dev.skywx.domain.AircraftState;
import dev.skywx.domain.Alert;
import dev.skywx.domain.SigmetRecord;

import java.time.Instant;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.stream.Collectors;

/**
 * 알림 상태 머신(FR-09). (hex, sigmet) 마다 ENTERED/INSIDE/LEFT, 히스테리시스 진입 2회 · 이탈 3회.
 * 예측(PREDICTED)은 관측과 별도 유형: 처음 한 번 이벤트, ETA 는 갱신만, 사라지면 PREDICTION_CLEARED.
 * 단일 스레드(엔진 주기)에서만 호출된다.
 */
public final class AlertStateMachine {
    public static final int ENTER_CONFIRM = 2;
    public static final int LEAVE_CONFIRM = 3;

    public enum EventType { ENTERED, LEFT, PREDICTED, PREDICTION_UPDATED, PREDICTION_CLEARED }

    public record Event(EventType type, Alert alert) {}

    record Key(String hex, String sigmetId) {}

    static final class Track {
        int inside, outside;
        boolean confirmed;
        Alert alert;
    }

    private final Map<Key, Track> observed = new HashMap<>();
    private final Map<Key, Alert> predicted = new LinkedHashMap<>();
    private final java.util.function.LongSupplier ids;

    public AlertStateMachine(java.util.function.LongSupplier idSupplier) { this.ids = idSupplier; }

    public List<Event> step(Map<String, List<IntersectionEngine.Hit>> hits, List<IntersectionEngine.Prediction> predictions,
                            Map<String, AircraftState> states, Instant now) {
        List<Event> out = new ArrayList<>();
        Set<Key> insideNow = hits.values().stream().flatMap(List::stream).map(h -> new Key(h.hex(), h.sigmet().id())).collect(Collectors.toSet());

        // 진입 확인
        for (List<IntersectionEngine.Hit> hs : hits.values()) for (IntersectionEngine.Hit h : hs) {
            Key k = new Key(h.hex(), h.sigmet().id());
            Track t = observed.computeIfAbsent(k, x -> new Track());
            t.inside++;
            t.outside = 0;
            if (!t.confirmed && t.inside >= ENTER_CONFIRM) {
                t.confirmed = true;
                AircraftState a = states.get(h.hex());
                t.alert = observedAlert(ids.getAsLong(), h, a, now);
                out.add(new Event(EventType.ENTERED, t.alert));
                Alert p = predicted.remove(k);
                if (p != null) out.add(new Event(EventType.PREDICTION_CLEARED, p));
            }
        }
        // 이탈 확인 (스냅샷에서 사라진 기체도 '밖' 으로 센다)
        var it = observed.entrySet().iterator();
        while (it.hasNext()) {
            var e = it.next();
            if (insideNow.contains(e.getKey())) continue;
            Track t = e.getValue();
            t.outside++;
            t.inside = 0;
            if (!t.confirmed) { it.remove(); continue; }
            if (t.outside >= LEAVE_CONFIRM) {
                Alert left = withLeft(t.alert, now);
                out.add(new Event(EventType.LEFT, left));
                it.remove();
            }
        }
        // 예측
        Set<Key> predictedNow = new java.util.HashSet<>();
        for (IntersectionEngine.Prediction p : predictions) {
            Key k = new Key(p.hex(), p.sigmet().id());
            if (observed.containsKey(k) && observed.get(k).confirmed) continue;
            predictedNow.add(k);
            Alert prev = predicted.get(k);
            AircraftState a = states.get(p.hex());
            if (prev == null) {
                Alert al = predictedAlert(ids.getAsLong(), p, a, now);
                predicted.put(k, al);
                out.add(new Event(EventType.PREDICTED, al));
            } else if (Math.abs(prev.etaS() - p.etaS()) >= 30) {
                Alert al = predictedAlert(prev.id(), p, a, prev.enteredAt());
                predicted.put(k, al);
                out.add(new Event(EventType.PREDICTION_UPDATED, al));
            }
        }
        var pit = predicted.entrySet().iterator();
        while (pit.hasNext()) {
            var e = pit.next();
            if (!predictedNow.contains(e.getKey())) {
                out.add(new Event(EventType.PREDICTION_CLEARED, withLeft(e.getValue(), now)));
                pit.remove();
            }
        }
        return out;
    }

    public List<Alert> activeObserved() {
        return observed.values().stream().filter(t -> t.confirmed && t.alert != null).map(t -> t.alert).toList();
    }

    public List<Alert> activePredicted() { return List.copyOf(predicted.values()); }

    public Set<String> insideSigmetIds(String hex) {
        return observed.entrySet().stream().filter(e -> e.getKey().hex().equals(hex) && e.getValue().confirmed)
                .map(e -> e.getKey().sigmetId()).collect(Collectors.toSet());
    }

    public Map<String, Set<String>> confirmedByHex() {
        Map<String, Set<String>> m = new HashMap<>();
        for (var e : observed.entrySet()) if (e.getValue().confirmed) m.computeIfAbsent(e.getKey().hex(), x -> new java.util.HashSet<>()).add(e.getKey().sigmetId());
        return m;
    }

    private static Alert observedAlert(long id, IntersectionEngine.Hit h, AircraftState a, Instant now) {
        SigmetRecord s = h.sigmet();
        Map<String, Object> ev = new LinkedHashMap<>();
        ev.put("polygon_index", h.polygonIndex());
        ev.put("band_ft", new int[]{s.baseFt(), s.topFt() == null ? -1 : s.topFt()});
        ev.put("aircraft_alt_ft", h.altFt());
        ev.put("valid_from", s.validFrom().toString());
        ev.put("valid_to", s.validTo().toString());
        ev.put("judged_at", now.toString());
        ev.put("method", "observed_point_in_polygon");
        ev.put("confirmations", ENTER_CONFIRM);
        ev.put("position", a == null ? null : new double[]{a.lat(), a.lon()});
        ev.put("provider", a == null ? null : a.provider());
        ev.put("seen_at", a == null ? null : a.seenAt().toString());
        return new Alert(id, "OBSERVED", h.hex(), a == null ? null : a.callsign(), s.id(), s.firId(), s.hazard(), s.qualifier(),
                now, null, null, h.altFt(), ev, false);
    }

    private static Alert predictedAlert(long id, IntersectionEngine.Prediction p, AircraftState a, Instant createdAt) {
        SigmetRecord s = p.sigmet();
        Map<String, Object> ev = new LinkedHashMap<>();
        ev.put("polygon_index", p.polygonIndex());
        ev.put("band_ft", new int[]{s.baseFt(), s.topFt() == null ? -1 : s.topFt()});
        ev.put("alt_ft_at_entry", p.altAtEntry());
        ev.put("valid_to", s.validTo().toString());
        ev.put("method", "dead_reckoning_10min");
        ev.put("distance_nm", p.distanceNm());
        ev.put("gs_kt", a == null ? null : a.gsKt());
        ev.put("track_deg", a == null ? null : a.trackDeg());
        ev.put("position", a == null ? null : new double[]{a.lat(), a.lon()});
        ev.put("judged_at", Instant.now().toString());
        return new Alert(id, "PREDICTED", p.hex(), a == null ? null : a.callsign(), s.id(), s.firId(), s.hazard(), s.qualifier(),
                createdAt, null, p.etaS(), p.altAtEntry(), ev, true);
    }

    private static Alert withLeft(Alert a, Instant now) {
        return new Alert(a.id(), a.kind(), a.hex(), a.callsign(), a.sigmetId(), a.firId(), a.hazard(), a.qualifier(),
                a.enteredAt(), now, a.etaS(), a.altFt(), a.evidence(), a.estimated());
    }
}
