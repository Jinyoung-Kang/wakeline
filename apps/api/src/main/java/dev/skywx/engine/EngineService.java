package dev.skywx.engine;

import dev.skywx.domain.AircraftState;
import dev.skywx.domain.Alert;
import dev.skywx.ingest.IngestEvents;
import dev.skywx.ingest.SigmetStore;
import dev.skywx.ingest.SnapshotStore;
import io.micrometer.core.instrument.MeterRegistry;
import io.micrometer.core.instrument.Timer;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.context.event.EventListener;
import org.springframework.stereotype.Service;

import java.time.Duration;
import java.time.Instant;
import java.util.ArrayDeque;
import java.util.Deque;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicReference;

/**
 * 스냅샷마다(10 s) 교차·예측 판정 → 알림 FSM → 이벤트. SIGMET 갱신 시(5분) STRtree 재구축 + 전체 재판정.
 * 엔진 실행은 하나의 락으로 직렬화한다(스냅샷·SIGMET 이벤트가 겹쳐도 FSM 은 단일 스레드).
 */
@Service
public class EngineService {
    private static final Logger log = LoggerFactory.getLogger(EngineService.class);
    private static final double TURN_THRESHOLD_DEG = 15.0;

    private final SnapshotStore snapshots;
    private final SigmetStore sigmets;
    private final ApplicationEventPublisher events;
    private final AtomicReference<SigmetIndex> index = new AtomicReference<>(new SigmetIndex(List.of(), Instant.now()));
    private final AtomicLong alertIds = new AtomicLong(System.currentTimeMillis() / 1000);
    private final AlertStateMachine fsm = new AlertStateMachine(alertIds::incrementAndGet);
    private final Map<String, Deque<Double>> trackHistory = new HashMap<>();
    private final Timer cycleTimer;
    private final Object lock = new Object();
    private volatile long lastCycleMs;

    public EngineService(SnapshotStore snapshots, SigmetStore sigmets, ApplicationEventPublisher events, MeterRegistry meters) {
        this.snapshots = snapshots;
        this.sigmets = sigmets;
        this.events = events;
        this.cycleTimer = Timer.builder("skywx_engine_cycle_seconds").publishPercentiles(0.5, 0.95).register(meters);
        meters.gauge("skywx_engine_index_size", index, i -> i.get().size());
        meters.gauge("skywx_alerts_active", fsm, f -> f.activeObserved().size() + f.activePredicted().size());
    }

    @EventListener
    public void onSigmets(IngestEvents.SigmetsUpdated e) {
        Instant now = Instant.now();
        index.set(new SigmetIndex(e.state().byId().values(), now));
        log.info("sigmet index rebuilt: {} polygons from {} sigmets", index.get().size(), e.state().byId().size());
        run(now);
    }

    @EventListener
    public void onSnapshot(IngestEvents.SnapshotUpdated e) {
        run(Instant.now());
    }

    /** 유효시간 만료로 인덱스에서 빠져야 할 경보를 5분마다 정리한다. */
    @org.springframework.scheduling.annotation.Scheduled(fixedDelay = 300_000)
    public void rebuildForExpiry() {
        Instant now = Instant.now();
        index.set(new SigmetIndex(sigmets.state().byId().values(), now));
    }

    private void run(Instant now) {
        synchronized (lock) {
            long t0 = System.nanoTime();
            Map<String, AircraftState> all = new HashMap<>(snapshots.global().states());
            all.putAll(snapshots.region().states());
            SigmetIndex idx = index.get();
            Set<String> turning = updateTurning(all);
            var hits = IntersectionEngine.observe(all.values(), idx, now);
            var predictions = IntersectionEngine.predict(all.values(), idx, now, fsm.confirmedByHex(), turning);
            List<AlertStateMachine.Event> evs = fsm.step(hits, predictions, all, now);
            lastCycleMs = (System.nanoTime() - t0) / 1_000_000;
            cycleTimer.record(Duration.ofNanos(System.nanoTime() - t0));
            if (!evs.isEmpty()) {
                log.info("engine: {} aircraft, {} inside, {} predicted, {} events ({} ms)", all.size(), hits.size(), predictions.size(), evs.size(), lastCycleMs);
                events.publishEvent(new EngineEvents.AlertsChanged(evs));
            }
        }
    }

    /** 최근 3회 관측의 트랙 변화가 15° 를 넘으면 선회 중으로 보고 예측을 보류한다. */
    private Set<String> updateTurning(Map<String, AircraftState> all) {
        Set<String> turning = new HashSet<>();
        for (AircraftState a : all.values()) {
            if (a.trackDeg() == null) continue;
            Deque<Double> h = trackHistory.computeIfAbsent(a.hex(), x -> new ArrayDeque<>(3));
            if (h.isEmpty() || Math.abs(angleDiff(h.peekLast(), a.trackDeg())) > 0.01) {
                h.addLast(a.trackDeg());
                if (h.size() > 3) h.removeFirst();
            }
            if (h.size() >= 2 && Math.abs(angleDiff(h.peekFirst(), h.peekLast())) > TURN_THRESHOLD_DEG) turning.add(a.hex());
        }
        if (trackHistory.size() > 4 * Math.max(1000, all.size())) trackHistory.keySet().retainAll(all.keySet());
        return turning;
    }

    static double angleDiff(double a, double b) {
        double d = (b - a + 540) % 360 - 180;
        return d;
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
