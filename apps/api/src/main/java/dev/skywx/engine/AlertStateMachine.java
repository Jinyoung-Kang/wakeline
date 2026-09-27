package dev.skywx.engine;

import dev.skywx.domain.AircraftState;
import dev.skywx.domain.Alert;
import dev.skywx.domain.SigmetRecord;

import java.time.Duration;
import java.time.Instant;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Deque;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.function.LongSupplier;
import java.util.stream.Collectors;

/**
 * 알림 상태 머신(FR-09). (hex, sigmet) 마다 ENTERED/INSIDE/LEFT·LOST. 예측(PREDICTED)은 관측과 별도 유형.
 * 단일 스레드(엔진 주기)에서만 호출된다.
 *
 * <p>히스테리시스는 엔진 실행 횟수가 아니라 <b>서로 다른 관측</b>(그 기체의 seen_at 이 바뀐 것)을 센다.
 * 엔진은 region 스냅샷(~10 s)·global 스냅샷(~120 s)·SIGMET 갱신마다 돌지만, 같은 위치를 다시 판정해도 세지 않는다.
 * <ul>
 *   <li>진입(ENTERED): 안쪽 관측 2회 연속. 근거에 실제 두 관측의 seen_at 을 남긴다.</li>
 *   <li>이탈(LEFT, close_reason=left): 판정 가능한 바깥 관측 3회 연속(지상 관측은 공중 위험 공역 밖으로 본다.
 *       고도 미보고 관측은 안/밖 어느 쪽으로도 세지 않는다).</li>
 *   <li>신호 소실(LOST, close_reason=signal_lost): 안에 있던 기체가 스냅샷에서 사라지거나 위치가 오래되어(opensky 300 s,
 *       그 외 60 s 초과) '현재 관측' 이 없는 상태가, 그 기체가 속한 스코프(region/global)의 <b>새 스냅샷 3번</b> 이어질 때.
 *       스코프 피드 자체가 끊겼으면(region 60 s · global 300 s 넘게 새 스냅샷 없음) 다른 스코프의 새 스냅샷도 1번으로 센다
 *       (예: OpenSky 일시 중지 중 region 주기로 소실 확정). 모든 피드가 멈추면(새 스냅샷 없음) 아무것도 바꾸지 않는다.
 *       실제 이탈을 본 것이 아니므로 LEFT 로 보고하지 않는다.</li>
 *   <li>확정 전(안쪽 1회) 트랙은 바깥 관측 1회에 버리고, 부재 3번이면 버린다.</li>
 * </ul>
 * 예측은 처음 한 번 PREDICTED, 예상 진입 시각(eta_at)이 30 s 이상 바뀔 때만 PREDICTION_UPDATED, 사라지면 PREDICTION_CLEARED.
 */
public final class AlertStateMachine {
    public static final int ENTER_CONFIRM = 2;
    public static final int LEAVE_CONFIRM = 3;
    /** 부재(관측 없음) 확정에 필요한 스코프 스냅샷 수 — 이탈과 같은 3회 규칙. */
    public static final int LOST_CONFIRM = LEAVE_CONFIRM;
    public static final int ETA_UPDATE_THRESHOLD_S = 30;

    public enum EventType { ENTERED, LEFT, LOST, PREDICTED, PREDICTION_UPDATED, PREDICTION_CLEARED }

    public record Event(EventType type, Alert alert) {}

    public static final String SCOPE_REGION = "region";
    public static final String SCOPE_GLOBAL = "global";

    /**
     * 한 판정 주기의 스냅샷 맥락. regionVersion/globalVersion = 각 스코프 현재 스냅샷 버전(하나의 단조 카운터에서 나온다),
     * *FeedStale = 그 스코프에 새 스냅샷이 끊겼는가(region 60 s · global 300 s), regionHexes = 관심 지역 스냅샷에 있는 hex.
     */
    public record Cycle(long regionVersion, long globalVersion, boolean regionFeedStale, boolean globalFeedStale, Set<String> regionHexes) {
        String scopeOf(String hex) { return regionHexes.contains(hex) ? SCOPE_REGION : SCOPE_GLOBAL; }

