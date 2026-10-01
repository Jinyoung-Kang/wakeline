package dev.wakeline.engine;

import dev.wakeline.aircraft.core.AircraftState;
import dev.wakeline.domain.Alert;
import dev.wakeline.domain.SigmetRecord;

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
 *       그 외 60 s 초과) '현재 관측' 이 없는 상태가, 그 기체의 마지막 관측이 온 스코프(region/global/focus/hot)의 <b>새 메시지 3번</b>
 *       이어질 때. 스코프 피드 자체가 끊겼으면(region 60 s · global 300 s · focus 30 s · hot 90 s 넘게 새 메시지 없음) 다른 스코프의
 *       새 메시지도 1번으로 센다(예: OpenSky 일시 중지 중 region 주기로 소실 확정). 모든 피드가 멈추면 아무것도 바꾸지 않는다.
 *       실제 이탈을 본 것이 아니므로 LEFT 로 보고하지 않는다. 마지막 관측의 출처가 수요 추적(focus·hot)이었고 그 추적이 이미 끝났으면
 *       (선택 해제·핫 리전 해제) 근거에 coverage_ended=true — 신호가 끊긴 것이 아니라 우리가 조회를 멈춘 것일 수 있다.</li>
 *   <li>경보 종료(SIGMET_ENDED, close_reason=sigmet_ended — DH-6·API-CONC-4): 추적 중인 SIGMET 이 최신 세트에서 만료(valid_to 경과)
 *       되었거나 빠졌으면(철회 — 취소·대체) 관측을 기다리지 않고 바로 닫는다. 항공기가 나간 것이 아니므로 LEFT(이탈)로 보고하지 않는다.
 *       left_at = 만료면 valid_to, 빠졌으면 그 세트의 수신 시각. 근거 end_cause: expired | withdrawn(같은 공급자의 경보는 세트에 있음)
 *       | provider_missing(그 공급자의 경보가 세트에 하나도 없음 — 철회인지 피드 누락인지 단정하지 않는다).</li>
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

    public enum EventType { ENTERED, LEFT, LOST, SIGMET_ENDED, PREDICTED, PREDICTION_UPDATED, PREDICTION_CLEARED }

    /** SIGMET_ENDED 근거의 end_cause 값. */
    public static final String END_EXPIRED = "expired";
    public static final String END_WITHDRAWN = "withdrawn";
    public static final String END_PROVIDER_MISSING = "provider_missing";

    public record Event(EventType type, Alert alert) {}

    public static final String SCOPE_REGION = "region";
    public static final String SCOPE_GLOBAL = "global";
    public static final String SCOPE_FOCUS = "focus";
    public static final String SCOPE_HOT = "hot";
    private static final List<String> ALL_SCOPES = List.of(SCOPE_REGION, SCOPE_GLOBAL, SCOPE_FOCUS, SCOPE_HOT);

    /**
     * 병합 뷰의 스코프 정보(계약 v2 §A3 — 수요 기반 focus·hot 포함). 엔진이 SnapshotStore.View 로 만든다.
     * 없으면(이전 시그니처) regionHexes 소속으로 region/global 만 구분한다.
     */
    public interface Scopes {
        /** 병합 관측이 온 스코프(region|global|focus|hot), 병합 뷰에 없으면 null. */
        String scopeOf(String hex);
        /** 세부 출처(hot 은 "hot:{셀}"), 없으면 null. */
        String sourceOf(String hex);
        /** 스코프의 최신 메시지 버전(부재 계수 표식 — 하나의 단조 카운터에서 나온다). */
        long version(String scope);
        /** 스코프 피드가 끊겼는가(새 메시지가 기준 시간 넘게 없음). */
        boolean feedStale(String scope);
        /** 그 출처가 아직 이 hex 를 조회 대상으로 두는가(focus: 임대에 있음 · hot: 셀이 살아 있음 · region/global: 항상). */
        boolean covering(String source, String hex);
    }

    /**
     * 한 판정 주기의 스냅샷 맥락. regionVersion/globalVersion = 각 스코프 현재 스냅샷 버전(하나의 단조 카운터에서 나온다),
     * *FeedStale = 그 스코프에 새 스냅샷이 끊겼는가(region 60 s · global 300 s), regionHexes = 관심 지역 스냅샷에 있는 hex.
     * scopes 가 있으면(엔진) 스코프 판단·부재 표식은 그것을 따른다 — 병합 뷰는 신선도 우선이라 region 에 있어도 다른 스코프의 관측일 수 있다(DH-2).
     */
    public record Cycle(long regionVersion, long globalVersion, boolean regionFeedStale, boolean globalFeedStale, Set<String> regionHexes,
                        SigmetSet sigmets, Scopes scopes) {
        /** SIGMET 세트 없이(경보 종료 판단 없음) — 이전 시그니처 호환. */
        public Cycle(long regionVersion, long globalVersion, boolean regionFeedStale, boolean globalFeedStale, Set<String> regionHexes) {
            this(regionVersion, globalVersion, regionFeedStale, globalFeedStale, regionHexes, null, null);
        }

        /** 스코프 정보 없이(region/global 만) — 이전 시그니처 호환. */
        public Cycle(long regionVersion, long globalVersion, boolean regionFeedStale, boolean globalFeedStale, Set<String> regionHexes,
                     SigmetSet sigmets) {
            this(regionVersion, globalVersion, regionFeedStale, globalFeedStale, regionHexes, sigmets, null);
        }

        String scopeOf(String hex) {
            if (scopes != null) {
                String s = scopes.scopeOf(hex);
                if (s != null) return s;
            }
            return regionHexes.contains(hex) ? SCOPE_REGION : SCOPE_GLOBAL;
        }

        String sourceOf(String hex) {
            String s = scopes == null ? null : scopes.sourceOf(hex);
            return s != null ? s : scopeOf(hex);
        }

        /** 마지막 관측의 출처가 이미 이 hex 를 조회하지 않는가(수요 추적 종료). 스코프 정보가 없으면 false. */
        boolean coverageEnded(String source, String hex) {
            return scopes != null && source != null && !scopes.covering(source, hex);
        }

        /**
         * 이 SIGMET 이 끝났는가(이 주기의 판정 기준 세트에서). null = 진행 중(또는 세트 정보 없음).
         * @param known 추적 중 알고 있던 경보(공급자·유효시간 — 세트에서 빠졌을 때 원인 구분용), 없으면 null
         */
        Ended ended(String sigmetId, SigmetRecord known, Instant now) {
            if (sigmets == null) return null;
            SigmetRecord cur = sigmets.byId().get(sigmetId);
            if (cur != null) return cur.validTo().isAfter(now) ? null : new Ended(END_EXPIRED, cur.validTo(), cur);
            if (known != null && !known.validTo().isAfter(now)) return new Ended(END_EXPIRED, known.validTo(), known);
            String provider = known == null ? null : known.provider();
            String cause = provider != null && sigmets.providers().contains(provider) ? END_WITHDRAWN : END_PROVIDER_MISSING;
            return new Ended(cause, sigmets.fetchedAt(), known);
        }

        /** 부재를 셀 기준 표식: 스코프가 살아 있으면 그 스코프 버전, 끊겼으면 어느 스코프든 가장 최근 스냅샷 버전. */
        long absenceMarker(String scope) {
            if (scopes != null) {
                if (!scopes.feedStale(scope)) return scopes.version(scope);
                long max = 0;
                for (String s : ALL_SCOPES) max = Math.max(max, scopes.version(s));
                return max;
            }
            boolean region = SCOPE_REGION.equals(scope);
            boolean stale = region ? regionFeedStale : globalFeedStale;
            if (stale) return Math.max(regionVersion, globalVersion);
            return region ? regionVersion : globalVersion;
        }
    }

    /**
     * 판정 기준 SIGMET 세트(엔진 인덱스를 만든 바로 그 세트): id → 경보, 세트에 들어 있는 공급자, 세트 수신 시각.
     * 세트에서 빠진 경보가 철회인지(같은 공급자의 다른 경보는 있음) 피드 누락인지 구분하는 데 쓴다 — SigmetRepository 의 철회 판단과 같은 규칙.
     */
    public record SigmetSet(Map<String, SigmetRecord> byId, Set<String> providers, Instant fetchedAt) {
        public static SigmetSet of(Map<String, SigmetRecord> byId, Instant fetchedAt) {
            Set<String> providers = new HashSet<>();
            for (SigmetRecord s : byId.values()) if (s.provider() != null) providers.add(s.provider());
            return new SigmetSet(Map.copyOf(byId), Set.copyOf(providers), fetchedAt);
        }
    }

    /** 경보 종료: 원인, 끝난 시각(만료 = valid_to, 빠짐 = 세트 수신 시각), 알고 있던 경보(없으면 null). */
    record Ended(String cause, Instant at, SigmetRecord sigmet) {
        /** left_at: 끝난 시각을 [진입 시각, 판정 시각] 으로 자른다(수집기·api 시계 차로 앞뒤가 뒤집히지 않게). */
        Instant clamp(Instant enteredAt, Instant now) {
            Instant t = at == null ? now : at;
            if (enteredAt != null && t.isBefore(enteredAt)) t = enteredAt;
            return t.isAfter(now) ? now : t;
        }
    }

    record Key(String hex, String sigmetId) {}

    /** 활성 예측과 그 예측을 만든 경보(세트에서 빠졌을 때 원인 구분용). */
    private record Pred(Alert alert, SigmetRecord sigmet) {}

    static final class Track {
        int inside, outside, absent;
        boolean confirmed;
        Alert alert;
        SigmetRecord sigmet;
        /** 마지막으로 센 관측의 seen_at — 이보다 새 seen_at 이어야 다음 관측으로 센다. */
        Instant lastSeenAt;
        String scope;
        /** 마지막 관측의 세부 출처(hot 은 셀 포함) — 소실 때 그 추적이 이미 끝났는지 본다. */
        String source;
        long absenceMarker;
        final Deque<Instant> insideSeen = new ArrayDeque<>(ENTER_CONFIRM);
        final Deque<Instant> outsideSeen = new ArrayDeque<>(LEAVE_CONFIRM);
    }

    private final Map<Key, Track> observed = new HashMap<>();
    private final Map<Key, Pred> predicted = new LinkedHashMap<>();
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
            Ended end = cycle.ended(k.sigmetId(), t.sigmet, now);
            if (end != null) { // 경보가 끝났다 — 항공기 관측과 무관하게 닫는다(이탈이 아니다)
                if (t.confirmed && t.alert != null)
                    out.add(new Event(EventType.SIGMET_ENDED, t.alert.closed(end.clamp(t.alert.enteredAt(), now), Alert.CLOSE_SIGMET_ENDED, endedEvidence(t, end, now))));
                it.remove();
                continue;
            }
            AircraftState a = states.get(k.hex());
            if (a != null && a.fresh(now)) {
                t.scope = cycle.scopeOf(k.hex());
                t.source = cycle.sourceOf(k.hex());
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
                        Pred p = predicted.remove(k);
                        if (p != null) out.add(new Event(EventType.PREDICTION_CLEARED,
                                p.alert().closed(now, Alert.CLOSE_PREDICTION_CLEARED, Map.of("cleared_by", "observed_entry"))));
                    }
                } else if (a.onGround() || a.altFt() != null) {
                    t.lastSeenAt = a.seenAt();
                    t.outside++;
                    t.inside = 0;
                    t.insideSeen.clear();
                    push(t.outsideSeen, a.seenAt(), LEAVE_CONFIRM);
                    if (!t.confirmed) { it.remove(); continue; }
                    if (t.outside >= LEAVE_CONFIRM) {
                        out.add(new Event(EventType.LEFT, t.alert.closed(now, Alert.CLOSE_LEFT, leftEvidence(t))));
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
                if (t.confirmed) out.add(new Event(EventType.LOST, t.alert.closed(now, Alert.CLOSE_SIGNAL_LOST,
                        lostEvidence(t, cycle.coverageEnded(t.source, k.hex())))));
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
            Pred prevP = predicted.get(k);
            Alert prev = prevP == null ? null : prevP.alert();
            AircraftState a = states.get(p.hex());
            if (prev == null) {
                Alert al = predictedAlert(ids.getAsLong(), p, a, now, now);
                predicted.put(k, new Pred(al, p.sigmet()));
                out.add(new Event(EventType.PREDICTED, al));
            } else if (prev.etaAt() == null || Math.abs(Duration.between(prev.etaAt(), p.etaAt()).toMillis()) >= ETA_UPDATE_THRESHOLD_S * 1000L) {
                Alert al = predictedAlert(prev.id(), p, a, prev.enteredAt(), now);
                predicted.put(k, new Pred(al, p.sigmet()));
                out.add(new Event(EventType.PREDICTION_UPDATED, al));
            }
        }
        var pit = predicted.entrySet().iterator();
        while (pit.hasNext()) {
            var e = pit.next();
            if (!best.containsKey(e.getKey())) {
                // 예측이 사라진 까닭이 경보 종료면 근거에 밝힌다(항공기 궤적이 바뀐 것이 아니다)
                Ended end = cycle.ended(e.getKey().sigmetId(), e.getValue().sigmet(), now);
                Map<String, Object> why = end == null ? null : Map.of("cleared_by", "sigmet_ended", "end_cause", end.cause());
                out.add(new Event(EventType.PREDICTION_CLEARED, e.getValue().alert().closed(now, Alert.CLOSE_PREDICTION_CLEARED, why)));
                pit.remove();
            }
        }
        return out;
    }

    public List<Alert> activeObserved() {
        return observed.values().stream().filter(t -> t.confirmed && t.alert != null).map(t -> t.alert).toList();
    }

    public List<Alert> activePredicted() { return predicted.values().stream().map(Pred::alert).toList(); }

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

    /**
     * band_ft = [base, top] — 발표된 값 그대로(top 이 발표되지 않았으면 null). 판정 가정은 따로 밝힌다:
     * top_assumed_unbounded(판정은 상한 무제한), top_is_lower_bound(발표값이 'FLnnn 이상' — band_ft 의 top 은 상한이 아니라 하한, DH-4).
     */
    private static void putBand(Map<String, Object> ev, SigmetRecord s) {
        ev.put("band_ft", Arrays.asList(s.baseFt(), s.topFt()));
        if (s.baseSource() != null) ev.put("base_source", s.baseSource());
        if (s.topSource() != null) ev.put("top_source", s.topSource());
        if (s.baseAssumedSurface()) ev.put("base_assumed_surface", true);
        if (s.topIsLowerBound()) ev.put("top_is_lower_bound", true);
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

    /** 이탈 근거. 경보 만료·철회는 이탈 판정 전에 SIGMET_ENDED 로 닫히므로 여기에 오는 것은 실제 바깥 관측뿐이다. */
    private static Map<String, Object> leftEvidence(Track t) {
        Map<String, Object> ev = new LinkedHashMap<>();
        ev.put("left_confirmations", t.outsideSeen.size());
        ev.put("left_confirmations_seen_at", iso(t.outsideSeen));
        return ev;
    }

    /** 경보 종료 근거: 원인, 경보 유효시간 끝, (빠졌으면) 그 세트의 수신 시각, 마지막으로 센 관측, 판정 시각. */
    private static Map<String, Object> endedEvidence(Track t, Ended end, Instant now) {
        Map<String, Object> ev = new LinkedHashMap<>();
        ev.put("end_cause", end.cause());
        SigmetRecord s = end.sigmet() != null ? end.sigmet() : t.sigmet;
        if (s != null) ev.put("sigmet_valid_to", s.validTo().toString());
        if (!END_EXPIRED.equals(end.cause()) && end.at() != null) ev.put("sigmet_set_fetched_at", end.at().toString());
        ev.put("last_seen_at", t.lastSeenAt == null ? null : t.lastSeenAt.toString());
        ev.put("judged_at", now.toString());
        return ev;
    }

    /** 소실 근거. coverageEnded: 마지막 관측을 준 수요 추적(focus·hot)이 이미 끝났다 — 신호 소실이 아니라 조회 중단일 수 있다. */
    private static Map<String, Object> lostEvidence(Track t, boolean coverageEnded) {
        Map<String, Object> ev = new LinkedHashMap<>();
        ev.put("last_seen_at", t.lastSeenAt == null ? null : t.lastSeenAt.toString());
        ev.put("absent_snapshots", t.absent);
        ev.put("scope", t.scope);
        if (coverageEnded) ev.put("coverage_ended", true);
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
