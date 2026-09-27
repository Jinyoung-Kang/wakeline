package dev.wakeline.engine;

import dev.wakeline.domain.AircraftState;
import dev.wakeline.domain.Alert;
import dev.wakeline.domain.SigmetRecord;
import dev.wakeline.ingest.IngestEvents;
import dev.wakeline.ingest.SigmetStore;
import dev.wakeline.ingest.SnapshotStore;
import io.micrometer.core.instrument.MeterRegistry;
import io.micrometer.core.instrument.Timer;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.context.event.EventListener;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;

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
 */
@Service
public class EngineService {
    private static final Logger log = LoggerFactory.getLogger(EngineService.class);
    private static final double TURN_THRESHOLD_DEG = 15.0;
    /** 스코프 피드가 끊겼다고 보는 기준(StatusService 의 stale 과 같은 값): region 60 s · global 300 s. */
    static final int REGION_FEED_STALE_S = 60;
    static final int GLOBAL_FEED_STALE_S = 300;

    private final SnapshotStore snapshots;
    private final SigmetStore sigmets;
    private final ApplicationEventPublisher events;
    private final AtomicReference<SigmetIndex> index = new AtomicReference<>(new SigmetIndex(List.of(), Instant.now()));
    /** 재시작해도 겹치지 않는 시간 기반 id(REL-1/COR-2). */
    private final AlertIds alertIds = new AlertIds(System::currentTimeMillis);
    private final AlertStateMachine fsm = new AlertStateMachine(alertIds::next);
    private final Map<String, Deque<Double>> trackHistory = new HashMap<>();
    private final Timer cycleTimer;
    private final Object lock = new Object();
    private volatile long lastCycleMs;
    private volatile int activeCount;
    /** 마지막 주기의 선회 중 hex(불변) — WS "selected" 예측 가능 여부 조회용(락 없이 읽는다). */
    private volatile Set<String> lastTurning = Set.of();
    /** 마지막으로 알린 '활성'(valid_to > now) SIGMET id 집합. lock 으로 보호. */
    private Set<String> activeSigmetIds = Set.of();

    public EngineService(SnapshotStore snapshots, SigmetStore sigmets, ApplicationEventPublisher events, MeterRegistry meters) {
        this.snapshots = snapshots;
        this.sigmets = sigmets;
        this.events = events;
        this.cycleTimer = Timer.builder("wakeline_engine_cycle_seconds").publishPercentiles(0.5, 0.95).register(meters);
        meters.gauge("wakeline_engine_index_size", index, i -> i.get().size());
        // FSM 은 엔진 스레드 전용 — 스크레이프 스레드는 마지막 주기에 기록한 값만 읽는다
        meters.gauge("wakeline_alerts_active", this, s -> s.activeCount);
    }

    @EventListener
    public void onSigmets(IngestEvents.SigmetsUpdated e) {
        Instant now = Instant.now();
        synchronized (lock) {
            index.set(new SigmetIndex(e.state().byId().values(), now));
            activeSigmetIds = activeIds(e.state().byId().values(), now);
        }
        log.info("sigmet index rebuilt: {} polygons from {} sigmets", index.get().size(), e.state().byId().size());
        run(now);
    }

    @EventListener
    public void onSnapshot(IngestEvents.SnapshotUpdated e) {
        run(Instant.now());
    }

    /**
     * 유효시간 만료 점검(30 s). 활성 SIGMET 이 만료로 빠지면 인덱스를 다시 만들고, SIGMET 목록 version 을 올려
     * SigmetsExpired 를 발행한다 — WS 가 새 수신 없이도(예: AWC 장애 중) 만료된 경보를 화면에서 걷어낼 수 있게(REL-13).
     */
    @Scheduled(fixedDelay = 30_000, initialDelay = 30_000)
    public void rebuildForExpiry() {
        Instant now = Instant.now();
        SigmetStore.State published;
        Set<String> expired;
        synchronized (lock) {
            SigmetStore.State st = sigmets.state();
            Set<String> active = activeIds(st.byId().values(), now);
            if (active.equals(activeSigmetIds)) return;
            expired = new HashSet<>(activeSigmetIds);
            expired.removeAll(active);
            activeSigmetIds = active;
            index.set(new SigmetIndex(st.byId().values(), now));
            if (expired.isEmpty()) return; // 새로 생긴 것은 SigmetsUpdated 가 이미 알렸다
            published = sigmets.republish();
        }
        log.info("sigmet expiry: {} expired, {} active — index rebuilt, sigmets v{}", expired.size(), activeSigmetIds.size(), published.version());
        events.publishEvent(new IngestEvents.SigmetsExpired(published, Set.copyOf(expired)));
    }

    static Set<String> activeIds(Collection<SigmetRecord> all, Instant now) {
        Set<String> ids = new HashSet<>();
        for (SigmetRecord s : all) if (s.validTo().isAfter(now)) ids.add(s.id());
        return ids;
    }

    private void run(Instant now) {
        synchronized (lock) {
            long t0 = System.nanoTime();
            SnapshotStore.View view = snapshots.view(now);
            Map<String, AircraftState> all = view.states();
            SigmetIndex idx = index.get();
            Set<String> turning = updateTurning(all.values(), now);
            lastTurning = Set.copyOf(turning);
            var hits = IntersectionEngine.observe(all.values(), idx, now);
            var predictions = IntersectionEngine.predict(all.values(), idx, now, fsm.confirmedByHex(), turning);
            var cycle = new AlertStateMachine.Cycle(view.region().version(), view.global().version(),
                    view.region().stale(now, REGION_FEED_STALE_S), view.global().stale(now, GLOBAL_FEED_STALE_S),
                    view.region().states().keySet());
            List<AlertStateMachine.Event> evs = fsm.step(hits, predictions, all, now, cycle);
            activeCount = fsm.activeCount();
            lastCycleMs = (System.nanoTime() - t0) / 1_000_000;
            cycleTimer.record(Duration.ofNanos(System.nanoTime() - t0));
            if (!evs.isEmpty()) {
                log.info("engine: {} aircraft, {} inside, {} predicted, {} events ({} ms)", all.size(), hits.size(), predictions.size(), evs.size(), lastCycleMs);
                events.publishEvent(new EngineEvents.AlertsChanged(evs));
            }
        }
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
        return IntersectionEngine.availability(a, Instant.now(), a != null && lastTurning.contains(a.hex()));
    }

    /** hex 로 현재 병합 뷰에서 찾아 predictionAvailability(AircraftState). */
    public PredictionAvailability predictionAvailability(String hex) {
        return predictionAvailability(snapshots.find(hex));
    }

    public List<Alert> activeAlerts(String kind) {
        synchronized (lock) {
            if ("observed".equalsIgnoreCase(kind)) return fsm.activeObserved();
            if ("predicted".equalsIgnoreCase(kind)) return fsm.activePredicted();
            List<Alert> all = new java.util.ArrayList<>(fsm.activeObserved());
            all.addAll(fsm.activePredicted());
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
    public int indexSize() { return index.get().size(); }
}