        /** 부재를 셀 기준 표식: 스코프가 살아 있으면 그 스코프 버전, 끊겼으면 어느 스코프든 가장 최근 스냅샷 버전. */
        long absenceMarker(String scope) {
            boolean region = SCOPE_REGION.equals(scope);
            boolean stale = region ? regionFeedStale : globalFeedStale;
            if (stale) return Math.max(regionVersion, globalVersion);
            return region ? regionVersion : globalVersion;
        }
    }

    record Key(String hex, String sigmetId) {}

    static final class Track {
        int inside, outside, absent;
        boolean confirmed;
        Alert alert;
        SigmetRecord sigmet;
        /** 마지막으로 센 관측의 seen_at — 이보다 새 seen_at 이어야 다음 관측으로 센다. */
        Instant lastSeenAt;
        String scope;
        long absenceMarker;
        final Deque<Instant> insideSeen = new ArrayDeque<>(ENTER_CONFIRM);
        final Deque<Instant> outsideSeen = new ArrayDeque<>(LEAVE_CONFIRM);
    }

    private final Map<Key, Track> observed = new HashMap<>();
    private final Map<Key, Alert> predicted = new LinkedHashMap<>();
    private final LongSupplier ids;

    public AlertStateMachine(LongSupplier idSupplier) { this.ids = idSupplier; }

