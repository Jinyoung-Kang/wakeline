package dev.wakeline.weather.core;

import dev.wakeline.aircraft.core.AircraftEvents;
import dev.wakeline.aircraft.core.AircraftState;
import dev.wakeline.aircraft.core.SnapshotStore;
import io.micrometer.core.instrument.Counter;
import io.micrometer.core.instrument.MeterRegistry;
import io.micrometer.core.instrument.Timer;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.context.event.EventListener;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayDeque;
import java.util.Collection;
import java.util.Deque;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.atomic.AtomicReference;

/**
 * 스냅샷마다(10 s) 교차·예측 판정 → 알림 FSM → 이벤트. SIGMET 갱신 시(5분) STRtree 재구축 + 전체 재판정.
 * 엔진 실행은 하나의 락으로 직렬화한다(스냅샷·SIGMET 이벤트가 겹쳐도 FSM 은 단일 스레드).
 * 판정 대상은 SnapshotStore 병합 뷰(600 s 넘은 global 기체 제외)이고, 관측·예측에는 '현재' 위치(opensky 300 s · 그 외 60 s)만 쓴다.
 * <ul>
 *   <li>한 주기의 예외(예: 잘못된 폴리곤의 JTS TopologyException)는 여기서 가둔다(API-CONC-2): 기록·wakeline_engine_errors_total 로 세고
 *       FSM 은 이전 상태를 유지한다. 예외가 이벤트 발행자(스트림 소비)로 새면 유효한 메시지가 DLQ 로 가고 뒤의 리스너(항적·WS)가 건너뛰어졌다.</li>
 *   <li>FSM 은 인덱스를 만든 바로 그 SIGMET 세트를 받아, 만료·철회된 경보의 알림을 SIGMET_ENDED 로 닫는다. 유효시간 만료 점검(30 s)도
 *       인덱스를 다시 만든 뒤 한 주기를 돌린다 — 모든 피드가 멈춰도 만료된 경보의 알림이 열린 채 남지 않는다.</li>
 *   <li>SIGMET 밖의 판정 구역(공역 — {@link ZoneSource}, ADR-035)은 같은 판정 코드의 <b>두 번째</b> 상태 머신이 다룬다(SIGMET 의 상태 · 사건은 그대로).
 *       운영 설정에 따라 off(판정 안 함) · shadow(판정하고 사건 수만 wakeline_zone_events_total 로 센다 — 저장 · 방송 없음) · on(SIGMET 알림과
 *       같은 사건 묶음으로 발행 — 저장 · WS · REST). on 에서 벗어나면 열린 공역 알림을 구역 종료(zone_ended · end_cause judging_off)로 닫아 발행하고,
 *       shadow 와 on 은 상태 머신을 따로 둔다(그림자 건수가 알림 상태를 바꾸지 않게). 판(차수)이 바뀌면 색인을 다시 짓고, 새 판에 없는 구역의
 *       알림은 edition_replaced 로 닫힌다. 이 길의 예외는 SIGMET 판정을 막지 않는다(따로 가둔다).</li>
 * </ul>
 */
@Service
public class EngineService {
    private static final Logger log = LoggerFactory.getLogger(EngineService.class);
    private static final double TURN_THRESHOLD_DEG = 15.0;
    /** 스코프 피드가 끊겼다고 보는 기준(StatusService 의 stale 과 같은 값): region 60 s · global 300 s. */
    static final int REGION_FEED_STALE_S = 60;
    static final int GLOBAL_FEED_STALE_S = 300;
    /** 수요 스코프 피드 끊김 기준: focus(5 s 주기) 30 s · hot(30~120 s 주기, 셀 수명 90 s) 90 s — 그 뒤로는 다른 스코프의 메시지로 부재를 센다. */
    static final int FOCUS_FEED_STALE_S = 30;
    static final int HOT_FEED_STALE_S = (int) SnapshotStore.HOT_TTL_S;

