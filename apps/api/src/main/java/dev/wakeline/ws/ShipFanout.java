package dev.wakeline.ws;

import dev.wakeline.domain.Bbox;
import dev.wakeline.domain.DestinationInfo;
import dev.wakeline.domain.DestinationParser;
import dev.wakeline.domain.ShipState;
import dev.wakeline.domain.ShipStatic;
import dev.wakeline.ingest.IngestEvents;
import dev.wakeline.ingest.ShipStore;
import dev.wakeline.portcalls.PortCallReader;
import dev.wakeline.portcalls.PortCallsInfo;
import io.micrometer.core.instrument.Counter;
import io.micrometer.core.instrument.MeterRegistry;
import io.micrometer.core.instrument.Timer;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.context.SmartLifecycle;
import org.springframework.context.annotation.Profile;
import org.springframework.context.event.EventListener;
import org.springframework.stereotype.Component;

import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Function;
import java.util.function.LongSupplier;

/**
 * 선박 WS 팬아웃(계약 v2 §B3 · 계약 v4 §C). 선박은 레이어를 켠 세션({type:"layers", ships:true})에만 보낸다.
 * <ul>
 *   <li>개별 선박(points): 줌 ≥ 7 이고 뷰포트 안 ≤ 5,000 척, 또는 4 ≤ 줌 &lt; 7 이고 ≤ 1,500 척. ships_snapshot(sseq 1) → ships_diff(바뀐 것만,
 *       sseq +1 — 항공기 seq 와 같은 규칙: 빈 diff 는 보내지 않아 틈이 없다). 60 s 마다·구독·resync·resume·백프레셔 때 스냅샷.</li>
 *   <li>선박 수 때문에 격자로 바꾸면 capped:true(줌 ≥ 7 은 5,000 척 초과 → 0.5°, 줌 4~6 은 1,500 척 초과 → 그 줌의 칸 크기). 줌 4~6 에서 수 때문에
 *       격자가 된 세션은 1,200 척 이하가 되어야 개별로 돌아온다(1,200~1,500 척 사이에서 되풀이 전환하지 않게).</li>
 *   <li>줌 &lt; 4: 선박 수와 무관하게 ships_grid. 칸 크기는 줌으로(5° z&lt;3 · 2° z&lt;5 · 0.5° z&lt;7 — 줌 4~6 은 수 때문에 격자일 때만).
 *       격자는 ShipStore 버전마다 한 번(O(선박 수)) 만들어 모든 세션이 같이 쓰고,
 *       세션은 자기 bbox 와 겹치는 칸만 고른다. 같은 버전·bbox 의 격자는 다시 보내지 않는다.</li>
 *   <li>select_ship → ship_selected(즉시, 그리고 그 선박이 바뀌거나 목록에서 빠질 때마다). state 는 실시간 목록에 있을 때만, static 은 알고 있으면.
 *       destination_info 는 static 의 보고 목적지를 결정적으로 푼 것(계약 v4 §B — 항구 표는 JVM 에서 한 번 읽는다).</li>
 *   <li>port_calls(ADR-022): static 의 호출부호로 읽은 한국 항만 입출항({@link PortCallReader} — 호출부호별 5 s 캐시). 수집기 조회가 끝나거나
 *       캐시가 만료되는 것은 선박 변화와 무관하므로, {@value #SELECTED_REFRESH_MS} ms 마다 선박을 고른 세션의 ship_selected 를 다시 계산하고
 *       값이 바뀌었을 때만 보낸다(pending → ok 등).</li>
 *   <li>빈도: ships 메시지(수집기 10 s)가 올 때 모든 선박 세션에 한 번 — 연달아 와도(분할 발행·만료) 10 s 에 한 번으로 모은다. 전송은 세션 우편함
 *       (항공기와 같은 단일 비행)이 하므로 느린 세션이 다른 세션·스트림 소비를 막지 않는다.</li>
 * </ul>
 */