    public List<Event> step(Map<String, List<IntersectionEngine.Hit>> hits, List<IntersectionEngine.Prediction> predictions,
                            Map<String, AircraftState> states, Instant now, Cycle cycle) {
        List<Event> out = new ArrayList<>();
        Map<Key, IntersectionEngine.Hit> insideNow = new HashMap<>();
        for (List<IntersectionEngine.Hit> hs : hits.values())
            for (IntersectionEngine.Hit h : hs) insideNow.putIfAbsent(new Key(h.hex(), h.sigmet().id()), h);
        for (Key k : insideNow.keySet()) observed.computeIfAbsent(k, x -> new Track());

        var it = observed.entrySet().iterator();
        while (it.hasNext()) {
            var e = it.next();
            Key k = e.getKey();
            Track t = e.getValue();
            AircraftState a = states.get(k.hex());
            if (a != null && a.fresh(now)) {
                t.scope = cycle.scopeOf(k.hex());
                t.absent = 0;
                t.absenceMarker = cycle.absenceMarker(t.scope);
                if (t.lastSeenAt != null && !a.seenAt().isAfter(t.lastSeenAt)) continue; // 같은 관측을 다시 판정 — 세지 않는다
                IntersectionEngine.Hit h = insideNow.get(k);
                if (h != null) {
                    t.lastSeenAt = a.seenAt();
                    t.sigmet = h.sigmet();
                    t.inside++;
                    t.outside = 0;
                    t.outsideSeen.clear();
                    push(t.insideSeen, a.seenAt(), ENTER_CONFIRM);
                    if (!t.confirmed && t.inside >= ENTER_CONFIRM) {
                        t.confirmed = true;
                        t.alert = observedAlert(ids.getAsLong(), h, a, t, now);
                        out.add(new Event(EventType.ENTERED, t.alert));
                        Alert p = predicted.remove(k);
                        if (p != null) out.add(new Event(EventType.PREDICTION_CLEARED,
                                p.closed(now, Alert.CLOSE_PREDICTION_CLEARED, Map.of("cleared_by", "observed_entry"))));
                    }
                } else if (a.onGround() || a.altFt() != null) {
                    t.lastSeenAt = a.seenAt();
                    t.outside++;
                    t.inside = 0;
                    t.insideSeen.clear();
                    push(t.outsideSeen, a.seenAt(), LEAVE_CONFIRM);
                    if (!t.confirmed) { it.remove(); continue; }
                    if (t.outside >= LEAVE_CONFIRM) {
                        out.add(new Event(EventType.LEFT, t.alert.closed(now, Alert.CLOSE_LEFT, leftEvidence(t, now))));
                        it.remove();
                    }
                }
                // 공중인데 고도 미보고: 판정할 수 없는 관측 — 안/밖 어느 쪽으로도 세지 않는다
                continue;
            }
            // 관측 없음(스냅샷에서 사라짐 또는 위치가 오래됨): 그 기체 스코프의 새 스냅샷마다 1회
            long m = cycle.absenceMarker(t.scope);
            if (m > t.absenceMarker) {
                t.absent++;
                t.absenceMarker = m;
            }
            if (t.absent >= LOST_CONFIRM) {
                if (t.confirmed) out.add(new Event(EventType.LOST, t.alert.closed(now, Alert.CLOSE_SIGNAL_LOST, lostEvidence(t))));
                it.remove();
            }
        }

        // 예측: 같은 (hex, sigmet) 의 여러 폴리곤은 가장 이른 진입 하나로
        Map<Key, IntersectionEngine.Prediction> best = new LinkedHashMap<>();
        for (IntersectionEngine.Prediction p : predictions) {
            Key k = new Key(p.hex(), p.sigmet().id());
            Track tr = observed.get(k);
            if (tr != null && tr.confirmed) continue;
            best.merge(k, p, (x, y) -> y.etaS() < x.etaS() ? y : x);
        }
        for (var e : best.entrySet()) {
            Key k = e.getKey();
            IntersectionEngine.Prediction p = e.getValue();
            Alert prev = predicted.get(k);
            AircraftState a = states.get(p.hex());
            if (prev == null) {
                Alert al = predictedAlert(ids.getAsLong(), p, a, now, now);
                predicted.put(k, al);
                out.add(new Event(EventType.PREDICTED, al));
            } else if (prev.etaAt() == null || Math.abs(Duration.between(prev.etaAt(), p.etaAt()).toMillis()) >= ETA_UPDATE_THRESHOLD_S * 1000L) {
                Alert al = predictedAlert(prev.id(), p, a, prev.enteredAt(), now);
                predicted.put(k, al);
                out.add(new Event(EventType.PREDICTION_UPDATED, al));
            }
        }
        var pit = predicted.entrySet().iterator();
        while (pit.hasNext()) {
            var e = pit.next();
            if (!best.containsKey(e.getKey())) {
                out.add(new Event(EventType.PREDICTION_CLEARED, e.getValue().closed(now, Alert.CLOSE_PREDICTION_CLEARED, null)));
                pit.remove();
            }
        }
        return out;
    }

    public List<Alert> activeObserved() {
        return observed.values().stream().filter(t -> t.confirmed && t.alert != null).map(t -> t.alert).toList();
    }

    public List<Alert> activePredicted() { return List.copyOf(predicted.values()); }

    public int activeCount() {
        int n = predicted.size();
        for (Track t : observed.values()) if (t.confirmed && t.alert != null) n++;
        return n;
    }

    public Set<String> insideSigmetIds(String hex) {
        return observed.entrySet().stream().filter(e -> e.getKey().hex().equals(hex) && e.getValue().confirmed)
                .map(e -> e.getKey().sigmetId()).collect(Collectors.toSet());
    }

    public Map<String, Set<String>> confirmedByHex() {
        Map<String, Set<String>> m = new HashMap<>();
        for (var e : observed.entrySet()) if (e.getValue().confirmed) m.computeIfAbsent(e.getKey().hex(), x -> new HashSet<>()).add(e.getKey().sigmetId());
        return m;
    }

    private static void push(Deque<Instant> q, Instant v, int cap) {
        q.addLast(v);
        while (q.size() > cap) q.removeFirst();
    }

    private static List<String> iso(Deque<Instant> q) { return q.stream().map(Instant::toString).toList(); }