    private final SnapshotStore snapshots;
    private final SigmetStore sigmets;
    private final ApplicationEventPublisher events;
    /** 인덱스와 그것을 만든 세트(한 벌로 바꾼다 — 판정과 종료 판단이 같은 세트를 본다). */
    record IndexState(ZoneIndex index, AlertStateMachine.SigmetSet set) {}
    private final AtomicReference<IndexState> index = new AtomicReference<>(
            new IndexState(new ZoneIndex(List.of(), Instant.now()), AlertStateMachine.SigmetSet.of(Map.of(), Instant.EPOCH)));
    /** 재시작해도 겹치지 않는 시간 기반 id(REL-1/COR-2). */
    private final AlertIds alertIds = new AlertIds(System::currentTimeMillis);
    private final AlertStateMachine fsm = new AlertStateMachine(alertIds::next);
    private final Map<String, Deque<Double>> trackHistory = new HashMap<>();
    private final Timer cycleTimer;
    private final Counter cycleErrors;
    /** 같은 오류가 주기마다(10 s) 반복될 때 스택을 1분에 한 번만 남긴다. */
    private volatile long lastErrorLogMs;
    private final Object lock = new Object();
    private volatile long lastCycleMs;
    private volatile int activeCount;
    /** 마지막 주기의 선회 중 hex(불변) — WS "selected" 예측 가능 여부 조회용(락 없이 읽는다). */
    private volatile Set<String> lastTurning = Set.of();
    /** 마지막으로 알린 '활성'(valid_to > now) SIGMET id 집합. lock 으로 보호. */
    private Set<String> activeSigmetIds = Set.of();

    /** SIGMET 밖의 판정 구역(없으면 null — 시험 · 공역 기능이 없는 구성). */
    private final ZoneSource extra;
    /** 공역 알림 상태 머신(on) · 그림자 상태 머신(shadow — 건수만) */
    private final AlertStateMachine zoneFsm = new AlertStateMachine(alertIds::next);
    private final AlertStateMachine shadowFsm = new AlertStateMachine(alertIds::next);
    private record ExtraIndex(long version, ZoneIndex index, AlertStateMachine.ZoneSet set) {}
    private ExtraIndex extraIndex;
    private String lastMode = ZoneSource.MODE_OFF;
    private final MeterRegistry meters;
    /** 판정 시각(now)의 출처 — 운영은 시스템 시계, 시험은 움직이는 시계를 넣는다. */
    private final Clock clock;
    public static final String END_JUDGING_OFF = "judging_off";

    public EngineService(SnapshotStore snapshots, SigmetStore sigmets, ApplicationEventPublisher events, MeterRegistry meters) {
        this(snapshots, sigmets, events, meters, (ZoneSource) null);
    }

    @org.springframework.beans.factory.annotation.Autowired
    public EngineService(SnapshotStore snapshots, SigmetStore sigmets, ApplicationEventPublisher events, MeterRegistry meters,
                         org.springframework.beans.factory.ObjectProvider<ZoneSource> extra) {
        this(snapshots, sigmets, events, meters, extra.getIfAvailable());
    }

    public EngineService(SnapshotStore snapshots, SigmetStore sigmets, ApplicationEventPublisher events, MeterRegistry meters, ZoneSource extra) {
        this(snapshots, sigmets, events, meters, extra, Clock.systemUTC());
    }

    /** 시계를 정하는 생성자(시험 — 장애 뒤 늦게 전달되는 스냅샷 재현). 다른 생성자는 시스템 시계를 쓴다. */
    EngineService(SnapshotStore snapshots, SigmetStore sigmets, ApplicationEventPublisher events, MeterRegistry meters, ZoneSource extra,
                  Clock clock) {
        this.clock = clock;
        this.extra = extra;
        this.meters = meters;
        this.snapshots = snapshots;
        this.sigmets = sigmets;
        this.events = events;
        this.cycleTimer = Timer.builder("wakeline_engine_cycle_seconds").publishPercentiles(0.5, 0.95).register(meters);
        this.cycleErrors = Counter.builder("wakeline_engine_errors_total").description("예외로 건너뛴 판정 주기(FSM 은 이전 상태 유지)").register(meters);
        meters.gauge("wakeline_engine_index_size", index, i -> i.get().index().size());
        // FSM 은 엔진 스레드 전용 — 스크레이프 스레드는 마지막 주기에 기록한 값만 읽는다
        meters.gauge("wakeline_alerts_active", this, s -> s.activeCount);
    }