@Profile("!cli & !migrate")
@Component
public class ShipFanout implements SmartLifecycle {
    public static final int POINTS_MIN_ZOOM = 7;
    public static final int MAX_SHIPS_PER_MESSAGE = 5_000;
    /** 계약 v4 §C: 줌 4~6 에서도 뷰포트 안 선박이 적으면 개별로 보낸다. */
    public static final int BAND_MIN_ZOOM = 4;
    /** 줌 4~6 의 개별 표시 상한(넘으면 격자). */
    public static final int BAND_MAX_SHIPS = 1_500;
    /** 줌 4~6 에서 수 때문에 격자가 된 세션이 개별로 돌아오는 기준(되풀이 전환 방지). */
    public static final int BAND_RESUME_SHIPS = 1_200;
    /** 선박 팬아웃 최소 간격(계약: 10 s 마다). */
    static final long MIN_INTERVAL_MS = 10_000;
    /** 개별 표시 세션의 주기 전체 스냅샷. */
    static final long RESYNC_MS = 60_000;
    /** 위치·표시 값이 그대로여도 seen_at 이 이만큼 앞으로 가면 다시 보낸다(화면의 나이·STALE 15분 계산이 맞게). */
    static final long SEEN_REFRESH_S = 60;
    /** 위치 변화 임계(°) — 약 11 m. 정박 선박의 GNSS 흔들림을 매번 보내지 않는다. */
    static final double POS_TOL_DEG = 1e-4;
    /** 선택 선박의 입출항 다시 보기 주기(ADR-022) — 읽기 캐시(5 s)와 같다. */
    static final long SELECTED_REFRESH_MS = 5_000;

    private final WsHub hub;
    private final ShipStore store;
    private final DestinationParser destinations = DestinationParser.bundled();
    private final ScheduledExecutorService timer;
    private final LongSupplier clock;
    private final Map<String, CachedJson> liteJson = new ConcurrentHashMap<>();
    private final AtomicReference<ShipGrid> grid = new AtomicReference<>();
    private final Object gridLock = new Object();
    private final AtomicBoolean fanoutQueued = new AtomicBoolean();
    private volatile long lastFanoutMs;
    private volatile boolean running = true;
    /** 정적 정보 → 입출항(운영: PortCallReader). 테스트 구성에서 없으면 port_calls 는 null. */
    private volatile Function<ShipStatic, PortCallsInfo> portCalls = st -> null;
    private final Counter snapshots;
    private final Counter diffs;
    private final Counter grids;
    private final Counter capped;
    private final Timer gridBuild;

    private record CachedJson(ShipStore.Ship ship, String json) {}

    @Autowired
    public ShipFanout(WsHub hub, ShipStore store, MeterRegistry meters, PortCallReader portCallReader) {
        this(hub, store, meters, Executors.newSingleThreadScheduledExecutor(Thread.ofPlatform().daemon().name("ship-fanout").factory()),
                System::currentTimeMillis);
        setPortCallSource(portCallReader::forStatic);
        scheduleSelectedRefresh();
    }

    /** ship_selected.port_calls 의 출처(운영: PortCallReader::forStatic). 테스트는 가짜를 넣는다 — 없으면 null. */
    void setPortCallSource(Function<ShipStatic, PortCallsInfo> f) { portCalls = f == null ? st -> null : f; }

    /** 테스트용: timer 가 null 이면 모으지 않고 이벤트마다 바로 팬아웃한다. */
    ShipFanout(WsHub hub, ShipStore store, MeterRegistry meters, ScheduledExecutorService timer, LongSupplier clock) {
        this.hub = hub;
        this.store = store;
        this.timer = timer;
        this.clock = clock;
        this.snapshots = Counter.builder("wakeline_ws_ship_messages_total").tag("type", "ships_snapshot").register(meters);
        this.diffs = Counter.builder("wakeline_ws_ship_messages_total").tag("type", "ships_diff").register(meters);
        this.grids = Counter.builder("wakeline_ws_ship_messages_total").tag("type", "ships_grid").register(meters);
        this.capped = Counter.builder("wakeline_ws_ship_capped_total")
                .description("뷰포트 안 선박이 개별 표시 상한(줌 ≥ 7 은 5,000 척, 줌 4~6 은 1,500 척)을 넘어 격자로 대신 보낸 경우").register(meters);
        this.gridBuild = Timer.builder("wakeline_ship_grid_build_seconds").description("선박 격자(세 단계) 한 번 만들기 — ShipStore 버전당 한 번").register(meters);
        hub.setShipsHook(this::onInitial);
        hub.setShipSelectedHook(this::recheckSelected);
    }

