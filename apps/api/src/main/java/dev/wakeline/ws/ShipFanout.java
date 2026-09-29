package dev.wakeline.ws;

import dev.wakeline.domain.Bbox;
import dev.wakeline.domain.DestinationInfo;
import dev.wakeline.domain.DestinationParser;
import dev.wakeline.domain.ShipState;
import dev.wakeline.domain.ShipStatic;
import dev.wakeline.ingest.IngestEvents;
import dev.wakeline.ingest.ShipStore;
import dev.wakeline.persist.ReadPool;
import dev.wakeline.persist.StoredStaticReader;
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
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;
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
 *   <li>static 의 출처(static-fallback · 계약 v5 §G17): 메모리(ShipStore — 선박 스트림)에 있으면 live. 없으면(api 재시작 뒤 스트림 보존 창보다 오래된
 *       정적 보고) DB ship 표의 마지막 저장 정적 보고를 싣고 stored · static_updated_at(저장 행의 updated_at)으로 밝힌다({@link StoredStaticReader} —
 *       MMSI 별 캐시, 공개 조회 상한). 저장값은 메모리에 넣지 않는다(지도 목록 · 검색은 그대로). DB 에도 없으면 none, 읽지 못하면 stored_unavailable
 *       (static null — 입출항은 no_call_sign · not_received).</li>
 *   <li>DB 조회는 우편함 밖(계약 v5 §G18 · ADR-025 — {@link ShipLookups}): 우편함은 캐시만 본다. 저장 정적 보고 · 입출항을 읽어야 하면 조회 실행기에 맡기고
 *       돌아온다 — 그동안 그 세션의 diff · pong · heartbeat 는 제때 간다. 결과는 우편함에 SHIP_SELECTED 작업으로 돌아와, 세션의 지금 물음(선박 · 메모리
 *       정적 정보의 유무 · 호출부호 — {@link Question})과 같을 때만 그때의 최신 상태와 함께 보낸다(선택이 바뀌었으면 버린다 — 세대 확인). 세션마다
 *       진행 중인 조회는 하나. ship_selected 는 늦어도 조회 마감(운영 5 s — 읽기 풀의 연결 대기 2 s + 문장 3 s) 뒤에 나간다.</li>
 *   <li>port_calls(ADR-022 개정): static 의 호출부호로 DB 입출항 색인에서 찾은 한국 항만 입출항({@link PortCallReader} — 호출부호별
 *       {@value PortCallReader#TTL_MS} ms 캐시). 색인 갱신 · 오래됨(2시간) 판정은 선박 변화와 무관하므로 {@value #SELECTED_REFRESH_MS} ms 마다 선박을 고른
 *       세션의 ship_selected 를 다시 계산하고 값이 바뀌었을 때만 보낸다(incomplete → ok 등). 선택은 외부 호출도 Redis 임대도 만들지 않는다.</li>
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
    /** 선택 선박의 입출항 다시 보기 주기(ADR-022 개정) — 읽기 캐시와 같다. */
    static final long SELECTED_REFRESH_MS = PortCallReader.TTL_MS;
    /** 시험 생성자의 조회 마감(바로 실행하는 실행기라 쓰이지 않는다 — 운영은 ReadPool.readBoundMs). */
    static final long DIRECT_LOOKUP_DEADLINE_MS = 5_000;

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
    /** 선택 선박의 DB 조회(저장 정적 보고 · 입출항 — 우편함 밖). 시험은 바로 실행하는 것을 쓰거나 바꿔 넣는다({@link #useLookups}). */
    private volatile ShipLookups lookups;
    private final Counter snapshots;
    private final Counter diffs;
    private final Counter grids;
    private final Counter capped;
    private final Timer gridBuild;

    private record CachedJson(ShipStore.Ship ship, String json) {}

    /** 운영: 조회 실행기 스레드 = 선택 조회 전용 읽기 풀의 연결 수, 조회 마감 = 그 풀의 한 번 읽기 상한(연결 대기 + 문장). */
    @Autowired
    public ShipFanout(WsHub hub, ShipStore store, MeterRegistry meters, PortCallReader portCallReader, StoredStaticReader storedStaticReader,
                      ReadPool readPool) {
        this(hub, store, meters, Executors.newSingleThreadScheduledExecutor(Thread.ofPlatform().daemon().name("ship-fanout").factory()),
                System::currentTimeMillis);
        useLookups(new ShipLookups(ShipLookups.boundedExecutor(readPool.size()), readPool.readBoundMs(), meters));
        setPortCallSource(ShipLookups.portCalls(portCallReader));
        setStoredStaticSource(ShipLookups.stored(storedStaticReader));
        scheduleSelectedRefresh();
    }

    /** ship_selected.port_calls 의 출처(운영: PortCallReader — 캐시 · 읽기). 테스트는 가짜를 넣는다 — 없으면 null. */
    void setPortCallSource(ShipLookups.Source<ShipStatic, PortCallsInfo> s) { lookups.setPortCalls(s); }

    /** 메모리에 정적 정보가 없는 선택 선박의 저장 정적 보고(운영: StoredStaticReader — 캐시 · 읽기). 테스트는 가짜를 넣는다 — 없으면 읽지 않는다(출처 null). */
    void setStoredStaticSource(ShipLookups.Source<String, StoredStaticReader.Lookup> s) { lookups.setStored(s); }

    /** 조회 묶음을 바꾼다(운영 생성자 · 시험 — 출처는 바꾼 뒤에 넣는다). 이전 것의 실행기는 닫는다. */
    void useLookups(ShipLookups l) {
        ShipLookups old = lookups;
        lookups = l;
        if (old != null) old.close();
    }

    ShipLookups lookups() { return lookups; }

    /** 테스트용: timer 가 null 이면 모으지 않고 이벤트마다 바로 팬아웃한다. 선택 조회는 바로 실행(부른 스레드 — 우편함)한다. */
    ShipFanout(WsHub hub, ShipStore store, MeterRegistry meters, ScheduledExecutorService timer, LongSupplier clock) {
        this.lookups = new ShipLookups(Runnable::run, DIRECT_LOOKUP_DEADLINE_MS, meters);
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
        lookups.close();
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
     * 선박을 고른 구독 세션마다 ship_selected 를 다시 계산하도록 예약한다(우편함 — 바뀐 것이 없으면 보내지 않는다). 입출항 색인 갱신 · 오래됨처럼
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

    /**
     * 선택 조회가 답하는 물음(계약 v5 §G18): 선박 · 메모리 정적 정보가 있는가(없으면 저장 정적 보고를 읽는다) · 입출항에 쓸 메모리 정적 정보의 호출부호.
     * 선박 위치 · 다른 정적 필드가 바뀌어도 물음은 같다 — 진행 중인 조회의 답을 그때의 최신 상태와 함께 쓴다.
     */
    record Question(String mmsi, boolean live, String callSign) {
        static Question of(String mmsi, ShipStatic live) { return new Question(mmsi, live != null, live == null ? null : live.callSign()); }
    }

    /**
     * 세션의 진행 중인 선택 조회(우편함만 WsSession.shipLookup 을 바꾼다). result 는 조회가 끝나면 조회 · 마감 스레드가 쓴다 — 우편함은 이 객체가 세션의
     * 지금 조회(세대)이고 물음이 같을 때만 읽는다. 앞 세대의 결과는 제 객체에 남아 읽히지 않는다(늦게 온 결과 버리기).
     */
    static final class PendingLookup {
        final Question question;
        volatile ShipLookups.Resolved result;

        PendingLookup(Question question) { this.question = question; }
    }

    /**
     * ship_selected 계산(우편함 작업). 캐시만으로 답할 수 있으면 바로 보낸다. 읽어야 하면 조회를 맡기고 돌아온다 — 같은 물음을 이미 읽는 중이면 새로 맡기지
     * 않는다. 조회가 끝나면 이 작업이 다시 예약돼 그 결과(와 그때의 선박 상태)로 보낸다. 선택 해제 · 물음이 바뀌면 진행 중인 조회의 결과는 쓰지 않는다.
     */
    void runSelected(WsSession s) {
        if (!s.ready() || !s.hello) return;
        if (s.shipSelectedForce.getAndSet(false)) s.shipSelectedForcePending = true; // 조회를 기다리는 동안에도 남는다
        String mmsi = s.selectedMmsi;
        if (mmsi == null) {
            s.shipSelectedSent = null;
            s.shipSelectedForcePending = false;
            dropLookup(s);
            return;
        }
        ShipStore.Ship ship = store.view().get(mmsi);
        ShipStatic live = ship != null ? ship.stat() : store.staticOf(mmsi);
        Question q = Question.of(mmsi, live);
        PendingLookup p = s.shipLookup;
        boolean same = p != null && p.question.equals(q);
        ShipLookups.Resolved r = same ? p.result : null; // 이 물음에 대해 끝난 조회
        if (r == null) r = lookups.cached(mmsi, live);  // 캐시(I/O 없음)
        if (r == null) {
            if (same) return; // 같은 물음을 읽는 중 — 끝나면 다시 온다
            dropLookup(s);
            startLookup(s, q, ship, live);
            return;
        }
        if (p != null) {
            s.shipLookup = null;
            if (r != p.result) lookups.dropped(); // 다른 물음이었거나 캐시가 먼저 답했다
        }
        sendSelected(s, mmsi, ship, fit(r, live));
    }

    private void startLookup(WsSession s, Question q, ShipStore.Ship ship, ShipStatic live) {
        ShipLookups l = lookups;
        CompletableFuture<ShipLookups.Resolved> f = l.load(q.mmsi(), live);
        if (f.isDone()) { // 바로 실행하는 실행기(시험) — 기다릴 것이 없다
            sendSelected(s, q.mmsi(), ship, fit(f.join(), live));
            return;
        }
        PendingLookup mine = new PendingLookup(q);
        s.shipLookup = mine;
        f.thenAccept(r -> {
            mine.result = r;
            if (!s.schedule(WsSession.Job.SHIP_SELECTED, () -> runSelected(s)) && s.isClosing()) l.dropped();
        });
    }

    /** 진행 중인 조회를 버린다(결과가 와도 쓰지 않는다). */
    private void dropLookup(WsSession s) {
        if (s.shipLookup == null) return;
        s.shipLookup = null;
        lookups.dropped();
    }

    /** 조회 결과를 지금의 메모리 정적 정보에 맞춘다: 물음이 같으면 입출항(같은 호출부호)은 그대로, 보일 정적 정보는 지금 메모리 값(live). */
    private static ShipLookups.Resolved fit(ShipLookups.Resolved r, ShipStatic live) {
        if (live == null || r.sel().stat() == live) return r;
        return new ShipLookups.Resolved(new ShipLookups.SelectedStatic(live, WsMessages.STATIC_LIVE), r.calls());
    }

    /** 보낸 것과 다르거나(선박 객체 · 정적 정보 · 출처 · 입출항) 강제면 보낸다. */
    private void sendSelected(WsSession s, String mmsi, ShipStore.Ship ship, ShipLookups.Resolved r) {
        ShipStatic stat = r.sel().stat();
        String source = r.sel().source();
        PortCallsInfo calls = r.calls();
        WsSession.ShipSelectedSent prev = s.shipSelectedSent;
        if (!s.shipSelectedForcePending && prev != null && mmsi.equals(prev.mmsi()) && prev.ship() == ship && Objects.equals(prev.stat(), stat)
                && Objects.equals(prev.staticSource(), source) && Objects.equals(prev.portCalls(), calls))
            return;
        String state = ship == null ? null : hub.toJson(WsMessages.encodeShipState(ship.state()));
        String st = stat == null ? null : hub.toJson(WsMessages.encodeShipStatic(stat));
        String storedAt = WsMessages.STATIC_STORED.equals(source) ? stat.updatedAt().toString() : null;
        DestinationInfo dest = stat == null ? null : destinations.parse(stat.destination());
        if (hub.send(s, hub.toJson(new WsMessages.ShipSelectedMsg("ship_selected", mmsi, state, st, source, storedAt, dest, calls)))) {
            s.shipSelectedSent = new WsSession.ShipSelectedSent(mmsi, ship, stat, source, calls);
            s.shipSelectedForcePending = false;
        }
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