    @EventListener
    public void onSigmets(WeatherEvents.SigmetsUpdated e) {
        Instant now = clock.instant();
        synchronized (lock) {
            index.set(build(e.state(), now));
            activeSigmetIds = activeIds(e.state().byId().values(), now);
        }
        log.info("sigmet index rebuilt: {} polygons from {} sigmets", indexSize(), e.state().byId().size());
        run(now);
    }

    /** 인덱스(만료 제외)와 세트. 인덱스 구축 실패(잘못된 폴리곤)는 호출자에게 올리지 않는다 — 이전 인덱스를 유지하고 센다. */
    private IndexState build(SigmetStore.State st, Instant now) {
        try {
            return new IndexState(new ZoneIndex(st.byId().values(), now), AlertStateMachine.SigmetSet.of(st.byId(), st.fetchedAt()));
        } catch (RuntimeException ex) {
            cycleErrors.increment();
            log.error("sigmet index build failed — keeping the previous index: {}", ex.toString(), ex);
            return index.get();
        }
    }

    /**
     * 스냅샷마다 판정 주기. 같은 스냅샷의 다른 리스너보다 먼저 돈다(명시 — 예전에는 클래스 스캔 순서였다): WS 의 selected 가 싣는 예측 가능 여부
     * ({@link #predictionAvailability} ← lastTurning)가 이 스냅샷의 주기 뒤 값이어야 한다(WsHub#onSnapshot 은 LOWEST_PRECEDENCE — ListenerWiringIT).
     */
    @EventListener
    @Order(Ordered.HIGHEST_PRECEDENCE)
    public void onSnapshot(AircraftEvents.SnapshotUpdated e) {
        run(clock.instant());
    }

    /**
     * 유효시간 만료 점검(30 s). 활성 SIGMET 이 만료로 빠지면 인덱스를 다시 만들고, SIGMET 목록 version 을 올려
     * SigmetsExpired 를 발행한다 — WS 가 새 수신 없이도(예: AWC 장애 중) 만료된 경보를 화면에서 걷어낼 수 있게(REL-13).
     */
    @Scheduled(fixedDelay = 30_000, initialDelay = 30_000)
    public void rebuildForExpiry() {
        Instant now = clock.instant();
        SigmetStore.State published;
        Set<String> expired;
        synchronized (lock) {
            SigmetStore.State st = sigmets.state();
            Set<String> active = activeIds(st.byId().values(), now);
            if (active.equals(activeSigmetIds)) return;
            expired = new HashSet<>(activeSigmetIds);
            expired.removeAll(active);
            activeSigmetIds = active;
            index.set(build(st, now));
            if (expired.isEmpty()) return; // 새로 생긴 것은 SigmetsUpdated 가 이미 알렸다
            published = sigmets.republish();
        }
        log.info("sigmet expiry: {} expired, {} active — index rebuilt, sigmets v{}", expired.size(), activeSigmetIds.size(), published.version());
        events.publishEvent(new WeatherEvents.SigmetsExpired(published, Set.copyOf(expired)));
        run(now); // 만료된 경보의 알림을 지금 닫는다(SIGMET_ENDED) — 새 스냅샷이 없어도(피드 장애 중)
    }

    static Set<String> activeIds(Collection<SigmetRecord> all, Instant now) {
        Set<String> ids = new HashSet<>();
        for (SigmetRecord s : all) if (s.validTo().isAfter(now)) ids.add(s.id());
        return ids;
    }