    /**
     * 선택 선박 다시 보기({@link #refreshSelected})를 {@value #SELECTED_REFRESH_MS} ms 마다 예약한다(운영 생성자에서 한 번). 수명 start() 에 두지 않는다 —
     * 이 빈은 처음부터 running 이라 Spring 이 start() 를 부르지 않는다. 멈춘 타이머면 예약하지 않는다(선박 변화 때만 다시 보낸다).
     */
    void scheduleSelectedRefresh() {
        if (timer == null) return;
        try {
            timer.scheduleWithFixedDelay(this::refreshSelected, SELECTED_REFRESH_MS, SELECTED_REFRESH_MS, TimeUnit.MILLISECONDS);
        } catch (RejectedExecutionException ignored) {
            // 이미 멈춘 타이머(종료 뒤)
        }
    }

    // ---- 수명: WS 허브보다 늦게, 타이머만 정리 ----
    @Override public void start() { running = true; }

    @Override
    public void stop() {
        running = false;
        if (timer != null) timer.shutdownNow();
    }

    @Override public boolean isRunning() { return running; }
    @Override public int getPhase() { return Integer.MAX_VALUE - 150; }

    // ---- 핸들러에서(수신 스레드 — 예약만) ----

    /** 레이어가 바뀌었다: 선박을 켰으면 전체를, 껐으면 보낸 상태를 비운다(다음 우편함 작업이). */
    void layersChanged(WsSession s) {
        s.shipsForce.set(true);
        s.schedule(WsSession.Job.SHIPS, () -> run(s));
    }

    /** 클라이언트 resync(sseq 틈) — 다음 선박 작업은 전체를 보낸다. */
    void resync(WsSession s) {
        if (!s.layerShips) return;
        layersChanged(s);
    }

    /** select_ship: 바로 한 번(선택이 null 이면 보낸 기록만 지운다). */
    void selected(WsSession s) {
        s.shipSelectedForce.set(true);
        s.schedule(WsSession.Job.SHIP_SELECTED, () -> runSelected(s));
    }

    /** 초기 세트(구독·resume·백프레셔)의 끝 — 우편함 안에서 불린다. 선박·선택 선박을 이어서 전체로 보낸다. */
    void onInitial(WsSession s) {
        if (s.layerShips) layersChanged(s);
        if (s.selectedMmsi != null) selected(s);
    }

    /**
     * 선박을 고른 구독 세션마다 ship_selected 를 다시 계산하도록 예약한다(우편함 — 바뀐 것이 없으면 보내지 않는다). 입출항 조회 결과·캐시 만료처럼
     * 선박 변화와 무관한 변화를 알린다. 일시정지한 세션은 건너뛴다(선박 변화 알림과 같다 — 다시 보면 초기 세트가 보낸다). 예외가 주기 작업을 멈추지 않게 삼킨다.
     */
    void refreshSelected() {
        try {
            for (WsSession s : hub.sessionsView()) recheckSelected(s);
        } catch (RuntimeException e) {
            // 다음 주기에 다시
        }
    }

    /** 이 세션의 ship_selected 를 다시 계산하도록 예약한다(선박을 고른 구독 세션만 — 바뀐 것이 없으면 보내지 않는다). */
    void recheckSelected(WsSession s) {
        if (s.selectedMmsi != null && s.subscribed()) s.schedule(WsSession.Job.SHIP_SELECTED, () -> runSelected(s));
    }