    /** band_ft = [base, top] — top 이 발표되지 않았으면 null(무제한 '가정' 은 top_assumed_unbounded 로 따로 밝힌다). */
    private static void putBand(Map<String, Object> ev, SigmetRecord s) {
        ev.put("band_ft", Arrays.asList(s.baseFt(), s.topFt()));
        if (s.baseSource() != null) ev.put("base_source", s.baseSource());
        if (s.topSource() != null) ev.put("top_source", s.topSource());
        if (s.baseAssumedSurface()) ev.put("base_assumed_surface", true);
        if (s.topAssumedUnbounded()) ev.put("top_assumed_unbounded", true);
    }

    private static double round1(double v) { return Math.round(v * 10) / 10.0; }

    private static Alert observedAlert(long id, IntersectionEngine.Hit h, AircraftState a, Track t, Instant now) {
        SigmetRecord s = h.sigmet();
        Map<String, Object> ev = new LinkedHashMap<>();
        ev.put("polygon_index", h.polygonIndex());
        putBand(ev, s);
        ev.put("aircraft_alt_ft", h.altFt());
        ev.put("valid_from", s.validFrom().toString());
        ev.put("valid_to", s.validTo().toString());
        ev.put("judged_at", now.toString());
        ev.put("method", "observed_point_in_polygon");
        ev.put("confirmations", t.insideSeen.size());
        ev.put("confirmations_seen_at", iso(t.insideSeen));
        ev.put("position", new double[]{a.lat(), a.lon()});
        ev.put("provider", a.provider());
        ev.put("seen_at", a.seenAt().toString());
        ev.put("position_age_s", round1(Math.max(0, a.ageSeconds(now))));
        return new Alert(id, "OBSERVED", h.hex(), a.callsign(), s.id(), s.firId(), s.hazard(), s.qualifier(),
                now, null, null, null, null, h.altFt(), ev, false);
    }

    private static Map<String, Object> leftEvidence(Track t, Instant now) {
        Map<String, Object> ev = new LinkedHashMap<>();
        ev.put("left_confirmations", t.outsideSeen.size());
        ev.put("left_confirmations_seen_at", iso(t.outsideSeen));
        // 바깥 관측의 원인이 경보 만료(항공기는 그대로)인 경우를 숨기지 않는다
        if (t.sigmet != null && !t.sigmet.validAt(now)) ev.put("sigmet_expired", true);
        return ev;
    }

    private static Map<String, Object> lostEvidence(Track t) {
        Map<String, Object> ev = new LinkedHashMap<>();
        ev.put("last_seen_at", t.lastSeenAt == null ? null : t.lastSeenAt.toString());
        ev.put("absent_snapshots", t.absent);
        ev.put("scope", t.scope);
        return ev;
    }

    private static Alert predictedAlert(long id, IntersectionEngine.Prediction p, AircraftState a, Instant createdAt, Instant now) {
        SigmetRecord s = p.sigmet();
        Map<String, Object> ev = new LinkedHashMap<>();
        ev.put("polygon_index", p.polygonIndex());
        putBand(ev, s);
        ev.put("alt_ft_at_entry", p.altAtEntry());
        ev.put("valid_from", s.validFrom().toString());
        ev.put("valid_to", s.validTo().toString());
        ev.put("method", "dead_reckoning_10min");
        ev.put("entry", p.entry());
        ev.put("distance_nm", p.distanceNm());
        if (a != null) {
            ev.put("gs_kt", a.gsKt());
            ev.put("track_deg", a.trackDeg());
            ev.put("vrate_fpm", a.vrateFpm());
            ev.put("position", new double[]{a.lat(), a.lon()});
            ev.put("provider", a.provider());
            ev.put("seen_at", a.seenAt().toString());
        }
        if (p.vrateAssumedZero()) ev.put("vrate_assumed_zero", true);
        ev.put("position_age_s", p.positionAgeS());
        ev.put("judged_at", now.toString());
        return new Alert(id, "PREDICTED", p.hex(), a == null ? null : a.callsign(), s.id(), s.firId(), s.hazard(), s.qualifier(),
                createdAt, null, null, p.etaS(), p.etaAt(), p.altAtEntry(), ev, true);
    }
}