    private void run(Instant now) {
        synchronized (lock) {
            long t0 = System.nanoTime();
            List<AlertStateMachine.Event> evs;
            int n, inside, predicted;
            try {
                SnapshotStore.View view = snapshots.view(now);
                Map<String, AircraftState> all = view.states();
                IndexState is = index.get();
                Set<String> turning = updateTurning(all.values(), now);
                lastTurning = Set.copyOf(turning);
                var hits = IntersectionEngine.observe(all.values(), is.index(), now);
                var predictions = IntersectionEngine.predict(all.values(), is.index(), now, fsm.confirmedByHex(), turning);
                var cycle = new AlertStateMachine.Cycle(view.region().version(), view.global().version(),
                        view.region().stale(now, REGION_FEED_STALE_S), view.global().stale(now, GLOBAL_FEED_STALE_S),
                        view.region().states().keySet(), is.set(), new ViewScopes(view, now));
                evs = fsm.step(hits, predictions, all, now, cycle);
                List<AlertStateMachine.Event> zoneEvs = runExtra(view, all, turning, now);
                if (!zoneEvs.isEmpty()) {
                    evs = new java.util.ArrayList<>(evs);
                    evs.addAll(zoneEvs);
                }
                n = all.size();
                inside = hits.size();
                predicted = predictions.size();
            } catch (RuntimeException ex) {
                cycleErrors.increment();
                long nowMs = System.currentTimeMillis();
                if (nowMs - lastErrorLogMs > 60_000) {
                    lastErrorLogMs = nowMs;
                    log.error("engine cycle failed — skipped, alert state kept: {}", ex.toString(), ex);
                } else {
                    log.warn("engine cycle failed — skipped: {}", ex.toString());
                }
                return;
            }
            activeCount = fsm.activeCount() + (extra != null && ZoneSource.MODE_ON.equals(lastMode) ? zoneFsm.activeCount() : 0);
            lastCycleMs = (System.nanoTime() - t0) / 1_000_000;
            cycleTimer.record(Duration.ofNanos(System.nanoTime() - t0));
            if (!evs.isEmpty()) {
                log.info("engine: {} aircraft, {} inside, {} predicted, {} events ({} ms)", n, inside, predicted, evs.size(), lastCycleMs);
                events.publishEvent(new EngineEvents.AlertsChanged(evs));
            }
        }
    }

    /**
     * 공역 판정 한 주기(ADR-035). 예외는 여기서 가둔다(SIGMET 판정 · 사건은 그대로 나간다). 돌려주는 것은 on 일 때 발행할 사건뿐 —
     * shadow 의 사건은 세기만 한다. lock 안에서 부른다.
     */
    private List<AlertStateMachine.Event> runExtra(SnapshotStore.View view, Map<String, AircraftState> all, Set<String> turning, Instant now) {
        if (extra == null) return List.of();
        try {
            String mode = extra.mode();
            List<AlertStateMachine.Event> out = new java.util.ArrayList<>();
            if (ZoneSource.MODE_ON.equals(lastMode) && !ZoneSource.MODE_ON.equals(mode)) out.addAll(zoneFsm.closeAll(now, END_JUDGING_OFF));
            if (ZoneSource.MODE_SHADOW.equals(lastMode) && !ZoneSource.MODE_SHADOW.equals(mode)) shadowFsm.closeAll(now, END_JUDGING_OFF);
            lastMode = mode;
            if (ZoneSource.MODE_OFF.equals(mode)) return out;
            long v = extra.version();
            if (extraIndex == null || extraIndex.version() != v) extraIndex = new ExtraIndex(v, new ZoneIndex(extra.zones(), now), extra.set());
            AlertStateMachine m = ZoneSource.MODE_ON.equals(mode) ? zoneFsm : shadowFsm;
            var hits = IntersectionEngine.observe(all.values(), extraIndex.index(), now);
            var preds = IntersectionEngine.predict(all.values(), extraIndex.index(), now, m.confirmedByHex(), turning);
            var cycle = new AlertStateMachine.Cycle(view.region().version(), view.global().version(),
                    view.region().stale(now, REGION_FEED_STALE_S), view.global().stale(now, GLOBAL_FEED_STALE_S),
                    view.region().states().keySet(), extraIndex.set(), new ViewScopes(view, now));
            var evs = m.step(hits, preds, all, now, cycle);
            for (var e : evs)
                meters.counter("wakeline_zone_events_total", "zone_type", extra.zoneType(), "mode", mode,
                        "level", e.alert().level() == null ? Zone.LEVEL_ALERT : e.alert().level(), "event", e.type().name()).increment();
            if (ZoneSource.MODE_ON.equals(mode)) out.addAll(evs);
            return out;
        } catch (RuntimeException ex) {
            cycleErrors.increment();
            log.warn("zone judgement failed — skipped this cycle, SIGMET judgement unaffected: {}", ex.toString());
            return List.of();
        }
    }