    /**
     * 캐시가 비어 있는(pending) 입출항인데 수요 서비스가 이 세션의 그 호출부호를 임대에 올리지 못했다(세션·IP 한도 · 서버 상한) → limited.
     * 누구도 조회하지 않는데 '조회 중' 이라 하지 않게. 캐시에 결과가 있으면 결과가 먼저다.
     */
    static PortCallsInfo gated(PortCallsInfo calls, WsSession.PortCallGate gate) {
        if (calls == null || gate == null || !PortCallsInfo.PENDING.equals(calls.status()) || !gate.callSign().equals(calls.callSign())) return calls;
        return PortCallsInfo.limited(calls.callSign(), gate.limitedBy());
    }

    // ---- 이벤트(스트림 소비·만료 스레드 — 예약만) ----

    @EventListener
    public void onShips(IngestEvents.ShipsUpdated e) {
        for (WsSession s : hub.sessionsView()) {
            String sel = s.selectedMmsi;
            if (sel != null && s.subscribed() && (e.changed().contains(sel) || e.removed().contains(sel)))
                s.schedule(WsSession.Job.SHIP_SELECTED, () -> runSelected(s));
        }
        requestFanout();
    }

    /** 모든 선박 세션에 팬아웃 — 직전 팬아웃 뒤 10 s 가 지나지 않았으면 그때까지 미룬다(그 사이 요청은 합친다). */
    void requestFanout() {
        if (!running) return;
        if (timer == null) { fanoutAll(); return; }
        if (!fanoutQueued.compareAndSet(false, true)) return;
        long delay = Math.max(0, lastFanoutMs + MIN_INTERVAL_MS - clock.getAsLong());
        try {
            timer.schedule(() -> {
                fanoutQueued.set(false);
                lastFanoutMs = clock.getAsLong();
                fanoutAll();
            }, delay, TimeUnit.MILLISECONDS);
        } catch (RejectedExecutionException ex) {
            fanoutQueued.set(false);
        }
    }

    void fanoutAll() {
        for (WsSession s : hub.sessionsView()) if (s.subscribed() && s.layerShips) s.schedule(WsSession.Job.SHIPS, () -> run(s));
        if (liteJson.size() > store.view().size() + AircraftJsonCache.PRUNE_SLACK) {
            Map<String, ShipStore.Ship> live = store.view().ships();
            liteJson.keySet().removeIf(m -> !live.containsKey(m));
        }
    }

    // ---- 우편함 작업(세션당 한 번에 하나) ----

    void run(WsSession s) {
        if (!s.ready() || !s.subscribed()) return;
        boolean force = s.shipsForce.getAndSet(false);
        if (!s.layerShips) { // 껐다: 보낸 상태만 비운다(클라이언트는 스스로 지운다)
            s.shipsMode = WsSession.ShipsMode.OFF;
            s.shipsSent.clear();
            s.sseq = 0;
            s.shipsGridKey = null;
            s.shipsSentVersion = -1;
            s.shipsDense = false;
            return;
        }
        WsSession.Sub sub = s.sub;
        ShipStore.View v = store.view();
        long now = clock.getAsLong();
        int zoom = sub.zoom();
        if (zoom < BAND_MIN_ZOOM) { // 줌 때문에 격자
            sendGrid(s, v, ShipGrid.cellDegFor(zoom), sub.bbox(), false, force, now);
            return;
        }
        int limit = pointsLimit(zoom, s.shipsMode == WsSession.ShipsMode.GRID && s.shipsDense);
        if (v.countIn(sub.bbox(), limit + 1) > limit) { // 수 때문에 격자(capped)
            double deg = zoom >= POINTS_MIN_ZOOM ? ShipGrid.LEVELS[ShipGrid.LEVELS.length - 1] : ShipGrid.cellDegFor(zoom);
            sendGrid(s, v, deg, sub.bbox(), true, force, now);
            return;
        }
        boolean snapshot = force || s.shipsMode != WsSession.ShipsMode.POINTS || s.sseq == 0 || now - s.shipsLastFullMs >= RESYNC_MS;
        if (snapshot) sendSnapshot(s, v, sub.bbox(), now);
        else if (v.version() != s.shipsSentVersion) sendDiff(s, v, sub.bbox(), now);
    }