    /** 병합 뷰 → FSM 스코프 정보(신선도 우선 병합이라 '어느 스코프의 관측인가' 는 뷰가 안다, DH-2). */
    record ViewScopes(SnapshotStore.View view, Instant now) implements AlertStateMachine.Scopes {
        @Override public String scopeOf(String hex) { return view.scopeOf(hex); }
        @Override public String sourceOf(String hex) { return view.sourceOf(hex); }
        @Override public long version(String scope) { return view.scopeVersion(scope); }
        @Override public boolean feedStale(String scope) {
            Instant at = view.scopeFetchedAt(scope);
            if (at == null || Instant.EPOCH.equals(at)) return true;
            long thresholdS = switch (scope) {
                case SnapshotStore.REGION -> REGION_FEED_STALE_S;
                case SnapshotStore.GLOBAL -> GLOBAL_FEED_STALE_S;
                case SnapshotStore.FOCUS -> FOCUS_FEED_STALE_S;
                default -> HOT_FEED_STALE_S;
            };
            return now.toEpochMilli() - at.toEpochMilli() > thresholdS * 1000L;
        }
        @Override public boolean covering(String source, String hex) { return view.covering(source, hex, now.toEpochMilli()); }
    }

    /** 최근 3회 관측의 트랙 변화가 15° 를 넘으면 선회 중으로 보고 예측을 보류한다. 오래된 위치는 이력에 넣지 않는다. */
    private Set<String> updateTurning(Collection<AircraftState> all, Instant now) {
        Set<String> turning = new HashSet<>();
        for (AircraftState a : all) {
            if (a.trackDeg() == null || !a.fresh(now)) continue;
            Deque<Double> h = trackHistory.computeIfAbsent(a.hex(), x -> new ArrayDeque<>(3));
            if (h.isEmpty() || Math.abs(angleDiff(h.peekLast(), a.trackDeg())) > 0.01) {
                h.addLast(a.trackDeg());
                if (h.size() > 3) h.removeFirst();
            }
            if (h.size() >= 2 && Math.abs(angleDiff(h.peekFirst(), h.peekLast())) > TURN_THRESHOLD_DEG) turning.add(a.hex());
        }
        if (trackHistory.size() > 4 * Math.max(1000, all.size())) {
            Set<String> keep = new HashSet<>();
            for (AircraftState a : all) keep.add(a.hex());
            trackHistory.keySet().retainAll(keep);
        }
        return turning;
    }

    static double angleDiff(double a, double b) {
        double d = (b - a + 540) % 360 - 180;
        return d;
    }

    /**
     * WS "selected" 용: 이 항공기에 진입 예측을 할 수 있는가(계약 §1). 엔진 predict() 와 같은 규칙,
     * 선회 여부는 마지막 엔진 주기 기준. a 가 null 이면 (false, null).
     */
    public PredictionAvailability predictionAvailability(AircraftState a) {
        return IntersectionEngine.availability(a, clock.instant(), a != null && lastTurning.contains(a.hex()));
    }

    /** hex 로 현재 병합 뷰에서 찾아 predictionAvailability(AircraftState). */
    public PredictionAvailability predictionAvailability(String hex) {
        return predictionAvailability(snapshots.find(hex));
    }

    /** 열린 알림 — SIGMET 과 공역(on 일 때만 — shadow 의 상태는 알림이 아니다). */
    public List<Alert> activeAlerts(String kind) {
        synchronized (lock) {
            boolean on = extra != null && ZoneSource.MODE_ON.equals(lastMode);
            List<Alert> all = new java.util.ArrayList<>();
            if (!"predicted".equalsIgnoreCase(kind)) { all.addAll(fsm.activeObserved()); if (on) all.addAll(zoneFsm.activeObserved()); }
            if (!"observed".equalsIgnoreCase(kind)) { all.addAll(fsm.activePredicted()); if (on) all.addAll(zoneFsm.activePredicted()); }
            return all;
        }
    }

    public Set<String> insideSigmets(String hex) { synchronized (lock) { return fsm.insideSigmetIds(hex); } }

    public List<String> aircraftInside(String sigmetId) {
        synchronized (lock) {
            return fsm.activeObserved().stream().filter(a -> a.sigmetId().equals(sigmetId)).map(Alert::hex).toList();
        }
    }

    public long lastCycleMs() { return lastCycleMs; }
    public int indexSize() { return index.get().index().size(); }
}