    /**
     * 이 줌에서 개별로 보낼 수 있는 뷰포트 안 선박 수의 상한(계약 v4 §C): 줌 ≥ 7 은 5,000, 줌 4~6 은 1,500 — 단 수 때문에 이미 격자인 세션(dense)은
     * 1,200 이하가 되어야 돌아온다. 줌 &lt; 4 는 부르지 않는다(항상 격자).
     */
    static int pointsLimit(int zoom, boolean dense) {
        if (zoom >= POINTS_MIN_ZOOM) return MAX_SHIPS_PER_MESSAGE;
        return dense ? BAND_RESUME_SHIPS : BAND_MAX_SHIPS;
    }

    private void sendSnapshot(WsSession s, ShipStore.View v, Bbox bbox, long now) {
        StringBuilder arr = new StringBuilder(4096).append('[');
        s.shipsSent.clear();
        boolean[] first = {true};
        v.forEachIn(bbox, ship -> {
            s.shipsSent.put(ship.mmsi(), ship);
            if (!first[0]) arr.append(',');
            first[0] = false;
            arr.append(lite(ship));
        });
        arr.append(']');
        String msg = hub.toJson(new WsMessages.ShipsSnapshotMsg("ships_snapshot", 1, Instant.ofEpochMilli(now), arr.toString()));
        if (hub.send(s, msg)) {
            s.sseq = 1;
            s.shipsLastFullMs = now;
            s.shipsMode = WsSession.ShipsMode.POINTS;
            s.shipsSentVersion = v.version();
            s.shipsGridKey = null;
            s.shipsDense = false;
            snapshots.increment();
        } else {
            s.sseq = 0; // 보내지 못했다(닫는 중) — 다음에는 스냅샷
        }
    }

    private void sendDiff(WsSession s, ShipStore.View v, Bbox bbox, long now) {
        List<ShipStore.Ship> upsert = new ArrayList<>();
        Set<String> seen = new HashSet<>();
        v.forEachIn(bbox, ship -> {
            seen.add(ship.mmsi());
            ShipStore.Ship prev = s.shipsSent.get(ship.mmsi());
            if (changed(prev, ship)) {
                upsert.add(ship);
                s.shipsSent.put(ship.mmsi(), ship);
            }
        });
        List<String> remove = new ArrayList<>();
        if (s.shipsSent.size() > seen.size()) {
            for (var it = s.shipsSent.keySet().iterator(); it.hasNext(); ) {
                String m = it.next();
                if (!seen.contains(m)) { remove.add(m); it.remove(); }
            }
        }
        s.shipsSentVersion = v.version();
        if (upsert.isEmpty() && remove.isEmpty()) return;
        StringBuilder arr = new StringBuilder(64 + upsert.size() * 170).append('[');
        for (int i = 0; i < upsert.size(); i++) {
            if (i > 0) arr.append(',');
            arr.append(lite(upsert.get(i)));
        }
        arr.append(']');
        int seq = s.sseq + 1;
        String msg = hub.toJson(new WsMessages.ShipsDiffMsg("ships_diff", seq, Instant.ofEpochMilli(now), arr.toString(), remove));
        if (hub.send(s, msg)) {
            s.sseq = seq;
            diffs.increment();
        } else {
            s.sseq = 0; // shipsSent 는 이미 바뀌었다 — 다음에는 스냅샷
        }
    }

    private void sendGrid(WsSession s, ShipStore.View v, double deg, Bbox bbox, boolean isCapped, boolean force, long now) {
        String key = v.version() + "|" + deg + "|" + bbox + "|" + isCapped;
        if (!force && s.shipsMode == WsSession.ShipsMode.GRID && key.equals(s.shipsGridKey)) return;
        String cells = grid(v).cellsJson(deg, bbox);
        String msg = hub.toJson(new WsMessages.ShipsGridMsg("ships_grid", Instant.ofEpochMilli(now), deg, cells, isCapped ? Boolean.TRUE : null));
        if (hub.send(s, msg)) {
            s.shipsMode = WsSession.ShipsMode.GRID;
            s.shipsGridKey = key;
            s.shipsDense = isCapped;
            s.shipsSent.clear();
            s.sseq = 0;
            s.shipsSentVersion = -1;
            grids.increment();
            if (isCapped) capped.increment();
        }
    }

    void runSelected(WsSession s) {
        if (!s.ready() || !s.hello) return;
        boolean force = s.shipSelectedForce.getAndSet(false);
        String mmsi = s.selectedMmsi;
        if (mmsi == null) { s.shipSelectedSent = null; return; }
        ShipStore.Ship ship = store.view().get(mmsi);
        ShipStatic stat = ship != null ? ship.stat() : store.staticOf(mmsi);
        PortCallsInfo calls = gated(portCalls.apply(stat), s.portCallGate);
        WsSession.ShipSelectedSent prev = s.shipSelectedSent;
        if (!force && prev != null && mmsi.equals(prev.mmsi()) && prev.ship() == ship && prev.stat() == stat && Objects.equals(prev.portCalls(), calls))
            return;
        String state = ship == null ? null : hub.toJson(WsMessages.encodeShipState(ship.state()));
        String st = stat == null ? null : hub.toJson(WsMessages.encodeShipStatic(stat));
        DestinationInfo dest = stat == null ? null : destinations.parse(stat.destination());
        if (hub.send(s, hub.toJson(new WsMessages.ShipSelectedMsg("ship_selected", mmsi, state, st, dest, calls))))
            s.shipSelectedSent = new WsSession.ShipSelectedSent(mmsi, ship, stat, calls);
    }

    // ---- 공유 캐시 ----

    /** 이 선박 객체의 ShipLite JSON(선박 객체가 바뀌기 전까지 한 번만 직렬화 — 모든 세션이 같은 String). */
    String lite(ShipStore.Ship ship) {
        CachedJson c = liteJson.get(ship.mmsi());
        if (c != null && c.ship() == ship) return c.json();
        String j = hub.toJson(WsMessages.encodeShipLite(ship.state(), ship.stat()));
        liteJson.put(ship.mmsi(), new CachedJson(ship, j));
        return j;
    }

    /** 이 버전의 격자(없으면 한 번 만든다 — 동시에 여러 세션이 요청해도 한 번). */
    ShipGrid grid(ShipStore.View v) {
        ShipGrid g = grid.get();
        if (g != null && g.version == v.version()) return g;
        synchronized (gridLock) {
            g = grid.get();
            if (g != null && g.version == v.version()) return g;
            long t0 = System.nanoTime();
            g = ShipGrid.build(v);
            gridBuild.record(Duration.ofNanos(System.nanoTime() - t0));
            grid.set(g);
            return g;
        }
    }

    /** 클라이언트에 보낸 값(prev)과 비교해 다시 보낼 만큼 바뀌었는가(ShipLite 필드 기준). */
    static boolean changed(ShipStore.Ship prev, ShipStore.Ship cur) {
        if (prev == null) return true;
        if (prev == cur) return false;
        ShipState a = prev.state(), b = cur.state();
        if (Math.abs(a.lat() - b.lat()) > POS_TOL_DEG || Math.abs(a.lon() - b.lon()) > POS_TOL_DEG) return true;
        if (diff(a.sogKn(), b.sogKn(), 0.05) || diff(a.cogDeg(), b.cogDeg(), 0.5)) return true;
        if (!Objects.equals(a.headingDeg(), b.headingDeg()) || !Objects.equals(a.navStatus(), b.navStatus())
                || !Objects.equals(a.positionSource(), b.positionSource())) return true;
        ShipStatic x = prev.stat(), y = cur.stat();
        if (!Objects.equals(x == null ? null : x.name(), y == null ? null : y.name())
                || !Objects.equals(x == null ? null : x.shipType(), y == null ? null : y.shipType())) return true;
        return b.seenAt().getEpochSecond() - a.seenAt().getEpochSecond() >= SEEN_REFRESH_S;
    }

    private static boolean diff(Double a, Double b, double tol) {
        if (a == null || b == null) return a != b;
        return Math.abs(a - b) > tol;
    }
}
